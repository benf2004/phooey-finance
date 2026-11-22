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
  completeSignIn,
  finishIdentity,
  issueSession,
  type Customer,
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
    "0005_subscription_trial",
    "0006_admin_accounts",
    "0007_mcp_routing",
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
    async batch(statements: { all(): Promise<unknown> }[]) {
      raw.exec("BEGIN");
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.all());
        raw.exec("COMMIT");
        return results;
      } catch (error) {
        raw.exec("ROLLBACK");
        throw error;
      }
    },
    prepare(query: string) {
      const stmt = raw.prepare(query);
      const bound = (...values: string[]) => ({
        first: async () => stmt.get(...values) ?? null,
        all: async () => ({ results: stmt.all(...values) }),
        run: async () => ({ meta: stmt.run(...values) }),
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
  function gatewayFixture() {
    const f = fixture();
    f.env.CANONICAL_APP = "true";
    const gateway = vi.fn((req: Request) => worker.fetch(req, { ...f.env, WORKSPACE_ID: "one" },
      { waitUntil: () => {} } as unknown as ExecutionContext));
    f.env.WORKSPACE_SERVICE_one = { fetch: gateway } as unknown as Fetcher;
    return { ...f, gateway };
  }
  it("opens Finance and Invoicer on the app domain using the assigned workspace binding", async () => {
    const { env, request, gateway, service } = gatewayFixture();
    const headers = { Cookie: (await issueSession(env, "owner", app)).split(";")[0] };
    const account = await (await request(app + "/cloud/account", { headers })).text();
    expect(account).toContain(`href="${app}/"`);
    expect(account).toContain(`href="${app}/invoicer/"`);
    expect(account).not.toContain(slot + "/cloud/enter");
    expect((await request(app + "/cloud/open", { headers })).headers.get("location")).toBe("/");
    expect((await request(app + "/", { headers })).status).toBe(200);
    expect((await request(app + "/invoicer/", { headers })).status).toBe(200);
    expect(gateway.mock.calls.every(([req]) => new URL(req.url).origin === app)).toBe(true);
    // Public invoice links still identify the workspace for signed-out recipients.
    expect(service.mock.calls[0][0].url).toBe(slot + "/");
  });
  it("requires an app session and rejects another owner's session in the workspace", async () => {
    const { env, db, request, gateway, service } = gatewayFixture();
    expect((await request(app + "/invoicer/api/v1/invoices")).status).toBe(401);
    expect((await request(app + "/settings")).headers.get("location")).toBe("/cloud/start");
    const wrongAudience = (await issueSession(env, "owner", slot, "dashboard")).split(";")[0];
    expect((await request(app + "/invoicer/api/v1/invoices", { headers: { Cookie: wrongAudience } })).status).toBe(401);
    db.raw.exec("INSERT INTO customers(id,email,subject,paid_until) VALUES('other','other@test.example','other',9999999999)");
    const Cookie = (await issueSession(env, "other", app)).split(";")[0];
    const response = await gateway(new Request(app + "/invoicer/api/v1/invoices", { headers: { Cookie } }));
    expect(response.status).toBe(401);
    expect(service).not.toHaveBeenCalled();
  });
  it("checks subscription and request origin before forwarding invoice changes", async () => {
    const { env, db, request, service } = gatewayFixture();
    const Cookie = (await issueSession(env, "owner", app)).split(";")[0];
    expect((await request(app + "/invoicer/api/v1/invoices", {
      method: "POST", headers: { Cookie, Origin: "https://evil.test" }, body: "{}",
    })).status).toBe(403);
    expect(service).not.toHaveBeenCalled();
    const saved = await request(app + "/invoicer/api/v1/invoices", {
      method: "POST", headers: { Cookie, Origin: app, "Content-Type": "application/json" }, body: "{}",
    });
    expect(saved.status, await saved.text()).toBe(200);
    service.mockClear();
    db.raw.exec("UPDATE customers SET paid_until=0");
    expect((await request(app + "/invoicer/", { headers: { Cookie } })).status).toBe(402);
    expect(service).not.toHaveBeenCalled();
  });
  it("redirects old browser links but retains public invoice access", async () => {
    const { request, service } = gatewayFixture();
    expect((await request(slot + "/")).headers.get("location")).toBe(app + "/");
    expect((await request(slot + "/transactions?account=one")).headers.get("location")).toBe(app + "/transactions?account=one");
    expect((await request(slot + "/cloud/enter?view=invoicer")).headers.get("location")).toBe(app + "/invoicer/");
    expect((await request(slot + "/invoicer/s/shared/info")).status).toBe(200);
    expect(service).toHaveBeenCalledOnce();
  });
  it("does not fall back to the old origin when a workspace binding is missing", async () => {
    const { env, request } = gatewayFixture();
    delete env.WORKSPACE_SERVICE_one;
    const Cookie = (await issueSession(env, "owner", app)).split(";")[0];
    expect((await request(app + "/", { headers: { Cookie } })).status).toBe(503);
  });
  it("gives administrators their own dashboard and Invoicer without checkout", async () => {
    const { db, env, request, service } = fixture();
    db.raw.exec(`UPDATE customers SET paid_until=0;
      UPDATE workspaces SET owner=NULL;
      INSERT INTO account_admins VALUES('owner');
      INSERT INTO workspaces VALUES('two','https://empty.example.test',NULL)`);
    const headers = {
      Cookie: (await issueSession(env, "owner", app)).split(";")[0],
      Origin: app,
    };
    const account = await request(app + "/cloud/account", { headers });
    const html = await account.text();
    expect(html).toContain("Administrator · Full access included");
    expect(html).toContain("Open Finance dashboard");
    expect(html).toContain("Open Invoicer");
    expect(html).not.toContain('action="/cloud/checkout"');
    expect(
      (await request(app + "/cloud/open", { headers })).headers.get("location"),
    ).toBe(slot + "/cloud/enter");
    expect(
      (
        await request(app + "/cloud/checkout", { method: "POST", headers })
      ).headers.get("location"),
    ).toBe("/cloud/open");
    expect(
      db.raw
        .prepare("SELECT count(*) AS n FROM workspaces WHERE owner='owner'")
        .get()?.n,
    ).toBe(1);
    expect(
      db.raw.prepare("SELECT owner FROM workspaces WHERE id='two'").get()
        ?.owner,
    ).toBeNull();
    expect(
      db.raw
        .prepare(
          "SELECT stripe_customer,checkout_attempt FROM customers WHERE id='owner'",
        )
        .get(),
    ).toMatchObject({ stripe_customer: null, checkout_attempt: null });
    const dashboard = {
      Cookie: (await issueSession(env, "owner", slot, "dashboard")).split(
        ";",
      )[0],
    };
    expect(
      (await request(slot + "/invoicer/", { headers: dashboard })).status,
    ).toBe(200);
    expect(service).toHaveBeenCalledOnce();
    // Revoking admin access does not leave a permanent complimentary grant.
    db.raw.exec("DELETE FROM account_admins WHERE customer='owner'");
    expect(
      (await request(slot + "/invoicer/", { headers: dashboard })).status,
    ).toBe(402);
  });
  it("never assigns an administrator another customer's workspace when capacity is full", async () => {
    const { db, env, request } = fixture();
    db.raw
      .exec(`INSERT INTO customers(id,subject,email) VALUES('admin','admin-subject','admin@example.test');
      INSERT INTO account_admins VALUES('admin')`);
    const headers = {
      Cookie: (await issueSession(env, "admin", app)).split(";")[0],
    };
    const account = await request(app + "/cloud/account", { headers });
    expect(account.status).toBe(200);
    const html = await account.text();
    expect(html).toContain("All hosted workspaces are assigned");
    expect(html).not.toContain('action="/cloud/checkout"');
    expect(
      db.raw.prepare("SELECT owner FROM workspaces WHERE id='one'").get()
        ?.owner,
    ).toBe("owner");
    expect((await request(app + "/admin", { headers })).status).toBe(200);
    expect(
      (
        await request(
          app + "/cloud/authorize-workspace?slot=one&nonce=" + "x".repeat(43),
          { headers },
        )
      ).status,
    ).toBe(403);
  });
  it("keeps native account forms same-origin and rejects forged origins", async () => {
    const { env, db, request } = fixture();
    db.raw.exec("INSERT INTO account_admins VALUES('owner')");
    const Cookie = (await issueSession(env, "owner", app)).split(";")[0];
    expect(
      (
        await request(app + "/cloud/account", { headers: { Cookie } })
      ).headers.get("Referrer-Policy"),
    ).toBe("same-origin");
    for (const Origin of ["null", "https://evil.test", market]) {
      expect(
        (
          await request(app + "/cloud/checkout", {
            method: "POST",
            headers: { Cookie, Origin },
          })
        ).status,
      ).toBe(403);
    }
    expect(
      (
        await request(app + "/cloud/checkout", {
          method: "POST",
          headers: { Cookie, Origin: app },
        })
      ).status,
    ).toBe(303);
  });
  it("keeps security settings readable but locks changes until reauthentication", async () => {
    const { env, db, request } = fixture();
    env.MELODY = {} as Fetcher;
    const Cookie = (await issueSession(env, "owner", app)).split(";")[0];
    const fresh = await request(app + "/cloud/security", {
      headers: { Cookie },
    });
    const html = await fresh.text();
    expect(html).toContain('class="account-page security-page"');
    expect(html).toContain('id="authenticator-title"');
    expect(html).not.toContain('<fieldset class="security-controls" disabled>');
    db.raw.exec("UPDATE sessions SET expires=expires-601");
    const stale = await request(app + "/cloud/security", {
      headers: { Cookie },
    });
    const locked = await stale.text();
    expect(locked).toContain("Confirm it’s you to make changes");
    expect(
      locked.match(/<fieldset class="security-controls" disabled>/g),
    ).toHaveLength(3);
    expect(
      (
        await request(app + "/cloud/security/setup-code", {
          method: "POST",
          headers: { Cookie, Origin: app, "Content-Type": "application/json" },
          body: "{}",
        })
      ).status,
    ).toBe(403);
  });
  it("keeps validation failures on the admin form and handles invalid page numbers", async () => {
    const { db, env, request } = fixture();
    db.raw.exec("INSERT INTO account_admins VALUES('owner')");
    const headers = {
      Cookie: (await issueSession(env, "owner", app)).split(";")[0],
      Origin: app,
    };
    const failed = await request(app + "/admin", {
      method: "POST",
      headers,
      body: new URLSearchParams({ email: "not-an-email" }),
    });
    expect(failed.status).toBe(400);
    const html = await failed.text();
    expect(html).toContain('value="not-an-email"');
    expect(html).toContain('id="grant-error" role="alert"');
    expect(html).toContain("User directory");
    expect(
      (await request(app + "/admin?page=broken", { headers })).status,
    ).toBe(200);
  });
  it("offers optional 2FA for new accounts, but not on every sign-in", async () => {
    const { env, request } = fixture();
    env.MELODY = {} as Fetcher;
    const first = await completeSignIn(env, "new-identity", "new@example.test");
    expect(first.headers.get("location")).toBe(app + "/cloud/security/setup");
    const cookie = first.headers
      .getSetCookie()
      .find((value) => value.startsWith("__Host-phooey_session="))!
      .split(";")[0];
    const setup = await request(app + "/cloud/security/setup", {
      headers: { Cookie: cookie },
    });
    expect(setup.status).toBe(200);
    expect(await setup.text()).toContain('href="/cloud/account">Skip for now');
    expect(
      (
        await completeSignIn(env, "new-identity", "new@example.test")
      ).headers.get("location"),
    ).toBe(app + "/cloud/account");
    expect(
      (
        await completeSignIn(
          env,
          "new-identity",
          "new@example.test",
          "https://evil.test",
        )
      ).headers.get("location"),
    ).toBe(app + "/cloud/account");
  });
  it("preserves the admin destination through the identity callback and optional second factor", async () => {
    const { env, db, request } = fixture();
    env.MELODY_CLIENT = "phooey-finance";
    env.MELODY = {
      fetch: async (req: Request) =>
        Response.json(
          new URL(req.url).pathname.endsWith("/token")
            ? { access_token: "test" }
            : {
                authId: "owner",
                socialAccountType: null,
                socialAccountId: null,
                email: "owner@example.test",
                emailVerified: true,
              },
        ),
    } as Fetcher;
    const subject = "melody:" + app + "|owner";
    db.raw
      .prepare("INSERT INTO login_identities VALUES(?,?)")
      .run(subject, "owner");
    db.raw.exec("INSERT INTO account_admins VALUES('owner')");
    for (const twoFactor of [false, true]) {
      if (twoFactor)
        db.raw.exec("INSERT INTO login_totp VALUES('owner','encrypted',-1)");
      const start = await request(app + "/cloud/start?next=/admin");
      const state = new URL(start.headers.get("location")!).searchParams.get(
        "state",
      );
      const done = await request(
        app + "/cloud/callback?code=test&state=" + state,
        { headers: { Cookie: start.headers.get("set-cookie")!.split(";")[0] } },
      );
      expect(done.headers.get("location")).toBe(
        twoFactor ? "/cloud/security/verify" : app + "/admin",
      );
      if (twoFactor) {
        const row = db.raw
          .prepare("SELECT payload FROM challenges WHERE audience='second'")
          .get();
        expect(JSON.parse(String(row?.payload)).destination).toBe("/admin");
      }
    }
  });
  it("opens Invoicer through the shared workspace handoff", async () => {
    const { env, request } = fixture();
    expect((await request(app + "/invoicer/")).headers.get("location")).toBe(
      "/cloud/start?next=/invoicer/",
    );
    const cookie = (await issueSession(env, "owner", app)).split(";")[0];
    const open = await request(app + "/invoicer/", {
      headers: { Cookie: cookie },
    });
    expect(open.headers.get("location")).toBe(
      slot + "/cloud/enter?view=invoicer",
    );
    const enter = await request(open.headers.get("location")!);
    const authorize = await request(enter.headers.get("location")!, {
      headers: { Cookie: cookie },
    });
    const accept = await request(authorize.headers.get("location")!, {
      headers: { Cookie: enter.headers.get("set-cookie")!.split(";")[0] },
    });
    expect(accept.headers.get("location")).toBe("/invoicer/");
    expect(accept.headers.get("set-cookie")).toContain(
      "__Host-phooey_dashboard=",
    );
  });
  it("restricts the user directory and grants to administrators on the app domain", async () => {
    const { db, env, request } = fixture();
    const headers = {
      Cookie: (await issueSession(env, "owner", app)).split(";")[0],
      Origin: app,
    };
    expect((await request(app + "/admin")).headers.get("location")).toBe(
      "/cloud/start?next=/admin",
    );
    expect((await request(app + "/admin", { headers })).status).toBe(403);
    const post = (origin: string) =>
      request(app + "/admin", {
        method: "POST",
        headers: { ...headers, Origin: origin },
        body: new URLSearchParams({ email: "new@example.test" }),
      });
    expect((await post(app)).status).toBe(403);
    db.raw.exec("INSERT INTO account_admins VALUES('owner')");
    expect((await post(market)).status).toBe(403);
    expect((await request(market + "/admin", { headers })).status).toBe(404);
    const directory = await request(app + "/admin", { headers });
    expect(directory.headers.get("Cache-Control")).toBe("no-store");
    expect(await directory.text()).toContain("owner@example.test");
    expect((await post(app)).status).toBe(409);
    expect(db.raw.prepare("SELECT count(*) AS n FROM customers").get()?.n).toBe(
      1,
    );
  });
  it("reserves one free workspace, verifies its owner and opens Finance and Invoicer without Stripe", async () => {
    const { db, env, request } = fixture();
    db.raw.exec(
      "INSERT INTO account_admins VALUES('owner'); INSERT INTO workspaces VALUES('two','https://free.example.test',NULL)",
    );
    const adminHeaders = {
      Cookie: (await issueSession(env, "owner", app)).split(";")[0],
      Origin: app,
    };
    const grant = (email: string) =>
      request(app + "/admin", {
        method: "POST",
        headers: adminHeaders,
        body: new URLSearchParams({ email }),
      });
    expect((await grant("owner@example.test")).status).toBe(409);
    for (const email of ["Collector@Example.test", "collector@example.test"]) {
      expect((await grant(email)).headers.get("location")).toBe(
        "/admin?saved=1",
      );
    }
    expect(
      db.raw.prepare("SELECT count(*) AS n FROM free_accounts").get()?.n,
    ).toBe(1);
    expect(
      await (await request(app + "/admin", { headers: adminHeaders })).text(),
    ).toContain("Awaiting signup");
    await completeSignIn(env, "verified-other", "different@example.test");
    const signedIn = await completeSignIn(
      env,
      "verified-owner",
      "Collector@Example.test",
    );
    const headers = {
      Cookie: signedIn.headers.getSetCookie()[0].split(";")[0],
      Origin: app,
    };
    const account = await (
      await request(app + "/cloud/account", { headers })
    ).text();
    expect(account).toContain("Complimentary account");
    expect(account).not.toContain("Start my 14-day free trial");
    expect(
      (await request(app + "/cloud/open", { headers })).headers.get("location"),
    ).toBe("https://free.example.test/cloud/enter");
    expect(
      (await request(app + "/cloud/checkout", { method: "POST", headers }))
        .status,
    ).toBe(409);
    const guest = db.raw
      .prepare("SELECT * FROM hosted_accounts WHERE subject='verified-owner'")
      .get()!;
    expect(guest.paid_until).toBe(0);
    expect(guest.is_admin).toBe(0);
    const workspaceCookie = (
      await issueSession(
        env,
        String(guest.id),
        "https://free.example.test",
        "dashboard",
      )
    ).split(";")[0];
    const res = await worker.fetch(
      new Request("https://free.example.test/invoicer/", {
        headers: { Cookie: workspaceCookie },
      }),
      { ...env, WORKSPACE_ID: "two" },
      {} as unknown as ExecutionContext,
    );
    expect(res.status).toBe(200);
    await completeSignIn(
      env,
      "another-verified-identity",
      "collector@example.test",
    );
    expect(
      db.raw
        .prepare(
          "SELECT complimentary FROM hosted_accounts WHERE subject='another-verified-identity'",
        )
        .get()?.complimentary,
    ).toBe(0);
    expect((await grant("collector@example.test")).status).toBe(409);
  });
  it("opens Melody account creation from the marketing signup and old waitlist links", async () => {
    const { env, request } = fixture();
    env.MELODY = {} as Fetcher;
    env.MELODY_CLIENT = "phooey-finance";
    for (const path of ["/cloud/signup", "/waitlist", "/cloud/waitlist"]) {
      expect((await request(market + path)).headers.get("location")).toBe(
        app + "/cloud/signup",
      );
    }
    for (const path of ["/cloud/signup", "/cloud/start"]) {
      const response = await request(app + path);
      const authorize = new URL(response.headers.get("location")!);
      expect(authorize.origin + authorize.pathname).toBe(
        app + "/oauth2/v1/authorize",
      );
      expect(authorize.searchParams.get("step")).toBe(
        path === "/cloud/signup" ? "sign_up" : null,
      );
      expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
      expect(response.headers.get("set-cookie")).toBeTruthy();
    }
  });
  it("replaces legacy Checkout, grants the trial immediately, and requires payment for the following year", async () => {
    const { env, db, request } = fixture();
    env.STRIPE_SECRET = "test";
    env.STRIPE_PRICE = "price_year";
    db.raw.exec(
      "UPDATE customers SET paid_until=0, stripe_customer='cus_owner', checkout_id='cs_old'",
    );
    const headers = {
      Cookie: (await issueSession(env, "owner", app)).split(";")[0],
      Origin: app,
    };
    const account = () =>
      request(app + "/cloud/account", { headers }).then((res) => res.text());
    const start = () =>
      request(app + "/cloud/checkout", { method: "POST", headers });
    const sync = () =>
      request(app + "/cloud/account?checkout=complete", { headers });
    const owner = () =>
      db.raw
        .prepare("SELECT * FROM customers WHERE id='owner'")
        .get() as unknown as Customer;
    const trialEnd = Math.floor(Date.now() / 1000) + 14 * 86400;
    const yearEnd = trialEnd + 365 * 86400;
    const forms: URLSearchParams[] = [];
    let expired = false;
    let complete = false;
    let status = "trialing";
    let invoiceStatus = "open";
    let invoiceReason = "subscription_cycle";
    const mock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input, init) => {
        const path = new URL(String(input)).pathname;
        if (path === "/v1/prices/price_year")
          return Response.json({
            active: true,
            currency: "usd",
            unit_amount: 2900,
            recurring: { interval: "year", interval_count: 1 },
          });
        if (path === "/v1/checkout/sessions/cs_old")
          return Response.json({ status: "open" });
        if (path === "/v1/checkout/sessions/cs_old/expire") {
          expired = true;
          return Response.json({ status: "expired" });
        }
        if (path === "/v1/checkout/sessions") {
          forms.push(new URLSearchParams(String(init?.body)));
          return Response.json({
            id: "cs_trial",
            url: "https://checkout.example/trial",
          });
        }
        if (path === "/v1/checkout/sessions/cs_trial")
          return Response.json({
            status: complete ? "complete" : "open",
            metadata: { offer: "finance-14-days" },
            url: "https://checkout.example/trial",
            customer: "cus_owner",
            subscription: "sub_owner",
          });
        if (path === "/v1/subscriptions/sub_owner")
          return Response.json({
            id: "sub_owner",
            customer: "cus_owner",
            status,
            trial_end: trialEnd,
            current_period_end: yearEnd,
            items: { data: [{ price: { id: "price_year" } }] },
            latest_invoice: {
              status: invoiceStatus,
              billing_reason: invoiceReason,
            },
          });
        throw Error("Unexpected Stripe request " + path);
      });
    try {
      expect(await account()).toContain("Start my 14-day free trial");
      for (let i = 0; i < 2; i++)
        expect((await start()).headers.get("location")).toBe(
          "https://checkout.example/trial",
        );
      expect(expired).toBe(true);
      expect(forms).toHaveLength(1);
      expect(forms[0].get("subscription_data[trial_period_days]")).toBe("14");
      expect(forms[0].get("payment_method_collection")).toBe("always");
      expect(forms[0].get("line_items[0][price]")).toBe("price_year");
      expect(forms[0].get("success_url")).toBe(
        app + "/cloud/account?checkout=complete",
      );
      complete = true;
      expect((await sync()).headers.get("location")).toBe("/cloud/account");
      expect(owner().paid_until).toBe(trialEnd);
      expect(await account()).toContain("Free trial through");
      expect(
        (await request(app + "/cloud/open", { headers })).headers.get(
          "location",
        ),
      ).toBe(slot + "/cloud/enter");
      const paid = () =>
        db.raw
          .prepare("SELECT count(*) AS n FROM milestones WHERE event='paid'")
          .get()!.n;
      expect(paid()).toBe(0);
      status = "active";
      const { refreshCheckout } = await import("../src/hosted/billing");
      await refreshCheckout(env, owner());
      expect(owner().paid_until).toBe(trialEnd);
      invoiceStatus = "paid";
      invoiceReason = "subscription_create";
      await refreshCheckout(env, owner());
      expect(owner().paid_until).toBe(trialEnd);
      invoiceReason = "subscription_cycle";
      await refreshCheckout(env, owner());
      expect(owner().paid_until).toBe(yearEnd);
      expect(paid()).toBe(1);
      status = "canceled";
      db.raw.exec(
        "UPDATE customers SET paid_until=0, checkout_id=NULL, checkout_attempt=NULL",
      );
      expect(await account()).toContain("Continue to billing");
      await start();
      expect(forms).toHaveLength(2);
      expect(forms[1].has("subscription_data[trial_period_days]")).toBe(false);
    } finally {
      mock.mockRestore();
    }
  });
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
    expect(res.headers.get("location")).toBe(app + "/cloud/security/setup");
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
      (await post("confirm-code", session + "; " + ticket, { code: "invalid" }))
        .status,
    ).toBe(400);
    // The same setup key remains usable after a typo.
    const confirmed = await post("confirm-code", session + "; " + ticket, {
      code,
    });
    expect(confirmed.status).toBe(200);
    const renewed = confirmed.headers
      .getSetCookie()
      .find((cookie) => cookie.startsWith("__Host-phooey_session="))!
      .split(";")[0];
    expect(renewed).toMatch(/session=.+/);
    expect(
      (
        await request(app + "/cloud/security", {
          headers: { Cookie: renewed },
        })
      ).status,
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

describe('Invoicer own-domain gateway', () => {
  const invoice = 'https://invoicer.phooey.foo';
  function invoiceFixture() {
    const f = fixture();
    f.env.CANONICAL_APP = 'true';
    f.env.INVOICER_ORIGIN = invoice;
    f.env.INVOICER_MARKETING_ORIGIN = 'https://getinvoicer.phooey.foo';
    f.env.WORKSPACE_SERVICE_one = {fetch: (req:Request) => worker.fetch(req,{...f.env,WORKSPACE_ID:'one'},{waitUntil(){}} as unknown as ExecutionContext)} as Fetcher;
    f.env.INVOICER_ASSETS = {fetch: async (req:Request) => new Response(new URL(req.url).pathname,{headers:{'Content-Type':'text/javascript'}})} as Fetcher;
    return f;
  }
  it('moves browser URLs and serves static assets without a session',async()=>{
    const f=invoiceFixture();
    const redirect=await f.request(app+'/invoicer/new');
    expect(redirect.headers.get('Location')).toBe(invoice+'/new');
    const asset=await f.request(invoice+'/assets/app.js');
    expect(asset.headers.get('Content-Type')).toBe('text/javascript');
    expect(await asset.text()).toBe('/assets/app.js');
  });
  it('binds the one-use login handoff to the initiating browser',async()=>{
    const f=invoiceFixture();
    const start=await f.request(invoice+'/');
    const startCookie=start.headers.get('Set-Cookie')!.split(';')[0];
    const nonce=new URL(start.headers.get('Location')!).searchParams.get('nonce');
    const financeSession=await issueSession(f.env,'owner',app);
    const handoff=await f.request(app+'/cloud/invoicer?nonce='+nonce,{headers:{Cookie:financeSession}});
    expect(handoff.headers.get('Location')).toContain(invoice+'/auth/accept?ticket=');
    const accepted=await f.request(handoff.headers.get('Location')!,{headers:{Cookie:startCookie}});
    expect(accepted.status).toBe(303);
    const cookie=accepted.headers.get('Set-Cookie')!.split(';')[0];
    const page=await f.request(invoice+'/api/v1/invoices',{headers:{Cookie:cookie}});
    expect(page.status).toBe(200);
    expect(new URL(f.service.mock.calls.at(-1)![0].url).pathname).toBe('/api/v1/invoices');
    expect(f.service.mock.calls.at(-1)![0].headers.get('Authorization')).toBe('Bearer '+'i'.repeat(32));
    expect((await f.request(handoff.headers.get('Location')!,{headers:{Cookie:startCookie}})).status).toBe(400);
  });
  it('passes only the supplied API key to the selected workspace, never the owner key',async()=>{
    const f=invoiceFixture(), key='phinv_one_'+'a'.repeat(64);
    const result=await f.request(invoice+'/mcp',{method:'POST',headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},body:'{}'});
    expect(result.status).toBe(200);
    expect(f.service.mock.calls.at(-1)![0].headers.get('Authorization')).toBe('Bearer '+key);
    expect(new URL(f.service.mock.calls.at(-1)![0].url).pathname).toBe('/mcp');
  });
  it('rejects cross-origin dashboard mutations and anonymous data access',async()=>{
    const f=invoiceFixture();
    const cookie=await issueSession(f.env,'owner',invoice);
    expect((await f.request(invoice+'/api/v1/keys',{method:'POST',headers:{Cookie:cookie,Origin:'https://evil.test','Content-Type':'application/json'},body:'{}'})).status).toBe(403);
    expect((await f.request(invoice+'/api/v1/invoices')).status).toBe(401);
    expect(f.service).not.toHaveBeenCalled();
  });
});
