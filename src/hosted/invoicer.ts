import { assert } from "../server/util";
import type { HostedEnv } from "./control";

export function publicInvoiceRead(req: Request, path: string) {
  if (req.method !== "GET" && req.method !== "HEAD") return false;
  return /^\/invoicer\/(?:s\/[a-zA-Z0-9_-]+(?:\/(?:pdf|info))?|assets\/[\w.-]+|fonts\/[\w.-]+|source\.tar\.gz|LICENSE\.txt)$/.test(
    path,
  );

}
export async function forwardInvoice(
  env: HostedEnv,
  req: Request,
  authenticated: boolean,
  externalKey = false,
) {
  assert(env.INVOICER, 404, "Invoicer is unavailable.");
  const url = new URL(req.url);
  url.pathname = url.pathname.slice("/invoicer".length) || "/";
  const headers = new Headers();
  for (const name of [
    "Content-Type",
    "Accept",
    "Idempotency-Key",
    "If-None-Match",
    "Range",
    "X-Business-Id",
    "MCP-Protocol-Version",
    "Mcp-Session-Id",
    "Origin",
  ]) {
    const value = req.headers.get(name);
    if (value) headers.set(name, value);
  }
  if (externalKey) headers.set("Authorization", req.headers.get("Authorization") || "");
  if (authenticated) {
    assert(
      env.INVOICER_KEY && env.INVOICER_KEY.length >= 32,
      503,
      "Invoicer is awaiting configuration.",
    );
    if (url.pathname === "/auth/session")
      return Response.json(
        { csrfToken: "" },
        { headers: { "Cache-Control": "no-store" } },
      );
    assert(
      !url.pathname.startsWith("/auth/"),
      403,
      "Manage sign-in through Finance.",
    );
    headers.set("Authorization", "Bearer " + env.INVOICER_KEY);
  }
  const response = await env.INVOICER.fetch(
    new Request(new Request(url, req), {
      headers,
      redirect: "manual",
    }),
  );
  if (new URL(req.url).origin !== env.INVOICER_ORIGIN && response.headers.get("Content-Type")?.includes("text/html")) {
    return new HTMLRewriter().on('[src], [href]', { element(el) {
      for (const attr of ['src','href']) { const value = el.getAttribute(attr); if (value?.startsWith('/assets/') || value?.startsWith('/fonts/')) el.setAttribute(attr,'/invoicer'+value); }
    }}).transform(response);
  }
  return response;
}
