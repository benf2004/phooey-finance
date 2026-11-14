import { beforeEach, afterEach, expect, it } from "vitest";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { readFile, readdir } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { compare, getRounds, hash } from "bcryptjs";

let mf: Miniflare, cookie: string, bootstrapHash: string;
let db: Awaited<ReturnType<Miniflare["getD1Database"]>>;
const oldPassword = "test-password-only";
const newPassword = "a new test password 🐦";
const options = (passwordHash: string) =>
  convertV4MiniflareOptions({
    modules: true,
    scriptPath: "dist/phooey_finance/index.js",
    compatibilityDate: "2026-11-12",
    compatibilityFlags: ["nodejs_compat"],
    d1Databases: { DB: "password-test" },
    r2Buckets: ["FILES"],
    queueProducers: { JOBS: "jobs" },
    bindings: {
      ADMIN_USERNAME: "admin",
      ADMIN_PASSWORD_HASH: passwordHash,
      ENCRYPTION_KEY: randomBytes(32).toString("base64"),
    },
  });
function request(
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  return mf.dispatchFetch("https://example.test/api" + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Origin: "https://example.test",
      Cookie: cookie ?? "",
      "Content-Type": "application/json",
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
const login = (password = oldPassword) =>
  request("/login", { username: "admin", password });
const change = (overrides = {}, headers = {}) =>
  request(
    "/settings/password",
    {
      currentPassword: oldPassword,
      newPassword,
      confirmPassword: newPassword,
      ...overrides,
    },
    headers,
  );
const getCookie = (response: Awaited<ReturnType<Miniflare["dispatchFetch"]>>) =>
  response.headers.get("Set-Cookie")!.split(";")[0];

beforeEach(async () => {
  bootstrapHash = await hash(oldPassword, 4);
  mf = new Miniflare(options(bootstrapHash));
  db = await mf.getD1Database("DB");
  for (const file of (await readdir("migrations")).sort()) {
    await db.exec(
      (await readFile("migrations/" + file, "utf8")).replaceAll("\n", " "),
    );
  }
  const signedIn = await login();
  expect(signedIn.status).toBe(200);
  cookie = getCookie(signedIn);
});
afterEach(async () => {
  await mf?.dispose();
});

it("requires a browser session and same-origin request, even for privileged bearer tokens", async () => {
  const tokenResponse = await request("/tokens", {
    name: "test",
    scopes: ["finance:read", "transactions:write", "tax:write"],
    days: 1,
  });
  expect(tokenResponse.status).toBe(200);
  const { token } = (await tokenResponse.json()) as { token: string };
  expect((await change({}, { Cookie: "" })).status).toBe(401);
  expect(
    (await change({}, { Cookie: "", Authorization: "Bearer " + token })).status,
  ).toBe(401);
  expect((await change({}, { Origin: "https://evil.test" })).status).toBe(403);
  expect((await change({}, { Origin: "" })).status).toBe(403);
  expect(
    await db.prepare("SELECT * FROM admin_credentials").first(),
  ).toBeNull();
});

it("validates current password, confirmation, length and bcrypt's UTF-8 byte limit", async () => {
  for (const [overrides, message] of [
    [{ currentPassword: "wrong" }, "Current password is incorrect"],
    [{ confirmPassword: "does not match" }, "do not match"],
    [{ newPassword: "short", confirmPassword: "short" }, "at least 12"],
    [
      { newPassword: "é".repeat(37), confirmPassword: "é".repeat(37) },
      "72 UTF-8 bytes",
    ],
    [{ newPassword: oldPassword, confirmPassword: oldPassword }, "different"],
  ] as const) {
    const result = await change(overrides);
    expect(result.status).toBe(400);
    expect(await result.text()).toContain(message);
  }
  expect(
    (
      await request("/settings/password", {
        currentPassword: {},
        newPassword: 12,
      })
    ).status,
  ).toBe(400);
  expect(
    (await request("/settings/password", { currentPassword: "x".repeat(5000) }))
      .status,
  ).toBe(413);
  expect(
    await db.prepare("SELECT * FROM admin_credentials").first(),
  ).toBeNull();
  expect((await request("/session")).status).toBe(200);
});

it("rate limits current-password guessing per account across browser sessions", async () => {
  for (let attempt = 0; attempt < 5; attempt++) {
    cookie = getCookie(await login());
    expect((await change({ currentPassword: "wrong" })).status).toBe(400);
  }
  const blocked = await change();
  expect(blocked.status).toBe(429);
  expect(await blocked.text()).toContain("Too many requests");
  expect(
    await db.prepare("SELECT * FROM admin_credentials").first(),
  ).toBeNull();
});

it("stores only a cost-12 hash, rotates the current cookie and invalidates all previous sessions", async () => {
  const firstCookie = cookie;
  const secondCookie = getCookie(await login());
  const response = await change();
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true });
  expect(response.headers.get("Set-Cookie")).toContain(
    "HttpOnly; SameSite=Strict",
  );
  expect(response.headers.get("Set-Cookie")).toContain("; Secure");
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  const replacement = getCookie(response);
  expect(replacement).not.toBe(firstCookie);
  for (const oldCookie of [firstCookie, secondCookie]) {
    expect(
      (await request("/session", undefined, { Cookie: oldCookie })).status,
    ).toBe(401);
    expect((await change({}, { Cookie: oldCookie })).status).toBe(401);
  }
  cookie = replacement;
  expect((await request("/session")).status).toBe(200);
  expect((await login()).status).toBe(401);
  expect((await login(newPassword)).status).toBe(200);
  const stored = await db
    .prepare("SELECT * FROM admin_credentials")
    .first<{ password_hash: string }>();
  expect(stored).not.toBeNull();
  expect(getRounds(stored!.password_hash)).toBe(12);
  expect(await compare(newPassword, stored!.password_hash)).toBe(true);
  expect(JSON.stringify(stored)).not.toContain(newPassword);
  const audit = await db
    .prepare("SELECT * FROM audit WHERE action='password_change'")
    .all();
  expect(audit.results).toHaveLength(1);
  expect(JSON.stringify(audit)).not.toContain(newPassword);
  expect(JSON.stringify(audit)).not.toContain(stored!.password_hash);
  const backup = await (await request("/backup")).text();
  expect(backup).not.toContain("admin_credentials");
  expect(backup).not.toContain(stored!.password_hash);
});

it("supports subsequent password changes and the exact 72-byte boundary", async () => {
  cookie = getCookie(await change());
  const boundaryPassword = "é".repeat(36);
  const response = await change({
    currentPassword: newPassword,
    newPassword: boundaryPassword,
    confirmPassword: boundaryPassword,
  });
  expect(response.status).toBe(200);
  cookie = getCookie(response);
  expect((await login(newPassword)).status).toBe(401);
  expect((await login(boundaryPassword)).status).toBe(200);
});

it("allows only one competing change and rolls back the losing transaction", async () => {
  const competingPassword = "another test password";
  const responses = await Promise.all([
    change(),
    change({
      newPassword: competingPassword,
      confirmPassword: competingPassword,
    }),
  ]);
  expect(responses.filter((response) => response.status === 200)).toHaveLength(
    1,
  );
  expect([400, 401, 409]).toContain(
    responses.find((response) => response.status !== 200)!.status,
  );
  const winner = responses.findIndex((response) => response.status === 200);
  cookie = getCookie(responses[winner]);
  expect((await request("/session")).status).toBe(200);
  expect(
    (await login(winner === 0 ? newPassword : competingPassword)).status,
  ).toBe(200);
  expect(
    (await login(winner === 0 ? competingPassword : newPassword)).status,
  ).toBe(401);
  expect(
    (
      await db
        .prepare("SELECT * FROM audit WHERE action='password_change'")
        .all()
    ).results,
  ).toHaveLength(1);
  expect(
    (await db.prepare("SELECT * FROM write_guards").all()).results,
  ).toHaveLength(0);
});

it("preserves the password through ledger restore and data reset", async () => {
  cookie = getCookie(await change());
  const original = await db.prepare("SELECT * FROM admin_credentials").first();
  const backup = await (await request("/backup")).json();
  expect((await request("/restore", backup)).status).toBe(200);
  expect(await db.prepare("SELECT * FROM admin_credentials").first()).toEqual(
    original,
  );
  expect(
    (
      await request("/settings/reset", {
        scope: "everything",
        confirmation: "RESET EVERYTHING",
      })
    ).status,
  ).toBe(200);
  expect(await db.prepare("SELECT * FROM admin_credentials").first()).toEqual(
    original,
  );
  expect((await request("/session")).status).toBe(200);
  expect((await login()).status).toBe(401);
  expect((await login(newPassword)).status).toBe(200);
});

it("preserves overrides on redeploy and supports server-secret recovery", async () => {
  cookie = getCookie(await change());
  await mf.setOptions(options(bootstrapHash));
  expect((await request("/session")).status).toBe(200);
  expect((await login()).status).toBe(401);
  expect((await login(newPassword)).status).toBe(200);
  const recoveryPassword = "test-only recovery password";
  await mf.setOptions(options(await hash(recoveryPassword, 4)));
  expect((await request("/session")).status).toBe(401);
  expect((await login(newPassword)).status).toBe(401);
  const recovered = await login(recoveryPassword);
  expect(recovered.status).toBe(200);
  cookie = getCookie(recovered);
  expect((await change({ currentPassword: recoveryPassword })).status).toBe(
    200,
  );
  expect((await login(newPassword)).status).toBe(200);
});
