import type { AppEnv } from "./auth";
import { rateLimit } from "./auth";
import { assert } from "./util";
import { dateSchema } from "../shared/models";
import type { HistoryCheck } from "../shared/sync-history";
import { fetchSimplefinAccounts, providerMessages } from "./sync";

const day = 86400;
const date = (seconds: number) =>
  new Date(seconds * 1000).toISOString().slice(0, 10);

// Two small provider reads, with no transaction imports or sync checkpoints.
export async function checkSyncHistory(
  env: AppEnv,
  start: string,
): Promise<HistoryCheck> {
  dateSchema.parse(start);
  const from = Date.parse(start + "T00:00:00Z") / 1000;
  const end = Math.floor(Date.now() / 1000) + 1;
  const cutoff = end - 90 * day;
  assert(
    from >= 0 && from < cutoff,
    400,
    "Choose a date more than 90 days ago to check older history",
  );
  const connection = await env.DB.prepare(
    "SELECT secret,generation,selected_accounts,available_accounts,selection_ready FROM connections WHERE id='simplefin'",
  ).first<{
    secret: string;
    generation: string;
    selected_accounts: string;
    available_accounts: string;
    selection_ready: number;
  }>();
  assert(
    connection?.selection_ready,
    400,
    "Choose bank accounts before checking history",
  );
  const selected: string[] = JSON.parse(connection.selected_accounts);
  const names: { id: string; name: string }[] = JSON.parse(
    connection.available_accounts,
  );
  assert(selected.length, 400, "Choose bank accounts before checking history");
  assert(
    !(await env.DB.prepare(
      "SELECT id FROM jobs WHERE kind='sync' AND status IN ('queued','running') LIMIT 1",
    ).first()),
    409,
    "Wait for the current sync to finish before checking history",
  );
  await rateLimit(env.DB, "history-check", 2, 3600);

  const result: HistoryCheck = {
    checkedAt: new Date().toISOString(),
    samples: [],
  };
  for (const [windowStart, windowEnd] of [
    [from, Math.min(from + 45 * day, cutoff)],
    [end - 45 * day, end],
  ]) {
    const params = new URLSearchParams({
      version: "2",
      "start-date": String(windowStart),
      "end-date": String(windowEnd),
    });
    for (const account of selected) params.append("account", account);
    const data = await fetchSimplefinAccounts(env, connection, params);
    const sample: HistoryCheck["samples"][number] = {
      from: date(windowStart),
      to: date(windowEnd - 1),
      warnings: providerMessages(data),
      accounts: [],
    };
    for (const accountId of selected) {
      const account = data.accounts.find((a) => a.id === accountId);
      const posted = (account?.transactions ?? []).filter(
        (tx) => !tx.pending && tx.posted > 0,
      );
      const transactions = posted.filter(
        (tx) => tx.posted >= windowStart && tx.posted < windowEnd,
      );
      if (posted.length !== transactions.length)
        sample.warnings.push(
          `${account?.name ?? accountId}: provider returned transactions outside the requested dates; excluded from this check.`,
        );
      const ids = [...new Set(transactions.map((tx) => tx.id))];
      const stored = await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM transactions WHERE account_id=? AND provider_id IN (SELECT value FROM json_each(?))",
      )
        .bind("sf:" + accountId, JSON.stringify(ids))
        .first<{ count: number }>();
      const dates = transactions.map((tx) => date(tx.posted)).sort();
      sample.accounts.push({
        id: accountId,
        name:
          account?.name ??
          names.find((a) => a.id === accountId)?.name ??
          accountId,
        returned: !!account,
        count: ids.length,
        oldest: dates[0] ?? null,
        newest: dates.at(-1) ?? null,
        missingFromLedger: ids.length - (stored?.count ?? 0),
      });
    }
    result.samples.push(sample);
  }
  const current = await env.DB.prepare(
    "SELECT generation FROM connections WHERE id='simplefin'",
  ).first<{ generation: string }>();
  assert(
    current?.generation === connection.generation,
    409,
    "Connection changed during the check. Run it again.",
  );
  return result;
}
