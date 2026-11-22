import { assert, id, now, readText } from "../server/util";
import { portal, reserve, type Customer, type HostedEnv } from "./control";

async function stripe(
  env: HostedEnv,
  path: string,
  form?: Record<string, string>,
  key?: string,
) {
  assert(
    env.STRIPE_SECRET && env.STRIPE_PRICE,
    503,
    "Checkout is awaiting payment configuration.",
  );
  const headers: Record<string, string> = {
    Authorization: "Bearer " + env.STRIPE_SECRET,
    "Stripe-Version": "2024-06-20",
  };
  if (key) headers["Idempotency-Key"] = key;
  const res = await fetch("https://api.stripe.com/v1/" + path, {
    method: form ? "POST" : "GET",
    headers,
    body: form ? new URLSearchParams(form) : undefined,
    redirect: "manual",
  });
  assert(res.ok, 502, "The payment provider is unavailable. Please retry.");
  return (await res.json()) as any;
}
export const eligibleForTrial = (c: Customer) =>
  !c.subscription && !c.paid_until && !c.trial_ends_at;
const trialOffer = "finance-14-days";

export async function refreshCheckout(env: HostedEnv, c: Customer) {
  if (!c.checkout_id || !c.stripe_customer) return;
  const session = await stripe(
    env,
    "checkout/sessions/" + encodeURIComponent(c.checkout_id),
  );
  if (
    session.status === "complete" &&
    session.customer === c.stripe_customer &&
    session.subscription
  )
    await reconcile(env, session.subscription);
}

export async function checkout(env: HostedEnv, c: Customer) {
  assert(!c.is_admin, 409, "Administrator accounts already include dashboard access.");
  assert(!c.complimentary, 409, "Your account already has complimentary access.");
  assert(c.paid_until <= now(), 409, "Your subscription is already active.");
  if (c.subscription) {
    const previous = await stripe(
      env,
      "subscriptions/" + encodeURIComponent(c.subscription),
    );
    if (!["canceled", "incomplete_expired"].includes(previous.status))
      return billingPortal(env, c);
  }
  const price = await stripe(
    env,
    "prices/" + encodeURIComponent(env.STRIPE_PRICE),
  );
  assert(
    price.active &&
      price.currency === "usd" &&
      price.unit_amount === 2900 &&
      price.recurring?.interval === "year" &&
      price.recurring?.interval_count === 1,
    503,
    "The $29 annual price is unavailable.",
  );
  await reserve(env, c.id);
  if (!c.stripe_customer) {
    const account = await stripe(
      env,
      "customers",
      { email: c.email, "metadata[phooey_customer]": c.id },
      "customer-" + c.id,
    );
    await env.CONTROL.prepare(
      "UPDATE customers SET stripe_customer=? WHERE id=? AND stripe_customer IS NULL",
    )
      .bind(account.id, c.id)
      .run();
  }
  c = (await env.CONTROL.prepare("SELECT * FROM customers WHERE id=?")
    .bind(c.id)
    .first<Customer>())!;
  if (c.checkout_id) {
    const prior = await stripe(
      env,
      "checkout/sessions/" + encodeURIComponent(c.checkout_id),
    );
    if (prior.status === "open") {
      if (eligibleForTrial(c) === (prior.metadata?.offer === trialOffer))
        return prior.url as string;
      // Replace pre-launch checkout links that would bill a new subscriber immediately.
      await stripe(
        env,
        "checkout/sessions/" + encodeURIComponent(c.checkout_id) + "/expire",
        {},
        "expire-" + c.checkout_id,
      );
    }
    if (prior.status === "complete" && prior.subscription) {
      await reconcile(env, prior.subscription);
      const after = await env.CONTROL.prepare(
        "SELECT paid_until FROM customers WHERE id=?",
      )
        .bind(c.id)
        .first<{ paid_until: number }>();
      if (after!.paid_until > now()) return portal(env) + "/cloud/account";
    }
    await env.CONTROL.prepare(
      "UPDATE customers SET checkout_id=NULL,checkout_attempt=NULL WHERE id=? AND checkout_id=?",
    )
      .bind(c.id, c.checkout_id)
      .run();
  }
  const attempt = await env.CONTROL.prepare(
    "UPDATE customers SET checkout_attempt=COALESCE(checkout_attempt,?) WHERE id=? AND paid_until<=? AND NOT EXISTS(SELECT 1 FROM free_accounts WHERE customer=customers.id) AND NOT EXISTS(SELECT 1 FROM account_admins WHERE customer=customers.id) RETURNING *",
  )
    .bind(id(), c.id, now())
    .first<Customer>();
  assert(attempt, 409, "The subscription has changed. Refresh your account.");
  const session = await stripe(
    env,
    "checkout/sessions",
    {
      mode: "subscription",
      ...(eligibleForTrial(attempt)
        ? {
            "subscription_data[trial_period_days]": "14",
            "metadata[offer]": trialOffer,
            payment_method_collection: "always",
          }
        : {}),
      "payment_method_types[0]": "card",
      "automatic_tax[enabled]":
        env.STRIPE_AUTOMATIC_TAX === "true" ? "true" : "false",
      ...(env.STRIPE_AUTOMATIC_TAX === "true"
        ? { "customer_update[address]": "auto" }
        : {}),
      customer: c.stripe_customer!,
      "line_items[0][price]": env.STRIPE_PRICE,
      "line_items[0][quantity]": "1",
      success_url: portal(env) + "/cloud/account?checkout=complete",
      cancel_url: portal(env) + "/cloud/account",
    },
    (eligibleForTrial(attempt) ? "trial-checkout-" : "checkout-") +
      attempt.checkout_attempt,
  );
  await env.CONTROL.prepare(
    "UPDATE customers SET checkout_id=? WHERE id=? AND checkout_attempt=?",
  )
    .bind(session.id, c.id, attempt.checkout_attempt)
    .run();
  return session.url as string;
}
export async function billingPortal(env: HostedEnv, c: Customer) {
  assert(c.stripe_customer, 400, "There is no billing account yet.");
  return (
    await stripe(env, "billing_portal/sessions", {
      customer: c.stripe_customer,
      return_url: portal(env) + "/cloud/account",
    })
  ).url as string;
}
async function reconcile(env: HostedEnv, subscriptionId: string) {
  // Read the current provider state after taking the revision snapshot. Concurrent deliveries retry.
  const probe = await stripe(
    env,
    "subscriptions/" + encodeURIComponent(subscriptionId),
  );
  const customer = await env.CONTROL.prepare(
    "SELECT * FROM customers WHERE stripe_customer=?",
  )
    .bind(probe.customer)
    .first<Customer>();
  if (!customer) return;
  const sub = await stripe(
    env,
    "subscriptions/" +
      encodeURIComponent(subscriptionId) +
      "?expand[]=latest_invoice",
  );
  if (!sub.items?.data.some((item: any) => item.price.id === env.STRIPE_PRICE))
    return;
  if (
    customer.subscription &&
    customer.subscription !== sub.id &&
    customer.paid_until > now()
  )
    return;
  const invoice = sub.latest_invoice;
  const active =
    sub.status === "active" &&
    (!sub.trial_end ||
      (invoice?.status === "paid" &&
        invoice.billing_reason !== "subscription_create"));
  // Failed renewals must not grant a fresh unpaid year. Keep only an already earned term.
  const trialEnd = sub.status === "trialing" ? sub.trial_end : 0;
  if (sub.status === "trialing")
    assert(
      Number.isSafeInteger(trialEnd) && trialEnd > 0,
      502,
      "Invalid trial end from Stripe.",
    );
  const until =
    trialEnd ||
    (active
      ? sub.current_period_end
      : Math.min(customer.paid_until, sub.ended_at ?? customer.paid_until));
  const result = await env.CONTROL.prepare(
    "UPDATE customers SET subscription=?,paid_until=?,trial_ends_at=?,billing_revision=billing_revision+1 WHERE id=? AND billing_revision=?",
  )
    .bind(sub.id, until, trialEnd, customer.id, customer.billing_revision)
    .run();
  assert(result.meta.changes === 1, 503, "Concurrent billing update. Retry.");
  if (active)
    await env.CONTROL.prepare(
      "INSERT OR IGNORE INTO milestones(customer,event,day) VALUES(?,'paid',date('now'))",
    )
      .bind(customer.id)
      .run();
}
export async function webhook(env: HostedEnv, request: Request) {
  assert(
    env.STRIPE_WEBHOOK_SECRET,
    503,
    "Billing notifications are not configured.",
  );
  const body = await readText(request, 250_000);
  const parts = (request.headers.get("Stripe-Signature") || "").split(",");
  const time = parts.find((x) => x.startsWith("t="))?.slice(2) ?? "";
  assert(
    /^\d+$/.test(time) && Math.abs(now() - Number(time)) <= 300,
    400,
    "Invalid signature.",
  );
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(env.STRIPE_WEBHOOK_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  let valid = false;
  for (const part of parts.filter((x) => /^v1=[0-9a-f]{64}$/.test(x))) {
    const bytes = Uint8Array.from(part.slice(3).match(/../g)!, (v) =>
      parseInt(v, 16),
    );
    if (
      await crypto.subtle.verify(
        "HMAC",
        key,
        bytes,
        encoder.encode(time + "." + body),
      )
    )
      valid = true;
  }
  assert(valid, 400, "Invalid signature.");
  const event = JSON.parse(body);
  if (event.type.startsWith("customer.subscription."))
    await reconcile(env, event.data.object.id);
  if (
    [
      "checkout.session.completed",
      "invoice.paid",
      "invoice.payment_failed",
    ].includes(event.type) &&
    event.data.object.subscription
  )
    await reconcile(env, event.data.object.subscription);
  return Response.json({ received: true });
}
