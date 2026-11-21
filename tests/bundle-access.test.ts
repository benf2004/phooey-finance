import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import worker from "../src/hosted/worker";
import { authenticator } from "./finance-authenticator";
import { verifyTotp } from "../src/hosted/totp";
import { encrypt } from "../src/server/auth";
import {
  afterPrimary,
  finishIdentity,
  issueSession,
  type HostedEnv,
} from "../src/hosted/control";
import { authenticate, credentialVersion, login } from "../src/server/auth";

const market = "https://getfinance.phooey.foo";
const app = "https://finance.phooey.foo";
const slot = "https://slot.example.test";
function database() {
  const raw = new DatabaseSync(":memory:");
  for (const file of [
    "0001_control",
    "0002_metrics",
    "0003_alerts",
    "0004_login_factors",
  ])
    raw.exec(readFileSync("hosted/migrations/" + file + ".sql", "utf8"));
  raw
    .prepare(
      "INSERT INTO customers(id,email,subject,paid_until) VALUES(?,?,?,?)",
    )
    .run(
      "owner",
      "owner@example.test",
      "subject",
      Math.floor(Date.now() / 1000) + 5000,
    );
  raw.prepare("INSERT INTO workspaces VALUES(?,?,?)").run("one", slot, "owner");
  return {
    raw,
    prepare(query: string) {
      const stmt = raw.prepare(query);
      const bound = (...values: string[]) => ({
        first: async () => stmt.get(...values) ?? null,
        all: async () => ({ results: stmt.all(...values) }),
        run: async () => stmt.run(...values),
      });
      return { ...bound(), bind: bound };
    },
  };
}
function fixture() {
  const db = database();
  const service = vi.fn(async (_req: Request) => Response.json({ ok: true }));
  const env = {
    CONTROL: db,
    PORTAL_ORIGIN: market,
    APP_ORIGIN: app,
    ASSETS: { fetch: () => new Response("Marketing") },
    INVOICER: { fetch: service },
    INVOICER_KEY: "i".repeat(32),
    GOOGLE_LOGIN_CLIENT: "Google client",
    GOOGLE_LOGIN_SECRET: "Google secret",
    APPLE_LOGIN_CLIENT: "Apple client",
    APPLE_LOGIN_SECRET: "Apple secret",
  } as unknown as HostedEnv;
  const request = (path: string, init?: RequestInit) =>
    worker.fetch(
      new Request(path, init),
      path.startsWith(slot) ? { ...env, WORKSPACE_ID: "one" } : env,
      { waitUntil: () => {} } as unknown as ExecutionContext,
    );
  return { db, env, service, request };
}
describe("subscriber workspace", () => {
  it("exposes the fictional dashboard and sends owners to their private workspace", async () => {
    const { request, env } = fixture();
    expect((await request(market + "/dashboard-preview")).status).toBe(200);
    expect((await request(app + "/dashboard")).headers.get("location")).toBe(
      "/cloud/start",
    );
    const cookie = (await issueSession(env, "owner", app)).split(";")[0];
    expect(
      (await request(app, { headers: { Cookie: cookie } })).headers.get(
        "location",
      ),
    ).toBe(slot + "/cloud/enter");
    const handoff = await request(slot + "/cloud/enter");
    expect(new URL(handoff.headers.get("location")!).origin).toBe(app);
    const next = await request(app + "/dashboard", {
      headers: { Cookie: cookie },
    });
    expect(next.headers.get("location")).toBe("/cloud/open");
    expect(
      (
        await request(app + "/cloud/open", { headers: { Cookie: cookie } })
      ).headers.get("location"),
    ).toBe(slot + "/cloud/enter");
    for (const path of [
      "/freelance-demo",
      "/foundation-preview",
      "/tiller-preview",
    ])
      expect((await request(market + path)).headers.get("location")).toBe(
        "/dashboard-preview",
      );
    for (const path of [
      "/business/template/",
      "/business/template/Foundation.xlsx",
      "/business/assets/workbook.png",
    ])
      expect((await request(market + path)).status).toBe(410);
  });
  it("routes signed-out app visitors to marketing and offers the configured social providers", async () => {
    const { request } = fixture();
    const r = await request(app);
    expect(r.headers.get("location")).toBe(market + "/");
    expect(await (await request(market)).text()).toBe("Marketing");
    for (const path of ["/cloud/start", "/dashboard", "/cloud/account"]) {
      const old = await request(market + path + "?state=discard");
      expect(old.headers.get("location")).toBe(app + path);
      expect(old.headers.has("set-cookie")).toBe(false);
    }
    for (const [path, method] of [
      ["/cloud/social/google", "GET"],
      ["/cloud/social/google/callback", "GET"],
      ["/cloud/social/apple/callback", "POST"],
      ["/cloud/webhook", "POST"],
      ["/cloud/checkout", "POST"],
      ["/cloud/mobile/exchange", "POST"],
    ]) {
      const res = await request(market + path, { method });
      expect(res.status).toBe(404);
      expect(res.headers.has("set-cookie")).toBe(false);
    }
    const google = await request(app + "/cloud/social/google");
    expect(
      new URL(google.headers.get("location")!).searchParams.get("redirect_uri"),
    ).toBe(app + "/cloud/social/google/callback");
    const login = await (await request(app + "/cloud/start")).text();
    expect(login).toContain("Continue with Google");
    expect(login).toContain("Continue with Apple");
    const apple = await request(app + "/cloud/social/apple");
    const auth = new URL(apple.headers.get("location")!);
    expect(auth.searchParams.get("redirect_uri")).toBe(
      app + "/cloud/social/apple/callback",
    );
    expect(auth.hostname).toBe("appleid.apple.com");
    expect(auth.searchParams.get("response_mode")).toBe("form_post");
    const bad = await request(app + "/cloud/social/apple/callback", {
      method: "POST",
      body: new URLSearchParams({ state: "wrong", code: "fake" }),
    });
    expect(bad.status).toBe(400);
  });
  it.each(["Google", "Apple"])(
    "signs in existing %s customers through Melody on Finance",
    async (provider) => {
      const { env, db, request } = fixture();
      const issuer =
        provider === "Google"
          ? "https://accounts.google.com"
          : "https://appleid.apple.com";
      db.raw
        .prepare("UPDATE customers SET subject=? WHERE id='owner'")
        .run(issuer + "|123");
      let challenge = "";
      let verified = false;
      const service = vi.fn(async (req: Request) => {
        const path = new URL(req.url).pathname;
        if (path === "/oauth2/v1/token") {
          const form = await req.formData();
          expect(
            createHash("sha256")
              .update(String(form.get("code_verifier")))
              .digest("base64url"),
          ).toBe(challenge);
          expect(form.has("client_secret")).toBe(false);
          return Response.json({ access_token: "melody-token" });
        }
        if (path === "/oauth2/v1/userinfo") {
          expect(req.headers.get("authorization")).toBe("Bearer melody-token");
          return Response.json({
            authId: "melody-user",
            socialAccountType: provider,
            socialAccountId: "123",
            email: "owner@example.test",
            emailVerified: verified,
          });
        }
        expect(req.headers.has("Cookie")).toBe(false);
        expect(req.headers.has("Authorization")).toBe(false);
        return new Response("Sign in with Melody");
      });
      env.MELODY = { fetch: service } as unknown as Fetcher;
      env.MELODY_CLIENT = "phooey-finance";
      for (const success of [false, true]) {
        verified = success;
        const start = await request(app + "/cloud/start");
        const auth = new URL(start.headers.get("location")!);
        expect(auth.origin + auth.pathname).toBe(app + "/oauth2/v1/authorize");
        expect(auth.searchParams.get("scope")).toBe("openid profile");
        challenge = auth.searchParams.get("code_challenge")!;
        expect(
          await (
            await request(auth.href, {
              headers: { Cookie: "finance-session", Authorization: "secret" },
            })
          ).text(),
        ).toBe("Sign in with Melody");
        const callback =
          app +
          "/cloud/callback?code=fixture&state=" +
          auth.searchParams.get("state");
        const headers = {
          Cookie: start.headers.get("set-cookie")!.split(";")[0],
        };
        expect((await request(callback)).status).toBe(400);
        const result = await request(callback, { headers });
        if (success) {
          expect(result.headers.get("location")).toBe(app + "/cloud/account");
          const session = result.headers.getSetCookie()[0].split(";")[0];
          expect(
            (
              await request(app + "/", { headers: { Cookie: session } })
            ).headers.get("location"),
          ).toBe(slot + "/cloud/enter");
        } else expect(result.status).toBe(403);
        expect((await request(callback, { headers })).status).toBe(400);
      }
      expect((await request(app + "/cloud/social/google")).status).toBe(410);
      expect(
        (await request(market + "/identity/v1/view/authorize")).status,
      ).toBe(404);
      expect(
        (
          await request(app + "/oauth2/v1/token", {
            method: "POST",
            headers: { Origin: app },
          })
        ).status,
      ).toBe(404);
      expect(
        (await request(app + "/oauth2/v1/authorize?client_id=other")).status,
      ).toBe(400);
      expect((await request(app + "/client.js")).status).toBe(200);
    },
  );
  it("accepts verified password identities and keeps different accounts with the same email separate", async () => {
    const { env, request, db } = fixture();
    env.MELODY_CLIENT = "phooey-finance";
    env.MELODY = {
      fetch: async (req: Request) =>
        Response.json(
          req.url.endsWith("/token")
            ? { access_token: "access" }
            : {
                authId: "password-user",
                socialAccountType: null,
                socialAccountId: null,
                email: "owner@example.test",
                emailVerified: true,
              },
        ),
    } as Fetcher;
    const start = await request(app + "/cloud/start");
    const state = new URL(start.headers.get("location")!).searchParams.get(
      "state",
    );
    const res = await finishIdentity(
      env,
      new Request(app + "/cloud/callback?state=" + state + "&code=ok", {
        headers: { Cookie: start.headers.get("set-cookie")!.split(";")[0] },
      }),
    );
    expect(res.headers.get("location")).toBe(app + "/cloud/account");
    expect(db.raw.prepare("SELECT count(*) AS n FROM customers").get()?.n).toBe(
      2,
    );
  });
  it.each(["primary", "second"] as const)(
    "enrolls and verifies a signed %s key in its permitted role",
    async (role) => {
      const { env, db, request } = fixture();
      env.MELODY = {} as Fetcher;
      env.ENCRYPTION_KEY = Buffer.alloc(32, 42).toString("base64");
      const cookieOf = (r: Response, name: string) =>
        r.headers
          .getSetCookie()
          .find((c) => c.startsWith("__Host-phooey_" + name + "="))!
          .split(";")[0];
      const post = (path: string, cookies: string, body: unknown = {}) =>
        request(app + "/cloud/security/" + path, {
          method: "POST",
          headers: {
            Origin: app,
            Cookie: cookies,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        });
      const session = (await issueSession(env, "owner", app)).split(";")[0];
      const key = authenticator(app);
      const begin = await post("register/options", session, {
        role,
        label: "My key",
      });
      const registered = await post(
        "register/finish",
        session + "; " + cookieOf(begin, "ceremony"),
        key.register(((await begin.json()) as { challenge: string }).challenge),
      );
      expect(registered.status).toBe(200);
      const secondSession = (await issueSession(env, "owner", app)).split(
        ";",
      )[0];
      expect(
        (
          await post("register/options", secondSession, {
            role: role === "primary" ? "second" : "primary",
            label: "Other",
          })
        ).status,
      ).toBe(409);
      const otpSecret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
      if (role === "primary")
        db.raw
          .prepare("INSERT INTO login_totp VALUES(?,?,?)")
          .run("owner", await encrypt(env, otpSecret), 0);
      const pending =
        role === "second"
          ? cookieOf(await afterPrimary(env, "owner"), "pending")
          : "";
      const op = role === "primary" ? "login" : "second";
      const opts = await post(op + "/options", pending);
      const assertion = key.authenticate(
        ((await opts.json()) as { challenge: string }).challenge,
        "owner",
      );
      const cookies = [pending, cookieOf(opts, "ceremony")]
        .filter(Boolean)
        .join("; ");
      const result = await post(op + "/finish", cookies, assertion);
      expect(result.status).toBe(200);
      expect((await post(op + "/finish", cookies, assertion)).status).toBe(
        role === "primary" ? 400 : 403,
      );
      if (role === "second") {
        expect(cookieOf(result, "session")).toMatch(/session=.+/);
      } else {
        const stepCookie = cookieOf(result, "pending");
        expect(
          await (
            await request(app + "/cloud/security/verify", {
              headers: { Cookie: stepCookie },
            })
          ).text(),
        ).toContain("Authenticator code");
        expect((await post("second/options", stepCookie)).status).toBe(403);
        expect(
          (
            await request(app + "/cloud/mobile/authorize", {
              method: "POST",
              headers: { Origin: app, Cookie: stepCookie },
            })
          ).headers.get("location"),
        ).toBe("/cloud/start");
        const clock = vi.spyOn(Date, "now");
        const current = Date.now();
        const step = Math.floor(current / 30000);
        const count = Buffer.alloc(8);
        count.writeBigUInt64BE(BigInt(step));
        const mac = createHmac("sha1", "12345678901234567890")
          .update(count)
          .digest();
        const code = String(
          (mac.readUInt32BE(mac[19] & 15) & 0x7fffffff) % 1000000,
        ).padStart(6, "0");
        try {
          clock.mockReturnValue(current);
          const complete = await post("verify-code", stepCookie, { code });
          expect(cookieOf(complete, "session")).toMatch(/session=.+/);
          const again = cookieOf(await afterPrimary(env, "owner"), "pending");
          expect((await post("verify-code", again, { code })).status).toBe(403);
        } finally {
          clock.mockRestore();
        }
      }
    },
  );
  it("enrolls and removes app-code protection only from a freshly signed-in account", async () => {
    const { env, db, request } = fixture();
    env.MELODY = {} as Fetcher;
    env.ENCRYPTION_KEY = Buffer.alloc(32, 45).toString("base64");
    const session = (await issueSession(env, "owner", app)).split(";")[0];
    const post = (path: string, cookies: string, data: object = {}) =>
      request(app + "/cloud/security/" + path, {
        method: "POST",
        headers: {
          Origin: app,
          Cookie: cookies,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(data),
      });
    const setup = await post("setup-code", session);
    const ticket = setup.headers.get("set-cookie")!.split(";")[0];
    const { secret } = (await setup.json()) as { secret: string };
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(
      db.raw.prepare("SELECT count(*) AS n FROM login_totp").get()?.n,
    ).toBe(0);
    const bits = Array.from(secret, (c) =>
      "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"
        .indexOf(c)
        .toString(2)
        .padStart(5, "0"),
    ).join("");
    const raw = Buffer.from(bits.match(/.{8}/g)!.map((x) => parseInt(x, 2)));
    const counter = Buffer.alloc(8);
    counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
    const signed = createHmac("sha1", raw).update(counter).digest();
    const code = String(
      (signed.readUInt32BE(signed[19] & 15) & 0x7fffffff) % 1000000,
    ).padStart(6, "0");
    expect(
      (await post("confirm-code", session + "; " + ticket, { code })).status,
    ).toBe(200);
    expect(
      db.raw.prepare("SELECT secret FROM login_totp").get()?.secret,
    ).not.toBe(secret);
    expect((await post("remove-code", session)).status).toBe(401);
    expect((await afterPrimary(env, "owner")).headers.get("location")).toBe(
      "/cloud/security/verify",
    );
    const fresh = (await issueSession(env, "owner", app)).split(";")[0];
    expect((await post("remove-code", fresh)).status).toBe(200);
    expect((await afterPrimary(env, "owner")).headers.get("location")).toBe(
      app + "/cloud/account",
    );
  });
  it("checks authenticator codes against the RFC 6238 SHA-1 vector", async () => {
    expect(
      await verifyTotp("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", "287082", 59),
    ).toBe(1);
  });
  it("forwards only entitled invoice requests and keeps the service credential off public shares", async () => {
    const { env, request, service, db } = fixture();
    const cookie = (await issueSession(env, "owner", slot, "dashboard")).split(
      ";",
    )[0];
    expect((await request(slot + "/invoicer/api/v1/invoices")).status).toBe(
      401,
    );
    expect(
      (
        await request(slot + "/invoicer/api/v1/invoices", {
          method: "POST",
          headers: { Cookie: cookie, Origin: "https://other.test" },
        })
      ).status,
    ).toBe(403);
    await request(slot + "/invoicer/api/v1/invoices", {
      headers: { Cookie: cookie },
    });
    expect(service.mock.calls[0][0].headers.get("authorization")).toBe(
      "Bearer " + env.INVOICER_KEY,
    );
    expect(service.mock.calls[0][0].headers.has("cookie")).toBe(false);
    await request(slot + "/invoicer/s/share/info", {
      headers: { Authorization: "Bearer forged" },
    });
    expect(service.mock.calls[1][0].headers.has("authorization")).toBe(false);
    db.raw.exec("UPDATE customers SET paid_until=0");
    expect(
      (
        await request(slot + "/invoicer/api/v1/invoices", {
          headers: { Cookie: cookie },
        })
      ).status,
    ).toBe(402);
    expect(service).toHaveBeenCalledTimes(2);
  });
  it("binds the iPhone grant to its verifier, workspace, and one exchange", async () => {
    const { env, request } = fixture();
    const state = randomBytes(32).toString("base64url"),
      verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const start = await request(
      app + "/cloud/mobile/start?" + new URLSearchParams({ state, challenge }),
    );
    const cookie = [
      start.headers.get("set-cookie")!,
      await issueSession(env, "owner", app),
    ]
      .map((v) => v.split(";")[0])
      .join("; ");
    const allow = await request(app + "/cloud/mobile/authorize", {
      method: "POST",
      headers: { Origin: app, Cookie: cookie },
    });
    const callback = new URL(allow.headers.get("location")!);
    expect(callback.searchParams.get("state")).toBe(state);
    const code = callback.searchParams.get("code");
    const exchange = (proof: string) =>
      request(app + "/cloud/mobile/exchange", {
        method: "POST",
        body: JSON.stringify({ code, verifier: proof }),
      });
    expect((await exchange(state)).status).toBe(400);
    const grant = (await (await exchange(verifier)).json()) as {
      origin: string;
      ticket: string;
    };
    expect(grant.origin).toBe(slot);
    expect((await exchange(verifier)).status).toBe(400);
    const accept = () =>
      request(slot + "/cloud/mobile/accept", {
        method: "POST",
        body: JSON.stringify({ ticket: grant.ticket }),
      });
    expect((await accept()).headers.get("set-cookie")).toContain(
      "__Host-phooey_dashboard",
    );
    expect((await accept()).status).toBe(400);
  });
  it("rejects an old self-hosted session after admin key rotation", async () => {
    const db = database();
    db.raw.exec(
      "DROP TABLE sessions; CREATE TABLE sessions(token_hash TEXT PRIMARY KEY,expires_at INTEGER,credential_version TEXT)",
    );
    const env = { DB: db, ADMIN_KEY: "a".repeat(40) } as unknown as HostedEnv;
    await expect(login(env, "", "incorrect", "ip")).rejects.toThrow(
      "Incorrect admin key",
    );
    const token = await login(env, "", env.ADMIN_KEY!, "ip");
    const req = new Request(slot, {
      headers: { Cookie: "phooey_session=" + token },
    });
    expect(await authenticate(env, req)).toBeTruthy();
    const version = await credentialVersion(env);
    env.ADMIN_KEY = "b".repeat(40);
    expect(await credentialVersion(env)).not.toBe(version);
    expect(await authenticate(env, req)).toBeNull();
  });
});
