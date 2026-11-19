// Run after npm run build: node tests/attachments-ui.mjs
// Uses a disposable Worker/database and browser profile; never loads real credentials.
import { chromium, expect } from "@playwright/test";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { hash } from "bcryptjs";
import { createServer } from "node:http";
import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { twoPagePDF, tinyPNG } from "./attachment-fixtures.ts";

const mf = new Miniflare(
  convertV4MiniflareOptions({
    modules: true,
    scriptPath: "dist/phooey_finance/index.js",
    compatibilityDate: "2026-11-12",
    compatibilityFlags: ["nodejs_compat"],
    d1Databases: { DB: "attachments-ui-test" },
    r2Buckets: ["FILES"],
    queueProducers: { JOBS: "jobs" },
    bindings: {
      ADMIN_USERNAME: "test-admin",
      ADMIN_PASSWORD_HASH: await hash("test-only original password", 4),
      ENCRYPTION_KEY: randomBytes(32).toString("base64"),
    },
  }),
);
let browser;
const server = createServer(async (request, response) => {
  try {
    if (request.url.startsWith("/api/")) {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      const result = await mf.dispatchFetch(
        `http://${request.headers.host}${request.url}`,
        {
          method: request.method,
          headers: request.headers,
          ...(body.length ? { body } : {}),
        },
      );
      response.writeHead(result.status, Object.fromEntries(result.headers));
      response.end(Buffer.from(await result.arrayBuffer()));
      return;
    }
    const pathname = new URL(request.url, "http://localhost").pathname;
    const asset = pathname.startsWith("/assets/") ? pathname : "/index.html";
    const root = resolve("dist/client");
    const path = resolve(root, "." + asset);
    if (!path.startsWith(root + "/")) throw new Error("Invalid path");
    response.setHeader(
      "Content-Type",
      path.endsWith(".js")
        ? "text/javascript"
        : path.endsWith(".css")
          ? "text/css"
          : "text/html",
    );
    response.end(await readFile(path));
  } catch {
    response.writeHead(500).end("Test server error");
  }
});
try {
  const db = await mf.getD1Database("DB");
  for (const file of (await readdir("migrations")).sort())
    await db.exec(
      (await readFile("migrations/" + file, "utf8")).replaceAll("\n", " "),
    );
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const url = `http://127.0.0.1:${server.address().port}`;
  const systemChrome =
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  browser = await chromium.launch(
    existsSync(chromium.executablePath())
      ? {}
      : { executablePath: systemChrome },
  );
  const page = await browser.newPage({
    viewport: { width: 1280, height: 900 },
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.clock.setFixedTime(new Date(2024, 0, 15, 12));
  await page.goto(url + "/transactions");
  await page.getByLabel("Username").fill("test-admin");
  await page
    .getByLabel("Password", { exact: true })
    .fill("test-only original password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Transactions", exact: true }),
  ).toBeVisible();
  const account = await (
    await page.request.post(url + "/api/accounts", {
      headers: { Origin: url },
      data: { name: "Synthetic receipts account" },
    })
  ).json();
  const txResponse = await page.request.post(url + "/api/transactions", {
    headers: { Origin: url },
    data: {
      account_id: account.id,
      description: "Synthetic attachment transaction",
      amount: -12345,
      type: "expense",
      posted: "2026-11-14",
    },
  });
  expect(txResponse.status()).toBe(200);
  const tx = await txResponse.json();
  await page.request.post(url + "/api/transactions", {
    headers: { Origin: url },
    data: {
      account_id: account.id,
      description: "Synthetic transaction without receipts",
      amount: -500,
      type: "expense",
      posted: "2026-11-14",
    },
  });
  const category = await (await page.request.post(url + "/api/categories", {
    headers: { Origin: url },
    data: { name: "Office supplies", type: "expense", color: "#28634a" },
  })).json();
  const base = url + `/api/transactions/${tx.id}/attachments`;
  const source = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 4200;
    canvas.height = 3200;
    const ctx = canvas.getContext("2d");
    const pixels = ctx.createImageData(canvas.width, canvas.height);
    let seed = 42;
    for (let i = 0; i < pixels.data.length; i += 4) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      const shade = 234 + (seed % 22);
      pixels.data[i] = shade;
      pixels.data[i + 1] = shade;
      pixels.data[i + 2] = shade;
      pixels.data[i + 3] = 255;
    }
    ctx.putImageData(pixels, 0, 0);
    ctx.fillStyle = "#111";
    ctx.font = "bold 92px sans-serif";
    ctx.fillText("SYNTHETIC RECEIPT", 160, 200);
    ctx.font = "52px sans-serif";
    for (let row = 0; row < 20; row++)
      ctx.fillText(
        `Receipt line ${row + 1}   Item detail   $12.34`,
        160,
        400 + row * 105,
      );
    ctx.font = "bold 80px sans-serif";
    ctx.fillText("TOTAL $246.80", 160, 2800);
    return canvas.toDataURL("image/jpeg", 1).split(",")[1];
  });
  const photo = Buffer.from(source, "base64");
  await page.reload();
  await expect(
    page.getByRole("columnheader", { name: "Receipts", exact: true }),
  ).toBeVisible();
  const receiptRow = page
    .getByRole("row")
    .filter({ hasText: "Synthetic attachment transaction" });
  const emptyRow = page
    .getByRole("row")
    .filter({ hasText: "Synthetic transaction without receipts" });
  for (const name of ["Description", "Merchant", "Category"])
    await expect(page.getByRole("columnheader", { name, exact: true })).toBeVisible();
  const merchantPencil = receiptRow.getByRole("button", { name: /^Edit merchant for/ });
  await merchantPencil.click();
  const merchant = receiptRow.getByRole("textbox", { name: "Merchant" });
  await expect(merchant).toBeFocused();
  await merchant.fill("Discard this edit");
  await merchant.press("Escape");
  await expect(merchantPencil).toBeFocused();
  await merchantPencil.click();
  await merchant.fill("Paper Supply Co.");
  await merchant.press("Enter");
  await expect(receiptRow.getByText("Paper Supply Co.", { exact: true })).toBeVisible();
  await receiptRow.getByRole("button", { name: /^Edit description for/ }).click();
  const newDescription = "Synthetic attachment transaction · office order";
  await receiptRow.getByRole("textbox", { name: "Description" }).fill(newDescription);
  await receiptRow.getByRole("button", { name: "Save description" }).click();
  await expect(receiptRow.getByRole("button", { name: newDescription, exact: true })).toBeVisible();
  await receiptRow.getByRole("button", { name: /^Edit category for/ }).click();
  await receiptRow.getByRole("combobox", { name: "Category" }).selectOption(category.id);
  await receiptRow.getByRole("button", { name: "Save category" }).click();
  await expect(receiptRow.getByText("Office supplies", { exact: true })).toBeVisible();
  await expect(page.locator("dialog.transaction-editor")).toHaveCount(0);
  await page.reload();
  await expect(receiptRow.getByText("Paper Supply Co.", { exact: true })).toBeVisible();
  await expect(receiptRow.getByText("Office supplies", { exact: true })).toBeVisible();
  await page.screenshot({ path: "/tmp/phooey-inline-ledger.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await merchantPencil.click();
  await expect(merchant).toHaveValue("Paper Supply Co.");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: "/tmp/phooey-inline-mobile.png" });
  await merchant.press("Escape");
  await page.setViewportSize({ width: 1280, height: 900 });
  await receiptRow.getByRole("button", { name: /^Edit description for/ }).click();
  await receiptRow.getByRole("textbox", { name: "Description" }).fill("Synthetic attachment transaction");
  await receiptRow.getByRole("button", { name: "Save description" }).click();
  await expect(receiptRow.getByRole("button", { name: "Synthetic attachment transaction", exact: true })).toBeVisible();
  const uploadButton = emptyRow.getByRole("button", {
    name: /^Upload receipts for/,
  });
  await expect(uploadButton).toBeVisible();
  const period = page.getByRole("combobox", { name: "Date range" });
  await page.goto(url + "/transactions?reviewed=1&page=2");
  await period.selectOption("last-quarter");
  const exportLink = page.getByRole("link", { name: "Export" });
  const exportParams = async () =>
    new URL(await exportLink.getAttribute("href"), url).searchParams;
  expect(Object.fromEntries(await exportParams())).toEqual({
    reviewed: "1",
    from: "2023-10-01",
    to: "2023-12-31",
  });
  await expect(receiptRow).toHaveCount(0);
  await period.selectOption("this-quarter");
  let bounds = await exportParams();
  expect([bounds.get("from"), bounds.get("to")]).toEqual([
    "2024-01-01",
    "2024-03-31",
  ]);
  await period.selectOption("custom");
  await expect(page.getByLabel("From", { exact: true })).toHaveValue(
    "2024-01-01",
  );
  await page.getByLabel("To", { exact: true }).fill("2026-11-30");
  await expect(receiptRow).toBeVisible();
  await page.reload();
  await expect(period).toHaveValue("custom");
  await period.selectOption("all");
  expect(Object.fromEntries(await exportParams())).toEqual({ reviewed: "1" });
  await page.goto(url + "/");
  await expect(period).toHaveValue("year-to-date");
  await period.selectOption("last-month");
  await expect(page.getByLabel("Report start date")).toHaveValue("2023-12-01");
  await expect(page.getByLabel("Report end date")).toHaveValue("2023-12-31");
  await page.goto(url + "/transactions");
  let attachmentListRequests = 0;
  page.on("request", (request) => {
    if (
      request.method() === "GET" &&
      /\/transactions\/[^/]+\/attachments$/.test(request.url())
    )
      attachmentListRequests++;
  });
  await page.reload();
  await expect(receiptRow).toBeVisible();
  expect(attachmentListRequests).toBe(0);
  for (let count = 1; count <= 2; count++) {
    const fileChooser = page.waitForEvent("filechooser");
    await uploadButton.click();
    await (
      await fileChooser
    ).setFiles({
      name: `row-receipt-${count}.pdf`,
      mimeType: "application/pdf",
      buffer: Buffer.from(twoPagePDF()),
    });
    await expect(
      emptyRow.getByRole("button", {
        name: new RegExp(`^View ${count} attachment`),
      }),
    ).toBeVisible();
    await expect(page.locator("dialog.transaction-editor")).toHaveCount(0);
    await expect(emptyRow.getByRole("checkbox")).not.toBeChecked();
  }
  expect(attachmentListRequests).toBe(0);
  await page
    .getByRole("row")
    .filter({ hasText: "Synthetic attachment transaction" })
    .click();
  const editor = page.locator("dialog.transaction-editor");
  await expect(editor.getByLabel(/^Amount/)).toHaveValue("-123.45");
  const chooser = editor.getByLabel("Choose receipt or invoice files");
  await chooser.setInputFiles({
    name: "synthetic-receipt.jpg",
    mimeType: "image/jpeg",
    buffer: photo,
  });
  await expect(editor.getByRole("status")).toHaveText("1 file attached.");
  expect(attachmentListRequests).toBe(1);
  let attachments = await (await page.request.get(base)).json();
  expect(attachments).toHaveLength(1);
  const balanced = attachments[0];
  expect(balanced.size).toBeLessThan(photo.length);
  expect(balanced.original_size).toBe(photo.length);
  await editor.getByTitle("Preview synthetic-receipt.jpg").click();
  const preview = page.locator("dialog.attachment-preview");
  const image = preview.getByRole("img");
  await expect(image).toBeVisible();
  await expect.poll(() => image.evaluate((el) => el.naturalWidth)).toBe(2800);
  expect(page.context().pages()).toHaveLength(1);
  await page.screenshot({ path: "/tmp/phooey-attachment-preview.png" });
  await preview
    .getByRole("button", { name: "Actual size", exact: true })
    .click();
  expect(await image.evaluate((el) => el.clientWidth)).toBe(2800);
  await preview.getByRole("button", { name: "Fit image", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(preview).toHaveCount(0);
  await expect(editor).toBeVisible();
  await expect(
    editor.getByTitle("Preview synthetic-receipt.jpg"),
  ).toBeFocused();
  const pdf = Buffer.from(twoPagePDF());
  await chooser.setInputFiles({
    name: "two-page-invoice.pdf",
    mimeType: "application/pdf",
    buffer: pdf,
  });
  await expect(editor.getByTitle("Preview two-page-invoice.pdf")).toBeVisible();
  attachments = await (await page.request.get(base)).json();
  const invoice = attachments.find(
    (item) => item.content_type === "application/pdf",
  );
  expect(invoice.size).toBe(pdf.length);
  expect(
    await (await page.request.get(base + "/" + invoice.id)).body(),
  ).toEqual(pdf);
  await editor.getByTitle("Preview two-page-invoice.pdf").click();
  await expect(preview.locator("iframe")).toBeVisible();
  const embeddedText = await preview
    .locator("iframe")
    .evaluate(async (frame) => await (await fetch(frame.src)).text());
  expect(embeddedText).toContain("page 2 of 2");
  expect(embeddedText).toContain("/Count 2");
  await page.waitForTimeout(1500); // The native PDF viewer paints after iframe load.
  await page.screenshot({ path: "/tmp/phooey-attachment-pdf.png" });
  const popupEvent = page.waitForEvent("popup");
  await preview
    .getByRole("link", { name: "Open in new tab", exact: true })
    .click();
  const popup = await popupEvent;
  await popup.waitForLoadState();
  await popup.waitForTimeout(1500);
  await popup.screenshot({ path: "/tmp/phooey-attachment-pdf-new-tab.png" });
  await popup.close();
  const downloadEvent = page.waitForEvent("download");
  await preview.getByRole("link", { name: "Download", exact: true }).click();
  const download = await downloadEvent;
  expect(download.suggestedFilename()).toBe("two-page-invoice.pdf");
  expect(await readFile(await download.path())).toEqual(pdf);
  await preview
    .getByRole("button", { name: "Close dialog", exact: true })
    .click();
  await expect(editor).toBeVisible();
  // HTTP failure retains a retryable upload; successful retry creates one attachment.
  await page.evaluate(() =>
    Object.defineProperty(navigator, "pdfViewerEnabled", {
      value: false,
      configurable: true,
    }),
  );
  await editor.getByTitle("Preview two-page-invoice.pdf").click();
  await expect(
    preview.getByText(/This browser does not support embedded PDFs/),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await page.evaluate(() => delete navigator.pdfViewerEnabled);
  await page.route(base + "/" + invoice.id, (route) =>
    route.fulfill({
      status: 404,
      contentType: "application/json",
      body: JSON.stringify({ error: "Synthetic missing file" }),
    }),
  );
  await editor.getByTitle("Preview two-page-invoice.pdf").click();
  await expect(preview.getByRole("alert")).toHaveText("Synthetic missing file");
  await expect(
    preview.getByRole("link", { name: "Download", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await page.unroute(base + "/" + invoice.id);
  await page.route("**/attachments", async (route) => {
    if (route.request().method() === "POST")
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "Synthetic upload failure" }),
      });
    else await route.continue();
  });
  await chooser.setInputFiles({
    name: "retry.pdf",
    mimeType: "application/pdf",
    buffer: pdf,
  });
  await expect(
    editor.getByText("retry.pdf: Synthetic upload failure"),
  ).toBeVisible();
  await page.unroute("**/attachments");
  await editor.getByRole("button", { name: "Retry failed files" }).click();
  await expect(editor.getByTitle("Preview retry.pdf")).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept());
  await editor
    .getByRole("button", { name: "Remove retry.pdf", exact: true })
    .click();
  await expect(editor.getByTitle("Preview retry.pdf")).toHaveCount(0);
  // Unsupported/corrupt phone files get a useful JPEG export instruction.
  await chooser.setInputFiles({
    name: "phone.heic",
    mimeType: "image/heic",
    buffer: Buffer.concat([
      Buffer.from([0, 0, 0, 24]),
      Buffer.from("ftypheic00000000"),
    ]),
  });
  await expect(
    editor.getByText(/Your browser cannot read this HEIC\/AVIF photo/),
  ).toBeVisible();
  await editor.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(
    receiptRow.getByRole("button", {
      name: "View 2 attachments for Synthetic attachment transaction",
      exact: true,
    }),
  ).toBeVisible();
  await page.goto(url + "/settings?tab=data");
  const compression = page.getByLabel("Image compression");
  await expect(compression).toHaveValue("balanced");
  await compression.selectOption("smaller");
  await page
    .getByRole("button", { name: "Save compression", exact: true })
    .click();
  await expect(page.getByRole("status")).toHaveText("Image compression saved.");
  await page.reload();
  await expect(compression).toHaveValue("smaller");
  await page.screenshot({ path: "/tmp/phooey-attachment-settings.png" });
  await page.goto(url + "/transactions");
  await page
    .getByRole("row")
    .filter({ hasText: "Synthetic attachment transaction" })
    .click();
  await chooser.setInputFiles({
    name: "smaller-receipt.jpg",
    mimeType: "image/jpeg",
    buffer: photo,
  });
  await expect(editor.getByTitle("Preview smaller-receipt.jpg")).toBeVisible();
  attachments = await (await page.request.get(base)).json();
  const smaller = attachments.find(
    (item) => item.filename === "smaller-receipt.jpg",
  );
  expect(smaller.size).toBeLessThan(balanced.size);
  expect(attachments.find((item) => item.id === balanced.id).size).toBe(
    balanced.size,
  );
  await editor.getByTitle("Preview smaller-receipt.jpg").click();
  await expect
    .poll(() => preview.getByRole("img").evaluate((el) => el.naturalWidth))
    .toBe(2000);
  await page.keyboard.press("Escape");
  // Keep a tiny PNG instead of replacing it with a larger JPEG.
  await chooser.setInputFiles({
    name: "tiny.png",
    mimeType: "image/png",
    buffer: Buffer.from(tinyPNG),
  });
  await expect(editor.getByTitle("Preview tiny.png")).toBeVisible();
  attachments = await (await page.request.get(base)).json();
  const tiny = attachments.find((item) => item.filename === "tiny.png");
  expect(tiny.size).toBe(tinyPNG.length);
  expect(await (await page.request.get(base + "/" + tiny.id)).body()).toEqual(
    Buffer.from(tinyPNG),
  );
  for (const preset of ["detailed", "original"]) {
    expect(
      (
        await page.request.post(url + "/api/settings/attachment-compression", {
          headers: { Origin: url },
          data: { preset },
        })
      ).status(),
    ).toBe(200);
    await chooser.setInputFiles({
      name: `${preset}.jpg`,
      mimeType: "image/jpeg",
      buffer: photo,
    });
    await expect(editor.getByTitle(`Preview ${preset}.jpg`)).toBeVisible();
    attachments = await (await page.request.get(base)).json();
    const result = attachments.find(
      (item) => item.filename === `${preset}.jpg`,
    );
    if (preset === "original")
      expect(
        await (await page.request.get(base + "/" + result.id)).body(),
      ).toEqual(photo);
    else {
      expect(result.size).toBeLessThan(photo.length);
      await editor.getByTitle(`Preview ${preset}.jpg`).click();
      await expect
        .poll(() => preview.getByRole("img").evaluate((el) => el.naturalWidth))
        .toBe(4000);
      await page.keyboard.press("Escape");
    }
  }
  await page.screenshot({ path: "/tmp/phooey-attachments-desktop.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  await expect(page.locator("dialog[open]")).toHaveCount(1);
  await editor.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  expect(
    await editor
      .locator(".attachment-list")
      .evaluate((el) => el.scrollHeight > el.clientHeight),
  ).toBe(true);
  await page.screenshot({ path: "/tmp/phooey-attachments-mobile.png" });
  expect(
    await editor.evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
  ).toBe(true);
  await expect(
    editor.getByRole("button", { name: "Save transaction", exact: true }),
  ).toBeEnabled();
  await editor.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(
    receiptRow.getByRole("button", {
      name: "View 6 attachments for Synthetic attachment transaction",
      exact: true,
    }),
  ).toBeVisible();
  const rowCheckbox = receiptRow.getByRole("checkbox");
  await rowCheckbox.check();
  await expect(editor).toHaveCount(0);
  await expect(rowCheckbox).toBeChecked();
  await rowCheckbox.uncheck();
  await receiptRow
    .getByRole("button", {
      name: "View 6 attachments for Synthetic attachment transaction",
      exact: true,
    })
    .click();
  await expect(
    editor.getByRole("region", { name: "Receipts and invoices", exact: true }),
  ).toBeFocused();
  page.once("dialog", (dialog) => dialog.accept());
  await editor
    .getByRole("button", { name: "Remove original.jpg", exact: true })
    .click();
  await expect(editor.getByTitle("Preview original.jpg")).toHaveCount(0);
  await editor.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(
    receiptRow.getByRole("button", {
      name: "View 5 attachments for Synthetic attachment transaction",
      exact: true,
    }),
  ).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.screenshot({ path: "/tmp/phooey-receipts-column.png" });
  await receiptRow.locator("td.transaction-date").click();
  await expect(editor).toBeVisible();
  await editor.getByRole("button", { name: "Cancel", exact: true }).click();
  await page
    .getByRole("button", { name: "Add transaction", exact: true })
    .click();
  await expect(
    editor.getByText(
      "Save this transaction, then add receipts from the Transactions table.",
    ),
  ).toBeVisible();
  expect(errors).toEqual([]);
  console.log(
    JSON.stringify(
      {
        result: "PASS",
        sourceBytes: photo.length,
        balancedBytes: balanced.size,
        smallerBytes: smaller.size,
        pdfBytes: pdf.length,
        checks: [
          "calendar presets, custom dates, and export bounds",
          "direct row uploads and receipt counts",
          "real photo compression",
          "preset persistence and future-upload-only behavior",
          "in-app image and full PDF previews",
          "zoom",
          "Escape/focus restoration",
          "PDF byte-exact download",
          "upload failure/retry",
          "remove",
          "HEIC feedback",
          "small-image fallback",
          "mobile layout",
          "unsaved transaction guidance",
        ],
      },
      null,
      2,
    ),
  );
} finally {
  await browser?.close();
  await new Promise((done) => server.close(done));
  await mf.dispose();
}
