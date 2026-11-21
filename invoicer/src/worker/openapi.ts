import { z } from 'zod';
import { brandingSchema, documentSchema, invoiceInputSchema, partySchema, settingsSchema } from '../shared/model';
const schema = (s: z.ZodType) => z.toJSONSchema(s, { target: 'draft-2020-12', io: 'input' });
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const json = (s: object) => ({ 'application/json': { schema: s } });
const revision = { type: 'object', required: ['revision'], properties: { revision: { type: 'integer', minimum: 1 } } };
const error = { description: 'Structured error', content: json(ref('Error')) };
const itemResponse = { description: 'Invoice with document snapshot, calculated totals, state and revision', content: json(ref('Invoice')) };
function operation(summary: string, body?: object, response: object = itemResponse, code = '200') {
  return { summary, security: [{ adminKey: [] }], ...(body ? { requestBody: { required: true, content: json(body) } } : {}), responses: { [code]: response, '401': error, '403': error, '404': error, '409': error, '422': error, '413': error, '503': error } };
}
const id = { name: 'id', in: 'path', required: true, schema: { type: 'string' } };
const paging = [{ name: 'page', in: 'query', schema: { type: 'integer', minimum: 1, default: 1 } }, { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 25 } }];
const list = (name: string) => ({ description: 'Paginated list', content: json({ type: 'object', required: ['items', 'total', 'page', 'limit'], properties: { items: { type: 'array', items: ref(name) }, total: { type: 'integer' }, page: { type: 'integer' }, limit: { type: 'integer' } } }) });
const pdf = { description: 'Generated PDF', headers: { 'X-PDF-Render-Ms': { schema: { type: 'string' }, description: 'Render duration; not a production CPU measurement' } }, content: { 'application/pdf': { schema: { type: 'string', format: 'binary' } } } };
const paths: Record<string, object> = {
  '/render': { post: operation('Render without persistence or automatic numbering', ref('InvoiceInput'), pdf) },
  '/invoices': {
    get: { ...operation('List invoices', undefined, list('Invoice')), parameters: [...paging, { name: 'q', in: 'query', schema: { type: 'string', maxLength: 100 } }, { name: 'status', in: 'query', schema: { type: 'string', enum: ['all', 'draft', 'issued', 'paid', 'void', 'overdue'] } }, { name: 'archived', in: 'query', schema: { type: 'boolean', default: false } }] },
    post: { ...operation('Create draft or issue immediately', ref('InvoiceInput'), itemResponse, '201'), parameters: [{ name: 'Idempotency-Key', in: 'header', schema: { type: 'string', maxLength: 200 }, description: 'Retries with identical input replay the existing invoice (200). Different input returns 409. Keys are retained until manually removed.' }] },
  },
  '/invoices/{id}': { parameters: [id], get: operation('Read an invoice'), put: operation('Replace a draft with revision check', { allOf: [ref('InvoiceInput'), ref('Revision')] }) },
  '/invoices/{id}/pdf': { parameters: [id], get: operation('Download invoice PDF', undefined, pdf) },
  '/invoices/{id}/payment': { parameters: [id], post: operation('Set the cumulative amount paid', { allOf: [ref('Revision'), { type: 'object', required: ['amountPaid'], properties: { amountPaid: { type: 'string', pattern: '^\\d{1,12}(\\.\\d{1,6})?$' } } }] }) },
  '/invoices/{id}/share': { parameters: [id], post: operation('Generate or rotate a share link (issued invoices only)', ref('Revision'), { description: 'New link and updated invoice', content: json({ type: 'object', properties: { url: { type: 'string', format: 'uri' }, invoice: ref('Invoice') } }) }), delete: operation('Revoke a share link', ref('Revision')) },
  '/settings': { get: operation('Read business defaults and numbering', undefined, { description: 'Settings and revision', content: json(ref('SettingsRecord')) }), put: operation('Replace settings; counter never moves backward', ref('SettingsRecord'), { description: 'Updated settings and revision', content: json(ref('SettingsRecord')) }) },
  '/customers': { get: { ...operation('List active customers', undefined, list('Customer')), parameters: paging }, post: operation('Create a customer', { type: 'object', required: ['party'], properties: { party: ref('Party') } }, { description: 'Created customer', content: json(ref('Customer')) }, '201') },
  '/customers/{id}': { parameters: [id], put: operation('Update customer', { type: 'object', required: ['party', 'revision'], properties: { party: ref('Party'), revision: { type: 'integer', minimum: 1 } } }, { description: 'Updated customer', content: json(ref('Customer')) }), delete: operation('Archive customer; existing invoices retain snapshots', ref('Revision'), { description: 'Archived', content: json({ type: 'object', properties: { ok: { type: 'boolean' } } }) }) },
  '/presets': { get: { ...operation('List branding presets', undefined, list('Preset')), parameters: paging }, post: operation('Create branding preset', { type: 'object', required: ['name', 'branding'], properties: { name: { type: 'string', minLength: 1, maxLength: 100 }, branding: ref('Branding') } }, { description: 'Created preset', content: json(ref('Preset')) }, '201') },
  '/presets/{id}': { parameters: [id], put: operation('Update preset', ref('PresetInput'), { description: 'Updated preset', content: json(ref('Preset')) }), delete: operation('Delete preset and clear it as default; snapshots remain', ref('Revision'), { description: 'Deleted', content: json({ type: 'object', properties: { ok: { type: 'boolean' } } }) }) },
  '/assets': { post: { ...operation('Upload PNG/JPEG logo', undefined, { description: 'Immutable asset', content: json({ type: 'object', properties: { id: { type: 'string' }, mime: { type: 'string' }, size: { type: 'integer' } } }) }, '201'), requestBody: { required: true, content: { 'image/png': { schema: { type: 'string', format: 'binary' } }, 'image/jpeg': { schema: { type: 'string', format: 'binary' } } } } } },
  '/assets/{id}': { parameters: [id], get: operation('Read protected logo asset', undefined, { description: 'Logo', content: { 'image/png': { schema: { type: 'string', format: 'binary' } }, 'image/jpeg': { schema: { type: 'string', format: 'binary' } } } }) },
};
for (const action of ['issue', 'duplicate', 'void', 'archive', 'restore']) paths[`/invoices/{id}/${action}`] = { parameters: [id], post: operation(`${action[0].toUpperCase()}${action.slice(1)} invoice`, ref('Revision'), itemResponse, action === 'duplicate' ? '201' : '200') };
export const openapi = {
  openapi: '3.1.0', info: { title: 'Invoicer', version: '0.1.0', description: 'Self-hosted single-business invoicing. Decimal monetary inputs; integer minor-unit totals. Stateless rendering does not write to D1. Latin-script text supported.' }, servers: [{ url: '/api/v1' }], paths,
  components: {
    securitySchemes: { adminKey: { type: 'http', scheme: 'bearer', description: 'The ADMIN_KEY Worker secret. Dashboard cookies are an alternative with same-origin CSRF protection.' } },
    schemas: {
      InvoiceInput: schema(invoiceInputSchema), InvoiceDocument: schema(documentSchema), Branding: schema(brandingSchema), Party: schema(partySchema), Revision: revision,
      SettingsRecord: { type: 'object', required: ['settings', 'revision'], properties: { settings: schema(settingsSchema), revision: { type: 'integer', minimum: 1 } } },
      Error: { type: 'object', required: ['error'], properties: { error: { type: 'object', required: ['code', 'message'], properties: { code: { type: 'string' }, message: { type: 'string' }, details: {} } } } },
      Totals: { type: 'object', description: 'Amounts in currency minor units', required: ['lines', 'subtotal', 'discount', 'tax', 'shipping', 'total', 'amountPaid', 'balanceDue'], properties: Object.fromEntries(['lines', 'subtotal', 'discount', 'tax', 'shipping', 'total', 'amountPaid', 'balanceDue'].map(k => [k, k === 'lines' ? { type: 'array', items: { type: 'integer' } } : { type: 'integer' }])) },
      Invoice: { type: 'object', properties: { id: { type: 'string' }, status: { type: 'string', enum: ['draft', 'issued', 'paid', 'void'] }, number: { type: 'string' }, document: ref('InvoiceDocument'), totals: ref('Totals'), revision: { type: 'integer' }, archivedAt: { type: ['string', 'null'] }, createdAt: { type: 'string' }, updatedAt: { type: 'string' }, shared: { type: 'boolean' }, overdue: { type: 'boolean' } } },
      Customer: { type: 'object', properties: { id: { type: 'string' }, party: ref('Party'), revision: { type: 'integer' } } },
      PresetInput: { type: 'object', required: ['name', 'branding', 'revision'], properties: { name: { type: 'string', minLength: 1, maxLength: 100 }, branding: ref('Branding'), revision: { type: 'integer', minimum: 1 } } },
      Preset: { allOf: [ref('PresetInput'), { type: 'object', properties: { id: { type: 'string' } } }] },
    },
  },
};
