import { readFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { PDFDocument } from "pdf-lib";
import { describe, it, expect } from "vitest";
import { newDocument } from "../src/shared/model";
import { renderPdf } from "../src/shared/pdf";
const font = async (name: string) =>
  new Uint8Array(await readFile(join("public/fonts", name)));
const logo = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5ZkAAAAASUVORK5CYII=",
    "base64",
  ),
);
describe("PDF renderer", () => {
  for (const template of ["classic", "modern"] as const)
    for (const face of ["sans", "serif", "mono"] as const)
      for (const paper of ["letter", "a4"] as const) {
        it(`${template} / ${face} / ${paper}: wraps and paginates Latin text`, async () => {
          const d = newDocument();
          d.business = {
            name: "Atelier René",
            address: "123 Market Street\nDenver, CO 80202",
            email: "hello@example.com",
            phone: "",
            taxId: "US-1234",
          };
          d.billTo = { ...d.business, name: "Zoë Müller — Studio" };
          d.invoiceNumber = "INV-0100";
          d.branding = {
            ...d.branding,
            template,
            font: face,
            paper,
            showShipping: true,
          };
          d.shipTo = { ...d.billTo, name: "Delivery desk" };
          d.branding.labels = {
            billTo: "Facturé à",
            notes: "Remarques",
            title: "FACTURE",
          };
          d.items = Array.from({ length: 36 }, (_, i) => ({
            description:
              `${i + 1}. Création graphique — Strategy, research and design. ` +
              (i === 10
                ? "Averylongunbrokenword".repeat(35)
                : "A thoughtful description that wraps across several lines. ".repeat(
                    2,
                  )),
            quantity: "2.5",
            rate: "120",
          }));
          d.notes =
            "Thank you, René. Żółć, č, ñ, á, ß, œ.\n" +
            "Long notes continue safely onto the next page. ".repeat(100);
          d.terms = "Please send a bank transfer within thirty days. ".repeat(
            80,
          );
          const started = performance.now();
          const cpu = process.cpuUsage();
          const bytes = await renderPdf(d, { font, logo, state: "paid" });
          const elapsed = performance.now() - started;
          const used = process.cpuUsage(cpu);
          const parsed = await PDFDocument.load(bytes);
          expect(parsed.getPageCount()).toBeGreaterThan(2);
          expect(parsed.getPages()[0].getWidth()).toBeCloseTo(
            paper === "a4" ? 595.28 : 612,
            1,
          );
          expect(parsed.getTitle()).toBe("FACTURE INV-0100");
          await mkdir("test-results/pdfs", { recursive: true });
          await writeFile(
            `test-results/pdfs/${template}-${face}-${paper}.pdf`,
            bytes,
          );
          console.log(
            `${template}-${face}-${paper}: ${parsed.getPageCount()} pages, ${Math.round(elapsed)}ms wall, ${Math.round((used.user + used.system) / 1000)}ms local process CPU`,
          );
        }, 20000);
      }
  it("rejects unsupported glyphs explicitly", async () => {
    const d = newDocument();
    d.notes = "😀";
    await expect(renderPdf(d, { font })).rejects.toThrow(
      "Unsupported PDF character",
    );
  });
  it("browser and Worker resource providers produce equivalent pages", async () => {
    const d = newDocument();
    d.items[0].rate = "120";
    const a = await renderPdf(d, { font });
    const b = await renderPdf(d, {
      font: async (name) => Uint8Array.from(await font(name)),
    });
    const p1 = await PDFDocument.load(a);
    const p2 = await PDFDocument.load(b);
    expect(p1.getPageCount()).toBe(p2.getPageCount());
    expect(p1.getPages()[0].getSize()).toEqual(p2.getPages()[0].getSize());
    expect(p1.getTitle()).toBe(p2.getTitle());
  });
});

describe("compact invoice layout", () => {
  it("keeps the parties, balance and short item table in a compact single-page invoice", async () => {
    const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const d = newDocument();
    d.invoiceNumber = "9";
    d.date = "2026-08-01";
    d.dueDate = "2026-11-04";
    d.paymentTerms = "Net 30";
    d.poNumber = "1200";
    d.business = {
      name: "Example Studio",
      address: "100 Sample Road\nExample City, ST 12345\nUnited States",
      email: "",
      phone: "",
      taxId: "",
    };
    d.billTo = { ...d.business, name: "Sample Client" };
    d.items = [
      { description: "First service", quantity: "1", rate: "10" },
      { description: "Second service", quantity: "2", rate: "200" },
    ];
    d.tax.value = "10";
    d.notes = "Thank you";
    const task = getDocument({
      data: await renderPdf(d, { font }),
      useSystemFonts: true,
    });
    const pdf = await task.promise;
    expect(pdf.numPages).toBe(1);
    const page = await pdf.getPage(1);
    const content = await page.getTextContent();
    const text = content.items.filter(
      (item): item is import("pdfjs-dist/types/src/display/api").TextItem =>
        "str" in item,
    );
    const at = (value: string) => text.find((item) => item.str === value)!;
    expect(at("Example Studio").transform[5]).toBeGreaterThan(690);
    expect(at("Balance Due:").transform[5]).toBeGreaterThan(
      at("Item").transform[5],
    );
    expect(at("Item").transform[5]).toBeGreaterThan(520);
    expect(
      at("First service").transform[5] - at("Second service").transform[5],
    ).toBeLessThanOrEqual(20);
    expect(at("Example Studio").fontName).not.toBe(
      at("100 Sample Road").fontName,
    );
    expect(text.filter((item) => item.str === "Balance Due:")).toHaveLength(1);
    expect(at("$451.00")).toBeDefined();
    expect(text.some((item) => item.str.includes("USD"))).toBe(false);
    await task.destroy();
  });
  it("keeps wrapped rows within page bounds and repeats table headings across page breaks", async () => {
    const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const d = newDocument();
    d.business.name = "Example Studio";
    d.invoiceNumber = "LONG-1";
    d.items = Array.from({ length: 70 }, (_, i) => ({
      description:
        `Service ${i + 1}: ` + "Detailed work description. ".repeat(8),
      quantity: "2",
      rate: "10",
    }));
    const task = getDocument({
      data: await renderPdf(d, { font }),
      useSystemFonts: true,
    });
    const pdf = await task.promise;
    expect(pdf.numPages).toBeGreaterThan(1);
    let tablePages = 0;
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      const text = content.items.filter(
        (item): item is import("pdfjs-dist/types/src/display/api").TextItem =>
          "str" in item && !!item.str.trim(),
      );
      if (text.some((item) => item.str.startsWith("Service "))) {
        tablePages++;
        expect(text.some((item) => item.str === "Item")).toBe(true);
      }
      for (const item of text) {
        expect(item.transform[4]).toBeGreaterThanOrEqual(28);
        expect(item.transform[4] + item.width).toBeLessThanOrEqual(584);
        expect(item.transform[5]).toBeGreaterThanOrEqual(19);
        expect(item.transform[5] + item.height).toBeLessThanOrEqual(780);
      }
    }
    expect(tablePages).toBeGreaterThan(1);
    await task.destroy();
  });
});
