import finance from "../server/index";
import invoicer from "../../invoicer/src/worker/index";
import { authenticate, checkOrigin, cookieToken, sessionCookie, type AppEnv } from "../server/auth";
import { AppError, assert, errorMessage, hash } from "../server/util";

export type SelfHostedEnv = AppEnv & { INVOICER_DB: D1Database };
const prefix = "/invoicer";

// Both apps use their existing services and migrations. Only the sign-in and
// asset routing differ; no hosted account, identity provider or billing is used.
async function invoiceRequest(request: Request, env: SelfHostedEnv, ctx: ExecutionContext) {
  assert(env.ADMIN_KEY && env.ADMIN_KEY.length >= 32, 503, "Configure ADMIN_KEY with at least 32 random characters.");
  assert(env.INVOICER_DB, 503, "Configure the INVOICER_DB database binding.");
  const url = new URL(request.url);
  const path = url.pathname.slice(prefix.length) || "/";
  const read = request.method === "GET" || request.method === "HEAD";
  const publicReference = read && ["/api/v1", "/api/v1/docs", "/api/v1/openapi.json"].includes(path);
  const headers = new Headers(request.headers);
  headers.delete("Cookie");
  // Never upgrade an API key to owner access just because the browser also
  // supplied a cookie. Invoicer independently enforces business key scopes.
  if (path.startsWith("/auth/") || (path.startsWith("/api/") && !publicReference && !headers.has("Authorization"))) {
    const principal = await authenticate(env, request, true);
    assert(principal, 401, "Sign in to Finance with your admin key.");
    if (!read) checkOrigin(request);
    if (path === "/auth/session" && read) return Response.json({ csrfToken: "" });
    if (path === "/auth/logout" && request.method === "POST") {
      await env.DB.prepare("DELETE FROM sessions WHERE token_hash=?")
        .bind(await hash(cookieToken(request) ?? "")).run();
      return Response.json({ ok: true }, { headers: { "Set-Cookie": sessionCookie("", request, 0) } });
    }
    assert(!path.startsWith("/auth/"), 403, "Sign in through Finance.");
    headers.set("Authorization", "Bearer " + env.ADMIN_KEY);
  }
  // Bearer clients need no browser session, but browser-origin requests must
  // still originate from this installation (including MCP).
  if (!read && headers.has("Origin")) checkOrigin(request);
  url.pathname = path;
  const response = await invoicer.fetch(new Request(new Request(url, request), { headers }), {
    DB: env.INVOICER_DB,
    ADMIN_KEY: env.ADMIN_KEY,
    BUNDLE_PREFIX: prefix,
    APP_PREFIX: prefix,
    PUBLIC_ORIGIN: url.origin,
    ASSETS: { fetch: (asset: Request) => {
      const assetUrl = new URL(asset.url);
      // The shared asset binding's SPA fallback is Finance's index. Select
      // Invoicer's shell explicitly for its dashboard routes.
      assetUrl.pathname = prefix + (/\.[a-z0-9]+$/i.test(assetUrl.pathname) ? assetUrl.pathname : "/");
      return env.ASSETS.fetch(new Request(assetUrl, asset));
    } } as Fetcher,
  }, ctx);
  // The API reference uses root-relative links in the standalone worker.
  const result = new Response(response.body, response);
  const location = result.headers.get("Location");
  if (location?.startsWith("/") && !location.startsWith("//") && !location.startsWith(prefix + "/")) result.headers.set("Location", prefix + location);
  if (path === "/api/v1/openapi.json" && result.ok) {
    const spec = await result.json() as Record<string, unknown>;
    return Response.json({ ...spec, servers: [{ url: prefix + "/api/v1" }] });
  }
  return result;
}

export default {
  async fetch(request, env, ctx) {
    const path = new URL(request.url).pathname;
    if (path === prefix || path.startsWith(prefix + "/")) {
      try {
        if (path === prefix) return new Response(null, { status: 308, headers: { Location: prefix + "/" + new URL(request.url).search } });
        const response = await invoiceRequest(request, env, ctx);
        const result = new Response(response.body, response);
        result.headers.set("Cache-Control", "no-store");
        return result;
      } catch (error) {
        return Response.json({ error: { message: errorMessage(error) } }, {
          status: error instanceof AppError ? error.status : 500,
          headers: { "Cache-Control": "no-store" },
        });
      }
    }
    return finance.fetch(request, { ...env, invoicerUrl: prefix + "/" }, ctx);
  },
  scheduled: finance.scheduled,
  queue: finance.queue,
} satisfies ExportedHandler<SelfHostedEnv, { jobId: string }>;
