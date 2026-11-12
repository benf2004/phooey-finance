import { compare } from "bcryptjs";
import { assert, hash, now, randomToken, id } from "./util";
import { scopeSchema, type Scope } from "../shared/models";
export type AppEnv = Env & {
  ADMIN_USERNAME: string;
  ADMIN_PASSWORD_HASH: string;
  ENCRYPTION_KEY: string;
};
export type Principal = {
  actor: string;
  scopes: Scope[];
  kind: "session" | "token";
};
export async function rateLimit(
  db: D1Database,
  key: string,
  max: number,
  seconds: number,
) {
  const n = now();
  const row = await db
    .prepare(
      "INSERT INTO rate_limits(key,count,expires_at) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN expires_at<=? THEN 1 ELSE count+1 END,expires_at=CASE WHEN expires_at<=? THEN excluded.expires_at ELSE expires_at END RETURNING count",
    )
    .bind(key, n + seconds, n, n)
    .first<{ count: number }>();
  assert(
    row && row.count <= max,
    429,
    "Too many requests. Please try again later.",
  );
}
export async function credentialVersion(env: AppEnv) {
  return hash(env.ADMIN_USERNAME + ":" + env.ADMIN_PASSWORD_HASH);
}
export async function login(
  env: AppEnv,
  username: string,
  password: string,
  ip: string,
) {
  assert(
    env.ADMIN_USERNAME && env.ADMIN_PASSWORD_HASH,
    503,
    "Configure the admin secrets to sign in.",
  );
  await rateLimit(env.DB, "login:" + ip, 10, 900);
  const valid = await compare(password, env.ADMIN_PASSWORD_HASH);
  assert(
    valid && (await hash(username)) === (await hash(env.ADMIN_USERNAME)),
    401,
    "Username or password is incorrect.",
  );
  const token = randomToken();
  await env.DB.prepare(
    "INSERT INTO sessions(token_hash,expires_at,credential_version) VALUES(?,?,?)",
  )
    .bind(await hash(token), now() + 86400, await credentialVersion(env))
    .run();
  return token;
}
export function cookieToken(request: Request) {
  return request.headers
    .get("cookie")
    ?.split(";")
    .map((s) => s.trim())
    .find((s) => s.startsWith("phooey_session="))
    ?.slice(15);
}
export async function authenticate(
  env: AppEnv,
  request: Request,
  sessionOnly = false,
): Promise<Principal | null> {
  const bearer = request.headers.get("authorization");
  if (!sessionOnly && bearer?.startsWith("Bearer ")) {
    const row = await env.DB.prepare(
      "SELECT id,scopes FROM access_tokens WHERE token_hash=? AND expires_at>?",
    )
      .bind(await hash(bearer.slice(7)), now())
      .first<{ id: string; scopes: string }>();
    if (!row) return null;
    await env.DB.prepare(
      "UPDATE access_tokens SET last_used_at=CURRENT_TIMESTAMP WHERE id=?",
    )
      .bind(row.id)
      .run();
    return {
      actor: "mcp:" + row.id,
      scopes: scopeSchema.parse(JSON.parse(row.scopes)),
      kind: "token",
    };
  }
  const token = cookieToken(request);
  if (!token) return null;
  const row = await env.DB.prepare(
    "SELECT credential_version FROM sessions WHERE token_hash=? AND expires_at>?",
  )
    .bind(await hash(token), now())
    .first<{ credential_version: string }>();
  if (!row || row.credential_version !== (await credentialVersion(env)))
    return null;
  return {
    actor: "admin",
    scopes: [
      "finance:read",
      "transactions:write",
      "rules:write",
      "tax:write",
      "sync:write",
    ],
    kind: "session",
  };
}
export function requireScope(p: Principal, scope: Scope) {
  assert(p.scopes.includes(scope), 403, `Permission required: ${scope}`);
}
export function checkOrigin(request: Request) {
  const origin = request.headers.get("origin");
  assert(
    origin === new URL(request.url).origin,
    403,
    "Request origin is not allowed.",
  );
}
export function sessionCookie(token: string, request: Request, maxAge = 86400) {
  return `phooey_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${new URL(request.url).protocol === "https:" ? "; Secure" : ""}`;
}
export async function issueToken(
  env: AppEnv,
  name: string,
  scopes: Scope[],
  days: number,
  clientId: string | null = null,
) {
  const token = randomToken();
  const tokenId = id();
  await env.DB.prepare(
    "INSERT INTO access_tokens(id,name,token_hash,scopes,expires_at,client_id) VALUES(?,?,?,?,?,?)",
  )
    .bind(
      tokenId,
      name,
      await hash(token),
      JSON.stringify(scopes),
      now() + days * 86400,
      clientId,
    )
    .run();
  return { id: tokenId, token, expires_in: days * 86400 };
}
export async function encrypt(env: AppEnv, value: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    Uint8Array.from(atob(env.ENCRYPTION_KEY), (c) => c.charCodeAt(0)),
    "AES-GCM",
    false,
    ["encrypt"],
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(value),
  );
  return (
    btoa(String.fromCharCode(...iv)) +
    "." +
    btoa(String.fromCharCode(...new Uint8Array(data)))
  );
}
export async function decrypt(env: AppEnv, value: string) {
  const [iv, data] = value.split(".");
  const key = await crypto.subtle.importKey(
    "raw",
    Uint8Array.from(atob(env.ENCRYPTION_KEY), (c) => c.charCodeAt(0)),
    "AES-GCM",
    false,
    ["decrypt"],
  );
  return new TextDecoder().decode(
    await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: Uint8Array.from(atob(iv), (c) => c.charCodeAt(0)),
      },
      key,
      Uint8Array.from(atob(data), (c) => c.charCodeAt(0)),
    ),
  );
}
