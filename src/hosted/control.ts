import { z } from "zod";
import { rateLimit, type AppEnv } from "../server/auth";
import { assert, hash, id, now, randomToken } from "../server/util";

export type HostedEnv = AppEnv & {
  CONTROL: D1Database;
  APP_ORIGIN?: string;
  MELODY?: Fetcher;
  MELODY_CLIENT?: string;
  INVOICER?: Fetcher;
  INVOICER_ASSETS?: Fetcher;
  INVOICER_ORIGIN?: string;
  INVOICER_MARKETING_ORIGIN?: string;
  INVOICER_KEY?: string;
  GOOGLE_LOGIN_CLIENT?: string;
  GOOGLE_LOGIN_SECRET?: string;
  APPLE_LOGIN_CLIENT?: string;
  APPLE_LOGIN_SECRET?: string;
  PORTAL_ORIGIN: string;
  WORKSPACE_ID?: string;
  CANONICAL_APP?: string;
  [binding: `WORKSPACE_SERVICE_${string}`]: Fetcher | undefined;
  IDENTITY_ORIGIN: string;
  IDENTITY_CLIENT: string;
  IDENTITY_SECRET: string;
  STRIPE_SECRET: string;
  STRIPE_WEBHOOK_SECRET: string;
  STRIPE_PRICE: string;
  SUPPORT_EMAIL: string;
  OPS_ALERT_URL?: string;
  STRIPE_AUTOMATIC_TAX?: string;
};
export type Customer = {
  id: string;
  email: string;
  security_version: number;
  complimentary: number;
  is_admin: number;
  stripe_customer: string | null;
  subscription: string | null;
  paid_until: number;
  trial_ends_at: number;
  billing_revision: number;
  checkout_attempt: string | null;
  checkout_id: string | null;
};
export const hasAccess = (
  account: Pick<Customer, "paid_until" | "complimentary" | "is_admin">,
) =>
  Boolean(account.is_admin || account.complimentary) ||
  account.paid_until > now();
export type Slot = { id: string; origin: string; owner: string | null };
export const marketing = (env: HostedEnv) => new URL(env.PORTAL_ORIGIN).origin;
export const portal = (env: HostedEnv) =>
  new URL(env.APP_ORIGIN || env.PORTAL_ORIGIN).origin;
export const signInDestination = (value?: string) =>
  (value?.startsWith("/oauth/authorize?") && value.length <= 10000 && !/[\r\n\\]/.test(value)) ||
  value === "/admin" ||
  value === "/cloud/invoicer" ||
  value === "/invoicer/" ||
  value === "/cloud/security/setup" ||
  value === "/cloud/security"
    ? value
    : "/cloud/account";
export const cookie = (name: string, value: string, seconds: number) =>
  `__Host-phooey_${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${seconds}`;
export function readCookie(request: Request, name: string) {
  return (
    request.headers
      .get("cookie")
      ?.split(";")
      .map((v) => v.trim())
      .find((v) => v.startsWith("__Host-phooey_" + name + "="))
      ?.split("=")[1] || ""
  );
}
export async function challenge(
  env: HostedEnv,
  audience: string,
  data: object,
  seconds = 600,
) {
  const secret = randomToken();
  await env.CONTROL.prepare("INSERT INTO challenges VALUES(?,?,?,?)")
    .bind(await hash(secret), audience, JSON.stringify(data), now() + seconds)
    .run();
  return secret;
}
export async function consume(
  env: HostedEnv,
  audience: string,
  secret: string,
) {
  const row = await env.CONTROL.prepare(
    "DELETE FROM challenges WHERE digest=? AND audience=? AND expires>? RETURNING payload",
  )
    .bind(await hash(secret), audience, now())
    .first<{ payload: string }>();
  assert(row, 400, "This link expired or was already used. Start again.");
  return JSON.parse(row.payload);
}
export async function customer(
  env: HostedEnv,
  request: Request,
  product = "session",
) {
  const raw = readCookie(request, product);
  if (!raw) return null;
  return env.CONTROL.prepare(
    "SELECT c.* FROM sessions s JOIN hosted_accounts c ON c.id=s.customer WHERE s.digest=? AND s.audience=? AND s.expires>?",
  )
    .bind(
      await hash(raw),
      new URL(request.url).origin +
        (product === "session" ? "" : "#" + product),
      now(),
    )
    .first<Customer>();
}
export async function issueSession(
  env: HostedEnv,
  customerId: string,
  origin: string,
  product = "session",
) {
  const token = randomToken(),
    age = 86400;
  await env.CONTROL.prepare("INSERT INTO sessions VALUES(?,?,?,?)")
    .bind(
      await hash(token),
      customerId,
      origin + (product === "session" ? "" : "#" + product),
      now() + age,
    )
    .run();
  return cookie(product, token, age);
}
export async function workspace(env: HostedEnv, customerId: string) {
  const existing = await env.CONTROL.prepare(
    "SELECT * FROM workspaces WHERE owner=?",
  )
    .bind(customerId)
    .first<Slot>();
  if (existing) return existing;
  // An administrator receives their own workspace, never access to another
  // customer's ledger. Re-check the grant in the atomic allocation statement.
  await env.CONTROL.prepare(
    `UPDATE workspaces SET owner=?
     WHERE id=(SELECT id FROM workspaces WHERE owner IS NULL ORDER BY id LIMIT 1)
     AND EXISTS(SELECT 1 FROM account_admins WHERE customer=?)
     AND NOT EXISTS(SELECT 1 FROM workspaces WHERE owner=?)`,
  )
    .bind(customerId, customerId, customerId)
    .run();
  return env.CONTROL.prepare("SELECT * FROM workspaces WHERE owner=?")
    .bind(customerId)
    .first<Slot>();
}
export async function reserve(env: HostedEnv, customerId: string) {
  let slot = await workspace(env, customerId);
  if (slot) return slot;
  await env.CONTROL.prepare(
    "UPDATE workspaces SET owner=? WHERE id=(SELECT id FROM workspaces WHERE owner IS NULL ORDER BY id LIMIT 1) AND NOT EXISTS(SELECT 1 FROM workspaces WHERE owner=?)",
  )
    .bind(customerId, customerId)
    .run();
  slot = await workspace(env, customerId);
  assert(
    slot,
    503,
    "All hosted workspaces are currently occupied. Please try again later. You haven't been charged.",
  );
  return slot;
}
export function redirect(url: string, cookieValue?: string) {
  const headers = new Headers({
    Location: url,
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
  });
  if (cookieValue) headers.append("Set-Cookie", cookieValue);
  return new Response(null, { status: 303, headers });
}
// The OIDC provider handles verified email, passwords, passkeys, and recovery.
// The one-use state is also tied to the initiating browser cookie.
export async function startIdentity(
  env: HostedEnv,
  request: Request,
  linkCustomer?: string,
) {
  assert(
    env.MELODY ? env.MELODY_CLIENT : env.IDENTITY_CLIENT && env.IDENTITY_SECRET,
    503,
    "Hosted sign-in is awaiting provider configuration.",
  );
  await rateLimit(
    env.CONTROL,
    "login:" + (request.headers.get("CF-Connecting-IP") || "local"),
    40,
    900,
  );
  const verifier = randomToken();
  const destination = signInDestination(
    new URL(request.url).searchParams.get("next") ?? undefined,
  );
  const state = await challenge(env, env.MELODY ? "melody" : "identity", {
    verifier,
    destination,
    linkCustomer,
    linkSession: linkCustomer
      ? await hash(readCookie(request, "session"))
      : undefined,
  });
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  const pkce = btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  const url = env.MELODY
    ? new URL("/oauth2/v1/authorize", portal(env))
    : new URL("/authorize", env.IDENTITY_ORIGIN);
  url.search = new URLSearchParams({
    response_type: "code",
    scope: env.MELODY ? "openid profile" : "openid email",
    client_id: env.MELODY ? env.MELODY_CLIENT! : env.IDENTITY_CLIENT,
    redirect_uri: portal(env) + "/cloud/callback",
    state,
    code_challenge: pkce,
    code_challenge_method: "S256",
  }).toString();
  if (env.MELODY && new URL(request.url).pathname === "/cloud/signup")
    url.searchParams.set("step", "sign_up");
  return redirect(url.href, cookie("login", state, 600));
}
export async function finishIdentity(env: HostedEnv, req: Request) {
  const query = new URL(req.url).searchParams,
    state = query.get("state");
  assert(
    state && readCookie(req, "login") === state,
    400,
    "Restart sign-in in this browser.",
  );
  const { verifier, linkCustomer, linkSession, destination } = await consume(
    env,
    env.MELODY ? "melody" : "identity",
    state,
  );
  assert(query.get("code"), 400, "Sign-in was cancelled.");
  const identityFetch = (legacy: string, melody: string, init: RequestInit) =>
    env.MELODY
      ? env.MELODY.fetch(
          new Request(new URL("/oauth2/v1/" + melody, portal(env)), init),
        )
      : fetch(new URL(legacy, env.IDENTITY_ORIGIN), init);
  const token = await identityFetch("/oauth/token", "token", {
    method: "POST",
    redirect: "manual",
    body: new URLSearchParams({
      grant_type: "authorization_code",
      ...(env.MELODY
        ? { client_id: env.MELODY_CLIENT! }
        : {
            client_id: env.IDENTITY_CLIENT,
            client_secret: env.IDENTITY_SECRET,
          }),
      redirect_uri: portal(env) + "/cloud/callback",
      code: query.get("code")!,
      code_verifier: verifier,
    }),
  });
  assert(token.ok, 401, "Sign-in expired. Please try again.");
  const { access_token } = z
    .object({ access_token: z.string().min(1) })
    .parse(await token.json());
  const profile = await identityFetch("/userinfo", "userinfo", {
    redirect: "manual",
    headers: { Authorization: "Bearer " + access_token },
  });
  assert(profile.ok, 401, "Could not verify your account.");
  const details = await profile.json();
  if (env.MELODY) {
    const p = z
      .object({
        authId: z.string().min(1),
        socialAccountType: z.enum(["Google", "Apple"]).nullable(),
        socialAccountId: z.string().min(1).nullable(),
        email: z.email(),
        emailVerified: z.boolean(),
      })
      .parse(details);
    assert(p.emailVerified, 403, "Verify your email, then sign in again.");
    assert(
      Boolean(p.socialAccountType) === Boolean(p.socialAccountId),
      403,
      "Invalid identity.",
    );
    const issuer =
      p.socialAccountType === "Google"
        ? "https://accounts.google.com"
        : "https://appleid.apple.com";
    const subject = p.socialAccountType
      ? issuer + "|" + p.socialAccountId
      : "melody:" + portal(env) + "|" + p.authId;
    if (linkCustomer) {
      const owner = await customer(env, req);
      assert(
        owner &&
          owner.id === linkCustomer &&
          linkSession === (await hash(readCookie(req, "session"))),
        403,
        "Sign in to the original account again.",
      );
      await env.CONTROL.prepare(
        `INSERT INTO login_identities(subject,customer)
        SELECT ?,? WHERE EXISTS(SELECT 1 FROM sessions WHERE digest=? AND customer=? AND expires>?)
        ON CONFLICT(subject) DO NOTHING`,
      )
        .bind(
          subject,
          owner.id,
          await hash(readCookie(req, "session")),
          owner.id,
          now(),
        )
        .run();
      const linked = await env.CONTROL.prepare(
        "SELECT customer FROM login_identities WHERE subject=?",
      )
        .bind(subject)
        .first<{ customer: string }>();
      assert(
        linked?.customer === owner.id,
        409,
        "This login belongs to another account.",
      );
      return redirect("/cloud/security", cookie("login", "", 0));
    }
    return completeSignIn(env, subject, p.email, destination);
  }
  const p = z
    .object({
      sub: z.string().min(1),
      email: z.email(),
      email_verified: z.boolean(),
    })
    .parse(details);
  assert(
    p.email_verified,
    403,
    "Verify your email with the sign-in provider, then sign in again.",
  );
  return completeSignIn(
    env,
    env.IDENTITY_ORIGIN + "|" + p.sub,
    p.email,
    destination,
  );
}
export async function completeSignIn(
  env: HostedEnv,
  subject: string,
  email: string,
  destination?: string,
) {
  const existing = await env.CONTROL.prepare(
    "SELECT customer FROM login_identities WHERE subject=? UNION ALL SELECT id FROM customers WHERE subject=? LIMIT 1",
  )
    .bind(subject, subject)
    .first();
  // Claim the reservation only after a provider has verified this email. Keep existing
  // linked identities on their original account, even if two identities share an email.
  const [, , identity] = await env.CONTROL.batch<{ id: string }>([
    env.CONTROL.prepare(
      `UPDATE customers SET subject=?, email=?, pending_free=0
      WHERE pending_free=1 AND email=? COLLATE NOCASE
      AND NOT EXISTS(SELECT 1 FROM login_identities WHERE subject=?)
      AND NOT EXISTS(SELECT 1 FROM customers WHERE subject=?)`,
    ).bind(subject, email, email, subject, subject),
    env.CONTROL.prepare(
      `INSERT INTO customers(id,subject,email)
      SELECT ?,?,? WHERE NOT EXISTS(SELECT 1 FROM login_identities WHERE subject=?)
      ON CONFLICT(subject) DO UPDATE SET email=excluded.email`,
    ).bind(id(), subject, email, subject),
    env.CONTROL.prepare(
      `SELECT customer AS id FROM login_identities WHERE subject=?
      UNION ALL SELECT id FROM customers WHERE subject=? LIMIT 1`,
    ).bind(subject, subject),
  ]);
  const row = identity.results[0];
  assert(row, 500, "Could not finish signing in.");
  await env.CONTROL.prepare(
    "INSERT INTO milestones(customer,event,day) SELECT ?,'signup',date('now') WHERE NOT EXISTS(SELECT 1 FROM milestones WHERE customer=? AND event='signup')",
  )
    .bind(row.id, row.id)
    .run();
  const next =
    !existing &&
    env.MELODY &&
    signInDestination(destination) === "/cloud/account"
      ? "/cloud/security/setup"
      : signInDestination(destination);
  return afterPrimary(env, row.id, false, undefined, next);
}
export async function afterPrimary(
  env: HostedEnv,
  owner: string,
  primaryKey = false,
  expectedVersion?: number,
  destination?: string,
) {
  const policy = await env.CONTROL.prepare(
    `
    SELECT security_version, EXISTS(SELECT 1 FROM login_totp WHERE customer=c.id) AS otp,
      EXISTS(SELECT 1 FROM login_keys WHERE customer=c.id AND role='second') AS security_key
    FROM customers c WHERE id=?`,
  )
    .bind(owner)
    .first<{ security_version: number; otp: number; security_key: number }>();
  assert(
    policy &&
      (expectedVersion === undefined ||
        policy.security_version === expectedVersion),
    403,
    "Security settings changed. Sign in again.",
  );
  if (policy.otp || policy.security_key) {
    const pending = await challenge(
      env,
      "second",
      {
        customer: owner,
        version: policy.security_version,
        primaryKey,
        destination: signInDestination(destination),
      },
      300,
    );
    const res = redirect(
      "/cloud/security/verify",
      cookie("pending", pending, 300),
    );
    res.headers.append("Set-Cookie", cookie("login", "", 0));
    res.headers.append("Set-Cookie", cookie("session", "", 0));
    return res;
  }
  return finishSession(env, owner, policy.security_version, destination);
}
export async function finishSession(
  env: HostedEnv,
  owner: string,
  version: number,
  destination?: string,
) {
  const token = randomToken();
  const inserted = await env.CONTROL.prepare(
    `INSERT INTO sessions(digest,customer,audience,expires)
    SELECT ?,id,?,? FROM customers WHERE id=? AND security_version=? RETURNING customer`,
  )
    .bind(await hash(token), portal(env), now() + 86400, owner, version)
    .first();
  assert(inserted, 403, "Security settings changed. Sign in again.");
  const res = redirect(
    portal(env) + signInDestination(destination),
    cookie("session", token, 86400),
  );
  res.headers.append("Set-Cookie", cookie("login", "", 0));
  res.headers.append("Set-Cookie", cookie("pending", "", 0));
  return res;
}
export async function milestone(
  env: HostedEnv,
  customerId: string,
  event:
    | "signup"
    | "ledger_loaded"
    | "sheet_edit"
    | "workspace_visit"
    | "sidebar_visit",
) {
  await env.CONTROL.prepare(
    "INSERT OR IGNORE INTO milestones(customer,event,day) VALUES(?,?,date('now'))",
  )
    .bind(customerId, event)
    .run();
}
