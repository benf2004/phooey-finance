import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import worker from "../src/hosted/worker";
import { issueSession, signInDestination, type HostedEnv } from "../src/hosted/control";
import { issueToken } from "../src/server/auth";
import { hash, now } from "../src/server/util";

const app = "https://finance.phooey.foo";
const market = "https://getfinance.phooey.foo";
function database(directory: string) {
  const raw = new DatabaseSync(":memory:");
  for (const file of readdirSync(directory).filter(f => f.endsWith(".sql")).sort())
    raw.exec(readFileSync(directory + "/" + file, "utf8"));
  return {
    raw,
    prepare(sql: string) {
      const statement = raw.prepare(sql);
      const bound = (...args: (string | number | null)[]) => ({
        first: async () => statement.get(...args) ?? null,
        all: async () => ({ results: statement.all(...args) }),
        run: async () => ({ meta: statement.run(...args) }),
      });
      return { ...bound(), bind: bound };
    },
  };
}
async function fixture() {
  const control = database("hosted/migrations");
  const env = { CONTROL: control, APP_ORIGIN: app, PORTAL_ORIGIN: market, CANONICAL_APP: "true",
    ASSETS: { fetch: () => new Response("Finance consent") },
  } as unknown as HostedEnv;
  const ctx = { waitUntil: () => {} } as unknown as ExecutionContext;
  const ledgers = {} as Record<string, ReturnType<typeof database>>;
  const workspaces = {} as Record<string, HostedEnv>;
  const services = {} as Record<string, ReturnType<typeof vi.fn>>;
  const cookies = {} as Record<string, string>;
  for (const id of ["one", "two"]) {
    control.raw.prepare("INSERT INTO customers(id,email,subject,paid_until) VALUES(?,?,?,?)")
      .run(id, id + "@example.test", id, now() + 1000);
    control.raw.prepare("INSERT INTO workspaces(id,origin,owner) VALUES(?,?,?)")
      .run(id, `https://${id}.workers.dev`, id);
    const db = ledgers[id] = database("migrations");
    const workspace = workspaces[id] = { ...env, DB: db as unknown as D1Database, WORKSPACE_ID: id,
      mcpRouting: { db: env.CONTROL, workspace: id, sharedClients: true } };
    const service = services[id] = vi.fn((req: Request) => worker.fetch(req, workspace, ctx));
    env[`WORKSPACE_SERVICE_${id}`] = { fetch: service } as unknown as Fetcher;
    cookies[id] = (await issueSession(env, id, app)).split(";")[0];
  }
  const request = (path: string, init?: RequestInit) => worker.fetch(new Request(app + path, init), env, ctx);
  return { env, control, ledgers, workspaces, services, cookies, request };
}
describe("hosted MCP main domain", () => {
  it("offers public OAuth discovery and preserves consent through login", async () => {
    const { request } = await fixture();
    const res = await request("/mcp");
    expect(res.status).toBe(401);
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get("www-authenticate")).toContain(app + "/.well-known/oauth-protected-resource/mcp");
    expect(await (await request("/.well-known/oauth-protected-resource/mcp")).json()).toMatchObject({ resource: app + "/mcp", authorization_servers: [app] });
    expect(await (await request("/.well-known/oauth-authorization-server")).json()).toMatchObject({ issuer: app, token_endpoint: app + "/oauth/token" });
    const next = "/oauth/authorize?client_id=test&state=original";
    expect((await request(next)).headers.get("location")).toBe("/cloud/start?next=" + encodeURIComponent(next));
    expect(signInDestination(next)).toBe(next);
    expect(signInDestination("//attacker.test")).toBe("/cloud/account");
    expect(signInDestination("/oauth/authorize?x=\n//attacker.test")).toBe("/cloud/account");
  });
  it("routes bearer tokens independently of browser cookies and rechecks revocation and subscription", async () => {
    const { request, workspaces, services, cookies, ledgers, control } = await fixture();
    const token = await issueToken(workspaces.one, "Assistant", ["finance:read"], 30);
    const headers = { Authorization: "Bearer " + token.token, Cookie: cookies.two };
    const initialized = await request("/mcp", { method: "POST",
      headers: { ...headers, Host: "finance.phooey.foo", "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
        protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" },
      } }),
    });
    const initializedBody = await initialized.text();
    expect(initialized.status, initializedBody).toBe(200);
    expect(initializedBody).toContain("serverInfo");
    expect(services.one).toHaveBeenCalledTimes(1);
    expect(services.two).not.toHaveBeenCalled();
    expect(services.one.mock.calls[0][0].headers.has("Cookie")).toBe(false);
    const settings = await request("/api/session", { headers: { Cookie: cookies.one } });
    expect(await settings.json()).toMatchObject({ mcpUrl: app + "/mcp" });
    control.raw.prepare("UPDATE customers SET paid_until=0 WHERE id='one'").run();
    expect((await request("/mcp", { headers })).status).toBe(403);
    control.raw.prepare("UPDATE customers SET paid_until=? WHERE id='one'").run(now() + 1000);
    ledgers.one.raw.prepare("DELETE FROM access_tokens").run();
    expect((await request("/mcp", { headers })).status).toBe(401);
    expect((await request("/mcp", { headers: { Authorization: "Bearer invalid" } })).status).toBe(401);
  });
  it("registers, consents, exchanges PKCE once, and revokes without a browser session", async () => {
    const { request, cookies, ledgers, services } = await fixture();
    const register = await request("/oauth/register", { method: "POST", body: JSON.stringify({ client_name: "MCP test", redirect_uris: ["https://client.test/callback"] }) });
    expect(register.status).toBe(201);
    const client = await register.json() as { client_id: string };
    const verifier = "v".repeat(43);
    const query = new URLSearchParams({ client_id: client.client_id, response_type: "code", redirect_uri: "https://client.test/callback", code_challenge_method: "S256",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"), resource: app + "/mcp", state: "original", scope: "finance:read" });
    const consent = await request("/api/oauth/authorize", { method: "POST", headers: { Origin: app, Cookie: cookies.two, "Content-Type": "application/json" }, body: JSON.stringify({ query: query.toString(), approved: true }) });
    expect(consent.status).toBe(200);
    const redirect = new URL((await consent.json() as { redirect: string }).redirect);
    expect(redirect.searchParams.get("state")).toBe("original");
    const body = new URLSearchParams({ grant_type: "authorization_code", client_id: client.client_id, redirect_uri: "https://client.test/callback", code: redirect.searchParams.get("code")!, code_verifier: verifier, resource: app + "/mcp" });
    const wrong = new URLSearchParams(body);
    wrong.set("resource", "https://other.test/mcp");
    expect((await request("/oauth/token", { method: "POST", body: wrong })).status).toBe(400);
    const exchanged = await request("/oauth/token", { method: "POST", body });
    expect(exchanged.status).toBe(200);
    const token = (await exchanged.json() as { access_token: string }).access_token;
    expect(ledgers.two.raw.prepare("SELECT id FROM access_tokens WHERE token_hash=?").get(await hash(token))).toBeTruthy();
    expect(services.one).not.toHaveBeenCalled();
    expect((await request("/oauth/token", { method: "POST", body })).status).toBe(400);
    const revoked = await request("/oauth/revoke", { method: "POST", body: new URLSearchParams({ token }) });
    expect(revoked.status).toBe(200);
    expect((await request("/mcp", { headers: { Authorization: "Bearer " + token } })).status).toBe(401);
  });
});
