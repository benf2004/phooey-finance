// Run after npm run build: node tests/password-ui.mjs
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
    d1Databases: { DB: "password-ui-test" },
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
  for (const file of (await readdir("migrations")).sort()) {
    await db.exec(
      (await readFile("migrations/" + file, "utf8")).replaceAll("\n", " "),
    );
  }
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const url = `http://127.0.0.1:${server.address().port}`;
  const systemChrome =
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  browser = await chromium.launch({
    ...(existsSync(chromium.executablePath())
      ? {}
      : existsSync(systemChrome)
        ? { executablePath: systemChrome }
        : {}),
  });
  const page = await browser.newPage({
    viewport: { width: 1280, height: 900 },
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(url + "/connections");
  await page.getByLabel("Username").fill("test-admin");
  await page
    .getByLabel("Password", { exact: true })
    .fill("test-only original password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(
    page.getByRole("heading", { name: "Settings", exact: true }),
  ).toBeVisible();
  const tabs = page.getByRole("tablist", { name: "Settings sections" });
  const connectionsTab = tabs.getByRole("tab", { name: "Connections", exact: true });
  const dataTab = tabs.getByRole("tab", { name: "Data", exact: true });
  const profileTab = tabs.getByRole("tab", { name: "Profile & password", exact: true });
  const appearanceTab = tabs.getByRole("tab", { name: "Appearance", exact: true });
  await expect(tabs.getByRole("tab")).toHaveCount(4);
  await expect(connectionsTab).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tabpanel")).toHaveCount(1);
  await expect(page.getByRole("heading", { name: "Bank connection" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "AI & MCP access" })).toBeVisible();
  await expect(page.getByLabel("Display name", { exact: true })).toBeHidden();
  await page.screenshot({ path: "/tmp/phooey-settings-connections.png", animations: "disabled" });
  await page.getByRole("button", { name: "Create access token", exact: true }).click();
  await expect(page.getByRole("dialog").getByLabel("Connection name")).toHaveValue("Personal assistant");
  await page.getByRole("dialog").getByRole("button", { name: "Cancel", exact: true }).click();
  await connectionsTab.focus();
  await page.keyboard.press("ArrowRight");
  await expect(dataTab).toBeFocused();
  await expect(dataTab).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("link", { name: "Full backup", exact: true })).toHaveAttribute("href", "/api/backup");
  await expect(page.getByRole("link", { name: "All transactions", exact: true })).toHaveAttribute("href", "/api/export");
  await expect(page.getByRole("heading", { name: "Activity", exact: true })).toBeVisible();
  await page.getByText("Restore a backup", { exact: true }).click();
  await expect(page.getByLabel("Choose a Phooey JSON backup")).toBeVisible();
  await page.getByRole("button", { name: "Delete all transactions", exact: true }).click();
  await expect(page.getByRole("dialog").getByRole("button", { name: "Delete all transactions", exact: true })).toBeDisabled();
  await page.getByRole("dialog").getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("button", { name: "Import CSV", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  await dataTab.focus();
  await page.keyboard.press("End");
  await expect(appearanceTab).toBeFocused();
  await expect(page.getByLabel("Color theme")).toBeVisible();
  await page.getByLabel("Color theme").selectOption("dark");
  await page.reload();
  await expect(appearanceTab).toHaveAttribute("aria-selected", "true");
  await expect(page.getByLabel("Color theme")).toHaveValue("dark");
  await page.getByRole("button", { name: "Use light theme" }).click();
  await expect(page.getByLabel("Color theme")).toHaveValue("light");
  await appearanceTab.focus();
  await page.keyboard.press("Home");
  await expect(connectionsTab).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(appearanceTab).toBeFocused();
  await page.goBack();
  await expect(connectionsTab).toHaveAttribute("aria-selected", "true");
  await profileTab.click();
  await page.getByLabel("Display name", { exact: true }).fill("Unsaved tab draft");
  await page.getByLabel("Current password", { exact: true }).fill("Unsaved password draft");
  await appearanceTab.click();
  await page.getByLabel("Negative amount color").selectOption("red");
  await profileTab.click();
  await expect(page.getByLabel("Display name", { exact: true })).toHaveValue("Unsaved tab draft");
  await expect(page.getByLabel("Current password", { exact: true })).toHaveValue("Unsaved password draft");
  await appearanceTab.click();
  await expect(page.getByLabel("Negative amount color")).toHaveValue("red");
  await page.getByLabel("Negative amount color").selectOption("normal");
  await expect(page.getByRole("status")).toHaveText("Appearance saved.");
  await page.setViewportSize({ width: 390, height: 844 });
  await profileTab.click();
  await expect(page.getByLabel("Display name", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect.poll(() => page.locator("#app-sidebar").evaluate((element) => element.getBoundingClientRect().right)).toBeLessThanOrEqual(1);
  await page.screenshot({ path: "/tmp/phooey-settings-mobile.png", animations: "disabled" });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByText("About Phooey Finance", { exact: true }).click();
  await expect(page.getByRole("link", { name: "Download source", exact: true })).toHaveAttribute("href", "/source.tar.gz");
  await expect(page.getByRole("link", { name: "License", exact: true })).toHaveAttribute("href", "/LICENSE.txt");
  await page.getByText("About Phooey Finance", { exact: true }).click();
  const displayName = page.getByLabel("Display name", { exact: true });
  const saveName = page.getByRole("button", { name: "Save display name" });
  await displayName.fill("  Finch Test  ");
  await saveName.click();
  await expect(page.getByRole("status")).toHaveText("Display name saved.");
  await expect(displayName).toHaveValue("Finch Test");
  const renamedAccount = page.getByRole("link", { name: "Finch Test account settings" });
  await expect(renamedAccount).toBeVisible();
  await expect(renamedAccount.locator(".avatar")).toBeVisible();
  await page.getByRole("button", { name: "Collapse sidebar" }).click();
  await page.reload();
  await expect(page.getByRole("button", { name: "Expand sidebar" })).toBeVisible();
  await expect(renamedAccount).toBeVisible();
  await expect(displayName).toHaveValue("Finch Test");
  await renamedAccount.focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(url + "/settings");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Toggle navigation" }).click();
  await expect(renamedAccount.locator(".account-name")).toBeVisible();
  await renamedAccount.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Toggle navigation" })).toHaveAttribute("aria-expanded", "false");
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByRole("button", { name: "Expand sidebar" }).click();
  await profileTab.click();
  await page.route("**/api/settings/profile", (route) => route.fulfill({
    status: 503, contentType: "application/json", body: JSON.stringify({ error: "Synthetic save failure" }),
  }));
  await displayName.fill("Unsaved name");
  await saveName.click();
  await expect(page.getByRole("alert")).toHaveText("Synthetic save failure");
  await expect(renamedAccount).toBeVisible();
  await page.unroute("**/api/settings/profile");
  const literalName = '<img src=x onerror="alert(1)">';
  await displayName.fill(literalName);
  await saveName.click();
  const literalAccount = page.getByRole("link", { name: literalName + " account settings" });
  await expect(literalAccount).toBeVisible();
  await expect(literalAccount.locator("img")).toHaveCount(0);
  await displayName.fill("   ");
  await saveName.click();
  await expect(displayName).toHaveValue("");
  await expect(page.getByRole("link", { name: "test-admin account settings" })).toBeVisible();
  await page.reload();
  await connectionsTab.click();
  await expect(
    page.getByRole("heading", { name: "Bank connection" }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "MCP access" })).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Settings & connections" }),
  ).toHaveCount(0);
  const account = page.getByRole("link", {
    name: "test-admin account settings",
  });
  await account.focus();
  await expect(account).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(url + "/settings");
  await expect(account).toHaveAttribute("aria-current", "page");
  await profileTab.click();
  const current = page.getByLabel("Current password", { exact: true });
  const next = page.getByLabel(/^New password/);
  const confirmation = page.getByLabel("Confirm new password", { exact: true });
  const submit = page.getByRole("button", { name: "Change password" });
  let submissions = 0;
  page.on("request", (request) => {
    if (request.url().endsWith("/api/settings/password")) submissions++;
  });
  await current.fill("incorrect password");
  await next.fill("test-only replacement password");
  await confirmation.fill("mismatched password");
  await submit.click();
  await expect(page.getByRole("alert")).toHaveText(
    "New passwords do not match.",
  );
  expect(submissions).toBe(0);
  await confirmation.fill("test-only replacement password");
  await submit.click();
  await expect(page.getByRole("alert")).toHaveText(
    "Current password is incorrect.",
  );
  await current.fill("test-only original password");
  await submit.click();
  await expect(page.getByRole("status")).toContainText("Password changed.");
  await expect(current).toHaveValue("");
  await expect(next).toHaveValue("");
  await expect(confirmation).toHaveValue("");
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Settings", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.getByLabel("Username").fill("test-admin");
  await page
    .getByLabel("Password", { exact: true })
    .fill("test-only replacement password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(
    page.getByRole("heading", { name: "Settings", exact: true }),
  ).toBeVisible();
  const accountResponse = await page.request.post(url + "/api/accounts", {
    headers: { Origin: url }, data: { name: "Synthetic appearance account" },
  });
  expect(accountResponse.status()).toBe(200);
  const testAccount = await accountResponse.json();
  for (const [description, amount] of [["Synthetic outgoing appearance", -12345], ["Synthetic incoming appearance", 2500]]) {
    const response = await page.request.post(url + "/api/transactions", {
      headers: { Origin: url }, data: { account_id: testAccount.id, description, amount,
        posted: new Date().toISOString().slice(0, 10), type: amount < 0 ? "expense" : "income" },
    });
    expect(response.status()).toBe(200);
  }
  if (await page.getByRole("button", { name: "Use light theme" }).count())
    await page.getByRole("button", { name: "Use light theme" }).click();
  await appearanceTab.click();
  const colorChoice = page.getByLabel("Negative amount color");
  const showMinus = page.getByLabel("Show minus sign for negative amounts");
  const preview = page.getByRole("group", { name: "Transaction amount preview" });
  await expect(colorChoice).toHaveValue("normal");
  await expect(showMinus).toBeChecked();
  for (const color of ["red", "normal"]) {
    for (const showSign of [true, false]) {
      await colorChoice.selectOption(color);
      await showMinus.setChecked(showSign);
      const expectedText = showSign ? "-$123.45" : "$123.45";
      await expect(preview.locator('.transaction-amount > span[aria-hidden="true"]')).toHaveText(expectedText);
      await expect(preview.locator(".transaction-amount-accessible")).toHaveText("Outgoing, -$123.45");
      await expect(preview.locator(".transaction-amount")).toHaveCSS("color", color === "red" ? "rgb(175, 73, 64)" : "rgb(32, 37, 43)");
      await expect(page.getByRole("button", { name: "Save appearance" })).toHaveCount(0);
      await expect(page.getByRole("status")).toHaveText("Appearance saved.");
      await page.reload();
      await expect(colorChoice).toHaveValue(color);
      if (showSign) await expect(showMinus).toBeChecked();
      else await expect(showMinus).not.toBeChecked();
      await page.getByRole("link", { name: "Transactions", exact: true }).click();
      const outgoing = page.getByRole("row").filter({ hasText: "Synthetic outgoing appearance" });
      const incoming = page.getByRole("row").filter({ hasText: "Synthetic incoming appearance" });
      await expect(outgoing.locator('.transaction-amount > span[aria-hidden="true"]')).toHaveText(expectedText);
      await expect(outgoing.locator(".transaction-amount")).toHaveCSS("color", color === "red" ? "rgb(175, 73, 64)" : "rgb(32, 37, 43)");
      await expect(incoming.locator('.transaction-amount > span[aria-hidden="true"]')).toHaveText("+$25.00");
      await page.getByRole("link", { name: "test-admin account settings" }).click();
      await appearanceTab.click();
    }
  }
  // Delay successive saves to verify the latest selection wins even after navigation.
  let releaseFirst, releaseSecond, sawFirst, sawSecond;
  const firstSeen = new Promise((resolve) => { sawFirst = resolve; });
  const secondSeen = new Promise((resolve) => { sawSecond = resolve; });
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const secondGate = new Promise((resolve) => { releaseSecond = resolve; });
  const appearanceWrites = [];
  await page.route("**/api/settings/transaction-appearance", async (route) => {
    appearanceWrites.push(route.request().postDataJSON());
    if (appearanceWrites.length === 1) { sawFirst(); await firstGate; }
    if (appearanceWrites.length === 2) { sawSecond(); await secondGate; }
    await route.continue();
  });
  await colorChoice.selectOption("red");
  await firstSeen;
  await showMinus.check();
  await colorChoice.selectOption("normal");
  await expect(page.getByRole("status")).toHaveText("Saving appearance…");
  await expect(preview.locator('.transaction-amount > span[aria-hidden="true"]')).toHaveText("-$123.45");
  expect(appearanceWrites).toHaveLength(1);
  await page.getByRole("link", { name: "Transactions", exact: true }).click();
  const rapidRow = page.getByRole("row").filter({ hasText: "Synthetic outgoing appearance" });
  await expect(rapidRow.locator('.transaction-amount > span[aria-hidden="true"]')).toHaveText("-$123.45");
  releaseFirst();
  await secondSeen;
  expect(appearanceWrites).toEqual([
    { negativeAmountColor: "red", showNegativeSign: false },
    { negativeAmountColor: "normal", showNegativeSign: true },
  ]);
  await expect(rapidRow.locator(".transaction-amount")).toHaveCSS("color", "rgb(32, 37, 43)");
  await expect(rapidRow.locator('.transaction-amount > span[aria-hidden="true"]')).toHaveText("-$123.45");
  releaseSecond();
  await expect.poll(async () => (await (await page.request.get(url + "/api/session")).json()).transactionAppearance)
    .toEqual({ negativeAmountColor: "normal", showNegativeSign: true });
  await page.unroute("**/api/settings/transaction-appearance");
  await page.getByRole("link", { name: "test-admin account settings" }).click();
  await appearanceTab.click();
  await page.route("**/api/settings/transaction-appearance", (route) => route.fulfill({
    status: 503, contentType: "application/json", body: JSON.stringify({ error: "Synthetic autosave failure" }),
  }));
  await colorChoice.selectOption("red");
  await expect(page.getByRole("alert")).toContainText("Appearance changes aren’t saved.");
  await expect(colorChoice).toHaveValue("red");
  await page.getByRole("link", { name: "Transactions", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Synthetic autosave failure");
  await expect(rapidRow.locator(".transaction-amount")).toHaveCSS("color", "rgb(175, 73, 64)");
  await page.unroute("**/api/settings/transaction-appearance");
  await page.getByRole("button", { name: "Retry appearance save" }).click();
  await expect.poll(async () => (await (await page.request.get(url + "/api/session")).json()).transactionAppearance)
    .toEqual({ negativeAmountColor: "red", showNegativeSign: true });
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page.getByRole("link", { name: "test-admin account settings" }).click();
  await appearanceTab.click();
  await page.reload();
  await expect(colorChoice).toHaveValue("red");
  await expect(showMinus).toBeChecked();
  await colorChoice.selectOption("normal");
  await showMinus.uncheck();
  await expect(page.getByRole("status")).toHaveText("Appearance saved.");
  await page.getByRole("link", { name: "Overview", exact: true }).click();
  await expect(page.getByRole("row").filter({ hasText: "Synthetic outgoing appearance" })
    .locator('.transaction-amount > span[aria-hidden="true"]')).toHaveText("$123.45");
  await page.getByRole("link", { name: "Transactions", exact: true }).click();
  const outgoing = page.getByRole("row").filter({ hasText: "Synthetic outgoing appearance" });
  await page.getByRole("button", { name: "Use dark theme" }).click();
  const normalDarkColor = await page.locator("body").evaluate((element) => getComputedStyle(element).color);
  await expect(outgoing.locator(".transaction-amount")).toHaveCSS("color", normalDarkColor);
  expect(normalDarkColor).not.toBe("rgb(0, 0, 0)");
  await outgoing.click();
  await expect(page.getByRole("dialog").getByLabel(/^Amount/)).toHaveValue("-123.45");
  expect(errors).toEqual([]);
  console.log(
    "PASS: four settings tabs and profile/password flows; appearance autosave, serialized rapid changes, navigation during saves, failure/retry, reload persistence, no visible replacement for hidden minus signs, accessible sign context, and unchanged signed editing values.",
  );
} finally {
  await browser?.close();
  await new Promise((done) => server.close(done));
  await mf.dispose();
}
