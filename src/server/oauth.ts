import { z } from "zod";
import { type AppEnv, issueToken, rateLimit } from "./auth";
import { assert, hash, id, now, randomToken } from "./util";
import { scopes, scopeSchema } from "../shared/models";
export function oauthMetadata(origin: string) {
  return {
    issuer: origin,
    authorization_endpoint: origin + "/oauth/authorize",
    token_endpoint: origin + "/oauth/token",
    registration_endpoint: origin + "/oauth/register",
    revocation_endpoint: origin + "/oauth/revoke",
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: scopes,
  };
}
export async function registerClient(env: AppEnv, input: unknown, ip: string) {
  await rateLimit(env.DB, "oauth-register:" + ip, 10, 3600);
  const data = z
    .object({
      client_name: z.string().max(100).default("Finance assistant"),
      redirect_uris: z.array(z.string().url()).min(1).max(5),
    })
    .parse(input);
  for (const uri of data.redirect_uris) {
    const u = new URL(uri);
    assert(
      (u.protocol === "https:" ||
        (u.protocol === "http:" &&
          ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname))) &&
        !u.hash &&
        !u.username &&
        !u.password,
      400,
      "Redirect URI must use HTTPS or loopback HTTP",
    );
  }
  const clientId = id();
  await env.DB.prepare(
    "INSERT INTO oauth_clients(id,name,redirect_uris,created_at) VALUES(?,?,?,?)",
  )
    .bind(clientId, data.client_name, JSON.stringify(data.redirect_uris), now())
    .run();
  return {
    client_id: clientId,
    client_name: data.client_name,
    redirect_uris: data.redirect_uris,
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code"],
    response_types: ["code"],
  };
}
export async function validateAuthorization(
  env: AppEnv,
  params: URLSearchParams,
  origin: string,
) {
  assert(
    params.get("response_type") === "code" &&
      params.get("code_challenge_method") === "S256",
    400,
    "Authorization requires code flow with PKCE S256",
  );
  const client = await env.DB.prepare("SELECT * FROM oauth_clients WHERE id=?")
    .bind(params.get("client_id"))
    .first<{ id: string; name: string; redirect_uris: string }>();
  assert(client, 400, "Unknown OAuth client");
  const redirect = params.get("redirect_uri") ?? "";
  assert(
    (JSON.parse(client.redirect_uris) as string[]).includes(redirect),
    400,
    "Redirect URI does not match",
  );
  const challenge = params.get("code_challenge") ?? "";
  assert(/^[A-Za-z0-9_-]{43}$/.test(challenge), 400, "Invalid PKCE challenge");
  const requested = scopeSchema.parse(
    (params.get("scope") || "finance:read").split(" "),
  );
  const resource = params.get("resource") ?? origin + "/mcp";
  assert(
    resource === origin + "/mcp",
    400,
    "Resource must identify this MCP endpoint",
  );
  return {
    client,
    redirect,
    challenge,
    scopes: requested,
    resource,
    state: params.get("state"),
  };
}
export async function authorize(
  env: AppEnv,
  params: URLSearchParams,
  origin: string,
  approved: boolean,
) {
  const data = await validateAuthorization(env, params, origin);
  const redirect = new URL(data.redirect);
  if (data.state) redirect.searchParams.set("state", data.state);
  if (!approved) {
    redirect.searchParams.set("error", "access_denied");
    return { redirect: redirect.toString() };
  }
  const code = randomToken();
  await env.DB.prepare(
    "INSERT INTO oauth_codes(code_hash,client_id,redirect_uri,challenge,scopes,expires_at,resource) VALUES(?,?,?,?,?,?,?)",
  )
    .bind(
      await hash(code),
      data.client.id,
      data.redirect,
      data.challenge,
      JSON.stringify(data.scopes),
      now() + 300,
      data.resource,
    )
    .run();
  redirect.searchParams.set("code", code);
  return { redirect: redirect.toString() };
}
export async function exchangeCode(
  env: AppEnv,
  params: URLSearchParams,
  origin: string,
) {
  assert(
    params.get("grant_type") === "authorization_code",
    400,
    "Unsupported grant type",
  );
  const verifier = params.get("code_verifier") ?? "";
  assert(
    /^[A-Za-z0-9._~-]{43,128}$/.test(verifier),
    400,
    "Invalid PKCE verifier",
  );
  const challenge = btoa(
    String.fromCharCode(
      ...new Uint8Array(
        await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(verifier),
        ),
      ),
    ),
  )
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
  const codeHash = await hash(params.get("code") ?? "");
  const resource = params.get("resource") ?? origin + "/mcp";
  const code = await env.DB.prepare(
    "DELETE FROM oauth_codes WHERE code_hash=? AND client_id=? AND redirect_uri=? AND challenge=? AND expires_at>? AND resource=? RETURNING scopes,client_id",
  )
    .bind(
      codeHash,
      params.get("client_id"),
      params.get("redirect_uri"),
      challenge,
      now(),
      resource,
    )
    .first<{ scopes: string; client_id: string }>();
  assert(code, 400, "Authorization code is invalid or expired");
  const client = await env.DB.prepare(
    "SELECT name FROM oauth_clients WHERE id=?",
  )
    .bind(code.client_id)
    .first<{ name: string }>();
  const grant = await issueToken(
    env,
    client?.name ?? "MCP client",
    scopeSchema.parse(JSON.parse(code.scopes)),
    1,
    code.client_id,
  );
  return {
    access_token: grant.token,
    token_type: "Bearer",
    expires_in: grant.expires_in,
    scope: JSON.parse(code.scopes).join(" "),
  };
}
