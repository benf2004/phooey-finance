import {
  PDFDocument,
  StandardFonts,
  rgb,
  type PDFFont,
  type PDFPage,
} from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import {
  calculate,
  labelDefaults,
  money,
  rateMoney,
  type InvoiceDocument,
  type InvoiceState,
} from "./model";

export interface PdfResources {
  font: (name: string) => Promise<Uint8Array>;
  logo?: Uint8Array;
  state?: InvoiceState;
}
export async function renderPdf(
  doc: InvoiceDocument,
  resources: PdfResources,
): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  pdf.setTitle(
    `${doc.branding.labels.title || "Invoice"} ${doc.invoiceNumber}`.trim(),
  );
  pdf.setAuthor(doc.business.name);
  // Fixed metadata makes the browser and Worker use the same document representation.
  const timestamp = new Date(`${doc.date}T00:00:00Z`);
  pdf.setCreationDate(timestamp);
  pdf.setModificationDate(timestamp);
  const family = { sans: "NotoSans", serif: "NotoSerif", mono: "NotoSansMono" }[
    doc.branding.font
  ];
  const [regularBytes, boldBytes] = await Promise.all([
    resources.font(`${family}-Regular.ttf`),
    resources.font(`${family}-Bold.ttf`),
  ]);
  let regular = await pdf.embedFont(regularBytes, { subset: true });
  let bold = await pdf.embedFont(boldBytes, { subset: true });
  if (doc.branding.font === "sans") {
    const helvetica = await pdf.embedFont(StandardFonts.Helvetica);
    const latin = new Set(helvetica.getCharacterSet());
    const printable =
      JSON.stringify(doc) + money(0, doc.currency, doc.locale, "symbol");
    if ([...printable].every((char) => latin.has(char.codePointAt(0)!))) {
      regular = helvetica;
      bold = await pdf.embedFont(StandardFonts.HelveticaBold);
    }
  }
  const supported = new Set(regular.getCharacterSet());
  function safe(value: string) {
    const s = value.replace(/\t/g, "    ").replace(/\r/g, "");
    for (const char of s)
      if (char !== "\n" && !supported.has(char.codePointAt(0)!))
        throw new Error(
          `Unsupported PDF character: ${char}. Use Latin-script text.`,
        );
    return s;
  }
  const labels = { ...labelDefaults, ...doc.branding.labels };
  const totals = calculate(doc);
  const format = (amount: number) =>
    money(amount, doc.currency, doc.locale, "symbol").replace(
      /\u202f|\u00a0/g,
      " ",
    );
  const width = doc.branding.paper === "a4" ? 595.28 : 612;
  const height = doc.branding.paper === "a4" ? 841.89 : 792;
  const margin = 29;
  const bottom = 42;
  const inner = width - margin * 2;
  const hex = doc.branding.accentColor.slice(1);
  const accent = rgb(
    parseInt(hex.slice(0, 2), 16) / 255,
    parseInt(hex.slice(2, 4), 16) / 255,
    parseInt(hex.slice(4, 6), 16) / 255,
  );
  const ink = rgb(0.16, 0.16, 0.16);
  const muted = rgb(0.42, 0.42, 0.42);
  const line = rgb(0.87, 0.89, 0.92);
  let page!: PDFPage;
  let y = height - margin;
  let inTable = false;
  function text(
    s: string,
    x: number,
    at: number,
    size = 10,
    font: PDFFont = regular,
    color = ink,
  ) {
    page.drawText(safe(s), { x, y: at, size, font, color });
  }
  function right(s: string, x: number, at: number, size = 10, font = regular) {
    text(s, x - font.widthOfTextAtSize(safe(s), size), at, size, font);
  }
  function wrapped(
    s: string,
    max: number,
    size = 10,
    font = regular,
  ): string[] {
    const result: string[] = [];
    for (const paragraph of safe(s).split("\n")) {
      if (!paragraph) {
        result.push("");
        continue;
      }
      let current = "";
      for (const word of paragraph.split(/ +/)) {
        const candidate = current ? `${current} ${word}` : word;
        if (font.widthOfTextAtSize(candidate, size) <= max) {
          current = candidate;
          continue;
        }
        if (current) result.push(current);
        current = "";
        for (const char of word) {
          if (font.widthOfTextAtSize(current + char, size) > max && current) {
            result.push(current);
            current = "";
          }
          current += char;
        }
      }
      result.push(current);
    }
    return result;
  }
  const descriptionWidth = inner * 0.59;
  const qtyX = margin + inner * 0.62;
  const rateX = margin + inner * 0.84;
  const amountX = width - margin - 16;
  function tableHeader() {
    const headers = [
      wrapped(labels.item, descriptionWidth - 30, 9),
      wrapped(labels.quantity, inner * 0.13 - 10, 9),
      wrapped(labels.rate, inner * 0.14 - 10, 9),
      wrapped(labels.amount, inner * 0.14 - 10, 9),
    ];
    const h = Math.max(...headers.map((x) => x.length)) * 12 + 10;
    page.drawRectangle({
      x: margin,
      y: y - h,
      width: inner,
      height: h,
      color:
        doc.branding.template === "modern" ? accent : rgb(0.23, 0.23, 0.23),
    });
    headers.forEach((hs, i) =>
      hs.forEach((s, j) => {
        const x = [margin + 15, qtyX, rateX, amountX][i];
        text(
          s,
          i < 2 ? x : x - regular.widthOfTextAtSize(s, 9),
          y - 14 - j * 12,
          9,
          regular,
          rgb(1, 1, 1),
        );
      }),
    );
    y -= h + 17;
  }
  function newPage(first = false) {
    page = pdf.addPage([width, height]);
    y = height - margin;
    if (!first) {
      text(
        wrapped(doc.business.name, inner * 0.6, 9, bold)[0] || "",
        margin,
        y,
        9,
        bold,
        muted,
      );
      right(doc.invoiceNumber, width - margin, y, 9);
      y -= 14;
      page.drawLine({
        start: { x: margin, y },
        end: { x: width - margin, y },
        color: line,
        thickness: 0.7,
      });
      y -= 25;
      if (inTable) tableHeader();
    }
  }
  function ensure(space: number) {
    if (y - space < bottom) newPage();
  }
  function block(
    s: string,
    size = 10,
    font = regular,
    color = ink,
    x = margin,
    max = inner,
  ) {
    for (const row of wrapped(s, max, size, font)) {
      ensure(size + 6);
      text(row, x, y, size, font, color);
      y -= size + 5;
    }
  }
  newPage(true);
  const inlineLogo = doc.branding.logoData;
  let logo = resources.logo;
  if (inlineLogo)
    logo = Uint8Array.from(atob(inlineLogo.split(",")[1]), (c) =>
      c.charCodeAt(0),
    );
  const headerTop = height - 18;
  y = headerTop;
  let logoHeight = 0;
  if (logo) {
    const image =
      logo[0] === 0x89 ? await pdf.embedPng(logo) : await pdf.embedJpg(logo);
    const scale = Math.min(120 / image.width, 44 / image.height);
    logoHeight = image.height * scale;
    page.drawImage(image, {
      x: 40,
      y: headerTop - logoHeight,
      width: image.width * scale,
      height: logoHeight,
    });
  }
  const titleSize = 28;
  for (const row of wrapped(labels.title, inner * 0.48, titleSize)) {
    y -= titleSize;
    right(row, width - 40, y, titleSize);
    y -= 5;
  }
  if (doc.invoiceNumber) {
    for (const row of wrapped("# " + doc.invoiceNumber, inner * 0.48, 12)) {
      y -= 15;
      right(row, width - 40, y, 11);
    }
  }
  if (resources.state === "paid" || resources.state === "void") {
    y -= 18;
    right(resources.state.toUpperCase(), width - margin, y, 10, bold);
  }
  const titleBottom = y;
  // One shared row grid keeps the parties and label/value metadata aligned and paginated.
  type HeaderCell = {
    value: string;
    x: number;
    font?: PDFFont;
    size?: number;
    alignRight?: boolean;
    shade?: boolean;
  };
  const rows = new Map<number, HeaderCell[]>();
  const addCell = (offset: number, cell: HeaderCell) =>
    rows.set(offset, [...(rows.get(offset) || []), cell]);
  function addRows(
    values: string[],
    start: number,
    x: number,
    max: number,
    firstBold = false,
  ) {
    let index = start;
    values.forEach((value, i) => {
      const font = firstBold && i === 0 ? bold : regular;
      for (const row of wrapped(value, max, 9, font)) {
        addCell(index, { value: row, x, font });
        index += 12;
      }
    });
    return index;
  }
  const party = (p: InvoiceDocument["business"]) =>
    [p.name, p.address, p.email, p.phone, p.taxId].filter(Boolean);
  const shipping =
    doc.branding.showShipping && doc.shipTo && party(doc.shipTo).length > 0;
  const senderEnd = addRows(party(doc.business), 0, 48, inner * 0.48, true);
  const billingStart = senderEnd + 14;
  addRows(
    [labels.billTo + ":"],
    billingStart,
    48,
    inner * (shipping ? 0.25 : 0.48),
  );
  addRows(
    party(doc.billTo),
    billingStart + 15,
    48,
    inner * (shipping ? 0.25 : 0.48),
    true,
  );
  if (shipping) {
    addRows(
      [labels.shipTo + ":"],
      billingStart,
      margin + inner * 0.28,
      inner * 0.23,
    );
    addRows(
      party(doc.shipTo!),
      billingStart + 15,
      margin + inner * 0.28,
      inner * 0.23,
      true,
    );
  }
  const date = (d: string) =>
    d
      ? new Intl.DateTimeFormat(doc.locale, {
          year: "numeric",
          month: "short",
          day: "numeric",
          timeZone: "UTC",
        }).format(new Date(d + "T00:00:00Z"))
      : "";
  const metadata = [
    [labels.date, date(doc.date)],
    [labels.paymentTerms, doc.paymentTerms],
    [labels.dueDate, date(doc.dueDate)],
    [labels.poNumber, doc.poNumber],
  ].filter(([, value]) => value);
  const contentTop = Math.min(height - 87, titleBottom - 12);
  let metaRow = 31;
  for (const [label, value] of [
    ...metadata,
    [labels.balanceDue, format(totals.balanceDue)],
  ]) {
    const emphasis =
      metaRow > 0 &&
      label === labels.balanceDue &&
      value === format(totals.balanceDue);
    const font = emphasis ? bold : regular;
    const left = wrapped(label + ":", inner * 0.25, emphasis ? 11 : 9, font);
    const rightRows = wrapped(value, inner * 0.2 - 8, emphasis ? 11 : 9, font);
    const count = Math.max(left.length, rightRows.length);
    for (let j = 0; j < count; j++) {
      addCell(metaRow, {
        value: left[j] || "",
        x: margin + inner * 0.783,
        font,
        size: emphasis ? 11 : 9,
        alignRight: true,
        shade: emphasis,
      });
      addCell(metaRow, {
        value: rightRows[j] || "",
        x: amountX,
        font,
        size: emphasis ? 11 : 9,
        alignRight: true,
      });
      metaRow += 12;
    }
    metaRow += 10;
  }
  y = contentTop;
  let previousOffset = 0;
  for (const [offset, cells] of [...rows.entries()].sort(
    (a, b) => a[0] - b[0],
  )) {
    y -= offset - previousOffset;
    previousOffset = offset;
    ensure(14);
    if (cells.some((c) => c.shade))
      page.drawRectangle({
        x: margin + inner * 0.52,
        y: y - 10,
        width: inner * 0.48 + 3,
        height: 26,
        color: rgb(0.96, 0.96, 0.96),
      });
    for (const cell of cells) {
      const size = cell.size || 9;
      if (cell.alignRight)
        right(cell.value, cell.x, y, size, cell.font || regular);
      else text(cell.value, cell.x, y, size, cell.font || regular);
    }
  }
  y -= 46;
  for (const field of doc.customFields)
    block(`${field.label}: ${field.value}`, 9, regular, muted);
  if (doc.customFields.length) y -= 10;
  ensure(55);
  inTable = true;
  tableHeader();
  doc.items.forEach((item, i) => {
    const description = wrapped(
      item.description,
      descriptionWidth - 30,
      9,
      bold,
    );
    const numeric = [
      wrapped(item.quantity, inner * 0.11 - 10, 9),
      wrapped(
        rateMoney(item.rate, doc.currency, doc.locale, "symbol").replace(
          /\u202f|\u00a0/g,
          " ",
        ),
        inner * 0.13 - 10,
        9,
      ),
      wrapped(format(totals.lines[i]), inner * 0.13 - 10, 9),
    ];
    const count = Math.max(description.length, ...numeric.map((x) => x.length));
    for (let j = 0; j < count; j++) {
      ensure(14);
      if (description[j])
        text(description[j], margin + 15, y, 9, j === 0 ? bold : regular);
      numeric.forEach((rows, col) => {
        if (rows[j]) {
          if (col === 0) text(rows[j], qtyX, y, 9);
          else right(rows[j], [qtyX, rateX, amountX][col], y, 9);
        }
      });
      y -= 12;
    }
    y -= 5;
  });
  inTable = false;
  y -= 47;
  const summary: Array<[string, number, boolean?]> = [
    [labels.subtotal, totals.subtotal],
  ];
  if (totals.discount)
    summary.push([
      labels.discount +
        (doc.discount.type === "percent"
          ? " (" + doc.discount.value + "%)"
          : ""),
      -totals.discount,
    ]);
  if (totals.tax)
    summary.push([
      labels.tax +
        (doc.tax.type === "percent" ? " (" + doc.tax.value + "%)" : ""),
      totals.tax,
    ]);
  if (totals.shipping) summary.push([labels.shipping, totals.shipping]);
  summary.push([labels.total, totals.total]);
  if (totals.amountPaid)
    summary.push(
      [labels.amountPaid, totals.amountPaid],
      [labels.balanceDue, totals.balanceDue, true],
    );
  for (const [label, value, emphasis] of summary) {
    const font = emphasis ? bold : regular;
    const labelRows = wrapped(label + ":", inner * 0.29, 9, font);
    const valueRows = wrapped(format(value), inner * 0.23, 9, font);
    const count = Math.max(labelRows.length, valueRows.length);
    ensure(count * 14 + 10);
    for (let i = 0; i < count; i++) {
      if (labelRows[i]) right(labelRows[i], margin + inner * 0.783, y, 9, font);
      if (valueRows[i]) right(valueRows[i], amountX, y, 9, font);
      y -= 12;
    }
    y -= 10;
  }
  y -= 34;
  for (const [visible, label, value] of [
    [doc.branding.showNotes, labels.notes, doc.notes],
    [doc.branding.showTerms, labels.terms, doc.terms],
  ] as const) {
    if (visible && value) {
      ensure(35);
      block(label + ":", 9, regular, muted, 48, inner - 38);
      block(value, 9, regular, ink, 48, inner - 38);
      y -= 16;
    }
  }
  pdf.getPages().forEach((p, i) => {
    if (pdf.getPageCount() > 1)
      p.drawText(`${i + 1} / ${pdf.getPageCount()}`, {
        x: width - margin - 30,
        y: 20,
        size: 8,
        font: regular,
        color: muted,
      });
  });
  return pdf.save();
}
