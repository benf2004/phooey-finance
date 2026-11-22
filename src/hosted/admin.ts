import { z } from "zod";
import { AppError, assert, id, now } from "../server/util";
import { portal, redirect, type Customer, type HostedEnv } from "./control";
import { escape, page } from "./html";

type DirectoryEntry = Pick<
  Customer,
  "email" | "is_admin" | "paid_until" | "trial_ends_at" | "complimentary"
> & {
  pending_free: number;
  workspace: string | null;
};

function accessLabel(user: DirectoryEntry) {
  if (user.is_admin) return "Admin access";
  if (user.pending_free) return "Awaiting signup";
  if (user.complimentary) return "Complimentary";
  if (user.trial_ends_at > now() && user.paid_until > now())
    return "Free trial";
  if (user.paid_until > now()) return "Subscribed";
  return user.paid_until ? "Expired" : "No subscription";
}

async function grantFreeAccount(
  env: HostedEnv,
  admin: Customer,
  email: string,
) {
  const db = env.CONTROL;
  const reserved = id();
  try {
    const [, , lookup] = await db.batch<{ complimentary: number }>([
      db
        .prepare(
          `INSERT INTO customers(id,subject,email,pending_free)
        SELECT ?,?,?,1 WHERE NOT EXISTS(SELECT 1 FROM customers WHERE email=? COLLATE NOCASE)`,
        )
        .bind(reserved, "free-invite:" + reserved, email, email),
      db
        .prepare(
          `INSERT INTO free_accounts(customer,granted_by)
        SELECT id,? FROM customers WHERE email=? COLLATE NOCASE
        AND (SELECT count(*) FROM customers WHERE email=? COLLATE NOCASE)=1
        AND paid_until<=? AND subscription IS NULL AND checkout_id IS NULL AND checkout_attempt IS NULL
        ON CONFLICT(customer) DO NOTHING`,
        )
        .bind(admin.id, email, email, now()),
      db
        .prepare(
          "SELECT complimentary FROM hosted_accounts WHERE email=? COLLATE NOCASE LIMIT 2",
        )
        .bind(email),
    ]);
    assert(
      lookup.results.length === 1,
      409,
      "Several accounts use this email. Use a distinct verified email for a free account.",
    );
    assert(
      lookup.results[0].complimentary,
      409,
      "This account already has billing activity. Manage its existing subscription in Stripe.",
    );
  } catch (error) {
    if (String(error).includes("No available hosted workspace"))
      throw new AppError(
        409,
        "Every workspace is assigned. Add an empty hosted workspace and try again.",
      );
    throw error;
  }
}

export async function adminRoute(
  env: HostedEnv,
  request: Request,
  admin: Customer,
) {
  const url = new URL(request.url);
  let enteredEmail = "";
  let formError = "";
  let responseStatus = 200;
  if (request.method === "POST") {
    enteredEmail = String((await request.formData()).get("email") ?? "")
      .trim()
      .toLowerCase();
    try {
      const email = z.email().max(254).safeParse(enteredEmail);
      assert(email.success, 400, "Enter a valid email address.");
      await grantFreeAccount(env, admin, email.data);
      return redirect("/admin?saved=1");
    } catch (error) {
      if (!(error instanceof AppError) || ![400, 409].includes(error.status))
        throw error;
      formError = error.message;
      responseStatus = error.status;
    }
  }
  assert(
    request.method === "GET" ||
      request.method === "HEAD" ||
      request.method === "POST",
    405,
    "Use GET or POST.",
  );
  const pageNumber = z.coerce
    .number()
    .int()
    .min(1)
    .max(1000000)
    .safeParse(url.searchParams.get("page") ?? 1);
  const current = pageNumber.success ? pageNumber.data : 1;
  const counts = await env.CONTROL.prepare(
    `SELECT
    (SELECT count(*) FROM customers) AS accounts,
    (SELECT count(*) FROM free_accounts) AS free,
    (SELECT count(*) FROM workspaces WHERE owner IS NULL) AS available`,
  ).first<{ accounts: number; free: number; available: number }>();
  const size = 50;
  const { results } = await env.CONTROL.prepare(
    `SELECT a.email,a.is_admin,a.paid_until,a.trial_ends_at,a.complimentary,a.pending_free,w.id AS workspace
    FROM hosted_accounts a LEFT JOIN workspaces w ON w.owner=a.id ORDER BY a.email COLLATE NOCASE,a.id LIMIT ? OFFSET ?`,
  )
    .bind(size + 1, (current - 1) * size)
    .all<DirectoryEntry>();
  const rows = results
    .slice(0, size)
    .map(
      (user) =>
        `<tr><th scope="row">${escape(user.email)}${user.is_admin ? "<small>Administrator</small>" : ""}</th><td><span class="access-badge${user.is_admin || user.complimentary || user.paid_until > now() ? " access-active" : ""}">${accessLabel(user)}</span></td><td>${escape(user.workspace ?? "Unassigned")}</td></tr>`,
    )
    .join("");
  return page(
    "Hosted accounts",
    `<div class="admin-directory"><div class="admin-toolbar"><p>Manage access to Finance and Invoicer.</p><div class="actions"><a href="/cloud/open">Open dashboard</a><a href="/cloud/account">Your account</a></div></div>
    <dl class="admin-stats"><div><dt>Total accounts</dt><dd>${counts?.accounts ?? 0}</dd></div><div><dt>Free accounts</dt><dd>${counts?.free ?? 0}</dd></div><div><dt>Available workspaces</dt><dd>${counts?.available ?? 0}</dd></div></dl>
    <section class="admin-grant"><h2>Create a free account</h2>
    <p>Give someone access to Finance and Invoicer. They can sign up with this email and open their workspace without a card.</p>
    <form method="post" action="/admin"><label for="grant-email">Email address<input id="grant-email" type="email" name="email" required maxlength="254" autocomplete="off" placeholder="name@example.com" value="${escape(enteredEmail)}" ${formError ? 'aria-invalid="true" aria-describedby="grant-error"' : ""}></label><button>Create free account</button></form>
    ${formError ? `<p class="form-error" id="grant-error" role="alert">${escape(formError)}</p>` : ""}
    ${url.searchParams.get("saved") === "1" ? `<p class="form-success" role="status">Free access is ready. Share the <a href="${escape(portal(env))}/cloud/signup">signup link</a> with the account owner.</p>` : ""}</section>
    <section><h2>User directory</h2>
    <div class="directory-table" role="region" aria-label="User directory" tabindex="0"><table aria-label="Hosted user directory"><thead><tr><th scope="col">Email address</th><th scope="col">Access</th><th scope="col">Workspace</th></tr></thead><tbody>${rows}</tbody></table></div>
    ${!rows ? "<p>No accounts on this page.</p>" : ""}
    <nav aria-label="Directory pages"><span>Page ${current}</span>${current > 1 ? `<a href="/admin?page=${current - 1}">Previous page</a>` : ""}${results.length > size ? `<a href="/admin?page=${current + 1}">Next page</a>` : ""}</nav>
    </section></div>`,
    responseStatus,
  );
}
