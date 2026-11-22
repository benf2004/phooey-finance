// Run after npm run build: node tests/spreadsheet-ui.mjs
// Uses a disposable Worker/database and browser profile; never loads real credentials.
import { chromium, expect } from "@playwright/test";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { hash } from "bcryptjs";
import { createServer } from "node:http";
import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";

const mf = new Miniflare(
  convertV4MiniflareOptions({
    modules: true,
    scriptPath: "dist/phooey_finance/index.js",
    compatibilityDate: "2026-11-12",
    compatibilityFlags: ["nodejs_compat"],
    d1Databases: { DB: "spreadsheet-ui-test" },
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
  browser = await chromium.launch(
    existsSync(chromium.executablePath())
      ? {}
      : {
          executablePath:
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        },
  );
  const page = await browser.newPage({
    viewport: { width: 1440, height: 960 },
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(url + "/transactions");
  await page.getByLabel("Username").fill("test-admin");
  await page
    .getByLabel("Password", { exact: true })
    .fill("test-only original password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Transactions", exact: true }),
  ).toBeVisible();
  async function post(path, data) {
    const response = await page.request.post(url + "/api" + path, {
      headers: { Origin: url },
      data,
    });
    expect(response.ok()).toBeTruthy();
    return response.json();
  }
  const account = await post("/accounts", { name: "Studio checking" });
  const category = await post("/categories", {
    name: "Office supplies",
    type: "expense",
    color: "#28634a",
  });
  const transactions = [];
  for (let i = 0; i < 24; i++)
    transactions.push(
      await post("/transactions", {
        account_id: account.id,
        description:
          i === 0
            ? "Monthly software subscription for the design team and client collaboration workspace"
            : [
                "Coffee with client",
                "Print shop",
                "Project payment",
                "Cloud hosting",
              ][i % 4],
        merchant: ["Studio supply", "Coffee shop", "Printworks", "Acme client"][
          i % 4
        ],
        notes:
          i === 0
            ? "Annual plan\nIncludes five team members and priority support"
            : "",
        amount: -(12345 + i * 100),
        type: "expense",
        posted: `2026-11-${String(22 - Math.floor(i / 2)).padStart(2, "0")}`,
      }),
    );
  await page.reload();
  await page.getByRole("button", { name: "Spreadsheet", exact: true }).click();
  const sheet = page.getByRole("grid", { name: "Transactions spreadsheet" });
  await expect(sheet).toBeVisible();
  const cell = (title, row = 1) =>
    sheet.getByRole("gridcell", { name: new RegExp(`^${title}, row ${row}:`) });
  let writes = 0;
  page.on("request", (request) => {
    if (
      /\/api\/transactions\/[^/]+$/.test(request.url()) &&
      ["PATCH", "PUT"].includes(request.method())
    )
      writes++;
  });
  await cell("Description").click();
  await expect(
    page.getByRole("dialog", { name: "Edit Description" }),
  ).toHaveCount(0);
  await cell("Description").dblclick();
  await expect(
    page.getByRole("dialog", { name: "Edit Description" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Save cell" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Cancel edit" })).toHaveCount(
    0,
  );
  await page
    .getByRole("textbox", { name: "Description", exact: true })
    .fill("Updated software subscription");
  await cell("Merchant", 2).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(cell("Description")).toContainText(
    "Updated software subscription",
  );
  expect(writes).toBe(1);
  await cell("Description").press("F2");
  await page
    .getByRole("textbox", { name: "Description", exact: true })
    .fill("Discard this edit");
  await page
    .getByRole("textbox", { name: "Description", exact: true })
    .press("Escape");
  await expect(cell("Description")).toContainText(
    "Updated software subscription",
  );
  expect(writes).toBe(1);
  await cell("Description").press("Enter");
  await page
    .getByRole("textbox", { name: "Description", exact: true })
    .press("Tab");
  await expect(cell("Tags")).toBeFocused();
  expect(writes).toBe(1);
  await cell("Tags").press("ArrowRight");
  await expect(cell("Account")).toBeFocused();
  await cell("Account").press("Enter");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(cell("Account")).toHaveAttribute("aria-readonly", "true");

  // A multiline edit expands without changing the table's column widths.
  const initialWidth = (await cell("Notes").boundingBox()).width;
  await cell("Notes").dblclick();
  await page
    .getByRole("button", { name: "Expand editor", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "Notes", exact: true })
    .fill(
      "Long note for the team about this purchase, including its purpose and the supporting receipt.",
    );
  await page.getByRole("textbox", { name: "Notes", exact: true }).press("End");
  await page
    .getByRole("textbox", { name: "Notes", exact: true })
    .press("Shift+Enter");
  await page
    .getByRole("textbox", { name: "Notes", exact: true })
    .pressSequentially("Second line kept intact.");
  await page.screenshot({ path: "/tmp/phooey-spreadsheet-editor.png" });
  await page.getByRole("textbox", { name: "Notes", exact: true }).press("Tab");
  await expect(cell("Review")).toBeFocused();
  await expect(cell("Notes")).toContainText("Second line kept intact.");
  expect((await cell("Notes").boundingBox()).width).toBe(initialWidth);
  const clippedHeight = (await cell("Notes").boundingBox()).height;
  await page.getByRole("button", { name: "Wrap text", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Wrap text", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  expect((await cell("Notes").boundingBox()).height).toBeGreaterThan(
    clippedHeight,
  );

  // Typed tags are included on Tab, even without pressing Add tag.
  await cell("Tags").dblclick();
  await page
    .getByRole("combobox", { name: "Add a tag", exact: true })
    .fill("Design");
  await page
    .getByRole("combobox", { name: "Add a tag", exact: true })
    .press("Tab");
  await expect(cell("Tags")).toContainText("Design");
  await expect(cell("Account")).toBeFocused();
  await cell("Tags").dblclick();
  await page
    .getByRole("combobox", { name: "Add a tag", exact: true })
    .fill("Client");
  await cell("Description", 2).click();
  await expect(cell("Tags")).toContainText("Client");

  await cell("Category").dblclick();
  await page
    .getByRole("combobox", { name: "Category", exact: true })
    .selectOption(category.id);
  await page
    .getByRole("combobox", { name: "Category", exact: true })
    .press("Tab");
  await expect(cell("Category")).toContainText("Office supplies");
  // Invalid values remain in the editor; correcting them can be retried without losing the draft.
  await cell("Amount").dblclick();
  await page
    .getByRole("textbox", { name: "Amount", exact: true })
    .fill("invalid");
  await page
    .getByRole("textbox", { name: "Amount", exact: true })
    .press("Enter");
  await expect(page.getByRole("alert")).toContainText("Your edit is kept here");
  await expect(
    page.getByRole("textbox", { name: "Amount", exact: true }),
  ).toHaveValue("invalid");
  await page
    .getByRole("textbox", { name: "Amount", exact: true })
    .fill("-135.25");
  await page
    .getByRole("textbox", { name: "Amount", exact: true })
    .press("Enter");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(cell("Amount")).toContainText("135.25");

  // A failed request keeps the draft and allows retry; rapid blur/Tab submits once.
  let reject = true;
  await page.route("**/api/transactions/*", async (route) => {
    if (route.request().method() === "PATCH" && reject) {
      reject = false;
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "Temporary connection issue" }),
      });
    } else await route.continue();
  });
  await cell("Merchant").dblclick();
  await page
    .getByRole("textbox", { name: "Merchant", exact: true })
    .fill("New merchant");
  await page
    .getByRole("textbox", { name: "Merchant", exact: true })
    .press("Tab");
  await expect(page.getByRole("alert")).toContainText(
    "Temporary connection issue",
  );
  await expect(
    page.getByRole("textbox", { name: "Merchant", exact: true }),
  ).toHaveValue("New merchant");
  await page
    .getByRole("textbox", { name: "Merchant", exact: true })
    .press("Tab");
  await expect(cell("Merchant")).toContainText("New merchant");
  await page.unroute("**/api/transactions/*");
  await page.reload();
  await expect(cell("Merchant")).toContainText("New merchant");
  await expect(cell("Tags")).toContainText("Design");
  await expect(cell("Tags")).toContainText("Client");
  await expect(cell("Notes")).toContainText("Second line kept intact.");
  await expect(
    page.getByRole("button", { name: "Wrap text", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await cell("Description").click();
  await page.screenshot({ path: "/tmp/phooey-spreadsheet-desktop.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await cell("Notes").dblclick();
  const editorBounds = await page
    .getByRole("dialog", { name: "Edit Notes" })
    .boundingBox();
  expect(editorBounds.x).toBeGreaterThanOrEqual(0);
  expect(editorBounds.x + editorBounds.width).toBeLessThanOrEqual(390);
  await page.screenshot({ path: "/tmp/phooey-spreadsheet-mobile.png" });
  await page
    .getByRole("textbox", { name: "Notes", exact: true })
    .press("Escape");
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto(url + "/accounts");
  await page.getByRole("button", { name: "Spreadsheet", exact: true }).click();
  const accountCell = page.getByRole("gridcell", { name: /^Account, row 1:/ });
  await accountCell.dblclick();
  await page
    .getByRole("textbox", { name: "Account", exact: true })
    .fill("Studio operating");
  await page
    .getByRole("textbox", { name: "Account", exact: true })
    .press("Tab");
  await expect(accountCell).toContainText("Studio operating");
  expect(errors).toEqual([]);
  console.log(
    "Spreadsheet UI checks passed: selection, double-click, autosave, keyboard, multiline, wrapping, tags, dropdowns, read-only cells, validation, retry, persistence, mobile, and accounts.",
  );
} finally {
  await browser?.close();
  await new Promise((done) => server.close(done));
  await mf.dispose();
}
