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
  signInDestination,
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
type Pending = {
  customer: string;
  version: number;
  primaryKey: boolean;
  destination?: string;
};
const script =
  '<p role="status" id="auth-status"></p><script defer src="/finance-security.js"></script>';
const json = (value: unknown) =>
  Response.json(value, { headers: { "Cache-Control": "no-store" } });
const button = (action: string, label: string, value = "") =>
  `<button type="button" data-action="${action}" data-value="${escape(value)}">${escape(label)}</button>`;
const codeInput =
  '<label for="auth-code">Authenticator code<input id="auth-code" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required placeholder="000000"></label>';
const codeForm = (action: string, label: string) =>
  `<form data-security-action="${action}">${codeInput}<button type="submit">${label}</button></form>`;

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
      '<p class="page-lead">One more step to keep your account safe.</p>' +
        (otp ? codeForm("verify-code", "Verify and continue") : "") +
        (keys.some((k) => k.role === "second") && !pending.primaryKey
          ? button("second", "Use security key or passkey")
          : "") +
        '<p class="page-footnote"><a href="/cloud/start">Start sign-in again</a></p>' +
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
      if (primary) {
        // Passkeys started on the authorization page preserve the same server-held destination.
        const login = await env.CONTROL.prepare(
          "SELECT payload FROM challenges WHERE digest=? AND audience='melody' AND expires>?",
        )
          .bind(await hash(readCookie(req, "login")), now())
          .first<{ payload: string }>();
        const destination = login
          ? signInDestination(JSON.parse(login.payload).destination)
          : undefined;
        return browserResult(
          await afterPrimary(
            env,
            owner,
            true,
            key.security_version,
            destination,
          ),
        );
      }
    }
    await consume(env, "second", readCookie(req, "pending"));
    return browserResult(
      await finishSession(env, owner!, pending!.version, pending!.destination),
    );
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
  if (!isPost && path === "/setup") {
    if (otp || keys.some((key) => key.role === "second"))
      return redirect("/cloud/account");
    return page(
      "Add a little extra security",
      `
      <ol class="setup-steps" aria-label="Account setup"><li>1. Account created</li><li>2. Email confirmed</li><li aria-current="step">3. Security</li></ol>
      <p class="page-lead">Your account is ready. Add two-factor authentication for an extra layer of protection.</p>
      <section class="security-panel"><span class="eyebrow">Optional</span><h2>Authenticator app</h2>
      <p>Use a time-based code from your authenticator app when you sign in.</p>
      ${fresh ? button("setup-code", "Set up two-factor authentication") : '<a class="button" href="/cloud/security/reauth?next=/cloud/security/setup">Sign in to set up</a>'}
      <section id="setup" hidden><p>Add an account in your authenticator using this setup key, then enter its six-digit code.</p><code id="setup-secret"></code>${codeForm("confirm-code", "Enable two-factor authentication")}</section></section>
      <div class="setup-footer"><a class="button button-secondary" href="/cloud/account">Skip for now</a><p>You can set this up later in Sign-in and security.</p></div>${script}`,
    );
  }
  if (!isPost && path === "") {
    const disabled = fresh ? "" : " disabled";
    const items = keys
      .map(
        (key) =>
          `<li><div><strong>${escape(key.label)}</strong><span>${key.role === "primary" ? "Passkey sign-in" : "Two-factor security key"}</span></div>${button("remove-key", "Remove", key.id)}</li>`,
      )
      .join("");
    const setup =
      '<section id="setup" hidden><p>Add a time-based account in your authenticator app using this setup key, then enter its six-digit code.</p><code id="setup-secret"></code>' +
      codeForm("confirm-code", "Enable authenticator") +
      "</section>";
    return page(
      "Sign-in and security",
      `<p class="security-intro">Manage how you sign in and protect your account.</p>
      <div class="security-account"><span>Signed in as</span><strong>${escape(c.email)}</strong></div>
      ${
        fresh
          ? '<p class="security-session-note">Security changes sign you out on other devices. This browser stays signed in.</p>'
          : '<section class="security-reauth" aria-labelledby="reauth-title"><div><h2 id="reauth-title">Confirm it’s you to make changes</h2><p>Your settings are locked until you sign in again.</p></div><div class="actions"><a class="button" href="/cloud/security/reauth">Sign in again</a><a href="/cloud/security/passkey">Use a passkey</a></div></section>'
      }
      <div class="security-settings">
        <section class="security-setting" aria-labelledby="passkeys-title">
          <div class="security-setting-info"><h2 id="passkeys-title">Passkeys &amp; security keys</h2><p>Sign in with your device’s fingerprint, face recognition, or a physical key.</p><span class="access-badge${keys.length ? " access-active" : ""}">${keys.length ? keys.length + (keys.length === 1 ? " key added" : " keys added") : "Not set up"}</span></div>
          <fieldset class="security-controls"${disabled}><legend class="visually-hidden">Manage passkeys and security keys</legend>
            ${items ? `<ul class="security-key-list">${items}</ul>` : ""}
            <label for="key-label">Device name<input id="key-label" name="key-label" maxlength="60" placeholder="e.g. My MacBook" autocomplete="off"></label>
            <div class="security-buttons">${!keys.some((key) => key.role === "second") ? button("register", "Add passkey", "primary") : ""}${!keys.some((key) => key.role === "primary") ? button("register", "Add two-factor security key", "second") : ""}</div>
            <p class="security-help">Keys can sign you in or act as a second factor. Remove existing keys before switching between these uses.</p>
          </fieldset>
        </section>
        <section class="security-setting" aria-labelledby="authenticator-title">
          <div class="security-setting-info"><h2 id="authenticator-title">Authenticator app</h2><p>Add a six-digit code from an app like 1Password or Google Authenticator when you sign in.</p><span class="access-badge${otp ? " access-active" : ""}">${otp ? "Enabled" : "Not enabled"}</span></div>
          <fieldset class="security-controls"${disabled}><legend class="visually-hidden">Manage authenticator app</legend>${otp ? '<p class="security-control-description">Your account is protected with two-factor authentication.</p>' + button("remove-code", "Remove authenticator") : button("setup-code", "Set up authenticator") + setup}</fieldset>
        </section>
        <section class="security-setting" aria-labelledby="linked-title">
          <div class="security-setting-info"><h2 id="linked-title">Connected sign-in methods</h2><p>Link another email, Google, or Apple login to this same account.</p></div>
          <fieldset class="security-controls"${disabled}><legend class="visually-hidden">Connect another sign-in method</legend><form method="post" action="/cloud/security/link"><button>Connect a sign-in method</button></form></fieldset>
        </section>
      </div>${script}`,
      200,
      "security",
    );
  }
  if (!isPost && path === "/reauth") {
    const url = new URL(req.url);
    if (!url.searchParams.has("next"))
      url.searchParams.set("next", "/cloud/security");
    return startIdentity(env, new Request(url, req));
  }
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
    await rateLimit(env.CONTROL, "totp-enroll:" + c.id, 10, 300);
    const enrollment = await env.CONTROL.prepare(
      "SELECT payload FROM challenges WHERE digest=? AND audience='totp-enroll' AND expires>?",
    )
      .bind(await hash(readCookie(req, "ceremony")), now())
      .first<{ payload: string }>();
    assert(
      enrollment,
      400,
      "Setup expired. Choose Set up authenticator to get a new key.",
    );
    const pending = JSON.parse(enrollment.payload);
    assert(
      pending.customer === c.id && pending.session === session,
      403,
      "Restart enrollment.",
    );
    const step = await verifyTotp(
      await decrypt(env, pending.encrypted),
      z.string().parse(values.code),
    );
    assert(
      step !== null,
      400,
      "That code did not match. Try the current six-digit code from your authenticator.",
    );
    await consume(env, "totp-enroll", readCookie(req, "ceremony"));
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
    const removed = await env.CONTROL.prepare(
      "DELETE FROM login_keys WHERE id=? AND customer=? AND " +
        activeSession +
        " RETURNING id",
    )
      .bind(z.string().parse(values.id), c.id, ...bindings)
      .first();
    assert(
      removed,
      404,
      "This key is no longer enrolled. Refresh your security settings.",
    );
  } else if (path === "/remove-code") {
    const removed = await env.CONTROL.prepare(
      "DELETE FROM login_totp WHERE customer=? AND " +
        activeSession +
        " RETURNING customer",
    )
      .bind(c.id, ...bindings)
      .first();
    assert(
      removed,
      404,
      "An authenticator is no longer enrolled. Refresh your security settings.",
    );
  } else return new Response("Not found", { status: 404 });
  // Security triggers revoke every old session. Keep this freshly authenticated
  // browser signed in with a new token after its successful security change.
  return browserResult(
    await finishSession(
      env,
      c.id,
      c.security_version + 1,
      values.next === "/cloud/account" ? "/cloud/account" : "/cloud/security",
    ),
  );
}
