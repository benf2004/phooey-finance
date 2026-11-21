import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { PDFDocument } from 'pdf-lib';
import { describe, it, expect } from 'vitest';
import { newDocument } from '../src/shared/model';
import { renderPdf } from '../src/shared/pdf';
const font = async (name: string) => new Uint8Array(await readFile(join('public/fonts', name)));
const logo = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5ZkAAAAASUVORK5CYII=', 'base64'));
describe('PDF renderer', () => {
  for (const template of ['classic', 'modern'] as const) for (const face of ['sans', 'serif', 'mono'] as const) for (const paper of ['letter', 'a4'] as const) {
    it(`${template} / ${face} / ${paper}: wraps and paginates Latin text`, async () => {
      const d = newDocument(); d.business = { name: 'Atelier René', address: '123 Market Street\nDenver, CO 80202', email: 'hello@example.com', phone: '', taxId: 'US-1234' }; d.billTo = { ...d.business, name: 'Zoë Müller — Studio' }; d.invoiceNumber = 'INV-0100'; d.branding = { ...d.branding, template, font: face, paper, showShipping: true }; d.shipTo = { ...d.billTo, name: 'Delivery desk' };
      d.branding.labels = { billTo: 'Facturé à', notes: 'Remarques', title: 'FACTURE' };
      d.items = Array.from({ length: 36 }, (_, i) => ({ description: `${i + 1}. Création graphique — Strategy, research and design. ` + (i === 10 ? 'Averylongunbrokenword'.repeat(35) : 'A thoughtful description that wraps across several lines. '.repeat(2)), quantity: '2.5', rate: '120' }));
      d.notes = 'Thank you, René. Żółć, č, ñ, á, ß, œ.\n' + 'Long notes continue safely onto the next page. '.repeat(100); d.terms = 'Please send a bank transfer within thirty days. '.repeat(80);
      const started = performance.now(); const cpu = process.cpuUsage();
      const bytes = await renderPdf(d, { font, logo, state: 'paid' });
      const elapsed = performance.now() - started; const used = process.cpuUsage(cpu); const parsed = await PDFDocument.load(bytes);
      expect(parsed.getPageCount()).toBeGreaterThan(2); expect(parsed.getPages()[0].getWidth()).toBeCloseTo(paper === 'a4' ? 595.28 : 612, 1); expect(parsed.getTitle()).toBe('FACTURE INV-0100');
      await mkdir('test-results/pdfs', { recursive: true }); await writeFile(`test-results/pdfs/${template}-${face}-${paper}.pdf`, bytes);
      console.log(`${template}-${face}-${paper}: ${parsed.getPageCount()} pages, ${Math.round(elapsed)}ms wall, ${Math.round((used.user + used.system) / 1000)}ms local process CPU`);
    }, 20000);
  }
  it('rejects unsupported glyphs explicitly', async () => { const d = newDocument(); d.notes = '😀'; await expect(renderPdf(d, { font })).rejects.toThrow('Unsupported PDF character'); });
  it('browser and Worker resource providers produce equivalent pages', async () => {
    const d = newDocument(); d.items[0].rate = '120';
    const a = await renderPdf(d, { font }); const b = await renderPdf(d, { font: async name => Uint8Array.from(await font(name)) });
    const p1 = await PDFDocument.load(a); const p2 = await PDFDocument.load(b);
    expect(p1.getPageCount()).toBe(p2.getPageCount()); expect(p1.getPages()[0].getSize()).toEqual(p2.getPages()[0].getSize()); expect(p1.getTitle()).toBe(p2.getTitle());
  });
});
