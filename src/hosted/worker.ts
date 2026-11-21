import { z } from "zod";
import legacy from "../server/index";
import { checkOrigin, rateLimit } from "../server/auth";
import {
  AppError,
  assert,
  errorMessage,
  now,
  randomToken,
} from "../server/util";
import {
  marketing,
  milestone,
  challenge,
  consume,
  cookie,
  customer,
  finishIdentity,
  issueSession,
  portal,
  readCookie,
  redirect,
  startIdentity,
  workspace,
  type Customer,
  type HostedEnv,
  type Slot,
} from "./control";
import { beginMobile, authorizeMobile, exchangeMobile } from "./mobile";
import { forwardInvoice, publicInvoiceRead } from "./invoicer";
import { socialProviders, startSocial, finishSocial } from "./social";
import { checkout, billingPortal, webhook } from "./billing";
import { operationalAlert } from "./operations";


import { escape, form, page } from "./html";
import { securityRoute } from "./security";
const json = (body: unknown) =>
  Response.json(body, { headers: { "Cache-Control": "no-store" } });
const active = (c: Customer) => c.paid_until > now();
async function ownerSlot(env: HostedEnv) {
  return env.CONTROL.prepare(
    "SELECT w.*,c.paid_until,c.email FROM workspaces w LEFT JOIN customers c ON w.owner=c.id WHERE w.id=?",
  )
    .bind(env.WORKSPACE_ID)
    .first<Slot & { paid_until: number; email: string }>();
}
async function marketingPage(env: HostedEnv, req: Request) {
  const res = await env.ASSETS.fetch(req);
  if (!res.headers.get("content-type")?.includes("text/html")) return res;
  return new HTMLRewriter().on('a[href="/dashboard"], a[href="/cloud/start"]', {
    element(link) {
      const path = link.getAttribute("href");
      if (path === "/cloud/start" && !env.MELODY && !socialProviders(env).length && !env.IDENTITY_CLIENT) {
        link.setAttribute("href", "/waitlist");
        link.setInnerContent("Join the beta list");
      } else {
        link.setAttribute("href", portal(env) + path);
      }
    },
  }).transform(res);
}
async function route(req: Request, env: HostedEnv, ctx: ExecutionContext) {
  const url = new URL(req.url),
    p = url.pathname,
    isPortal = !env.WORKSPACE_ID;
  const isMarketing = isPortal && url.origin === marketing(env);
  const isApp = isPortal && url.origin === portal(env);
  const read = req.method === "GET" || req.method === "HEAD";
  const slot = isPortal ? null : await ownerSlot(env);
  assert(
    isPortal ? isMarketing || isApp : url.origin === slot?.origin,
    404,
    "Unknown workspace.",
  );
  if (!isPortal && publicInvoiceRead(req, p) && slot?.owner && slot.paid_until > now()) return forwardInvoice(env, req, false);
  const pagePath = p.replace(/\/$/, "");
  if (["/freelance-demo", "/foundation-preview", "/tiller-preview"].includes(pagePath))
    return redirect("/dashboard-preview");
  if (/^\/business\/(template|tiller-connect)(\/|$)/.test(p) ||
      /^\/business\/assets\/(workbook|foundation-preview|split-example)\.png$/.test(p))
    return new Response("Gone", { status: 410 });
  if (read && (p === "/business/brand.css" || p.startsWith("/business/assets/") ||
      p.startsWith("/business/fonts/") || p === "/source.tar.gz" || p === "/LICENSE.txt"))
    return env.ASSETS.fetch(req);
  if (read && pagePath === "/dashboard-preview")
    return isApp && !isMarketing ? redirect(marketing(env) + p) : env.ASSETS.fetch(req);
  if (read && /^\/business(?:\/(?:pricing|privacy|terms))?(?:\/index\.html)?\/?$/.test(p)) {
    if (isMarketing) return marketingPage(env, req);
    return isApp ? redirect(marketing(env) + p) : env.ASSETS.fetch(req);
  }
  if (isMarketing) {
    if (p === "/" && read)
      return marketingPage(env, new Request(new URL("/business/", req.url), req));
    if (p.startsWith("/assets/") && read) return env.ASSETS.fetch(req);
    if (p === "/waitlist" && read)
      return page(
        "Join the hosted beta",
        '<p>Join the list for phooey! finance and Invoicer. The planned bundle is $29 per year.</p><form method="post" action="/waitlist"><label>Email address<input type="email" name="email" required maxlength="254"></label><button>Join the beta list</button></form>',
      );
    if (p === "/cloud/contact" && read)
      return page(
        "Contact Phooey",
        env.SUPPORT_EMAIL
          ? `<p><a href="mailto:${escape(z.email().parse(env.SUPPORT_EMAIL))}">${escape(env.SUPPORT_EMAIL)}</a></p>`
          : '<p><a href="https://github.com/benf2004/phooey-finance/issues">Project support</a></p><p>Keep financial records and account credentials out of public issues.</p>',
      );
    if ((p === "/waitlist" || p === "/cloud/waitlist") && req.method === "POST") {
      checkOrigin(req);
      await rateLimit(
        env.CONTROL,
        "waitlist:" + (req.headers.get("CF-Connecting-IP") || "local"),
        12,
        900,
      );
      const email = z
        .email()
        .max(254)
        .parse((await req.formData()).get("email"))
        .toLowerCase();
      await env.CONTROL.prepare("INSERT OR IGNORE INTO waitlist VALUES(?,?)")
        .bind(email, now())
        .run();
      return page(
        "You’re on the beta list",
        "<p>Thanks for your interest in the Finance and Invoicer beta.</p>",
      );
    }
    if (!isApp) {
      if (read && ["/cloud/start", "/dashboard", "/dashboard/", "/cloud/account", "/cloud/open"].includes(p))
        return redirect(portal(env) + p);
      return new Response("Not found", { status: 404 });
    }
  }
  if (isApp && read && (p === "/cloud/contact" || p === "/waitlist"))
    return redirect(marketing(env) + p);
  if (isApp && env.MELODY) {
    if (p === "/cloud/security" || p.startsWith("/cloud/security/")) return securityRoute(req,env);
    if (p === "/finance-security.js" && read) return env.ASSETS.fetch(req);
    if (p.startsWith("/cloud/social/")) return new Response("Gone", { status: 410 });
    if (p.startsWith("/identity/v1/") || p === "/oauth2/v1/authorize" ||
        p === "/client.js" || p === "/client.css") {
      if ((p === "/oauth2/v1/authorize" || p === "/identity/v1/view/authorize") &&
          (url.searchParams.get("client_id") !== env.MELODY_CLIENT ||
           url.searchParams.get("redirect_uri") !== portal(env) + "/cloud/callback"))
        return jsonError("Unknown sign-in client.", 400);
      const forwarded = new Request(req, { redirect: "manual" });
      // Melody's browser session is disabled. Finance owns the web and iPhone sessions.
      forwarded.headers.delete("Cookie");
      forwarded.headers.delete("Authorization");
      const res = await env.MELODY.fetch(forwarded);
      if (p === "/client.js" || p === "/client.css") return res;
      const response = new Response(res.body, res);
      response.headers.set("Cache-Control", "no-store");
      response.headers.set("Referrer-Policy", "strict-origin");
      if (p === "/identity/v1/view/authorize" && res.ok && res.headers.get("content-type")?.includes("text/html"))
        return new HTMLRewriter().on("#root", { element(el) {
          el.before('<nav aria-label="Sign-in options" style="text-align:center;padding:1rem"><a href="/cloud/security/passkey">Sign in with a passkey</a></nav>', {html:true});
        }}).transform(response);
      return response;
    }
  }
  if (isPortal && p === "/cloud/webhook" && req.method === "POST")
    return webhook(env, req);
  if (p === "/sheets" || p.startsWith("/addon/") || p.startsWith("/cloud/sheets/") || p === "/cloud/google/callback")
    return jsonError("This endpoint is no longer available.", 410);
  if (isPortal && p === "/cloud/social/apple/callback" && req.method === "POST")
    return finishSocial(env, req, "apple");
  if (isPortal && p === "/cloud/mobile/start" && req.method === "GET") return beginMobile(env, req);
  if (isPortal && p === "/cloud/mobile/exchange" && req.method === "POST") return exchangeMobile(env, req);
  if (slot && p === "/cloud/mobile/accept" && req.method === "POST") {
    const { ticket } = z.object({ ticket: z.string().length(43) }).parse(await req.json());
    const grant = await consume(env, "mobile-workspace:" + url.origin, ticket);
    assert(slot.owner === grant.customer && slot.paid_until > now(), 403, "Subscription unavailable.");
    const res = json({ ok: true });
    res.headers.set("Set-Cookie", await issueSession(env, grant.customer, url.origin, "dashboard"));
    return res;
  }
  const externalOAuth =
    p === "/oauth/token" ||
    p === "/oauth/register" ||
    p === "/oauth/revoke" ||
    p === "/mcp";
  if (req.method !== "GET" && req.method !== "HEAD" && !externalOAuth)
    checkOrigin(req);
  const c = await customer(env, req, isPortal ? "session" : "dashboard");
  if (p === "/cloud/logout" || p === "/api/logout" || (!isPortal && p === "/invoicer/auth/logout")) {
    assert(req.method === "POST", 405, "Use POST.");
    if (c)
      await env.CONTROL.prepare("DELETE FROM sessions WHERE customer=?")
        .bind(c.id)
        .run();
    const res = (p.startsWith("/api/") || p === "/invoicer/auth/logout")
      ? json({ ok: true })
      : redirect(marketing(env) + "/");
    for (const name of ["session", "dashboard", "sheets", "pending", "ceremony", "login"])
      res.headers.append("Set-Cookie", cookie(name, "", 0));
    return res;
  }
  if (isPortal) {
    if (p === "/dashboard" || p === "/dashboard/") return redirect(c ? "/cloud/open" : "/cloud/start");
    if (p === "/cloud/open" || p === "/") {
      if (!c) return redirect(marketing(env) + "/");
      const assigned = await workspace(env, c.id);
      return redirect(assigned && active(c) ? assigned.origin + "/cloud/enter" : "/cloud/account");
    }
    const providers = socialProviders(env);
    if (p === "/cloud/social/google/callback" && req.method === "GET") return finishSocial(env, req, "google");
    if (req.method === "GET" && (p === "/cloud/social/google" || p === "/cloud/social/apple"))
      return startSocial(env, req, p.endsWith("google") ? "google" : "apple");
    if (p === "/cloud/start" && req.method === "GET") {
      if (c) return redirect("/cloud/account");
      if (env.MELODY) return startIdentity(env, req);
      if (providers.length) return page("Sign in to phooey! finance", '<div class="actions">' + providers.map(p => '<a class="button" href="/cloud/social/' + p + '">Continue with ' + (p === "apple" ? "Apple" : "Google") + '</a>').join("") + '</div>');
      if (!env.IDENTITY_CLIENT || !env.IDENTITY_SECRET)
        return redirect(marketing(env) + "/waitlist");
      return startIdentity(env, req);
    }
    if (p === "/cloud/callback" && req.method === "GET")
      return finishIdentity(env, req);
    if (p.startsWith("/assets/")) return env.ASSETS.fetch(req);
    if (!p.startsWith("/cloud/"))
      return new Response("Not found", { status: 404 });
    if (!c) return redirect("/cloud/start");
    if (p === "/cloud/mobile/authorize" && req.method === "POST") return authorizeMobile(env, req, c);
    if (p === "/cloud/checkout" && req.method === "POST")
      return redirect(await checkout(env, c));
    if (p === "/cloud/billing" && req.method === "POST")
      return redirect(await billingPortal(env, c));
    const slot = await workspace(env, c.id);
    if (p === "/cloud/authorize-workspace") {
      assert(
        slot && url.searchParams.get("slot") === slot.id,
        403,
        "This workspace belongs to another account.",
      );
      const nonce = z.string().length(43).parse(url.searchParams.get("nonce"));
      const ticket = await challenge(
        env,
        "enter:" + slot.origin,
        {
          customer: c.id,
          nonce,
          view: "/",
        },
        90,
      );
      return redirect(slot.origin + "/cloud/accept?ticket=" + ticket);
    }
    if (p === "/cloud/account") {
      const status = active(c)
        ? "Active through " +
          new Date(c.paid_until * 1000).toISOString().slice(0, 10)
        : "Annual subscription";
      return page(
        "Your Phooey account",
        `<p>${escape(c.email)} · ${status}</p>` +
          (readCookie(req, "mobile") && slot && active(c) ? form("/cloud/mobile/authorize", "Open workspace on iPhone") : "") +
          (slot && (active(c) || c.paid_until > now() - 30 * 86400)
            ? `<div class="actions"><a class="button" href="${escape(slot.origin)}/cloud/enter">Open Finance dashboard</a></div>`
            : "") +
          (!active(c)
            ? "<p>Finance and Invoicer cost $29/year. Optional bank syncing is billed separately by SimpleFIN Bridge.</p>" +
              form("/cloud/checkout", "Subscribe for $29/year")
            : "") +
          (c.stripe_customer ? form("/cloud/billing", "Manage billing") : "") +
          (env.MELODY ? '<p><a href="/cloud/security">Sign-in and security</a></p>' : "") +
          form("/cloud/logout", "Sign out everywhere"),
      );
    }
    return new Response("Not found", { status: 404 });
  }
  assert(slot, 404, "Workspace unavailable.");
  if (p === "/cloud/enter") {
    const nonce = randomToken();
    return redirect(
      portal(env) +
        "/cloud/authorize-workspace?" +
        new URLSearchParams({ slot: slot.id, nonce }),
      cookie("enter", nonce, 300),
    );
  }
  if (p === "/cloud/accept") {
    const data = await consume(
      env,
      "enter:" + url.origin,
      url.searchParams.get("ticket") ?? "",
    );
    assert(
      data.customer === slot.owner && readCookie(req, "enter") === data.nonce,
      403,
      "Open your workspace from your Phooey account.",
    );
    return redirect(
      "/",
      await issueSession(
        env,
        data.customer,
        url.origin,
        "dashboard",
      ),
    );
  }
  if (p.startsWith("/assets/") || p === "/phooey-transactions-template.csv")
    return env.ASSETS.fetch(req);
  if (
    externalOAuth ||
    p.startsWith("/.well-known/") ||
    (p.startsWith("/api/files/") && req.headers.has("Authorization"))
  ) {
    assert(slot.owner && slot.paid_until > now(), 403, "Subscription expired.");
    return legacy.fetch(req as Parameters<typeof legacy.fetch>[0], env, ctx);
  }
  if (p === "/cloud/account") return redirect(portal(env) + "/cloud/account");
  if (!c || c.id !== slot.owner) {
    if (p.startsWith("/api/") || p.startsWith("/invoicer/api/") || p.startsWith("/invoicer/auth/")) return jsonError("Please sign in", 401);
    return redirect(marketing(env) + "/");
  }
  if (!active(c)) {
    const canExport = c.paid_until > now() - 30 * 86400;
    if (!(
      canExport &&
      req.method === "GET" &&
      ["/api/export", "/api/backup"].includes(p)
    )) {
      if (p.startsWith("/api/") )
        return jsonError(
          "Your paid term has ended. Open your Phooey account to renew or export your ledger.",
          402,
        );
      return page(
        "Subscription ended",
        (canExport
          ? '<p>Download your ledger within 30 days of expiry.</p><div class="actions"><a href="/api/export">Export CSV</a><a href="/api/backup">Download JSON backup</a></div>'
          : "") +
          '<a href="' +
          portal(env) +
          '/cloud/account">Manage subscription</a>',
        402,
      );
    }
  }
  if (p === "/invoicer") return redirect("/invoicer/");
  if (p.startsWith("/invoicer/")) return forwardInvoice(env, req, true);
  if (p === "/api/session")
    ctx.waitUntil(milestone(env, c.id, "workspace_visit"));
  assert(
    !["/api/login", "/api/settings/password"].includes(p),
    403,
    "Manage sign-in through your Phooey account.",
  );
  return legacy.fetch(
    req as Parameters<typeof legacy.fetch>[0],
    { ...env, hostedCustomer: c.id, invoicerUrl: env.INVOICER ? "/invoicer/" : undefined, ADMIN_USERNAME: c.email },
    ctx,
  );
}
function jsonError(error: string, status: number) {
  return Response.json(
    { error },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}
export default {
  async fetch(req: Request, env: HostedEnv, ctx: ExecutionContext) {
    try {
      return await route(req, env, ctx);
    } catch (e) {
      const conflict = /CHECK constraint|UNIQUE constraint/.test(String(e));
      const status =
        e instanceof AppError
          ? e.status
          : e instanceof z.ZodError
            ? 400
            : conflict
              ? 409
              : 500;
      if (status >= 500 && new URL(req.url).pathname === "/cloud/webhook")
        ctx.waitUntil(operationalAlert(env, "billing_webhook_failed"));
      const message = conflict
        ? "This record changed. Review its current values before saving."
        : errorMessage(e);
      return req.headers.get("Accept")?.includes("text/html")
        ? page(
            "Unable to continue",
            `<p>${escape(message)}</p><a href="/cloud/account">Return to account</a>`,
            status,
          )
        : jsonError(message, status);
    }
  },
  async scheduled(event: ScheduledController, env: HostedEnv) {
    if (!env.WORKSPACE_ID) {
      if (
        !(await env.CONTROL.prepare(
          "SELECT id FROM workspaces WHERE owner IS NULL LIMIT 1",
        ).first())
      )
        await operationalAlert(env, "workspace_capacity");
      await env.CONTROL.batch(
        ["sessions", "challenges", "rate_limits"].map((t) =>
          env.CONTROL.prepare(
            "DELETE FROM " +
              t +
              " WHERE " +
              (t === "rate_limits" ? "expires_at" : "expires") +
              "<?",
          ).bind(now()),
        ),
      );
      return;
    }
    const slot = await ownerSlot(env);
    if (!slot?.owner || slot.paid_until <= now()) return;
    if (event.cron === "47 6,18 * * *") {
      const delayed = await env.DB.prepare(
        "SELECT 1 FROM connections WHERE selection_ready=1 AND json_array_length(selected_accounts)>0 AND (status='attention' OR unixepoch(last_success) < ?)",
      )
        .bind(now() - 86400)
        .first();
      if (delayed) await operationalAlert(env, "feed_delayed");
    } else await legacy.scheduled(event, env);
  },
  async queue(batch: MessageBatch<{ jobId: string }>, env: HostedEnv) {
    const slot = await ownerSlot(env);
    if (slot?.owner && slot.paid_until > now()) {
      await legacy.queue(batch, env);
      const imported = await env.DB.prepare(
        "SELECT 1 AS present FROM transactions WHERE source IN ('csv','simplefin') AND deleted=0 LIMIT 1",
      ).first();
      if (imported) await milestone(env, slot.owner, "ledger_loaded");
    } else batch.ackAll();
  },
} satisfies ExportedHandler<HostedEnv, { jobId: string }>;
