import { PDFDocument, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { calculate, labelDefaults, money, rateMoney, type InvoiceDocument, type InvoiceState } from './model';

export interface PdfResources {
  font: (name: string) => Promise<Uint8Array>;
  logo?: Uint8Array;
  state?: InvoiceState;
}
export async function renderPdf(doc: InvoiceDocument, resources: PdfResources): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  pdf.setTitle(`${doc.branding.labels.title || 'Invoice'} ${doc.invoiceNumber}`.trim());
  pdf.setAuthor(doc.business.name);
  // Fixed metadata makes the browser and Worker use the same document representation.
  const timestamp = new Date(`${doc.date}T00:00:00Z`);
  pdf.setCreationDate(timestamp); pdf.setModificationDate(timestamp);
  const family = { sans: 'NotoSans', serif: 'NotoSerif', mono: 'NotoSansMono' }[doc.branding.font];
  const [regularBytes, boldBytes] = await Promise.all([resources.font(`${family}-Regular.ttf`), resources.font(`${family}-Bold.ttf`)]);
  const regular = await pdf.embedFont(regularBytes, { subset: true });
  const bold = await pdf.embedFont(boldBytes, { subset: true });
  const supported = new Set(regular.getCharacterSet());
  function safe(value: string) {
    const s = value.replace(/\t/g, '    ').replace(/\r/g, '');
    for (const char of s) if (char !== '\n' && !supported.has(char.codePointAt(0)!)) throw new Error(`Unsupported PDF character: ${char}. Use Latin-script text.`);
    return s;
  }
  const labels = { ...labelDefaults, ...doc.branding.labels };
  const totals = calculate(doc);
  const format = (amount: number) => money(amount, doc.currency, doc.locale).replace(/\u202f|\u00a0/g, ' ');
  const width = doc.branding.paper === 'a4' ? 595.28 : 612;
  const height = doc.branding.paper === 'a4' ? 841.89 : 792;
  const margin = 44; const bottom = 52; const inner = width - margin * 2;
  const hex = doc.branding.accentColor.slice(1);
  const accent = rgb(parseInt(hex.slice(0, 2), 16) / 255, parseInt(hex.slice(2, 4), 16) / 255, parseInt(hex.slice(4, 6), 16) / 255);
  const ink = rgb(.13, .16, .22); const muted = rgb(.42, .46, .52); const line = rgb(.87, .89, .92);
  let page!: PDFPage; let y = height - margin; let inTable = false;
  function text(s: string, x: number, at: number, size = 10, font: PDFFont = regular, color = ink) { page.drawText(safe(s), { x, y: at, size, font, color }); }
  function right(s: string, x: number, at: number, size = 10, font = regular) { text(s, x - font.widthOfTextAtSize(safe(s), size), at, size, font); }
  function wrapped(s: string, max: number, size = 10, font = regular): string[] {
    const result: string[] = [];
    for (const paragraph of safe(s).split('\n')) {
      if (!paragraph) { result.push(''); continue; }
      let current = '';
      for (const word of paragraph.split(/ +/)) {
        const candidate = current ? `${current} ${word}` : word;
        if (font.widthOfTextAtSize(candidate, size) <= max) { current = candidate; continue; }
        if (current) result.push(current);
        current = '';
        for (const char of word) {
          if (font.widthOfTextAtSize(current + char, size) > max && current) { result.push(current); current = ''; }
          current += char;
        }
      }
      result.push(current);
    }
    return result;
  }
  const descriptionWidth = inner * .49;
  const qtyX = margin + inner * .65;
  const rateX = margin + inner * .82;
  const amountX = width - margin - 8;
  function tableHeader() {
    const headers = [wrapped(labels.item, descriptionWidth - 16, 9, bold), wrapped(labels.quantity, inner * .14 - 8, 9, bold), wrapped(labels.rate, inner * .16 - 8, 9, bold), wrapped(labels.amount, inner * .17 - 8, 9, bold)];
    const h = Math.max(...headers.map(x => x.length)) * 12 + 16;
    page.drawRectangle({ x: margin, y: y - h + 8, width: inner, height: h, color: doc.branding.template === 'modern' ? accent : rgb(.95, .96, .98) });
    const color = doc.branding.template === 'modern' ? rgb(1, 1, 1) : ink;
    headers.forEach((hs, i) => hs.forEach((s, j) => {
      const x = [margin + 8, qtyX, rateX, amountX][i];
      text(s, i === 0 ? x : x - bold.widthOfTextAtSize(s, 9), y - 6 - j * 12, 9, bold, color);
    }));
    y -= h + 10;
  }
  function newPage(first = false) {
    page = pdf.addPage([width, height]); y = height - margin;
    if (!first) {
      text(wrapped(doc.business.name, inner * .6, 9, bold)[0] || '', margin, y, 9, bold, muted);
      right(doc.invoiceNumber, width - margin, y, 9);
      y -= 14; page.drawLine({ start: { x: margin, y }, end: { x: width - margin, y }, color: line, thickness: .7 }); y -= 25;
      if (inTable) tableHeader();
    }
  }
  function ensure(space: number) { if (y - space < bottom) newPage(); }
  function block(s: string, size = 10, font = regular, color = ink, x = margin, max = inner) {
    for (const row of wrapped(s, max, size, font)) { ensure(size + 6); text(row, x, y, size, font, color); y -= size + 5; }
  }
  function columns(left: string[], rightLines: string[]) {
    const leftRows = left.flatMap(s => wrapped(s, inner * .51, 10));
    const rightRows = rightLines.flatMap(s => wrapped(s, inner * .41, 10));
    for (let i = 0; i < Math.max(leftRows.length, rightRows.length); i++) {
      ensure(16); if (leftRows[i]) text(leftRows[i], margin, y); if (rightRows[i]) text(rightRows[i], margin + inner * .59, y); y -= 15;
    }
  }
  const party = (p: InvoiceDocument['business']) => [p.name, p.address, p.email, p.phone, p.taxId].filter(Boolean);
  newPage(true);
  if (doc.branding.template === 'modern') page.drawRectangle({ x: 0, y: height - 7, width, height: 7, color: accent });
  const inlineLogo = doc.branding.logoData;
  let logo = resources.logo;
  if (inlineLogo) logo = Uint8Array.from(atob(inlineLogo.split(',')[1]), c => c.charCodeAt(0));
  const titleSize = 25;
  const titleLines = wrapped(labels.title, inner * .55, titleSize);
  const headerTop = y;
  let logoHeight = 0;
  if (logo) {
    const image = logo[0] === 0x89 ? await pdf.embedPng(logo) : await pdf.embedJpg(logo);
    const scale = Math.min(inner * .40 / image.width, 54 / image.height);
    logoHeight = image.height * scale;
    const rowHeight = Math.max(31, logoHeight);
    page.drawImage(image, { x: margin, y: headerTop - (rowHeight + logoHeight) / 2, width: image.width * scale, height: logoHeight });
  }
  const rowHeight = Math.max(31, logoHeight);
  y = headerTop - (rowHeight - 31) / 2 - titleSize;
  titleLines.forEach((s, i) => { text(s, width - margin - regular.widthOfTextAtSize(s, titleSize), y - i * 31, titleSize, regular, accent); });
  y -= (titleLines.length - 1) * 31;
  if (doc.invoiceNumber) {
    for (const s of wrapped(`# ${doc.invoiceNumber}`, inner * .55, 12)) {
      y -= 20;
      text(s, width - margin - regular.widthOfTextAtSize(s, 12), y, 12, regular, muted);
    }
  }
  if (resources.state === 'paid' || resources.state === 'void') { y -= 20; right(resources.state.toUpperCase(), width - margin, y, 11, bold); }
  y = Math.min(y, headerTop - rowHeight) - 28;
  const date = (d: string) => d ? new Intl.DateTimeFormat(doc.locale, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(`${d}T00:00:00Z`)) : '';
  columns([labels.from, ...party(doc.business)], [`${labels.date}: ${date(doc.date)}`, doc.dueDate && `${labels.dueDate}: ${date(doc.dueDate)}`, doc.paymentTerms && `${labels.paymentTerms}: ${doc.paymentTerms}`, doc.poNumber && `${labels.poNumber}: ${doc.poNumber}`].filter(Boolean));
  y -= 22;
  columns([labels.billTo, ...party(doc.billTo)], doc.branding.showShipping && doc.shipTo ? [labels.shipTo, ...party(doc.shipTo)] : []);
  y -= 18;
  for (const field of doc.customFields) block(`${field.label}: ${field.value}`, 9, regular, muted);
  y -= 14;
  ensure(70); inTable = true; tableHeader();
  doc.items.forEach((item, i) => {
    const description = wrapped(item.description, descriptionWidth - 16, 10);
    const numeric = [wrapped(item.quantity, inner * .14 - 8, 9), wrapped(rateMoney(item.rate, doc.currency, doc.locale).replace(/\u202f|\u00a0/g, ' '), inner * .16 - 8, 9), wrapped(format(totals.lines[i]), inner * .17 - 8, 9)];
    const count = Math.max(description.length, ...numeric.map(x => x.length));
    for (let j = 0; j < count; j++) {
      ensure(16);
      if (description[j]) text(description[j], margin + 8, y, 10);
      numeric.forEach((rows, col) => { if (rows[j]) right(rows[j], [qtyX, rateX, amountX][col], y, 9); });
      y -= 16;
    }
    y -= 4; page.drawLine({ start: { x: margin, y }, end: { x: width - margin, y }, color: line, thickness: .5 }); y -= 18;
  });
  inTable = false; y -= 18;
  const summary: Array<[string, number, boolean?]> = [[labels.subtotal, totals.subtotal]];
  if (totals.discount) summary.push([labels.discount, -totals.discount]);
  if (totals.tax) summary.push([labels.tax, totals.tax]);
  if (totals.shipping) summary.push([labels.shipping, totals.shipping]);
  summary.push([labels.total, totals.total, true]);
  if (totals.amountPaid) summary.push([labels.amountPaid, totals.amountPaid]);
  summary.push([labels.balanceDue, totals.balanceDue, true]);
  for (const [label, value, emphasis] of summary) {
    const labelRows = wrapped(label, inner * .40, 10, emphasis ? bold : regular);
    const valueRows = wrapped(format(value), inner * .35, 10, emphasis ? bold : regular);
    const rows = Math.max(labelRows.length, valueRows.length);
    ensure(rows * 16 + 8);
    for (let i = 0; i < rows; i++) { if (labelRows[i]) text(labelRows[i], margin + inner * .23, y, 10, emphasis ? bold : regular); if (valueRows[i]) right(valueRows[i], width - margin, y, 10, emphasis ? bold : regular); y -= 16; }
    y -= 6;
  }
  y -= 22;
  for (const [visible, label, value] of [[doc.branding.showNotes, labels.notes, doc.notes], [doc.branding.showTerms, labels.terms, doc.terms]] as const) {
    if (visible && value) { ensure(45); block(label, 11, bold); y -= 3; block(value, 9, regular, muted); y -= 18; }
  }
  pdf.getPages().forEach((p, i) => {
    p.drawLine({ start: { x: margin, y: 35 }, end: { x: width - margin, y: 35 }, color: line, thickness: .6 });
    p.drawText(`${i + 1} / ${pdf.getPageCount()}`, { x: width - margin - 30, y: 20, size: 8, font: regular, color: muted });
  });
  return pdf.save();
}
