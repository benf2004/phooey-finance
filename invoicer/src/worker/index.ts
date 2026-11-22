import { Hono } from 'hono';
import { setCookie } from 'hono/cookie';
import { z } from 'zod';
import { AppError, brandingSchema, decimal, partySchema, settingsSchema, toMinor, type InvoiceDocument } from '../shared/model';
import { renderPdf } from '../shared/pdf';
import { authenticate, keyMatches, requireKey, type AppEnv, type Env } from './auth';
import { jsonBody, readBody, sameOrigin, sha, token } from './http';
import { checkChange, createInvoice, getInvoice, getSettings, invoiceSelect, present, resolveDocument, revisionSchema, updateDraft, validateBranding, validateImage, type InvoiceRow } from './store';
import { handleMcp } from './mcp';
import { openapi } from './openapi';

const app = new Hono<AppEnv>();
app.use('*', async (c, next) => {
  await next();
  c.header('X-Content-Type-Options', 'nosniff'); c.header('Referrer-Policy', 'no-referrer'); c.header('X-Robots-Tag', 'noindex, nofollow');
  c.header('X-Frame-Options', 'SAMEORIGIN');
  c.header('Content-Security-Policy', "default-src 'self'; script-src 'self' https://static.cloudflareinsights.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self' https://cloudflareinsights.com; frame-src 'self' blob:; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'self'");
  if (c.req.path === '/mcp' || c.req.path.startsWith('/api') || c.req.path.startsWith('/auth') || c.req.path.startsWith('/s/')) c.header('Cache-Control', 'no-store');
});
app.onError((error, c) => {
  if (error instanceof z.ZodError) return c.json({ error: { code: 'validation', message: 'Check the invoice fields', details: error.issues.map(x => ({ path: x.path.join('.'), message: x.message })) } }, 422);
  if (error instanceof AppError) return c.json({ error: { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) } }, error.status as 400);
  // Never log request bodies, keys, customer details or share tokens.
  console.error(JSON.stringify({ event: 'request_failed', type: error.name }));
  return c.json({ error: { code: 'internal', message: 'The request could not be completed' } }, 500);
});
app.use('/mcp', authenticate);
app.all('/mcp', async c => {
  if (!c.req.header('Authorization')?.startsWith('Bearer ')) throw new AppError(401,'unauthorized','Use an API key for MCP');
  return handleMcp(c.req.raw,c.env,c.executionCtx,c.get('keyScope'),async request => app.fetch(request,c.env,c.executionCtx));
});
app.get('/health', async c => { await c.env.DB.prepare('SELECT 1 FROM settings LIMIT 1').first(); return c.json({ ok: true }); });
app.post('/auth/login', async c => {
  const key = requireKey(c.env); sameOrigin(c.req.raw);
  const body = z.object({ key: z.string().max(1000) }).parse(await jsonBody(c.req.raw));
  const ip = await sha(`${key}:${c.req.header('CF-Connecting-IP') || 'local'}`); const now = Date.now();
  const attempt = await c.env.DB.prepare('INSERT INTO login_attempts (ip_hash, count, window_end) VALUES (?, 1, ?) ON CONFLICT(ip_hash) DO UPDATE SET count = CASE WHEN window_end <= ? THEN 1 ELSE count + 1 END, window_end = CASE WHEN window_end <= ? THEN ? ELSE window_end END RETURNING count').bind(ip, now + 600000, now, now, now + 600000).first<{ count: number }>();
  if (attempt!.count > 8) { c.header('Retry-After', '600'); throw new AppError(429, 'login_throttled', 'Too many login attempts. Try again in 10 minutes.'); }
  if (!await keyMatches(body.key, key)) throw new AppError(401, 'unauthorized', 'Invalid admin key');
  const raw = token(); const csrf = token(); const expires = now + 12 * 3600000;
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM sessions WHERE expires_at <= ?').bind(now),
    c.env.DB.prepare('DELETE FROM login_attempts WHERE ip_hash = ? OR window_end <= ?').bind(ip, now),
    c.env.DB.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?)').bind(await sha(raw), csrf, await sha(key), expires),
  ]);
  setCookie(c, 'invoicer_session', raw, { httpOnly: true, secure: new URL(c.req.url).protocol === 'https:', sameSite: 'Strict', path: '/', maxAge: 43200 });
  return c.json({ csrfToken: csrf, expiresAt: expires });
});
app.use('/auth/session', authenticate);
app.get('/auth/session', c => c.json({ csrfToken: c.get('csrf') }));
app.use('/auth/logout', authenticate);
app.post('/auth/logout', async c => {
  if (c.get('sessionHash')) await c.env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(c.get('sessionHash')).run();
  setCookie(c, 'invoicer_session', '', { httpOnly: true, secure: new URL(c.req.url).protocol === 'https:', sameSite: 'Strict', path: '/', maxAge: 0 });
  return c.json({ ok: true });
});
app.get('/api/v1/openapi.json', c => c.json(openapi));
app.get('/api/v1', c => c.redirect('/api/v1/docs'));
app.get('/api/v1/docs', c => c.html(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Invoicer API</title><style>body{font:16px system-ui;max-width:850px;margin:60px auto;padding:24px;color:#233047;line-height:1.6}pre{background:#f4f6fa;padding:20px;overflow:auto;border-radius:12px}a{color:#5367df}code{font-family:monospace}h2{margin-top:35px}</style></head><body><h1>Invoicer REST API</h1><p>Your businesses, invoices, and integrations.</p><p><a href="${c.env.APP_PREFIX || ''}/api/v1/openapi.json">Download the OpenAPI 3.1 specification</a> · <a href="${c.env.APP_PREFIX || ''}/">Open dashboard</a></p><h2>Authentication</h2><p>Send <code>Authorization: Bearer YOUR_API_KEY</code>. All data endpoints require this header or an authenticated dashboard session. Cookie mutations also require a same-origin request and <code>X-CSRF-Token</code>.</p><h2>Generate a PDF without saving</h2><pre>curl "$INVOICER_URL/api/v1/render" \\\n  -H "Authorization: Bearer $INVOICER_API_KEY" \\\n  -H 'Content-Type: application/json' \\\n  --data '{"billTo":{"name":"Acme Ltd"},"items":[{"description":"Design services","quantity":"2.5","rate":"120"}]}' \\\n  --output invoice.pdf</pre><h2>Save an invoice</h2><p>Use <code>POST /api/v1/invoices</code> with the same data. Add <code>"status":"issued"</code> to issue immediately. Business and customer names are required to issue. Defaults come from business settings and the default preset. Use <code>Idempotency-Key</code> to safely retry creation.</p><h2>Update and lifecycle actions</h2><p>Every saved record has a <code>revision</code>. Include it in updates and invoice actions. Stale requests return 409. Only drafts allow content edits; issued invoices allow payment changes, voiding, sharing, archiving and restoration.</p><p><code>POST /invoices/{id}/issue</code>, <code>/duplicate</code>, <code>/payment</code>, <code>/void</code>, <code>/archive</code>, <code>/restore</code> and <code>/share</code> accept a revision. Payment also accepts decimal-string <code>amountPaid</code>. <code>DELETE /invoices/{id}/share</code> revokes a link. Links grant read access to anyone holding them.</p><h2>Limits and totals</h2><p>JSON requests: 1 MiB. Logos: PNG/JPEG, 256 KiB, at most 2048 × 2048. Invoices: 200 lines. Monetary inputs and quantities are non-negative decimal strings with up to six decimal places. Totals are returned in currency minor units. Each line rounds half-up, followed by discount, tax on the discounted subtotal, shipping, and amount paid. Overpayment is rejected.</p><h2>Lists and errors</h2><p>Lists accept <code>page</code> and <code>limit</code> (maximum 100). Invoices additionally accept <code>q</code>, <code>status</code>, and <code>archived=true</code>. Errors use <code>{"error":{"code":"…","message":"…","details":[]}}</code>. See the specification for all payloads.</p></body></html>`));
app.use('/api/v1/*', authenticate);
app.use('/api/v1/*', async (c, next) => {
  const businessId = c.get('businessId');
  if (c.req.path === '/api/v1/businesses' && c.get('admin')) return next();
  if (!await c.env.DB.prepare('SELECT id FROM businesses WHERE id=?').bind(businessId).first()) throw new AppError(404, 'not_found', 'Business not found');
  const match = c.req.path.match(/^\/api\/v1\/(invoices|customers|presets|assets)\/([^/]+)/);
  if (match && !await c.env.DB.prepare(`SELECT id FROM ${match[1]} WHERE id=? AND business_id=?`).bind(match[2],businessId).first()) throw new AppError(404, 'not_found', 'Record not found in this business');
  await next();
});
app.get('/api/v1/businesses', async c => {
  const rows = c.get('admin') ? await c.env.DB.prepare('SELECT id,name FROM businesses ORDER BY created_at,id').all() : await c.env.DB.prepare('SELECT id,name FROM businesses WHERE id=?').bind(c.get('businessId')).all();
  return c.json({items:rows.results});
});
app.post('/api/v1/businesses', async c => {
  if (!c.get('admin')) throw new AppError(403,'owner_required','Create businesses from the dashboard');
  const {name} = z.object({name:z.string().trim().min(1).max(200)}).parse(await jsonBody(c.req.raw));
  const id = crypto.randomUUID();
  await c.env.DB.batch([
    c.env.DB.prepare('INSERT INTO businesses(id,name) VALUES(?,?)').bind(id,name),
    c.env.DB.prepare('INSERT INTO settings(id,document) VALUES(?,?)').bind(id,JSON.stringify({business:{name}})),
    c.env.DB.prepare('INSERT INTO counters(id) VALUES(?)').bind(id),
  ]);
  return c.json({id,name},201);
});
app.get('/api/v1/keys', async c => {
  if (!c.get('admin')) throw new AppError(403,'owner_required','Manage keys from the dashboard');
  const rows = await c.env.DB.prepare('SELECT id,name,prefix,scope,created_at FROM api_keys WHERE business_id=? AND revoked_at IS NULL ORDER BY created_at DESC').bind(c.get('businessId')).all();
  return c.json({items:rows.results});
});
app.post('/api/v1/keys', async c => {
  if (!c.get('admin')) throw new AppError(403,'owner_required','Manage keys from the dashboard');
  const {name,scope} = z.object({name:z.string().trim().min(1).max(100),scope:z.enum(['read','write']).default('read')}).parse(await jsonBody(c.req.raw));
  const namespace = c.env.KEY_NAMESPACE || 'local';
  const raw = `phinv_${namespace}_${token()}`;
  const id = crypto.randomUUID(), prefix = raw.slice(0,raw.lastIndexOf('_')+9);
  await c.env.DB.prepare('INSERT INTO api_keys(id,business_id,name,prefix,token_hash,scope) VALUES(?,?,?,?,?,?)').bind(id,c.get('businessId'),name,prefix,await sha(raw),scope).run();
  return c.json({id,name,scope,prefix,key:raw},201);
});
app.delete('/api/v1/keys/:id', async c => {
  if (!c.get('admin')) throw new AppError(403,'owner_required','Manage keys from the dashboard');
  checkChange(await c.env.DB.prepare("UPDATE api_keys SET revoked_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND business_id=? AND revoked_at IS NULL").bind(c.req.param('id'),c.get('businessId')).run());
  return c.json({ok:true});
});
app.post('/api/v1/render', async c => {
  const { document } = await resolveDocument(c.env.DB, await jsonBody(c.req.raw), c.get('businessId'));
  return pdfResponse(c.env, document);
});
app.get('/api/v1/settings', async c => c.json(await getSettings(c.env.DB, c.get('businessId'))));
app.put('/api/v1/settings', async c => {
  const body = z.object({ settings: settingsSchema, revision: z.number().int().positive() }).parse(await jsonBody(c.req.raw));
  await validateBranding(c.env.DB, body.settings.branding, c.get('businessId'));
  if (body.settings.defaultPresetId && !await c.env.DB.prepare('SELECT id FROM presets WHERE id = ? AND business_id = ?').bind(body.settings.defaultPresetId, c.get('businessId')).first()) throw new AppError(422, 'invalid_preset', 'Preset not found');
  const result = await c.env.DB.prepare('UPDATE settings SET document = ?, revision = revision + 1 WHERE id = ? AND revision = ?').bind(JSON.stringify(body.settings), c.get('businessId'), body.revision).run(); checkChange(result);
  return c.json(await getSettings(c.env.DB, c.get('businessId')));
});
app.post('/api/v1/invoices', async c => {
  const result = await createInvoice(c.env.DB, await jsonBody(c.req.raw), c.req.header('Idempotency-Key'), c.get('businessId'));
  if (result.replayed) c.header('Idempotency-Replayed', 'true');
  return c.json(result.invoice, result.replayed ? 200 : 201);
});
app.get('/api/v1/invoices', async c => {
  const { page, limit, offset } = pagination(c.req.query()); const q = c.req.query('q') || '';
  if (q.length > 100) throw new AppError(400, 'search_limit', 'Search is limited to 100 characters');
  const status = z.enum(['all', 'draft', 'issued', 'paid', 'void', 'overdue']).parse(c.req.query('status') || 'all');
  const where = ['business_id = ?', c.req.query('archived') === 'true' ? 'archived_at IS NOT NULL' : 'archived_at IS NULL'];
  const params: (string | number)[] = [c.get('businessId')];
  if (q) { where.push("(instr(lower(COALESCE(number, '') || ' ' || json_extract(document, '$.billTo.name')), lower(?)) > 0)"); params.push(q); }
  if (status === 'draft' || status === 'void') { where.push('state = ?'); params.push(status); }
  if (status === 'issued') where.push("state = 'issued' AND amount_paid < json_extract(totals, '$.total')");
  if (status === 'paid') where.push("state = 'issued' AND amount_paid = json_extract(totals, '$.total')");
  if (status === 'overdue') { where.push("state = 'issued' AND amount_paid < json_extract(totals, '$.total') AND json_extract(document, '$.dueDate') != '' AND json_extract(document, '$.dueDate') < ?"); params.push(new Date().toISOString().slice(0, 10)); }
  const clause = where.join(' AND ');
  const [count, rows] = await c.env.DB.batch([
    c.env.DB.prepare(`SELECT COUNT(*) AS count FROM invoices WHERE ${clause}`).bind(...params),
    c.env.DB.prepare(`${invoiceSelect} WHERE ${clause} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`).bind(...params, limit, offset),
  ]);
  return c.json({ items: (rows.results as InvoiceRow[]).map(present), total: (count.results[0] as { count: number }).count, page, limit });
});
app.get('/api/v1/invoices/:id', async c => c.json(await getInvoice(c.env.DB, c.req.param('id'), c.get('businessId'))));
app.put('/api/v1/invoices/:id', async c => c.json(await updateDraft(c.env.DB, c.req.param('id'), await jsonBody(c.req.raw), c.get('businessId'))));
app.get('/api/v1/invoices/:id/pdf', async c => { const invoice = await getInvoice(c.env.DB, c.req.param('id'), c.get('businessId')); return pdfResponse(c.env, invoice.document, invoice.status); });
app.post('/api/v1/invoices/:id/:action', async c => {
  const id = c.req.param('id'); const action = c.req.param('action'); const body = await jsonBody(c.req.raw); const { revision } = revisionSchema.parse(body);
  const current = await getInvoice(c.env.DB, id, c.get('businessId'));
  if (current.revision !== revision) throw new AppError(409, 'revision_conflict', 'This invoice changed. Reload it before trying again.');
  if (action === 'duplicate') {
    const input = { ...current.document, invoiceNumber: '', amountPaid: '0', status: 'draft' };
    return c.json((await createInvoice(c.env.DB, input, undefined, c.get('businessId'))).invoice, 201);
  }
  if (current.archivedAt && action !== 'restore') throw new AppError(409, 'archived_invoice', 'Restore this invoice first');
  const update = (set: string, condition = '', values: (string | number | null)[] = []) => c.env.DB.prepare(`UPDATE invoices SET ${set}, revision = revision + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ? AND revision = ? ${condition}`).bind(...values, id, revision);
  if (action === 'share') {
    if (current.status === 'draft') throw new AppError(409, 'draft_share', 'Issue the invoice before sharing');
    const raw = token();
    const results = await c.env.DB.batch([
      c.env.DB.prepare("INSERT INTO shares (invoice_id, token_hash) SELECT id, ? FROM invoices WHERE id = ? AND revision = ? AND state != 'draft' AND archived_at IS NULL ON CONFLICT(invoice_id) DO UPDATE SET token_hash = excluded.token_hash").bind(await sha(raw), id, revision),
      update('state = state', "AND state != 'draft' AND archived_at IS NULL"),
    ]);
    checkChange(results[1]);
    return c.json({ url: `${c.env.PUBLIC_ORIGIN || new URL(c.req.url).origin}${c.env.BUNDLE_PREFIX || ''}/s/${raw}`, invoice: await getInvoice(c.env.DB, id, c.get('businessId')) });
  }
  if (action === 'archive') {
    const results = await c.env.DB.batch([c.env.DB.prepare('DELETE FROM shares WHERE invoice_id = ? AND EXISTS (SELECT 1 FROM invoices WHERE id = ? AND revision = ? AND archived_at IS NULL)').bind(id, id, revision), update("archived_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')", 'AND archived_at IS NULL')]); checkChange(results[1]);
  } else if (action === 'restore') { checkChange(await update('archived_at = NULL', 'AND archived_at IS NOT NULL').run()); }
  else if (action === 'issue') {
    if (!current.document.business.name || !current.document.billTo.name) throw new AppError(422, 'missing_party', 'Business and customer names are required to issue an invoice');
    try { checkChange(await update("state = 'issued'", "AND state = 'draft' AND archived_at IS NULL").run()); }
    catch (e) { if (String(e).includes('UNIQUE')) throw new AppError(409, 'number_conflict', 'Invoice number already exists; change the number or numbering settings'); throw e; }
  } else if (action === 'void') { checkChange(await update("state = 'void'", "AND state = 'issued' AND archived_at IS NULL").run()); }
  else if (action === 'payment') {
    const { amountPaid } = z.object({ amountPaid: decimal }).parse(body);
    let amount: number; try { amount = toMinor(amountPaid, current.document.currency); } catch (e) { throw new AppError(422, 'invalid_amount', (e as Error).message); }
    if (amount > current.totals.total) throw new AppError(422, 'overpayment', 'Amount paid cannot exceed the invoice total');
    checkChange(await update('amount_paid = ?', "AND state = 'issued' AND archived_at IS NULL", [amount]).run());
  } else throw new AppError(404, 'not_found', 'Unknown invoice action');
  return c.json(await getInvoice(c.env.DB, id, c.get('businessId')));
});
app.delete('/api/v1/invoices/:id/share', async c => {
  const id = c.req.param('id'); const { revision } = revisionSchema.parse(await jsonBody(c.req.raw));
  const result = await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM shares WHERE invoice_id = ? AND EXISTS(SELECT 1 FROM invoices WHERE id = ? AND revision = ?)').bind(id, id, revision),
    c.env.DB.prepare('UPDATE invoices SET revision = revision + 1 WHERE id = ? AND revision = ?').bind(id, revision),
  ]); checkChange(result[1]); return c.json(await getInvoice(c.env.DB, id, c.get('businessId')));
});
app.get('/api/v1/customers', async c => {
  const { page, limit, offset } = pagination(c.req.query());
  const [count, rows] = await c.env.DB.batch([c.env.DB.prepare('SELECT COUNT(*) AS count FROM customers WHERE archived = 0 AND business_id = ?').bind(c.get('businessId')), c.env.DB.prepare("SELECT * FROM customers WHERE archived = 0 AND business_id = ? ORDER BY lower(json_extract(document, '$.name')), id LIMIT ? OFFSET ?").bind(c.get('businessId'), limit, offset)]);
  return c.json({ items: (rows.results as Array<{ id: string; document: string; revision: number }>).map(row => ({ id: row.id, party: JSON.parse(row.document as string), revision: row.revision })), total: (count.results[0] as { count: number }).count, page, limit });
});
app.post('/api/v1/customers', async c => {
  const { party } = z.object({ party: partySchema.refine(p => !!p.name, 'Customer name is required') }).parse(await jsonBody(c.req.raw)); const id = crypto.randomUUID();
  await c.env.DB.prepare('INSERT INTO customers (id, business_id, document) VALUES (?, ?, ?)').bind(id, c.get('businessId'), JSON.stringify(party)).run(); return c.json({ id, party, revision: 1 }, 201);
});
app.put('/api/v1/customers/:id', async c => {
  const { party, revision } = z.object({ party: partySchema.refine(p => !!p.name, 'Customer name is required'), revision: z.number().int().positive() }).parse(await jsonBody(c.req.raw));
  checkChange(await c.env.DB.prepare('UPDATE customers SET document = ?, revision = revision + 1 WHERE id = ? AND revision = ? AND archived = 0').bind(JSON.stringify(party), c.req.param('id'), revision).run()); return c.json({ id: c.req.param('id'), party, revision: revision + 1 });
});
app.delete('/api/v1/customers/:id', async c => { const { revision } = revisionSchema.parse(await jsonBody(c.req.raw)); checkChange(await c.env.DB.prepare('UPDATE customers SET archived = 1, revision = revision + 1 WHERE id = ? AND revision = ? AND archived = 0').bind(c.req.param('id'), revision).run()); return c.json({ ok: true }); });
app.get('/api/v1/presets', async c => { const { page, limit, offset } = pagination(c.req.query()); const [count, rows] = await c.env.DB.batch([c.env.DB.prepare('SELECT COUNT(*) AS count FROM presets WHERE business_id = ?').bind(c.get('businessId')), c.env.DB.prepare('SELECT * FROM presets WHERE business_id = ? ORDER BY name, id LIMIT ? OFFSET ?').bind(c.get('businessId'), limit, offset)]); return c.json({ items: (rows.results as Array<{ id: string; name: string; document: string; revision: number }>).map(row => ({ id: row.id, name: row.name, branding: JSON.parse(row.document as string), revision: row.revision })), total: (count.results[0] as { count: number }).count, page, limit }); });
app.post('/api/v1/presets', async c => { const data = z.object({ name: z.string().min(1).max(100), branding: brandingSchema }).parse(await jsonBody(c.req.raw)); await validateBranding(c.env.DB, data.branding, c.get('businessId')); const id = crypto.randomUUID(); await c.env.DB.prepare('INSERT INTO presets (id, business_id, name, document) VALUES (?, ?, ?, ?)').bind(id, c.get('businessId'), data.name, JSON.stringify(data.branding)).run(); return c.json({ id, ...data, revision: 1 }, 201); });
app.put('/api/v1/presets/:id', async c => { const data = z.object({ name: z.string().min(1).max(100), branding: brandingSchema, revision: z.number().int().positive() }).parse(await jsonBody(c.req.raw)); await validateBranding(c.env.DB, data.branding, c.get('businessId')); checkChange(await c.env.DB.prepare('UPDATE presets SET name = ?, document = ?, revision = revision + 1 WHERE id = ? AND revision = ?').bind(data.name, JSON.stringify(data.branding), c.req.param('id'), data.revision).run()); return c.json({ id: c.req.param('id'), ...data, revision: data.revision + 1 }); });
app.delete('/api/v1/presets/:id', async c => {
  const { revision } = revisionSchema.parse(await jsonBody(c.req.raw)); const id = c.req.param('id');
  const results = await c.env.DB.batch([
    c.env.DB.prepare("UPDATE settings SET document = json_set(document, '$.defaultPresetId', NULL), revision = revision + 1 WHERE json_extract(document, '$.defaultPresetId') = ? AND EXISTS(SELECT 1 FROM presets WHERE id = ? AND revision = ?)").bind(id, id, revision),
    c.env.DB.prepare('DELETE FROM presets WHERE id = ? AND revision = ?').bind(id, revision),
  ]); checkChange(results[1]); return c.json({ ok: true });
});
app.post('/api/v1/assets', async c => {
  const bytes = await readBody(c.req.raw, 262144); const mime = await validateImage(bytes); const id = crypto.randomUUID();
  await c.env.DB.prepare('INSERT INTO assets (id, business_id, mime, bytes) VALUES (?, ?, ?, ?)').bind(id, c.get('businessId'), mime, bytes).run(); return c.json({ id, mime, size: bytes.length }, 201);
});
app.get('/api/v1/assets/:id', async c => {
  const asset = await c.env.DB.prepare('SELECT mime, bytes FROM assets WHERE id = ?').bind(c.req.param('id')).first<{ mime: string; bytes: ArrayBuffer }>();
  if (!asset) throw new AppError(404, 'not_found', 'Logo not found');
  // D1 serializes BLOB reads as byte arrays. Normalize before constructing a binary response.
  return new Response(new Uint8Array(asset.bytes).buffer, { headers: { 'Content-Type': asset.mime, 'Cache-Control': 'no-store' } });
});
app.get('/s/:token/pdf', async c => { const invoice = await sharedInvoice(c.env, c.req.param('token')); return pdfResponse(c.env, invoice.document, invoice.status, true); });
app.get('/s/:token/info', async c => {
  const invoice = await sharedInvoice(c.env, c.req.param('token'));
  return c.json({ number: invoice.number, title: invoice.document.branding.labels.title || 'Invoice', businessName: invoice.document.business.name, status: invoice.status, currency: invoice.document.currency, locale: invoice.document.locale, total: invoice.totals.total, balanceDue: invoice.totals.balanceDue });
});
app.get('/s/:token', async c => {
  let status = 200;
  try { await sharedInvoice(c.env, c.req.param('token')); }
  catch (error) { if (error instanceof AppError && error.status === 404) status = 404; else throw error; }
  const page = await c.env.ASSETS.fetch(c.req.raw);
  return new Response(page.body, { status, headers: page.headers });
});
app.all('/s/*', () => { throw new AppError(404, 'not_found', 'This invoice link is unavailable'); });
app.all('/api/*', () => { throw new AppError(404, 'not_found', 'API endpoint not found'); });
app.all('/auth/*', () => { throw new AppError(404, 'not_found', 'Authentication endpoint not found'); });
app.get('*', async c => {
  const response = await c.env.ASSETS.fetch(c.req.raw);
  if (/\.(?:m?js|css|woff2?|ttf|svg|png|jpg|map)$/.test(c.req.path) && response.headers.get('Content-Type')?.includes('text/html')) return c.text('Asset not found',404);
  if (response.headers.get('Content-Type')?.includes('text/html')) { const result = new Response(response.body,response); result.headers.set('Cache-Control','no-cache'); return result; }
  return response;
});
app.notFound(c => c.json({ error: { code: 'not_found', message: 'Not found' } }, 404));

function pagination(query: Record<string, string>) {
  const { page, limit } = z.object({ page: z.coerce.number().int().min(1).max(1000000).default(1), limit: z.coerce.number().int().min(1).max(100).default(25) }).parse(query);
  return { page, limit, offset: (page - 1) * limit };
}
async function sharedInvoice(env: Env, raw: string) {
  if (!/^[0-9a-f]{64}$/.test(raw)) throw new AppError(404, 'not_found', 'This invoice link is unavailable');
  const row = await env.DB.prepare("SELECT invoice_id, business_id FROM shares JOIN invoices ON invoices.id = shares.invoice_id WHERE token_hash = ? AND archived_at IS NULL AND state != 'draft'").bind(await sha(raw)).first<{ invoice_id: string; business_id: string }>();
  if (!row) throw new AppError(404, 'not_found', 'This invoice link is unavailable'); return getInvoice(env.DB, row.invoice_id, row.business_id);
}
async function pdfResponse(env: Env, document: InvoiceDocument, state?: 'draft' | 'issued' | 'paid' | 'void', inline = false) {
  let logo: Uint8Array | undefined;
  if (document.branding.logoAssetId) { const asset = await env.DB.prepare('SELECT bytes FROM assets WHERE id = ?').bind(document.branding.logoAssetId).first<{ bytes: ArrayBuffer }>(); if (asset) logo = new Uint8Array(asset.bytes); }
  const started = performance.now();
  let bytes: Uint8Array;
  try {
    bytes = await renderPdf(document, { state, logo, font: async name => {
      const response = await env.ASSETS.fetch(new Request(`https://assets.local/fonts/${name}`));
      if (!response.ok || response.headers.get('content-type')?.includes('text/html')) throw new AppError(503, 'missing_fonts', 'PDF fonts are missing; rebuild the static assets');
      return new Uint8Array(await response.arrayBuffer());
    } });
  } catch (e) { if (e instanceof AppError) throw e; throw new AppError(422, 'pdf_render', (e as Error).message); }
  // workerd's performance clock excludes blocked I/O; production invocations expose CPU time in Workers observability.
  const measured = performance.now() - started;
  return new Response(Uint8Array.from(bytes).buffer, { headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="invoice-${document.invoiceNumber.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 80) || 'preview'}.pdf"`, 'Cache-Control': 'no-store', 'Server-Timing': `pdf;dur=${measured.toFixed(1)}`, 'X-PDF-Render-Ms': measured.toFixed(1) } });
}
export default app;
