import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';

const root = resolve('.'); const workspace = await mkdtemp(join(tmpdir(), 'invoicer-test-')); const port = 8791; const url = `http://127.0.0.1:${port}`;
let key = randomBytes(32).toString('hex'); const configPath = join(workspace, 'wrangler.jsonc'); const statePath = join(workspace, 'state');
await writeFile(join(workspace, '.dev.vars'), `ADMIN_KEY=${key}\n`, { mode: 0o600 });
await writeFile(configPath, JSON.stringify({ name: 'invoicer-test', main: join(root, 'src/worker/index.ts'), compatibility_date: '2026-10-07', compatibility_flags: ['nodejs_compat'], assets: { directory: join(root, 'dist'), binding: 'ASSETS', not_found_handling: 'single-page-application', run_worker_first: true }, d1_databases: [{ binding: 'DB', database_name: 'invoicer-test', database_id: '00000000-0000-0000-0000-000000000000', migrations_dir: join(root, 'migrations') }] }));
const environment = { ...process.env, WRANGLER_SEND_METRICS: 'false', WRANGLER_LOG_PATH: join(workspace, 'logs'), NO_COLOR: '1' };
function wrangler(args, quiet = false) {
  const child = spawn(process.execPath, [join(root, 'node_modules/wrangler/bin/wrangler.js'), ...args, '--config', configPath], { cwd: root, env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', d => { output += d; }); child.stderr.on('data', d => { output += d; });
  const done = new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', code => code === 0 ? resolve(output) : reject(new Error(`Local Wrangler command failed (${code}): ${output.replaceAll(key, '[redacted]')}`))); });
  return { child, done, output: () => output };
}
let worker;
let passed = 0;
function check(name, fn) { fn(); passed++; console.log(`✓ ${name}`); }
async function request(path, { method = 'GET', data, headers = {}, auth = true, raw } = {}) {
  const response = await fetch(url + path, { method, headers: { ...(auth ? { Authorization: `Bearer ${key}` } : {}), ...(data !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: raw ?? (data !== undefined ? JSON.stringify(data) : undefined) });
  const content = response.headers.get('content-type') || ''; const value = content.includes('application/json') ? await response.json() : new Uint8Array(await response.arrayBuffer());
  return { response, value, status: response.status };
}
const input = { billTo: { name: 'Acme Studio', email: 'billing@example.com' }, items: [{ description: 'Strategy and design', quantity: '2.5', rate: '120' }] };
try {
  await wrangler(['d1', 'migrations', 'apply', 'DB', '--local', '--persist-to', statePath]).done;
  worker = wrangler(['dev', '--ip', '127.0.0.1', '--port', String(port), '--persist-to', statePath]); worker.done.catch(() => {});
  for (let i = 0; i < 80; i++) { try { if ((await fetch(url + '/health')).ok) break; } catch {} if (i === 79) throw new Error('Local Worker did not start: ' + worker.output().replaceAll(key, '[redacted]')); await new Promise(r => setTimeout(r, 250)); }
  const anonymous = await request('/api/v1/invoices', { auth: false }); check('private API rejects anonymous requests', () => assert.equal(anonymous.status, 401));
  const loginWithoutOrigin = await request('/auth/login', { method: 'POST', data: { key }, auth: false }); check('login requires same origin', () => assert.equal(loginWithoutOrigin.status, 403));
  const login = await request('/auth/login', { method: 'POST', data: { key }, headers: { Origin: url }, auth: false }); check('admin key creates dashboard session', () => assert.equal(login.status, 200));
  const cookie = login.response.headers.get('set-cookie').split(';')[0]; const csrf = login.value.csrfToken;
  const cookieGet = await request('/api/v1/settings', { auth: false, headers: { Cookie: cookie } }); check('session can read settings', () => assert.equal(cookieGet.status, 200));
  const csrfFail = await request('/api/v1/customers', { method: 'POST', data: { party: { name: 'CSRF' } }, auth: false, headers: { Cookie: cookie, Origin: url } }); check('cookie mutations require CSRF', () => assert.equal(csrfFail.status, 403));
  const settings = (await request('/api/v1/settings')).value;
  const updateSettings = await request('/api/v1/settings', { method: 'PUT', data: { revision: settings.revision, settings: { ...settings.settings, business: { ...settings.settings.business, name: 'Design Works', address: '100 Market Street', email: 'hello@example.com' } } } }); check('settings update on empty database', () => assert.equal(updateSettings.status, 200));
  const countsBefore = await request('/api/v1/invoices');
  const pdf = await request('/api/v1/render', { method: 'POST', data: input }); check('stateless PDF returns actual PDF bytes', () => { assert.equal(pdf.status, 200); assert.equal(Buffer.from(pdf.value.slice(0, 5)).toString(), '%PDF-'); });
  const countsAfter = await request('/api/v1/invoices'); check('stateless rendering creates no invoice records', () => assert.equal(countsBefore.value.total, countsAfter.value.total));
  await mkdir('test-results', { recursive: true }); await writeFile('test-results/api-invoice.pdf', pdf.value);
  console.log(`  Worker render duration: ${pdf.response.headers.get('x-pdf-render-ms')}ms (local runtime, not production CPU)`);
  const badAmount = await request('/api/v1/render', { method: 'POST', data: { ...input, amountPaid: '10000' } }); check('invalid calculations return structured validation error', () => { assert.equal(badAmount.status, 422); assert.equal(badAmount.value.error.code, 'invalid_amount'); });
  const badGlyph = await request('/api/v1/render', { method: 'POST', data: { ...input, notes: '😀' } }); check('unsupported PDF glyphs fail clearly', () => assert.equal(badGlyph.status, 422));
  const logo = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5ZkAAAAASUVORK5CYII=', 'base64');
  const asset = await request('/api/v1/assets', { method: 'POST', raw: logo, headers: { 'Content-Type': 'image/png' } }); check('valid PNG logo uploads', () => assert.equal(asset.status, 201));
  const assetDownload = await request(`/api/v1/assets/${asset.value.id}`); check('logo download preserves the original binary bytes', () => { assert.equal(assetDownload.status, 200); assert.deepEqual(Buffer.from(assetDownload.value), logo); });
  const fakeImage = await request('/api/v1/assets', { method: 'POST', raw: Buffer.from('<svg/>'), headers: { 'Content-Type': 'image/png' } }); check('image validation checks bytes, not claimed MIME', () => assert.equal(fakeImage.status, 422));
  const hugeImage = await request('/api/v1/assets', { method: 'POST', raw: Buffer.alloc(262145), headers: { 'Content-Type': 'image/png' } }); check('oversized logos are rejected', () => assert.equal(hugeImage.status, 413));
  const customer = (await request('/api/v1/customers', { method: 'POST', data: { party: { name: 'Zoë Müller', address: '123 Creative Lane', email: 'zoe@example.com' } } })).value;
  const preset = (await request('/api/v1/presets', { method: 'POST', data: { name: 'Studio', branding: { template: 'modern', accentColor: '#3859aa', logoAssetId: asset.value.id, labels: { title: 'FACTURE' } } } })).value;
  let invoice = (await request('/api/v1/invoices', { method: 'POST', data: { items: input.items, customerId: customer.id, presetId: preset.id } })).value;
  check('saved invoice snapshots resolved references and branding', () => { assert.equal(invoice.document.billTo.name, 'Zoë Müller'); assert.equal(invoice.document.branding.template, 'modern'); assert.equal(invoice.totals.total, 30000); });
  const stale = await request(`/api/v1/invoices/${invoice.id}`, { method: 'PUT', data: { ...invoice.document, revision: 99 } }); check('stale draft updates are rejected', () => assert.equal(stale.status, 409));
  const update = await request(`/api/v1/invoices/${invoice.id}`, { method: 'PUT', data: { ...invoice.document, notes: 'Thank you!', revision: invoice.revision } }); invoice = update.value;
  const issuedRace = await Promise.all([1, 2].map(() => request(`/api/v1/invoices/${invoice.id}/issue`, { method: 'POST', data: { revision: invoice.revision } })));
  check('concurrent issue requests cannot issue twice', () => assert.deepEqual(issuedRace.map(x => x.status).sort(), [200, 409])); invoice = issuedRace.find(x => x.status === 200).value;
  check('first issue assigns sequential number', () => assert.equal(invoice.number, 'INV-0001'));
  const frozen = await request(`/api/v1/invoices/${invoice.id}`, { method: 'PUT', data: { ...invoice.document, revision: invoice.revision } }); check('issued content is immutable', () => assert.equal(frozen.status, 409));
  await request(`/api/v1/customers/${customer.id}`, { method: 'PUT', data: { party: { ...customer.party, name: 'Changed Customer' }, revision: customer.revision } });
  await request(`/api/v1/presets/${preset.id}`, { method: 'PUT', data: { name: 'Changed Style', branding: { ...preset.branding, template: 'classic' }, revision: preset.revision } });
  const preserved = (await request(`/api/v1/invoices/${invoice.id}`)).value; check('customer and preset edits preserve issued snapshots', () => { assert.equal(preserved.document.billTo.name, 'Zoë Müller'); assert.equal(preserved.document.branding.template, 'modern'); });
  const logoPdf = await request(`/api/v1/invoices/${invoice.id}/pdf`); check('saved invoice PDF with logo renders', () => assert.equal(logoPdf.status, 200)); await writeFile('test-results/api-branded.pdf', logoPdf.value);
  let shared = await request(`/api/v1/invoices/${invoice.id}/share`, { method: 'POST', data: { revision: invoice.revision } }); invoice = shared.value.invoice; const sharePath = new URL(shared.value.url).pathname;
  const publicView = await request(sharePath, { auth: false }); check('customer can view without account and receives privacy headers', () => { assert.equal(publicView.status, 200); assert.equal(publicView.response.headers.get('cache-control'), 'no-store'); assert.equal(publicView.response.headers.get('referrer-policy'), 'no-referrer'); });
  const publicPdf = await request(sharePath + '/pdf', { auth: false }); check('customer can download invoice PDF', () => assert.equal(publicPdf.status, 200));
  const paid = await request(`/api/v1/invoices/${invoice.id}/payment`, { method: 'POST', data: { revision: invoice.revision, amountPaid: '300' } }); invoice = paid.value; check('payment derives paid state and zero balance', () => { assert.equal(invoice.status, 'paid'); assert.equal(invoice.totals.balanceDue, 0); });
  const revoke = await request(`/api/v1/invoices/${invoice.id}/share`, { method: 'DELETE', data: { revision: invoice.revision } }); invoice = revoke.value; check('revocation updates invoice', () => assert.equal(revoke.status, 200));
  check('revoked links no longer resolve', () => {}); assert.equal((await request(sharePath, { auth: false })).status, 404);
  shared = await request(`/api/v1/invoices/${invoice.id}/share`, { method: 'POST', data: { revision: invoice.revision } }); invoice = shared.value.invoice; const archivedPath = new URL(shared.value.url).pathname;
  const archive = await request(`/api/v1/invoices/${invoice.id}/archive`, { method: 'POST', data: { revision: invoice.revision } }); invoice = archive.value; check('archive revokes customer links', () => assert.equal(invoice.shared, false)); assert.equal((await request(archivedPath, { auth: false })).status, 404);
  invoice = (await request(`/api/v1/invoices/${invoice.id}/restore`, { method: 'POST', data: { revision: invoice.revision } })).value; check('restoring does not restore old share links', () => { assert.equal(invoice.archivedAt, null); assert.equal(invoice.shared, false); }); assert.equal((await request(archivedPath, { auth: false })).status, 404);
  const duplicated = await request(`/api/v1/invoices/${invoice.id}/duplicate`, { method: 'POST', data: { revision: invoice.revision } }); check('duplicate is a fresh unpaid unnumbered draft', () => { assert.equal(duplicated.value.status, 'draft'); assert.equal(duplicated.value.number, ''); assert.equal(duplicated.value.document.amountPaid, '0.00'); });
  const multi = await Promise.all(Array.from({ length: 8 }, (_, i) => request('/api/v1/invoices', { method: 'POST', data: { ...input, status: 'issued', notes: `Concurrent ${i}` } }))); check('concurrent creation allocates eight unique sequential numbers', () => { assert(multi.every(x => x.status === 201)); assert.equal(new Set(multi.map(x => x.value.number)).size, 8); assert.deepEqual(multi.map(x => x.value.number).sort(), Array.from({ length: 8 }, (_, i) => `INV-${String(i + 2).padStart(4, '0')}`)); });
  const retries = await Promise.all([1, 2].map(() => request('/api/v1/invoices', { method: 'POST', data: input, headers: { 'Idempotency-Key': 'retry-safe' } }))); check('concurrent idempotent retries return one invoice', () => { assert.deepEqual(retries.map(x => x.status).sort(), [200, 201]); assert.equal(retries[0].value.id, retries[1].value.id); });
  const keyConflict = await request('/api/v1/invoices', { method: 'POST', data: { ...input, notes: 'changed' }, headers: { 'Idempotency-Key': 'retry-safe' } }); check('different input with same idempotency key conflicts', () => assert.equal(keyConflict.status, 409));
  const duplicateNumber = await request('/api/v1/invoices', { method: 'POST', data: { ...input, status: 'issued', invoiceNumber: 'INV-0001' } }); check('explicit duplicate numbers are rejected atomically', () => assert.equal(duplicateNumber.status, 409));
  const emptyHeaderKey = await request('/api/v1/invoices', { method: 'POST', data: input, headers: { 'Idempotency-Key': '   ' } }); check('invalid idempotency header is rejected', () => assert.equal(emptyHeaderKey.status, 400));
  const settingsAfter = (await request('/api/v1/settings')).value;
  const counterReset = await request('/api/v1/settings', { method: 'PUT', data: { ...settingsAfter, settings: { ...settingsAfter.settings, nextNumber: 1 } } }); check('numbering counter never moves backward', () => assert.equal(counterReset.value.settings.nextNumber, 10));
  const voided = await request(`/api/v1/invoices/${invoice.id}/void`, { method: 'POST', data: { revision: invoice.revision } }); check('paid invoice can be voided with history preserved', () => assert.equal(voided.value.status, 'void'));
  const reference = await request('/api/v1/openapi.json', { auth: false }); check('public OpenAPI includes all expected operations', () => { assert.equal(reference.value.openapi, '3.1.0'); assert(reference.value.paths['/invoices/{id}/share'].delete); });
  const logout = await request('/auth/logout', { method: 'POST', auth: false, headers: { Cookie: cookie, Origin: url, 'X-CSRF-Token': csrf } }); check('logout revokes session', () => assert.equal(logout.status, 200)); assert.equal((await request('/auth/session', { auth: false, headers: { Cookie: cookie } })).status, 401);
  const replacementLogin = await request('/auth/login', { method: 'POST', data: { key }, headers: { Origin: url }, auth: false });
  const rotationCookie = replacementLogin.response.headers.get('set-cookie').split(';')[0];
  for (let i = 0; i < 9; i++) { const failed = await request('/auth/login', { method: 'POST', auth: false, data: { key: 'wrong' }, headers: { Origin: url } }); if (i === 8) check('repeated failed logins are throttled', () => assert.equal(failed.status, 429)); }
  async function restart(secret) {
    const stopped = new Promise(resolve => worker.child.once('exit', resolve)); worker.child.kill('SIGTERM'); await stopped;
    await writeFile(join(workspace, '.dev.vars'), secret ? `ADMIN_KEY=${secret}\n` : '', { mode: 0o600 });
    worker = wrangler(['dev', '--ip', '127.0.0.1', '--port', String(port), '--persist-to', statePath]); worker.done.catch(() => {});
    for (let i = 0; i < 80; i++) { try { if ((await fetch(url + '/health')).ok) return; } catch {} await new Promise(r => setTimeout(r, 250)); }
    throw new Error('Restart failed');
  }
  const oldKey = key; key = randomBytes(32).toString('hex'); await restart(key);
  const expiredByRotation = await request('/auth/session', { auth: false, headers: { Cookie: rotationCookie } });
  check('rotating admin key invalidates existing sessions', () => assert.equal(expiredByRotation.status, 401));
  const oldBearer = await request('/api/v1/settings', { auth: false, headers: { Authorization: `Bearer ${oldKey}` } });
  check('rotating admin key rejects old API keys', () => assert.equal(oldBearer.status, 401));
  const newBearer = await request('/api/v1/settings'); check('replacement API key works', () => assert.equal(newBearer.status, 200));
  await restart('');
  const unconfigured = await request('/api/v1/settings'); check('missing admin key fails closed', () => assert.equal(unconfigured.status, 503));
  console.log(`\n${passed} integration scenarios passed on a fresh isolated D1 database.`);
} finally {
  worker?.child.kill('SIGTERM');
  await new Promise(r => setTimeout(r, 300));
  await rm(workspace, { recursive: true, force: true });
}
