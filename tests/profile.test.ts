import { afterEach, beforeEach, expect, it } from "vitest";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { readFile, readdir } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { hash } from "bcryptjs";

let mf: Miniflare, cookie: string;
let db: Awaited<ReturnType<Miniflare["getD1Database"]>>;
const origin = "https://profile.test";
function request(path: string, body?: unknown, headers = {}) {
  return mf.dispatchFetch(origin + "/api" + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Cookie: cookie ?? "",
      Origin: origin,
      "Content-Type": "application/json",
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
const login = (username = "test-admin") =>
  request("/login", {
    username,
    password: "synthetic password only",
  });
beforeEach(async () => {
  mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      scriptPath: "dist/phooey_finance/index.js",
      compatibilityDate: "2026-11-12",
      compatibilityFlags: ["nodejs_compat"],
      d1Databases: { DB: "profile-test" },
      r2Buckets: ["FILES"],
      queueProducers: { JOBS: "jobs" },
      bindings: {
        ADMIN_USERNAME: "test-admin",
        ADMIN_PASSWORD_HASH: await hash("synthetic password only", 4),
        ENCRYPTION_KEY: randomBytes(32).toString("base64"),
      },
    }),
  );
  db = await mf.getD1Database("DB");
  for (const file of (await readdir("migrations")).sort()) {
    await db.exec(
      (await readFile("migrations/" + file, "utf8")).replaceAll("\n", " "),
    );
  }
  const response = await login();
  expect(response.status).toBe(200);
  cookie = response.headers.get("Set-Cookie")!.split(";")[0];
});
afterEach(async () => {
  await mf?.dispose();
});

it("persists independent appearance options without changing profile, transaction values or exports", async () => {
  await request("/settings/profile", { displayName: "Finch" });
  const account = (await (
    await request("/accounts", { name: "Synthetic account" })
  ).json()) as { id: string };
  const transaction = (await (
    await request("/transactions", {
      account_id: account.id,
      posted: "2026-01-02",
      amount: -12345,
      description: "Appearance test",
      type: "expense",
    })
  ).json()) as { id: string };
  expect(transaction.id).toBeTruthy();
  const original = await db
    .prepare("SELECT * FROM transactions WHERE id=?")
    .bind(transaction.id)
    .first();
  const exportResponse = await request("/export");
  expect(exportResponse.status).toBe(200);
  const exportBefore = await exportResponse.text();
  expect(exportBefore).toContain("-123.45");
  expect(await (await request("/session")).json()).toMatchObject({
    transactionAppearance: {
      negativeAmountColor: "normal",
      showNegativeSign: true,
    },
  });
  for (const negativeAmountColor of ["red", "normal"]) {
    for (const showNegativeSign of [true, false]) {
      const appearance = { negativeAmountColor, showNegativeSign };
      const result = await request(
        "/settings/transaction-appearance",
        appearance,
      );
      expect(result.status).toBe(200);
      expect(await result.json()).toEqual(appearance);
      expect(await (await request("/session")).json()).toMatchObject({
        displayName: "Finch",
        transactionAppearance: appearance,
      });
      expect(
        await db
          .prepare("SELECT * FROM transactions WHERE id=?")
          .bind(transaction.id)
          .first(),
      ).toEqual(original);
      expect(await (await request("/export")).text()).toBe(exportBefore);
    }
  }
  await request("/settings/profile", { displayName: "Finch renamed" });
  expect(await (await request("/session")).json()).toMatchObject({
    displayName: "Finch renamed",
    transactionAppearance: {
      negativeAmountColor: "normal",
      showNegativeSign: false,
    },
  });
});

it("authorizes and validates appearance saves without changing prior preferences on failure", async () => {
  const appearance = { negativeAmountColor: "red", showNegativeSign: false };
  expect(
    (await request("/settings/transaction-appearance", appearance)).status,
  ).toBe(200);
  expect(
    (
      await request("/settings/transaction-appearance", appearance, {
        Cookie: "",
      })
    ).status,
  ).toBe(401);
  expect(
    (
      await request("/settings/transaction-appearance", appearance, {
        Origin: "https://evil.test",
      })
    ).status,
  ).toBe(403);
  for (const invalid of [
    { negativeAmountColor: "blue", showNegativeSign: true },
    { negativeAmountColor: "normal", showNegativeSign: "false" },
    {},
  ]) {
    expect(
      (await request("/settings/transaction-appearance", invalid)).status,
    ).toBe(400);
  }
  expect(await (await request("/session")).json()).toMatchObject({
    transactionAppearance: appearance,
  });
});

it("persists a trimmed profile, preserves other preferences and keeps login credentials separate", async () => {
  expect(await (await request("/session")).json()).toMatchObject({
    username: "test-admin",
    displayName: "",
  });
  await db
    .prepare("INSERT INTO settings(key,value) VALUES('preferences',?)")
    .bind(JSON.stringify({ theme: "dark", nested: { keep: true } }))
    .run();
  const response = await request("/settings/profile", {
    displayName: "  Finch 🐦  ",
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ displayName: "Finch 🐦" });
  expect(await (await request("/session")).json()).toMatchObject({
    username: "test-admin",
    displayName: "Finch 🐦",
  });
  expect(await (await request("/preferences/preferences")).json()).toEqual({
    theme: "dark",
    nested: { keep: true },
    displayName: "Finch 🐦",
  });
  expect(
    await db.prepare("SELECT * FROM admin_credentials").first(),
  ).toBeNull();
  expect((await login("Finch 🐦")).status).toBe(401);
  expect((await login()).status).toBe(200);
  expect(
    (await request("/settings/profile", { displayName: "   " })).status,
  ).toBe(200);
  expect(await (await request("/session")).json()).toMatchObject({
    username: "test-admin",
    displayName: "",
  });
});

it("requires a same-origin session and rejects bearer-only profile changes", async () => {
  expect(
    (await request("/settings/profile", { displayName: "No" }, { Cookie: "" }))
      .status,
  ).toBe(401);
  expect(
    (
      await request(
        "/settings/profile",
        { displayName: "No" },
        { Origin: "https://evil.test" },
      )
    ).status,
  ).toBe(403);
  const tokenResponse = await request("/tokens", {
    name: "test",
    scopes: ["finance:read"],
    days: 1,
  });
  const token = (await tokenResponse.json()) as { token: string };
  expect(
    (
      await request(
        "/settings/profile",
        { displayName: "No" },
        { Cookie: "", Authorization: "Bearer " + token.token },
      )
    ).status,
  ).toBe(401);
  expect(
    await db
      .prepare("SELECT value FROM settings WHERE key='preferences'")
      .first(),
  ).toBeNull();
});

it("rejects invalid names and credential edits without losing the saved name", async () => {
  await request("/settings/profile", { displayName: "Keep me" });
  for (const input of [
    { displayName: "x".repeat(81) },
    { displayName: "a\nb" },
    { displayName: 123 },
    {},
    { displayName: "New", username: "hijack" },
  ]) {
    expect((await request("/settings/profile", input)).status).toBe(400);
  }
  expect(
    (await request("/settings/profile", { displayName: "x".repeat(3000) }))
      .status,
  ).toBe(413);
  expect(await (await request("/session")).json()).toMatchObject({
    displayName: "Keep me",
  });
});

it("falls back for legacy/imported preference shapes and can save over them", async () => {
  for (const value of [
    "null",
    "[]",
    '"legacy"',
    '{"displayName":42}',
    "not json",
  ]) {
    await db
      .prepare(
        "INSERT INTO settings(key,value) VALUES('preferences',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .bind(value)
      .run();
    expect(await (await request("/session")).json()).toMatchObject({
      displayName: "",
    });
    expect(
      (await request("/settings/profile", { displayName: "Valid name" }))
        .status,
    ).toBe(200);
    expect(await (await request("/session")).json()).toMatchObject({
      displayName: "Valid name",
    });
  }
});
