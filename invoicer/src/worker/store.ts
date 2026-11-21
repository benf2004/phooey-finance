import { z } from 'zod';
import { PDFDocument } from 'pdf-lib';
import { AppError, brandingSchema, calculate, defaultSettings, documentSchema, fromMinor, invoiceInputSchema, partySchema, settingsSchema, type Branding, type Invoice, type SettingsRecord, type Totals } from '../shared/model';
import { canonical, sha } from './http';

export interface InvoiceRow { id: string; state: 'draft' | 'issued' | 'void'; number: string | null; document: string; totals: string; amount_paid: number; revision: number; archived_at: string | null; created_at: string; updated_at: string; shared: number }
const invoiceSelect = 'SELECT invoices.*, EXISTS(SELECT 1 FROM shares WHERE invoice_id = invoices.id) AS shared FROM invoices';
export function present(row: InvoiceRow): Invoice {
  const document = documentSchema.parse(JSON.parse(row.document));
  const totals: Totals = JSON.parse(row.totals);
  document.invoiceNumber = row.number || document.invoiceNumber;
  document.amountPaid = fromMinor(row.amount_paid, document.currency);
  totals.amountPaid = row.amount_paid; totals.balanceDue = totals.total - row.amount_paid;
  const status = row.state === 'issued' && totals.balanceDue === 0 ? 'paid' : row.state;
  return { id: row.id, status, number: document.invoiceNumber, document, totals, revision: row.revision, archivedAt: row.archived_at, createdAt: row.created_at, updatedAt: row.updated_at, shared: !!row.shared, overdue: status === 'issued' && !!document.dueDate && document.dueDate < new Date().toISOString().slice(0, 10) };
}
export async function getInvoice(db: D1Database, id: string) {
  const row = await db.prepare(`${invoiceSelect} WHERE invoices.id = ?`).bind(id).first<InvoiceRow>();
  if (!row) throw new AppError(404, 'not_found', 'Invoice not found');
  return present(row);
}
export async function getSettings(db: D1Database): Promise<SettingsRecord> {
  const row = await db.prepare('SELECT document, revision, prefix, next_number FROM settings JOIN counters ON settings.id = counters.id WHERE settings.id = 1').first<{ document: string; revision: number; prefix: string; next_number: number }>();
  if (!row) throw new AppError(503, 'database_setup', 'Apply the D1 migrations before using the application');
  return { settings: { ...settingsSchema.parse(JSON.parse(row.document)), numberPrefix: row.prefix, nextNumber: row.next_number }, revision: row.revision };
}
export async function validateBranding(db: D1Database, branding: Branding) {
  if (branding.logoAssetId && branding.logoData) throw new AppError(422, 'invalid_logo', 'Choose a saved logo asset or inline logo, not both');
  if (branding.logoAssetId) {
    if (!await db.prepare('SELECT id FROM assets WHERE id = ?').bind(branding.logoAssetId).first()) throw new AppError(422, 'invalid_asset', 'Logo asset not found');
  }
  if (branding.logoData) {
    if (!/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/.test(branding.logoData)) throw new AppError(422, 'invalid_logo', 'Use a PNG or JPEG base64 data URL');
    const bytes = Uint8Array.from(atob(branding.logoData.split(',')[1]), c => c.charCodeAt(0));
    await validateImage(bytes);
  }
}
export async function resolveDocument(db: D1Database, value: unknown) {
  const input = invoiceInputSchema.parse(value);
  const { settings } = await getSettings(db);
  let preset: Branding | undefined;
  const presetId = input.presetId ?? settings.defaultPresetId;
  if (presetId) {
    const row = await db.prepare('SELECT document FROM presets WHERE id = ?').bind(presetId).first<{ document: string }>();
    if (!row) throw new AppError(422, 'invalid_preset', 'Branding preset not found');
    preset = brandingSchema.parse(JSON.parse(row.document));
  }
  let customer = {};
  if (input.customerId) {
    const row = await db.prepare('SELECT document FROM customers WHERE id = ? AND archived = 0').bind(input.customerId).first<{ document: string }>();
    if (!row) throw new AppError(422, 'invalid_customer', 'Customer not found');
    customer = partySchema.parse(JSON.parse(row.document));
  }
  const branding = brandingSchema.parse({ ...settings.branding, ...preset, ...input.branding, labels: { ...settings.branding.labels, ...preset?.labels, ...input.branding?.labels } });
  // An explicit inline logo supersedes a saved asset; both representations are never retained.
  if (input.branding?.logoData) branding.logoAssetId = null;
  if (input.branding?.logoAssetId) branding.logoData = null;
  await validateBranding(db, branding);
  const document = documentSchema.parse({ ...input, date: input.date || new Date().toISOString().slice(0, 10), currency: input.currency || settings.currency, locale: input.locale || settings.locale, business: { ...settings.business, ...input.business }, billTo: { ...customer, ...input.billTo }, branding });
  let totals: Totals;
  try { totals = calculate(document); } catch (e) { throw new AppError(422, 'invalid_amount', (e as Error).message); }
  return { document, totals, status: input.status };
}
export async function createInvoice(db: D1Database, value: unknown, key?: string) {
  if (key !== undefined && (key.length < 1 || key.length > 200 || !/^[\x21-\x7e]+$/.test(key))) throw new AppError(400, 'invalid_idempotency_key', 'Idempotency-Key must contain 1–200 printable ASCII characters');
  const hash = await sha(canonical(value));
  async function replay() {
    if (!key) return null;
    const row = await db.prepare('SELECT request_hash, invoice_id FROM idempotency WHERE key = ?').bind(key).first<{ request_hash: string; invoice_id: string }>();
    if (!row) return null;
    if (row.request_hash !== hash) throw new AppError(409, 'idempotency_conflict', 'This Idempotency-Key was used with different input');
    return { invoice: await getInvoice(db, row.invoice_id), replayed: true };
  }
  const prior = await replay(); if (prior) return prior;
  const { document, totals, status } = await resolveDocument(db, value);
  if (status === 'issued' && (!document.business.name || !document.billTo.name)) throw new AppError(422, 'missing_party', 'Business and customer names are required to issue an invoice');
  const id = crypto.randomUUID();
  const statements = [db.prepare('INSERT INTO invoices (id, document, totals, amount_paid) VALUES (?, ?, ?, ?)').bind(id, JSON.stringify(document), JSON.stringify(totals), totals.amountPaid)];
  if (status === 'issued') statements.push(db.prepare("UPDATE invoices SET state = 'issued' WHERE id = ?").bind(id));
  if (key) statements.push(db.prepare('INSERT INTO idempotency (key, request_hash, invoice_id, created_at) VALUES (?, ?, ?, ?)').bind(key, hash, id, Date.now()));
  try { await db.batch(statements); }
  catch (e) { const retry = await replay(); if (retry) return retry; if (String(e).includes('UNIQUE')) throw new AppError(409, 'number_conflict', 'Invoice number already exists; choose another number or update the numbering counter'); throw e; }
  return { invoice: await getInvoice(db, id), replayed: false };
}
export async function updateDraft(db: D1Database, id: string, value: unknown) {
  const revision = z.object({ revision: z.number().int().positive() }).parse(value).revision;
  const current = await getInvoice(db, id);
  if (current.status !== 'draft' || current.archivedAt) throw new AppError(409, 'frozen_invoice', 'Only active drafts can be edited; duplicate an issued invoice to make corrections');
  const { document, totals } = await resolveDocument(db, value);
  const result = await db.prepare("UPDATE invoices SET document = ?, totals = ?, amount_paid = ?, revision = revision + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ? AND revision = ? AND state = 'draft' AND archived_at IS NULL").bind(JSON.stringify(document), JSON.stringify(totals), totals.amountPaid, id, revision).run();
  checkChange(result); return getInvoice(db, id);
}
export function checkChange(result: D1Result) { if (result.meta.changes === 0) throw new AppError(409, 'revision_conflict', 'This record changed. Reload it before trying again.'); }
export const revisionSchema = z.object({ revision: z.number().int().positive() });
export async function validateImage(bytes: Uint8Array): Promise<'image/png' | 'image/jpeg'> {
  if (!bytes.length || bytes.length > 262144) throw new AppError(413, 'logo_size', 'Logos must be 256 KiB or smaller');
  let mime: 'image/png' | 'image/jpeg'; let width = 0, height = 0;
  if (bytes.length >= 24 && bytes.slice(0, 8).every((v, i) => v === [137, 80, 78, 71, 13, 10, 26, 10][i])) {
    mime = 'image/png'; const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); width = data.getUint32(16); height = data.getUint32(20);
  } else if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    mime = 'image/jpeg'; let offset = 2;
    while (offset + 8 < bytes.length) {
      if (bytes[offset] !== 0xff) break;
      const marker = bytes[offset + 1]; const length = (bytes[offset + 2] << 8) | bytes[offset + 3];
      if ([0xc0, 0xc1, 0xc2].includes(marker)) { height = (bytes[offset + 5] << 8) | bytes[offset + 6]; width = (bytes[offset + 7] << 8) | bytes[offset + 8]; break; }
      if (length < 2) break; offset += 2 + length;
    }
  } else throw new AppError(422, 'logo_format', 'Only PNG and JPEG logos are accepted');
  if (!width || !height || width > 2048 || height > 2048) throw new AppError(422, 'logo_dimensions', 'Logo dimensions must be at most 2048 × 2048 pixels');
  try { const pdf = await PDFDocument.create(); if (mime === 'image/png') await pdf.embedPng(bytes); else await pdf.embedJpg(bytes); }
  catch { throw new AppError(422, 'invalid_logo', 'The logo image is damaged or invalid'); }
  return mime;
}
export { invoiceSelect, defaultSettings };
