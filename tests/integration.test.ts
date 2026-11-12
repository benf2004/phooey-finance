import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { readFile } from "node:fs/promises";
import { hash as passwordHash } from "bcryptjs";
import { randomBytes, createHash } from "node:crypto";
let mf: Miniflare, cookie: string;
let db: Awaited<ReturnType<Miniflare["getD1Database"]>>;
let account: string, other: string, txId: string;
let seq = 0;
async function req(
  path: string,
  method = "GET",
  body?: unknown,
  extra: Record<string, string> = {},
) {
  return mf.dispatchFetch("http://127.0.0.1" + path, {
    method,
    headers: {
      Host: "127.0.0.1",
      Origin: "http://127.0.0.1",
      Cookie: cookie ?? "",
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...extra,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}
async function json(
  path: string,
  method = "GET",
  body?: unknown,
  extra: Record<string, string> = {},
) {
  const r = await req(path, method, body, extra);
  const data = (await r.json()) as Record<string, any>;
  expect(r.status, JSON.stringify(data)).toBeLessThan(300);
  return data;
}
beforeAll(async () => {
  mf = new Miniflare(
    convertV4MiniflareOptions({
      name: "test",
      modules: true,
      scriptPath: "dist/phooey_finance/index.js",
      compatibilityDate: "2026-11-12",
      compatibilityFlags: ["nodejs_compat"],
      d1Databases: { DB: "test" },
      r2Buckets: ["FILES"],
      queueProducers: { JOBS: "jobs" },
      bindings: {
        ADMIN_USERNAME: "admin",
        ADMIN_PASSWORD_HASH: await passwordHash("test-password-only", 4),
        ENCRYPTION_KEY: randomBytes(32).toString("base64"),
        SOURCE_URL: "https://github.com/benf2004/phooey-finance",
      },
    }),
  );
  db = await mf.getD1Database("DB");
  await db.exec(
    (await readFile("migrations/0001_initial.sql", "utf8")).replaceAll(
      "\n",
      " ",
    ),
  );
  await db.exec(await readFile("migrations/0002_sync_recovery.sql", "utf8"));
  await db.exec(
    (await readFile("migrations/0003_sync_generation.sql", "utf8")).replaceAll(
      "\n",
      " ",
    ),
  );
  const login = await req("/api/login", "POST", {
    username: "admin",
    password: "test-password-only",
  });
  expect(login.status).toBe(200);
  cookie = login.headers.get("Set-Cookie")!.split(";")[0];
});
afterAll(async () => await mf?.dispose());
describe("real Worker and D1 integration", () => {
  it("protects APIs and rejects cross-origin mutations", async () => {
    expect(
      (await mf.dispatchFetch("http://127.0.0.1/api/accounts")).status,
    ).toBe(401);
    expect(
      (await req("/api/accounts", "POST", {}, { Origin: "https://evil.test" }))
        .status,
    ).toBe(403);
    expect((await mf.dispatchFetch("http://127.0.0.1/mcp")).status).toBe(401);
  });
  it("creates accounts and preserves distinct currencies", async () => {
    account = (
      await json("/api/accounts", "POST", { name: "Checking", balance: 100000 })
    ).id;
    other = (await json("/api/accounts", "POST", { name: "Savings" })).id;
    expect((await json("/api/accounts")).length).toBe(2);
  });
  it("makes transaction creation and edits retry-safe", async () => {
    const transaction = {
      account_id: account,
      posted: "2026-01-02",
      amount: -10000,
      description: "Office purchase",
      category_id: "office",
      type: "expense",
      reviewed: true,
    };
    const created = await json("/api/transactions", "POST", transaction, {
      "Idempotency-Key": "create-one",
    });
    txId = created.id;
    expect(
      (
        await json("/api/transactions", "POST", transaction, {
          "Idempotency-Key": "create-one",
        })
      ).id,
    ).toBe(txId);
    const edit = {
      transaction: { ...transaction, notes: "Reconciled" },
      revision: 1,
    };
    expect(
      (
        await json("/api/transactions/" + txId, "PUT", edit, {
          "Idempotency-Key": "edit-one",
        })
      ).revision,
    ).toBe(2);
    expect(
      (
        await json("/api/transactions/" + txId, "PUT", edit, {
          "Idempotency-Key": "edit-one",
        })
      ).revision,
    ).toBe(2);
    expect((await req("/api/transactions/" + txId, "PUT", edit)).status).toBe(
      409,
    );
  });
  it("supports full text search and compound filters", async () => {
    const results = await json(
      "/api/transactions?q=office&account=" + account + "&type=expense",
    );
    expect(results.total).toBe(1);
    expect(results.items[0].notes).toBe("Reconciled");
  });
  it("keeps audit records flat after repeated edits", async () => {
    let tx = await json("/api/transactions/" + txId);
    for (let i = 0; i < 8; i++) {
      await json("/api/transactions/" + txId, "PUT", {
        transaction: {
          ...tx,
          reviewed: !!tx.reviewed,
          pending: !!tx.pending,
          notes: "Edit " + i,
        },
        revision: tx.revision,
      });
      tx = await json("/api/transactions/" + txId);
    }
    const audits = await db
      .prepare("SELECT before_json FROM audit WHERE entity_id=?")
      .bind(txId)
      .all();
    expect(
      audits.results.every(
        (r: any) => !String(r.before_json).includes('"history"'),
      ),
    ).toBe(true);
  });
  it("reconciles splits and excludes transfers from reports", async () => {
    await json("/api/transactions", "POST", {
      account_id: account,
      posted: "2026-02-01",
      amount: -15000,
      description: "Split purchase",
      type: "expense",
      splits: [
        { amount: -10000, category_id: "office", type: "expense" },
        { amount: -5000, category_id: "groceries", type: "expense" },
      ],
    });
    const a = await json("/api/transactions", "POST", {
      account_id: account,
      posted: "2026-02-02",
      amount: -20000,
      description: "To savings",
      type: "expense",
    });
    const b = await json("/api/transactions", "POST", {
      account_id: other,
      posted: "2026-02-02",
      amount: 20000,
      description: "From checking",
      type: "income",
    });
    await json("/api/transfers", "POST", { first: a.id, second: b.id });
    const report = await json("/api/report?from=2026-02-01&to=2026-02-28");
    expect(report.groups.USD.expenses).toBe(15000);
    expect(report.groups.USD.income).toBe(0);
    expect((await json("/api/transactions?category=groceries")).total).toBe(1);
  });
  it("previews CSV duplicates without dropping legitimate repeated transactions", async () => {
    const text =
      "Date,Description,Amount\n2026-01-02,Office purchase,-100.00\n2026-03-01,Another purchase,-20.00";
    const result = await json("/api/import/preview", "POST", {
      name: "bank.csv",
      account_id: account,
      text,
      mapping: {
        date: 0,
        description: 1,
        amount: 2,
        dateFormat: "iso",
        invert: false,
      },
    });
    expect(result.rows[0].duplicate).toBe(txId);
    expect(result.rows[1].duplicate).toBe(null);
  });
  it("exports escaped CSV and a credential-free backup", async () => {
    const csv = await req("/api/export");
    expect(await csv.text()).toContain("Office purchase");
    const b = await json("/api/backup");
    expect(b.version).toBe(1);
    expect(b.tables.accounts.length).toBe(2);
    expect(b.tables.sessions).toBeUndefined();
    expect(JSON.stringify(b)).not.toContain("test-password-only");
    expect((await req("/api/restore", "POST", b)).status).toBe(409);
  });
  it("saves editable tax assumptions with optimistic locking", async () => {
    const state = await json("/api/taxes/2026");
    state.profile.businessProfit = 10000000;
    const result = await json("/api/taxes/2026", "PUT", {
      profile: state.profile,
      revision: 0,
    });
    expect(result.estimate.federalTotal).toBeGreaterThan(0);
    expect(result.revision).toBe(1);
    expect(
      (
        await req("/api/taxes/2026", "PUT", {
          profile: state.profile,
          revision: 0,
        })
      ).status,
    ).toBe(409);
  });
  it("serves MCP tools and enforces read-only token scopes", async () => {
    const token = await json("/api/tokens", "POST", {
      name: "Test reader",
      scopes: ["finance:read"],
      days: 1,
    });
    const call = async (method: string, params: unknown) => {
      const response = await req(
        "/mcp",
        "POST",
        { jsonrpc: "2.0", id: ++seq, method, params },
        {
          Authorization: "Bearer " + token.token,
          Accept: "application/json, text/event-stream",
          "MCP-Protocol-Version": "2025-03-26",
        },
      );
      const text = await response.text();
      expect(response.status, text).toBe(200);
      return JSON.parse(
        text.startsWith("event:") ? text.split("data: ")[1].trim() : text,
      );
    };
    const tools = await call("tools/list", {});
    expect(
      tools.result.tools.some((t: any) => t.name === "get_tax_estimate"),
    ).toBe(true);
    const read = await call("tools/call", {
      name: "list_accounts",
      arguments: {},
    });
    expect(read.result.isError).not.toBe(true);
    const denied = await call("tools/call", {
      name: "create_transaction",
      arguments: {
        transaction: {
          account_id: account,
          posted: "2026-01-01",
          amount: 100,
          description: "Denied",
          type: "income",
        },
        request_key: "must-not-write",
      },
    });
    expect(denied.result.isError).toBe(true);
  });
  it("performs OAuth PKCE flow and consumes authorization codes once", async () => {
    const client = await json("/oauth/register", "POST", {
      client_name: "Test OAuth client",
      redirect_uris: ["http://127.0.0.1:9999/callback"],
    });
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const query = new URLSearchParams({
      response_type: "code",
      client_id: client.client_id,
      redirect_uri: client.redirect_uris[0],
      code_challenge: challenge,
      code_challenge_method: "S256",
      scope: "finance:read",
      state: "preserved",
      resource: "http://127.0.0.1/mcp",
    });
    const consent = await json("/api/oauth/authorize", "POST", {
      query: query.toString(),
      approved: true,
    });
    const redirect = new URL(consent.redirect);
    expect(redirect.searchParams.get("state")).toBe("preserved");
    const form = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: client.client_id,
      redirect_uri: client.redirect_uris[0],
      code: redirect.searchParams.get("code")!,
      code_verifier: verifier,
      resource: "http://127.0.0.1/mcp",
    });
    const exchange = () =>
      mf.dispatchFetch("http://127.0.0.1/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      });
    const token = await exchange();
    expect(token.status).toBe(200);
    expect(((await token.json()) as any).access_token).toBeTruthy();
    expect((await exchange()).status).toBe(400);
  });
});
