import {
  generateRegistrationOptions,
  generateAuthenticationOptions,
  verifyRegistrationResponse,
  verifyAuthenticationResponse,
  type RegistrationResponseJSON,
  type AuthenticationResponseJSON,
} from "@simplewebauthn/server";
import { z } from "zod";
import { decrypt, encrypt, rateLimit, checkOrigin } from "../server/auth";
import { assert, hash, now, readJSON } from "../server/util";
import {
  afterPrimary,
  challenge,
  consume,
  cookie,
  customer,
  finishSession,
  portal,
  readCookie,
  redirect,
  startIdentity,
  type HostedEnv,
} from "./control";
import { escape, page } from "./html";
import { newTotpSecret, verifyTotp } from "./totp";

type Role = "primary" | "second";
type KeyRow = {
  id: string;
  customer: string;
  role: Role;
  counter: number;
  public_key: string;
  label: string;
};
type Pending = { customer: string; version: number; primaryKey: boolean };
const script =
  '<p role="status" id="auth-status"></p><script defer src="/finance-security.js"></script>';
const json = (value: unknown) =>
  Response.json(value, { headers: { "Cache-Control": "no-store" } });
const button = (action: string, label: string, value = "") =>
  `<button type="button" data-action="${action}" data-value="${escape(value)}">${escape(label)}</button>`;
const codeInput =
  '<label>Authenticator code<input name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6"></label>';

async function pendingLogin(env: HostedEnv, req: Request): Promise<Pending> {
  const row = await env.CONTROL.prepare(
    "SELECT payload FROM challenges WHERE digest=? AND audience='second' AND expires>?",
  )
    .bind(await hash(readCookie(req, "pending")), now())
    .first<{ payload: string }>();
  assert(row, 403, "Sign-in expired. Start again.");
  return JSON.parse(row.payload);
}
function browserResult(res: Response) {
  const response = json({ next: res.headers.get("location") });
  for (const value of res.headers.getSetCookie())
    response.headers.append("Set-Cookie", value);
  return response;
}
async function optionsResponse(
  env: HostedEnv,
  purpose: string,
  data: object,
  options: object,
) {
  const ticket = await challenge(env, "ceremony:" + purpose, data, 300);
  const res = json(options);
  res.headers.set("Set-Cookie", cookie("ceremony", ticket, 300));
  return res;
}
const getKeys = async (env: HostedEnv, owner: string) =>
  (
    await env.CONTROL.prepare(
      "SELECT * FROM login_keys WHERE customer=? ORDER BY label,id",
    )
      .bind(owner)
      .all<KeyRow>()
  ).results;

export async function securityRoute(req: Request, env: HostedEnv) {
  const path = new URL(req.url).pathname.slice("/cloud/security".length);
  const origin = portal(env),
    rpID = new URL(origin).hostname;
  const isPost = req.method === "POST";
  assert(isPost || req.method === "GET", 405, "Use GET or POST.");
  if (isPost) checkOrigin(req);
  if (path === "/passkey" && !isPost)
    return page(
      "Sign in with a passkey",
      button("login", "Use passkey") +
        '<p><a href="/cloud/start">Other sign-in methods</a></p>' +
        script,
    );
  if (path === "/verify" && !isPost) {
    const pending = await pendingLogin(env, req);
    const otp = await env.CONTROL.prepare(
      "SELECT 1 FROM login_totp WHERE customer=?",
    )
      .bind(pending.customer)
      .first();
    const keys = await getKeys(env, pending.customer);
    return page(
      "Verify your sign-in",
      (otp ? codeInput + button("verify-code", "Verify code") : "") +
        (keys.some((k) => k.role === "second") && !pending.primaryKey
          ? button("second", "Use security key or passkey")
          : "") +
        script,
    );
  }
  if (
    isPost &&
    [
      "/login/options",
      "/login/finish",
      "/second/options",
      "/second/finish",
      "/verify-code",
    ].includes(path)
  ) {
    await rateLimit(
      env.CONTROL,
      "factor-ip:" + (req.headers.get("CF-Connecting-IP") || "local"),
      100,
      300,
    );
    const primary = path.startsWith("/login/");
    const pending = primary ? null : await pendingLogin(env, req);
    let owner = pending?.customer;
    if (owner) await rateLimit(env.CONTROL, "factor-verify:" + owner, 30, 300);
    if (path === "/verify-code") {
      const { code } = z
        .object({ code: z.string() })
        .parse(await readJSON(req, 2048));
      const otp = await env.CONTROL.prepare(
        "SELECT secret FROM login_totp WHERE customer=?",
      )
        .bind(owner)
        .first<{ secret: string }>();
      assert(otp, 403, "Authenticator codes are unavailable.");
      const step = await verifyTotp(await decrypt(env, otp.secret), code);
      assert(
        step !== null &&
          (await env.CONTROL.prepare(
            "UPDATE login_totp SET last_step=? WHERE customer=? AND last_step<? RETURNING customer",
          )
            .bind(step, owner, step)
            .first()),
        403,
        "Enter a new authenticator code.",
      );
    } else {
      assert(!pending?.primaryKey, 403, "Use your authenticator app.");
      const role = primary ? "primary" : "second";
      if (path.endsWith("/options")) {
        const allowed = owner
          ? (await getKeys(env, owner))
              .filter((k) => k.role === role)
              .map(({ id }) => ({ id }))
          : undefined;
        assert(!allowed || allowed.length, 403, "No security key enrolled.");
        const options = await generateAuthenticationOptions({
          rpID,
          allowCredentials: allowed,
          userVerification: primary ? "required" : "preferred",
        });
        return optionsResponse(
          env,
          role,
          { challenge: options.challenge, pending: readCookie(req, "pending") },
          options,
        );
      }
      const assertion = (await readJSON(
        req,
        65536,
      )) as AuthenticationResponseJSON;
      const attempt = await consume(
        env,
        "ceremony:" + role,
        readCookie(req, "ceremony"),
      );
      assert(
        primary || attempt.pending === readCookie(req, "pending"),
        403,
        "Restart verification.",
      );
      const key = await env.CONTROL.prepare(
        "SELECT k.*,c.security_version FROM login_keys k JOIN customers c ON c.id=k.customer WHERE k.id=? AND k.role=?",
      )
        .bind(z.string().max(2048).parse(assertion.id), role)
        .first<KeyRow & { security_version: number }>();
      assert(
        key && (!owner || key.customer === owner),
        403,
        "Key unavailable for this sign-in.",
      );
      const handle = assertion.response?.userHandle;
      assert(
        !handle || handle === Buffer.from(key.customer).toString("base64url"),
        403,
        "Key belongs to another account.",
      );
      const verification = await verifyAuthenticationResponse({
        response: assertion,
        expectedOrigin: origin,
        expectedRPID: rpID,
        expectedChallenge: attempt.challenge,
        requireUserVerification: primary,
        credential: {
          id: key.id,
          publicKey: new Uint8Array(Buffer.from(key.public_key, "base64url")),
          counter: key.counter,
        },
      }).catch(() => null);
      assert(verification?.verified, 403, "Key verification failed.");
      assert(
        await env.CONTROL.prepare(
          "UPDATE login_keys SET counter=? WHERE id=? AND customer=? AND role=? AND counter=? RETURNING id",
        )
          .bind(
            verification.authenticationInfo.newCounter,
            key.id,
            key.customer,
            role,
            key.counter,
          )
          .first(),
        403,
        "Restart key verification.",
      );
      owner = key.customer;
      if (primary)
        return browserResult(
          await afterPrimary(env, owner, true, key.security_version),
        );
    }
    await consume(env, "second", readCookie(req, "pending"));
    return browserResult(await finishSession(env, owner!, pending!.version));
  }

  const c = await customer(env, req);
  if (!c && !isPost) return redirect("/cloud/start");
  assert(c, 401, "Sign in again.");
  const keys = await getKeys(env, c.id);
  const otp = await env.CONTROL.prepare(
    "SELECT 1 FROM login_totp WHERE customer=?",
  )
    .bind(c.id)
    .first();
  const session = await hash(readCookie(req, "session"));
  const fresh = await env.CONTROL.prepare(
    "SELECT 1 FROM sessions WHERE digest=? AND expires>?",
  )
    .bind(session, now() + 86400 - 600)
    .first();
  if (!isPost && path === "") {
    const items = keys
      .map(
        (k) =>
          `<li>${escape(k.label)} · ${k.role === "primary" ? "Primary sign-in" : "Two-factor authentication"} ${button("remove-key", "Remove", k.id)}</li>`,
      )
      .join("");
    const enrollKey =
      '<label>Key name<input name="key-label" maxlength="60" placeholder="My security key"></label>' +
      (!keys.some((k) => k.role === "second")
        ? button("register", "Add a primary passkey", "primary")
        : "") +
      (!keys.some((k) => k.role === "primary")
        ? button("register", "Add a two-factor security key", "second")
        : "");
    return page(
      "Sign-in and security",
      "<p>" +
        escape(c.email) +
        "</p>" +
        (!fresh
          ? '<p>Sign in again to change your methods.</p><a href="/cloud/security/reauth">Email, Google or Apple</a> · <a href="/cloud/security/passkey">Passkey</a>'
          : "") +
        (fresh
          ? "<p>Changing a key or authenticator signs you out of your sessions.</p><fieldset>"
          : "<fieldset disabled>") +
        "<h2>Passkeys and security keys</h2><p>Choose one role for your keys. Remove your enrolled keys before switching roles.</p><ul>" +
        items +
        "</ul>" +
        enrollKey +
        "<h2>Authenticator app</h2>" +
        (otp
          ? button("remove-code", "Remove authenticator")
          : button("setup-code", "Set up authenticator") +
            '<section id="setup" hidden><p>In your authenticator, add a time-based account for phooey! finance using this setup key.</p><code id="setup-secret"></code>' +
            codeInput +
            button("confirm-code", "Confirm authenticator") +
            "</section>") +
        '<h2>Additional sign-in method</h2><form method="post" action="/cloud/security/link"><button>Link email, Google or Apple</button></form></fieldset><p><a href="/cloud/account">Back to account</a></p>' +
        script,
    );
  }
  if (!isPost && path === "/reauth") return startIdentity(env, req);
  assert(
    isPost && fresh,
    403,
    "Sign in again before changing security settings.",
  );
  if (path === "/link") return startIdentity(env, req, c.id);
  await rateLimit(env.CONTROL, "security-settings:" + c.id, 40, 300);
  const values = (await readJSON(req, 65536)) as Record<string, unknown>;
  const activeSession =
    "EXISTS(SELECT 1 FROM sessions WHERE digest=? AND customer=? AND expires>?)";
  const bindings = [session, c.id, now()] as const;
  if (path === "/setup-code") {
    assert(!otp, 409, "An authenticator is already enrolled.");
    const secret = newTotpSecret();
    const ticket = await challenge(
      env,
      "totp-enroll",
      { customer: c.id, session, encrypted: await encrypt(env, secret) },
      300,
    );
    const response = json({ secret });
    response.headers.set("Set-Cookie", cookie("ceremony", ticket, 300));
    return response;
  }
  if (path === "/confirm-code") {
    const pending = await consume(
      env,
      "totp-enroll",
      readCookie(req, "ceremony"),
    );
    assert(
      pending.customer === c.id && pending.session === session,
      403,
      "Restart enrollment.",
    );
    const step = await verifyTotp(
      await decrypt(env, pending.encrypted),
      z.string().parse(values.code),
    );
    assert(step !== null, 400, "Code did not match. Start enrollment again.");
    assert(
      await env.CONTROL.prepare(
        "INSERT INTO login_totp SELECT ?,?,? WHERE " +
          activeSession +
          " RETURNING customer",
      )
        .bind(c.id, pending.encrypted, step, ...bindings)
        .first(),
      403,
      "Sign in again.",
    );
  } else if (path === "/register/options") {
    const role = z.enum(["primary", "second"]).parse(values.role);
    assert(
      keys.every((k) => k.role === role),
      409,
      "Remove keys with the other role first.",
    );
    const options = await generateRegistrationOptions({
      rpName: "phooey! finance",
      rpID,
      userID: new TextEncoder().encode(c.id),
      userName: c.email,
      excludeCredentials: keys.map(({ id }) => ({ id })),
      authenticatorSelection: {
        residentKey: role === "primary" ? "required" : "preferred",
        userVerification: role === "primary" ? "required" : "preferred",
      },
    });
    return optionsResponse(
      env,
      "register",
      {
        customer: c.id,
        session,
        role,
        label: z.string().trim().min(1).max(60).parse(values.label),
        challenge: options.challenge,
      },
      options,
    );
  } else if (path === "/register/finish") {
    const pending = await consume(
      env,
      "ceremony:register",
      readCookie(req, "ceremony"),
    );
    assert(
      pending.customer === c.id && pending.session === session,
      403,
      "Restart registration.",
    );
    const result = await verifyRegistrationResponse({
      response: values as unknown as RegistrationResponseJSON,
      expectedOrigin: origin,
      expectedRPID: rpID,
      expectedChallenge: pending.challenge,
      requireUserVerification: pending.role === "primary",
    }).catch(() => null);
    assert(
      result?.verified && result.registrationInfo,
      403,
      "Registration failed.",
    );
    const key = result.registrationInfo.credential;
    assert(
      await env.CONTROL.prepare(
        "INSERT INTO login_keys SELECT ?,?,?,?,?,? WHERE " +
          activeSession +
          " RETURNING id",
      )
        .bind(
          key.id,
          c.id,
          pending.role,
          Buffer.from(key.publicKey).toString("base64url"),
          key.counter,
          pending.label,
          ...bindings,
        )
        .first(),
      403,
      "Sign in again.",
    );
  } else if (path === "/remove-key") {
    await env.CONTROL.prepare(
      "DELETE FROM login_keys WHERE id=? AND customer=? AND " + activeSession,
    )
      .bind(z.string().parse(values.id), c.id, ...bindings)
      .run();
  } else if (path === "/remove-code") {
    await env.CONTROL.prepare(
      "DELETE FROM login_totp WHERE customer=? AND " + activeSession,
    )
      .bind(c.id, ...bindings)
      .run();
  } else return new Response("Not found", { status: 404 });
  return json({ next: "/cloud/start" });
}
