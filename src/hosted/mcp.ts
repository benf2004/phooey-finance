import { rateLimit } from "../server/auth";
import { oauthMetadata, registerClient } from "../server/oauth";
import { scopes } from "../shared/models";
import { assert, hash, now, readJSON, readText } from "../server/util";
import { portal, type HostedEnv } from "./control";

// Resolve opaque credentials without cookies or trusting a caller's workspace ID.
// A routing entry never grants access: the selected ledger authenticates again.
export async function mcpGateway(req: Request, env: HostedEnv): Promise<Response | null> {
  const origin = portal(env), path = new URL(req.url).pathname;
  const json = (body: unknown, status = 200, headers = {}) =>
    Response.json(body, { status, headers: { "Cache-Control": "no-store", ...headers } });
  if (req.method === "GET" && path === "/.well-known/oauth-authorization-server")
    return json(oauthMetadata(origin));
  if (req.method === "GET" && ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"].includes(path))
    return json({ resource: origin + "/mcp", authorization_servers: [origin], scopes_supported: scopes });
  if (req.method === "POST" && path === "/oauth/register")
    return json(await registerClient({ ...env, DB: env.CONTROL }, await readJSON(req, 10000),
      req.headers.get("CF-Connecting-IP") ?? "local"), 201);
  const tokenRequest = req.method === "POST" && path === "/oauth/token";
  const revoke = req.method === "POST" && path === "/oauth/revoke";
  const download = path.startsWith("/api/files/") && req.headers.has("Authorization");
  if (path !== "/mcp" && !tokenRequest && !revoke && !download) return null;
  let credential = req.headers.get("Authorization")?.match(/^Bearer (.+)$/)?.[1] ?? "";
  if (tokenRequest || revoke) {
    await rateLimit(env.CONTROL, "mcp-exchange:" + (req.headers.get("CF-Connecting-IP") ?? "local"), 30, 60);
    const text = await readText(req, 10000);
    const body = new URLSearchParams(text);
    req = new Request(req, { body: text });
    credential = body.get(tokenRequest ? "code" : "token") ?? "";
  }
  const route = credential && await env.CONTROL.prepare(
    "SELECT workspace FROM mcp_routes WHERE kind=? AND digest=? AND expires>?",
  ).bind(tokenRequest ? "code" : "token", await hash(credential), now()).first<{ workspace: string }>();
  if (!route) {
    if (revoke) return json({});
    if (tokenRequest) return json({ error: "invalid_grant" }, 400);
    return json({ error: "MCP authentication required" }, 401, {
      "WWW-Authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
    });
  }
  const service = env[`WORKSPACE_SERVICE_${route.workspace.replaceAll("-", "_")}`];
  assert(service, 503, "Your workspace is temporarily unavailable.");
  const forwarded = new Request(req, { redirect: "manual" });
  forwarded.headers.delete("Cookie");
  return service.fetch(forwarded);
}
