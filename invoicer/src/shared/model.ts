import { z } from 'zod';
import Decimal from 'decimal.js';

export const currencies = Intl.supportedValuesOf('currency');
export const decimal = z.string().regex(/^\d{1,12}(\.\d{1,6})?$/, 'Use a non-negative decimal string (up to 6 decimal places)');
const text = (max = 2000) => z.string().max(max);
export const partySchema = z.object({ name: text(200).trim().default(''), address: text().default(''), email: z.union([z.literal(''), z.email()]).default(''), phone: text(100).default(''), taxId: text(200).default('') });
export type Party = z.infer<typeof partySchema>;
export const emptyParty: Party = { name: '', address: '', email: '', phone: '', taxId: '' };
export const labelDefaults = {
  title: 'INVOICE', from: 'From', billTo: 'Bill to', shipTo: 'Ship to', invoiceNumber: 'Invoice number', date: 'Date', dueDate: 'Due date', paymentTerms: 'Payment terms', poNumber: 'PO number', item: 'Description', quantity: 'Qty', rate: 'Rate', amount: 'Amount', subtotal: 'Subtotal', discount: 'Discount', tax: 'Tax', shipping: 'Shipping', total: 'Total', amountPaid: 'Amount paid', balanceDue: 'Balance due', notes: 'Notes', terms: 'Terms',
};
export type LabelKey = keyof typeof labelDefaults;
const labelShape = Object.fromEntries(Object.keys(labelDefaults).map(k => [k, text(64).min(1).optional()])) as Record<LabelKey, z.ZodOptional<z.ZodString>>;
export const brandingSchema = z.object({
  template: z.enum(['classic', 'modern']).default('classic'),
  accentColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#174b3d'),
  font: z.enum(['sans', 'serif', 'mono']).default('sans'),
  paper: z.enum(['letter', 'a4']).default('letter'),
  logoAssetId: z.string().max(100).nullable().default(null),
  logoData: z.string().max(350000).nullable().default(null),
  labels: z.object(labelShape).default({}),
  showShipping: z.boolean().default(false),
  showNotes: z.boolean().default(true),
  showTerms: z.boolean().default(true),
});
export type Branding = z.infer<typeof brandingSchema>;
export const defaultBranding = brandingSchema.parse({});
export const adjustmentSchema = z.object({ type: z.enum(['percent', 'fixed']).default('percent'), value: decimal.default('0') });
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(d => { const t = new Date(`${d}T00:00:00Z`); return !isNaN(t.valueOf()) && t.toISOString().slice(0, 10) === d; }, 'Invalid date');
export const currencySchema = z.string().refine(c => currencies.includes(c), 'Unsupported currency');
export const itemSchema = z.object({ description: text(8000).min(1), quantity: decimal.refine(q => new Decimal(q).greaterThan(0), 'Quantity must be positive'), rate: decimal });
const documentShape = {
  business: partySchema,
  billTo: partySchema,
  shipTo: partySchema.optional(),
  invoiceNumber: text(100).default(''),
  date: dateSchema,
  dueDate: z.union([dateSchema, z.literal('')]).default(''),
  paymentTerms: text(200).default(''),
  poNumber: text(200).default(''),
  currency: currencySchema.default('USD'),
  locale: z.enum(['en-US', 'en-GB', 'en-CA', 'en-AU', 'de-DE', 'fr-FR', 'es-ES', 'it-IT', 'pt-PT']).default('en-US'),
  items: z.array(itemSchema).min(1).max(200),
  tax: adjustmentSchema.default({ type: 'percent', value: '0' }),
  discount: adjustmentSchema.default({ type: 'percent', value: '0' }),
  shipping: decimal.default('0'),
  amountPaid: decimal.default('0'),
  notes: text(20000).default(''),
  terms: text(20000).default(''),
  customFields: z.array(z.object({ label: text(64).min(1), value: text(2000) })).max(20).default([]),
  branding: brandingSchema,
};
export const documentSchema = z.object(documentShape);
export type InvoiceDocument = z.infer<typeof documentSchema>;
export const invoiceInputSchema = z.object({
  ...documentShape,
  business: partySchema.partial().optional(),
  billTo: partySchema.partial().optional(),
  date: dateSchema.optional(),
  currency: currencySchema.optional(),
  locale: documentShape.locale.optional(),
  branding: brandingSchema.partial().extend({ labels: z.object(labelShape).optional() }).optional(),
  customerId: z.string().max(100).optional(),
  presetId: z.string().max(100).optional(),
  status: z.enum(['draft', 'issued']).default('draft'),
});
export type InvoiceInput = z.input<typeof invoiceInputSchema>;
export const settingsSchema = z.object({
  business: partySchema.default(emptyParty),
  currency: currencySchema.default('USD'),
  locale: documentShape.locale.default('en-US'),
  branding: brandingSchema.default(defaultBranding),
  defaultPresetId: z.string().max(100).nullable().default(null),
  numberPrefix: z.string().max(30).regex(/^[\p{L}\p{N}\-_/]*$/u).default('INV-'),
  nextNumber: z.number().int().min(1).max(999999999).default(1),
});
export type Settings = z.infer<typeof settingsSchema>;
export const defaultSettings = settingsSchema.parse({});
export interface Totals { lines: number[]; subtotal: number; discount: number; tax: number; shipping: number; total: number; amountPaid: number; balanceDue: number }
export function minorDigits(currency: string) { return new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits!; }
export function toMinor(value: string | Decimal, currency: string) {
  const n = new Decimal(value).mul(new Decimal(10).pow(minorDigits(currency))).toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
  if (!n.isFinite() || n.isNegative() || n.greaterThan(1e14)) throw new Error('Amount exceeds the supported range');
  return n.toNumber();
}
export function fromMinor(value: number, currency: string) { return new Decimal(value).div(new Decimal(10).pow(minorDigits(currency))).toFixed(minorDigits(currency)); }
export function money(value: number, currency: string, locale = 'en-US') {
  return new Intl.NumberFormat(locale, { style: 'currency', currency, currencyDisplay: 'code' }).format(new Decimal(value).div(new Decimal(10).pow(minorDigits(currency))).toNumber());
}
// Unit rates retain their input precision; only calculated line amounts round to minor units.
export function rateMoney(value: string, currency: string, locale = 'en-US') {
  return new Intl.NumberFormat(locale, { style: 'currency', currency, currencyDisplay: 'code', maximumFractionDigits: Math.max(minorDigits(currency), new Decimal(value).decimalPlaces()) }).format(new Decimal(value).toNumber());
}
export function calculate(doc: InvoiceDocument): Totals {
  const lines = doc.items.map(item => toMinor(new Decimal(item.quantity).mul(item.rate), doc.currency));
  const subtotal = lines.reduce((a, b) => a + b, 0);
  if (!Number.isSafeInteger(subtotal) || subtotal > 1e14) throw new Error('Invoice total exceeds the supported range');
  const adjustment = (a: InvoiceDocument['tax'], base: number) => {
    if (a.type === 'fixed') return toMinor(a.value, doc.currency);
    if (new Decimal(a.value).greaterThan(100)) throw new Error('Percentage must be between 0 and 100');
    return new Decimal(base).mul(a.value).div(100).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toNumber();
  };
  const discount = adjustment(doc.discount, subtotal);
  if (discount > subtotal) throw new Error('Discount cannot exceed subtotal');
  const tax = adjustment(doc.tax, subtotal - discount);
  const shipping = toMinor(doc.shipping, doc.currency);
  const total = subtotal - discount + tax + shipping;
  if (!Number.isSafeInteger(total) || total > 1e14) throw new Error('Invoice total exceeds the supported range');
  const amountPaid = toMinor(doc.amountPaid, doc.currency);
  if (amountPaid > total) throw new Error('Amount paid cannot exceed total');
  return { lines, subtotal, discount, tax, shipping, total, amountPaid, balanceDue: total - amountPaid };
}
export function newDocument(settings: Settings = defaultSettings): InvoiceDocument {
  return documentSchema.parse({ business: settings.business, billTo: emptyParty, date: new Date().toISOString().slice(0, 10), currency: settings.currency, locale: settings.locale, items: [{ description: 'Professional services', quantity: '1', rate: '0' }], branding: settings.branding });
}
export type InvoiceState = 'draft' | 'issued' | 'paid' | 'void';
export interface Invoice { id: string; status: InvoiceState; number: string; document: InvoiceDocument; totals: Totals; revision: number; archivedAt: string | null; createdAt: string; updatedAt: string; shared: boolean; overdue: boolean }
export interface Customer { id: string; party: Party; revision: number }
export interface Preset { id: string; name: string; branding: Branding; revision: number }
export interface SettingsRecord { settings: Settings; revision: number }
export class AppError extends Error { constructor(public status: number, public code: string, message: string, public details?: unknown) { super(message); } }
