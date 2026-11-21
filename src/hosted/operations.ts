import { now } from "../server/util";
import type { HostedEnv } from "./control";

// Alerts intentionally contain only a provisioned slot label and a fixed event name.
export async function operationalAlert(
  env: HostedEnv,
  event:
    | "feed_delayed"
    | "workbook_refresh_failed"
    | "workspace_capacity"
    | "billing_webhook_failed",
) {
  const slot = env.WORKSPACE_ID ?? "portal";
  const registered = await env.CONTROL.prepare(
    "INSERT INTO alert_delivery(slot,event,at) VALUES(?,?,?) ON CONFLICT(slot,event) DO UPDATE SET at=excluded.at WHERE alert_delivery.at<?",
  )
    .bind(slot, event, now(), now() - 21600)
    .run();
  if (!registered.meta.changes) return;
  console.error(JSON.stringify({ service: "phooey-finance", event, slot }));
  if (!env.OPS_ALERT_URL) return;
  try {
    const url = new URL(env.OPS_ALERT_URL);
    if (url.protocol !== "https:")
      throw Error("HTTPS alert endpoint required.");
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ service: "phooey-finance", event, slot }),
      redirect: "manual",
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw Error("Alert endpoint unavailable.");
  } catch {
    await env.CONTROL.prepare(
      "DELETE FROM alert_delivery WHERE slot=? AND event=?",
    )
      .bind(slot, event)
      .run();
    console.error(
      JSON.stringify({
        service: "phooey-finance",
        event: "alert_delivery_failed",
        slot,
      }),
    );
  }
}
