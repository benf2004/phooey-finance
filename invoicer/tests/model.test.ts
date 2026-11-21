import { describe, expect, it } from 'vitest';
import { calculate, documentSchema, invoiceInputSchema, minorDigits, newDocument, rateMoney } from '../src/shared/model';
const document = () => newDocument();
describe('currency calculations', () => {
  it('rounds lines half-up before subtotal', () => { const d = document(); d.items = [{ description: 'A', quantity: '1', rate: '0.005' }, { description: 'B', quantity: '1', rate: '0.005' }]; expect(calculate(d).subtotal).toBe(2); });
  it('keeps fractional arithmetic exact', () => { const d = document(); d.items = [{ description: 'Hours', quantity: '2.5', rate: '120' }, { description: 'Fee', quantity: '3', rate: '0.1' }]; expect(calculate(d).total).toBe(30030); });
  it('displays fractional unit rates without hiding precision used by totals', () => { expect(rateMoney('0.005', 'USD')).toContain('0.005'); expect(rateMoney('1.234567', 'JPY')).toContain('1.234567'); expect(rateMoney('120', 'USD')).toContain('120.00'); });
  it('applies discount, tax, shipping, then payment', () => { const d = document(); d.items[0].rate = '100'; d.discount = { type: 'percent', value: '10' }; d.tax = { type: 'percent', value: '8.25' }; d.shipping = '5'; d.amountPaid = '20'; expect(calculate(d)).toMatchObject({ subtotal: 10000, discount: 1000, tax: 743, shipping: 500, total: 10243, amountPaid: 2000, balanceDue: 8243 }); });
  it('supports fixed adjustments', () => { const d = document(); d.items[0].rate = '100'; d.discount = { type: 'fixed', value: '12.34' }; d.tax = { type: 'fixed', value: '5.11' }; expect(calculate(d).total).toBe(9277); });
  it('uses zero and three digit currency minor units', () => { const d = document(); d.currency = 'JPY'; d.items[0].rate = '1.5'; expect(minorDigits('JPY')).toBe(0); expect(calculate(d).total).toBe(2); d.currency = 'KWD'; d.items[0].rate = '1.2345'; expect(calculate(d).total).toBe(1235); });
  it('rejects overpayment, oversized discount and invalid percentage', () => { const d = document(); d.items[0].rate = '10'; d.amountPaid = '11'; expect(() => calculate(d)).toThrow('Amount paid'); d.amountPaid = '0'; d.discount = { type: 'fixed', value: '11' }; expect(() => calculate(d)).toThrow('Discount'); d.discount = { type: 'percent', value: '101' }; expect(() => calculate(d)).toThrow('Percentage'); });
  it('rejects amounts outside the safe range', () => { const d = document(); d.items[0] = { description: 'Huge', quantity: '999999999999', rate: '999999999999' }; expect(() => calculate(d)).toThrow('range'); });
});
describe('input boundaries', () => {
  it('rejects exponent notation, negative quantities, impossible dates and unknown currency', () => { const d = document(); d.items[0].quantity = '-1'; expect(documentSchema.safeParse(d).success).toBe(false); d.items[0].quantity = '1e2'; expect(documentSchema.safeParse(d).success).toBe(false); d.items[0].quantity = '1'; d.date = '2026-02-30'; expect(documentSchema.safeParse(d).success).toBe(false); d.date = '2026-02-28'; d.currency = 'ZZZ'; expect(documentSchema.safeParse(d).success).toBe(false); });
  it('allows minimal API input and partial overrides', () => { expect(invoiceInputSchema.parse({ items: [{ description: 'Consulting', quantity: '1', rate: '20' }], branding: { labels: { title: 'FACTURE' }, accentColor: '#aabbcc' } }).status).toBe('draft'); });
});
