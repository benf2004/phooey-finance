import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import worker, { type SelfHostedEnv } from "../src/self-hosted/worker";
import { readFile, readdir } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";

const origin = "http://localhost";
const key = randomBytes(32).toString("hex");
let env: SelfHostedEnv;
const databases: DatabaseSync[] = [];
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
async function database(directory: string) {
  const raw = new DatabaseSync(":memory:");
  databases.push(raw);
  raw.exec("PRAGMA foreign_keys=ON");
  for (const file of (await readdir(directory)).filter(f => f.endsWith(".sql")).sort())
    raw.exec(await readFile(`${directory}/${file}`, "utf8"));
  return {
    prepare(sql: string) {
      const stmt = raw.prepare(sql);
      const bound = (...args: any[]) => ({
        bind: (...next: any[]) => bound(...next),
        first: async (column?: string) => { const row = stmt.get(...args); return column ? row?.[column] ?? null : row ?? null; },
        all: async () => ({ results: stmt.all(...args), meta: { changes: raw.prepare("SELECT changes() AS n").get()!.n } }),
        run: async () => ({ meta: { changes: Number(stmt.run(...args).changes) } }),
      });
      return bound();
    },
    async batch(statements: { all(): Promise<unknown> }[]) {
      raw.exec("BEGIN");
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.all());
        raw.exec("COMMIT");
        return results;
      } catch (error) { raw.exec("ROLLBACK"); throw error; }
    },
  } as unknown as D1Database;
}
async function request(path: string, method = "GET", body?: unknown, headers: Record<string, string> = {}) {
  return worker.fetch(new Request(origin + path, {
    method, headers: { Host: "localhost", ...(body ? { "Content-Type": "application/json" } : {}), ...headers },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }) as Parameters<typeof worker.fetch>[0], env, ctx);
}
async function data(path: string, method = "GET", body?: unknown, headers: Record<string, string> = {}) {
  const response = await request(path, method, body, headers);
  const value = await response.json() as any;
  expect(response.status, JSON.stringify(value)).toBeLessThan(300);
  return value;
}
async function signIn() {
  const response = await request("/api/login", "POST", { password: key }, { Origin: origin });
  expect(response.status).toBe(200);
  return { Cookie: response.headers.get("Set-Cookie")!.split(";")[0], Origin: origin };
}
beforeAll(async () => {
  env = {
    DB: await database("migrations"), INVOICER_DB: await database("invoicer/migrations"),
    ADMIN_KEY: key, ENCRYPTION_KEY: randomBytes(32).toString("base64"), SOURCE_URL: "https://example.test/source",
    ASSETS: { async fetch(req: Request) {
      let path = new URL(req.url).pathname;
      if (path.endsWith("/")) path += "index.html";
      const mime = path.endsWith(".html") ? "text/html" : path.endsWith(".js") ? "application/javascript" : "application/octet-stream";
      try { return new Response(await readFile("dist/client" + path), { headers: { "Content-Type": mime } }); }
      catch { return new Response("Missing asset", { status: 404 }); }
    } },
  } as unknown as SelfHostedEnv;
});
afterAll(() => { for (const db of databases) db.close(); });

describe("self-hosted Finance and Invoicer", () => {
  it("uses one admin key and session for both complete workspaces", async () => {
    expect(await data("/api/login-method")).toEqual({ mode: "key" });
    expect((await request("/api/session")).status).toBe(401);
    expect((await request("/invoicer/auth/session")).status).toBe(401);
    expect((await request("/invoicer/api/v1/invoices")).status).toBe(401);
    const headers = await signIn();
    expect(await data("/api/session", "GET", undefined, headers)).toMatchObject({ keyAuth: true, hosted: false, invoicerUrl: "/invoicer/" });
    expect(await data("/invoicer/auth/session", "GET", undefined, headers)).toEqual({ csrfToken: "" });
    expect(await data("/invoicer/api/v1/businesses", "GET", undefined, headers)).toHaveProperty("items");
    const account = await data("/api/accounts", "POST", { name: "Self-hosted checking" }, headers);
    expect(account.id).toBeTruthy();
    const business = await data("/invoicer/api/v1/businesses", "POST", { name: "Self-hosted studio" }, headers);
    expect(business.id).toBeTruthy();
    expect(await data("/invoicer/api/v1/settings", "GET", undefined, { ...headers, "X-Business-Id": business.id })).toHaveProperty("settings.business.name", "Self-hosted studio");
  });

  it("serves Invoicer deep links, assets and API references under its prefix", async () => {
    for (const path of ["/invoicer/", "/invoicer/new", "/invoicer/settings"]) {
      const response = await request(path);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain('/invoicer/assets/');
    }
    const shell = await (await request("/invoicer/")).text();
    const script = shell.match(/src="([^"]+\.js)"/)![1];
    const asset = await request(script);
    expect(asset.status).toBe(200);
    expect(asset.headers.get("Content-Type")).toMatch(/javascript/);
    const font = await request("/invoicer/fonts/NotoSans-Regular.ttf");
    expect(font.status).toBe(200);
    expect(font.headers.get("Content-Type")).not.toContain("text/html");
    expect((await request("/invoicer?test=1")).headers.get("Location")).toBe("/invoicer/?test=1");
    expect((await request("/invoicer/api/v1")).headers.get("Location")).toBe("/invoicer/api/v1/docs");
    expect(await (await request("/invoicer/api/v1/docs")).text()).toContain('href="/invoicer/"');
    expect(await data("/invoicer/api/v1/openapi.json")).toHaveProperty("servers", [{ url: "/invoicer/api/v1" }]);
  });

  it("rejects cross-origin cookie writes and signs out of both apps together", async () => {
    const headers = await signIn();
    for (const Origin of ["https://other.test", ""]) {
      expect((await request("/invoicer/api/v1/businesses", "POST", { name: "Blocked" }, { ...headers, Origin })).status).toBe(403);
      expect((await request("/invoicer/auth/logout", "POST", undefined, { ...headers, Origin })).status).toBe(403);
    }
    expect((await request("/invoicer/auth/logout", "POST", undefined, headers)).status).toBe(200);
    expect((await request("/api/session", "GET", undefined, headers)).status).toBe(401);
    expect((await request("/invoicer/auth/session", "GET", undefined, headers)).status).toBe(401);
    const second = await signIn();
    expect((await request("/api/logout", "POST", undefined, second)).status).toBe(200);
    expect((await request("/invoicer/auth/session", "GET", undefined, second)).status).toBe(401);
    const stale = await signIn();
    const db = env.DB;
    env.ADMIN_KEY = "replacement".repeat(4);
    expect((await request("/api/session", "GET", undefined, stale)).status).toBe(401);
    expect((await request("/invoicer/auth/session", "GET", undefined, stale)).status).toBe(401);
    env.ADMIN_KEY = key;
  });

  it("keeps scoped API keys isolated even alongside an admin cookie", async () => {
    const headers = await signIn();
    const business = await data("/invoicer/api/v1/businesses", "POST", { name: "API business" }, headers);
    const selected = { ...headers, "X-Business-Id": business.id };
    const token = await data("/invoicer/api/v1/keys", "POST", { name: "Read only", scope: "read" }, selected);
    const bearer = { ...headers, Authorization: `Bearer ${token.key}` };
    expect(await data("/invoicer/api/v1/settings", "GET", undefined, bearer)).toHaveProperty("settings.business.name", "API business");
    expect((await request("/invoicer/api/v1/invoices", "POST", {}, bearer)).status).toBe(403);
    expect((await request("/invoicer/api/v1/settings", "GET", undefined, { ...bearer, "X-Business-Id": "default" })).status).toBe(403);
    expect((await request("/invoicer/api/v1/businesses", "POST", { name: "Blocked" }, bearer)).status).toBe(403);
    expect((await request("/invoicer/api/v1/settings", "GET", undefined, { ...headers, Authorization: "Bearer invalid" })).status).toBe(401);
    await data(`/invoicer/api/v1/keys/${token.id}`, "DELETE", undefined, selected);
    expect((await request("/invoicer/api/v1/settings", "GET", undefined, bearer)).status).toBe(401);
  });

  it("issues invoices, renders PDFs and keeps invoice data private", async () => {
    const headers = await signIn();
    const invoice = await data("/invoicer/api/v1/invoices", "POST", {
      business: { name: "Example studio" }, billTo: { name: "Example client" },
      items: [{ description: "Design work", quantity: "2", rate: "50" }], status: "issued",
    }, headers);
    expect(invoice.status).toBe("issued");
    const pdfPath = `/invoicer/api/v1/invoices/${invoice.id}/pdf`;
    expect((await request(pdfPath)).status).toBe(401);
    const pdf = await request(pdfPath, "GET", undefined, headers);
    expect(pdf.status, pdf.headers.get("Content-Type") || "").toBe(200);
    expect(pdf.headers.get("Content-Type")).toBe("application/pdf");
    expect((await pdf.text()).slice(0, 5)).toBe("%PDF-");
    const paid = await data(`/invoicer/api/v1/invoices/${invoice.id}/payment`, "POST", { revision: invoice.revision, amountPaid: "100" }, headers);
    expect(paid.status).toBe("paid");
  });

  it("supports both MCP endpoints without hosted authentication services", async () => {
    const initialize = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } } };
    const headers = { Accept: "application/json, text/event-stream", Authorization: "Bearer " + key };
    expect(await data("/invoicer/mcp", "POST", initialize, headers)).toHaveProperty("result.serverInfo.name", "phooey-invoicer");
    expect((await request("/invoicer/mcp", "POST", initialize, await signIn())).status).toBe(401);
    expect((await request("/mcp", "POST", initialize)).status).toBe(401);
    const ownerMcp = await request("/mcp", "POST", initialize, headers);
    expect(ownerMcp.status).toBe(200);
    expect(await ownerMcp.text()).toContain('"serverInfo"');
    expect((await request("/api/session", "GET", undefined, headers)).status).toBe(401);
    env.ADMIN_KEY = "replacement".repeat(4);
    expect((await request("/mcp", "POST", initialize, headers)).status).toBe(401);
    expect((await request("/invoicer/mcp", "POST", initialize, headers)).status).toBe(401);
    env.ADMIN_KEY = key;
    const financeToken = randomBytes(32).toString("hex");
    const db = env.DB;
    await db.prepare("INSERT INTO access_tokens(id,name,token_hash,scopes,expires_at) VALUES('mcp-test','Test',?,'[\"finance:read\"]',?)")
      .bind(createHash("sha256").update(financeToken).digest("hex"), Math.floor(Date.now() / 1000) + 3600).run();
    const financeMcp = await request("/mcp", "POST", initialize, { ...headers, Authorization: "Bearer " + financeToken });
    expect(financeMcp.status).toBe(200);
    expect(await financeMcp.text()).toContain('"serverInfo"');
  });
});
