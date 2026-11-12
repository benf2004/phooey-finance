import { z } from "zod";
import { type AppEnv, encrypt, decrypt, rateLimit } from "./auth";
import { assert, id, now, AppError } from "./util";
import { Ledger, ruleMatches } from "./ledger";
import { parseMoney } from "../shared/money";
const hosts = new Set(["bridge.simplefin.org", "beta-bridge.simplefin.org"]);
export function validateSimplefinURL(value: string) {
  const url = new URL(value);
  assert(
    url.protocol === "https:" &&
      hosts.has(url.hostname) &&
      !url.port &&
      !url.hash,
    400,
    "Use a SimpleFIN Bridge token",
  );
  return url;
}
async function boundedText(response: Response, max = 8_000_000) {
  const reader = response.body!.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) {
      await reader.cancel();
      throw new AppError(502, "Provider response exceeds the supported size");
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let cursor = 0;
  for (const c of chunks) {
    out.set(c, cursor);
    cursor += c.length;
  }
  return new TextDecoder().decode(out);
}
export async function connectSimplefin(env: AppEnv, token: string) {
  const running = await env.DB.prepare(
    "SELECT id FROM jobs WHERE kind='sync' AND status='running' AND lease_until>? LIMIT 1",
  )
    .bind(now())
    .first();
  assert(
    !running,
    409,
    "Wait for the running sync before replacing the connection",
  );
  let decoded: string;
  try {
    decoded = atob(token.trim());
  } catch {
    throw new AppError(400, "Invalid setup token");
  }
  const url = validateSimplefinURL(decoded);
  assert(
    !url.username &&
      !url.password &&
      url.pathname.startsWith("/simplefin/claim/"),
    400,
    "Invalid claim URL",
  );
  const response = await fetch(url, {
    method: "POST",
    // Workers supports manual redirects; response.ok rejects 3xx without forwarding credentials.
    redirect: "manual",
    signal: AbortSignal.timeout(20000),
  });
  assert(
    response.ok,
    400,
    "Setup token could not be claimed. Generate a fresh token and try again.",
  );
  const access = (await boundedText(response, 5000)).trim();
  const accessUrl = validateSimplefinURL(access);
  assert(
    accessUrl.username && accessUrl.password,
    400,
    "Provider did not return an access URL",
  );
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE jobs SET status='cancelled' WHERE kind='sync' AND status IN ('queued','running')",
    ),
    env.DB.prepare(
      "INSERT INTO connections(id,secret,generation,status) VALUES('simplefin',?,?,'selecting') ON CONFLICT(id) DO UPDATE SET secret=excluded.secret,generation=excluded.generation,status='selecting',last_error=NULL,last_success=NULL,resume_from=NULL,selected_accounts='[]',available_accounts='[]',selection_ready=0",
    ).bind(await encrypt(env, access), id()),
  ]);
  return discoverSimplefinAccounts(env);
}
export async function requestSync(env: AppEnv, start?: string) {
  const connection = await env.DB.prepare(
    "SELECT id,last_success,resume_from,generation,selected_accounts,selection_ready FROM connections WHERE id='simplefin'",
  ).first<{
    id: string;
    last_success: string | null;
    resume_from: number | null;
    generation: string;
    selected_accounts: string;
    selection_ready: number;
  }>();
  assert(connection, 400, "Connect SimpleFIN first");
  assert(
    connection.selection_ready &&
      JSON.parse(connection.selected_accounts).length,
    400,
    "Choose accounts to import in Settings first",
  );
  const active = await env.DB.prepare(
    "SELECT id FROM jobs WHERE kind='sync' AND status IN ('queued','running') ORDER BY created_at DESC LIMIT 1",
  ).first<{ id: string }>();
  if (active) {
    await env.JOBS.send({ jobId: active.id });
    return { jobId: active.id };
  }
  await rateLimit(env.DB, "manual-sync", 4, 3600);
  const end = Math.floor(Date.now() / 1000) + 1;
  const startDate = start
    ? Math.floor(new Date(start + "T00:00:00Z").getTime() / 1000)
    : (connection.resume_from ??
      (connection.last_success
        ? Math.floor(new Date(connection.last_success).getTime() / 1000) -
          5 * 86400
        : end - 45 * 86400));
  assert(
    startDate < end && startDate >= 0,
    400,
    "Backfill date must be in the past",
  );
  const jobId = id();
  const guard = id();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO write_guards VALUES(?,(SELECT COUNT(*)=1 FROM connections WHERE id='simplefin' AND generation=? AND selection_ready=1 AND json_array_length(selected_accounts)>0))",
    ).bind(guard, connection.generation),
    env.DB.prepare("INSERT INTO jobs(id,kind,payload) VALUES(?,'sync',?)").bind(
      jobId,
      JSON.stringify({
        cursor: startDate,
        end,
        generation: connection.generation,
      }),
    ),
    env.DB.prepare("DELETE FROM write_guards WHERE id=?").bind(guard),
  ]);
  await env.JOBS.send({ jobId });
  return { jobId };
}
const accountSetSchema = z.object({
  errors: z.array(z.string()).optional(),
  errlist: z.array(z.unknown()).optional(),
  connections: z
    .array(
      z.object({
        conn_id: z.string(),
        org_name: z.string().optional(),
        name: z.string().optional(),
      }),
    )
    .optional(),
  accounts: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      currency: z.string(),
      balance: z.string(),
      "balance-date": z.number(),
      conn_id: z.string().optional(),
      org: z
        .object({ name: z.string().optional(), id: z.string().optional() })
        .optional(),
      transactions: z
        .array(
          z.object({
            id: z.string(),
            posted: z.number(),
            amount: z.string(),
            description: z.string(),
            pending: z.boolean().optional(),
            transacted_at: z.number().optional(),
          }),
        )
        .optional(),
    }),
  ),
});
type AccountChoice = {
  id: string;
  name: string;
  institution: string;
  currency: string;
};
function providerMessages(data: z.infer<typeof accountSetSchema>) {
  return [
    ...new Set([
      ...(data.errors ?? []),
      ...(data.errlist ?? []).map((error) => {
        if (typeof error === "string") return error;
        if (
          error &&
          typeof error === "object" &&
          "msg" in error &&
          typeof error.msg === "string"
        )
          return error.msg;
        return JSON.stringify(error);
      }),
    ]),
  ];
}
async function fetchSimplefinAccounts(
  env: AppEnv,
  connection: { secret: string; generation: string },
  params: URLSearchParams,
) {
  await rateLimit(env.DB, "simplefin-requests", 20, 86400);
  const url = validateSimplefinURL(await decrypt(env, connection.secret));
  const auth =
    "Basic " +
    btoa(
      decodeURIComponent(url.username) + ":" + decodeURIComponent(url.password),
    );
  url.username = "";
  url.password = "";
  url.pathname = url.pathname.replace(/\/$/, "") + "/accounts";
  url.search = params.toString();
  const response = await fetch(url, {
    headers: { Authorization: auth },
    redirect: "manual",
    signal: AbortSignal.timeout(30000),
  });
  if (response.status === 402 || response.status === 403) {
    const message =
      response.status === 402
        ? "SimpleFIN subscription needs attention"
        : "Connection revoked. Reconnect SimpleFIN.";
    await env.DB.prepare(
      "UPDATE connections SET status='attention',last_error=? WHERE id='simplefin' AND generation=?",
    )
      .bind(message, connection.generation)
      .run();
    throw new AppError(400, message);
  }
  assert(response.ok, 502, "SimpleFIN is temporarily unavailable");
  return accountSetSchema.parse(JSON.parse(await boundedText(response)));
}
export async function simplefinState(env: AppEnv) {
  const connection = await env.DB.prepare(
    "SELECT id,last_success,last_error,status,generation,selected_accounts,available_accounts,selection_ready FROM connections WHERE id='simplefin'",
  ).first<{
    id: string;
    last_success: string | null;
    last_error: string | null;
    status: string;
    generation: string;
    selected_accounts: string;
    available_accounts: string;
    selection_ready: number;
  }>();
  if (!connection) return null;
  const { selected_accounts, available_accounts, selection_ready, ...state } =
    connection;
  return {
    ...state,
    selectedAccounts: JSON.parse(selected_accounts) as string[],
    accounts: JSON.parse(available_accounts) as AccountChoice[],
    selectionReady: !!selection_ready,
  };
}
export async function discoverSimplefinAccounts(env: AppEnv) {
  const connection = await env.DB.prepare(
    "SELECT secret,generation FROM connections WHERE id='simplefin'",
  ).first<{ secret: string; generation: string }>();
  assert(connection, 400, "Connect SimpleFIN first");
  const data = await fetchSimplefinAccounts(
    env,
    connection,
    new URLSearchParams({ version: "2", "balances-only": "1" }),
  );
  // Cache names only: discovery never persists balances or transactions to the ledger.
  const accounts: AccountChoice[] = data.accounts.map((account) => ({
    id: account.id,
    name: account.name,
    currency: account.currency,
    institution:
      account.org?.name ??
      data.connections?.find((c) => c.conn_id === account.conn_id)?.org_name ??
      "",
  }));
  const problems = providerMessages(data);
  const result = await env.DB.prepare(
    "UPDATE connections SET available_accounts=?,last_error=? WHERE id='simplefin' AND generation=?",
  )
    .bind(
      JSON.stringify(accounts),
      problems.length ? problems.join("\n").slice(0, 4000) : null,
      connection.generation,
    )
    .run();
  assert(
    result.meta.changes,
    409,
    "Connection changed. Refresh and try again.",
  );
  return simplefinState(env);
}
export async function selectSimplefinAccounts(env: AppEnv, input: unknown) {
  const { generation, accountIds, removeUnselected } = z
    .object({
      generation: z.string().min(1),
      accountIds: z.array(z.string().min(1)).max(200),
      removeUnselected: z.boolean().default(false),
    })
    .parse(input);
  const connection = await simplefinState(env);
  assert(
    connection && connection.generation === generation,
    409,
    "Connection changed. Refresh and try again.",
  );
  const selected = [...new Set(accountIds)];
  assert(
    selected.every((id) => connection.accounts.some((a) => a.id === id)),
    400,
    "Refresh the account list and choose available accounts",
  );
  const selectedJSON = JSON.stringify(selected);
  const guard = id();
  const nextGeneration = id();
  const statements = [
    env.DB.prepare(
      "INSERT INTO write_guards VALUES(?,(SELECT COUNT(*)=1 FROM connections WHERE id='simplefin' AND generation=?))",
    ).bind(guard, generation),
    env.DB.prepare(
      "UPDATE jobs SET status='cancelled',lease_until=0 WHERE kind='sync' AND status IN ('queued','running')",
    ),
    env.DB.prepare(
      "UPDATE connections SET selected_accounts=?,selection_ready=1,generation=?,last_success=NULL,resume_from=NULL,last_error=NULL,status=? WHERE id='simplefin'",
    ).bind(
      selectedJSON,
      nextGeneration,
      selected.length ? "connected" : "paused",
    ),
  ];
  if (removeUnselected) {
    const removedAccounts =
      "SELECT id FROM accounts WHERE source='simplefin' AND provider_id NOT IN (SELECT value FROM json_each(?))";
    const removedTransactions = `SELECT id FROM transactions WHERE account_id IN (${removedAccounts})`;
    // Keep recorded tax payments, but unlink removed bank transactions.
    statements.push(
      env.DB.prepare(
        `UPDATE tax_payments SET transaction_id=NULL WHERE transaction_id IN (${removedTransactions})`,
      ).bind(selectedJSON),
      env.DB.prepare(
        `UPDATE transactions SET transfer_id=NULL,revision=revision+1 WHERE transfer_id IN (SELECT transfer_id FROM transactions WHERE account_id IN (${removedAccounts}))`,
      ).bind(selectedJSON),
      env.DB.prepare(
        `DELETE FROM transactions WHERE account_id IN (${removedAccounts})`,
      ).bind(selectedJSON),
      env.DB.prepare(
        `DELETE FROM rules WHERE account_id IN (${removedAccounts})`,
      ).bind(selectedJSON),
      env.DB.prepare(
        `DELETE FROM balance_snapshots WHERE account_id IN (${removedAccounts})`,
      ).bind(selectedJSON),
      env.DB.prepare(
        `DELETE FROM accounts WHERE id IN (${removedAccounts})`,
      ).bind(selectedJSON),
    );
  }
  statements.push(
    new Ledger(env.DB).auditStatement(
      "sync.accounts",
      "simplefin",
      { accountIds: connection.selectedAccounts },
      { accountIds: selected, removeUnselected },
    ),
  );
  statements.push(
    env.DB.prepare("DELETE FROM write_guards WHERE id=?").bind(guard),
  );
  await env.DB.batch(statements);
  return simplefinState(env);
}
type SyncPayload = {
  generation: string;
  cursor: number;
  end: number;
  stageKey?: string;
  offset?: number;
  problems?: string[];
  initialCursor?: number;
};
export async function syncWindow(
  env: AppEnv,
  jobId: string,
  payload: SyncPayload,
) {
  const connection = await env.DB.prepare(
    "SELECT secret,generation,selected_accounts,selection_ready FROM connections WHERE id='simplefin'",
  ).first<{
    secret: string;
    generation: string;
    selected_accounts: string;
    selection_ready: number;
  }>();
  if (
    !connection ||
    connection.generation !== payload.generation ||
    !connection.selection_ready ||
    !JSON.parse(connection.selected_accounts).length
  ) {
    await env.DB.prepare("UPDATE jobs SET status='cancelled' WHERE id=?")
      .bind(jobId)
      .run();
    return;
  }
  const windowEnd = Math.min(payload.end, payload.cursor + 45 * 86400);
  if (!payload.stageKey) {
    const params = new URLSearchParams({
      version: "2",
      "start-date": String(payload.cursor),
      "end-date": String(windowEnd),
      pending: "1",
    });
    const selected = new Set<string>(JSON.parse(connection.selected_accounts));
    for (const account of selected) params.append("account", account);
    const data = await fetchSimplefinAccounts(env, connection, params);
    // Enforce selection even if the provider ignores account filters.
    data.accounts = data.accounts.filter((account) => selected.has(account.id));
    const stageKey = "sync/" + jobId + "/" + payload.cursor;
    await env.FILES.put(stageKey, JSON.stringify(data));
    const problems = [
      ...(payload.problems ?? []),
      ...providerMessages(data),
    ].slice(-30);
    const next = {
      ...payload,
      stageKey,
      offset: 0,
      problems,
      initialCursor: payload.initialCursor ?? payload.cursor,
    };
    const staged = await env.DB.prepare(
      "UPDATE jobs SET payload=?,status='queued',lease_until=0,progress='Bank data received; importing',updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='running' AND EXISTS(SELECT 1 FROM connections WHERE id='simplefin' AND generation=?)",
    )
      .bind(JSON.stringify(next), jobId, payload.generation)
      .run();
    if (!staged.meta.changes) return;
    await env.JOBS.send({ jobId });
    return;
  }
  const object = await env.FILES.get(payload.stageKey);
  assert(object, 502, "Staged sync data is unavailable; retry synchronization");
  const data = accountSetSchema.parse(await object.json());
  const selected = new Set<string>(JSON.parse(connection.selected_accounts));
  data.accounts = data.accounts.filter((account) => selected.has(account.id));
  const ledger = new Ledger(env.DB, "sync");
  const rules = await ledger.rules();
  const categories = await ledger.categories();
  const records = data.accounts.flatMap((account) =>
    (account.transactions ?? []).map((tx) => ({ account, tx })),
  );
  const offset = payload.offset ?? 0;
  const end = Math.min(offset + 100, records.length);
  const guard = id();
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      "INSERT INTO write_guards VALUES(?,(SELECT COUNT(*)=1 FROM connections WHERE id='simplefin' AND generation=?) AND (SELECT COUNT(*)=1 FROM jobs WHERE id=? AND status='running'))",
    ).bind(guard, payload.generation, jobId),
  ];
  if (offset === 0) {
    for (const account of data.accounts) {
      if (!/^[A-Z]{3}$/.test(account.currency)) {
        payload.problems = [
          ...(payload.problems ?? []),
          "Unsupported account currency: " + account.name,
        ];
        continue;
      }
      const accountId = "sf:" + account.id;
      const balance = parseMoney(account.balance);
      const captured = new Date(account["balance-date"] * 1000).toISOString();
      const institution =
        account.org?.name ??
        data.connections?.find((c) => c.conn_id === account.conn_id)
          ?.org_name ??
        "";
      statements.push(
        env.DB.prepare(
          "INSERT INTO accounts(id,name,institution,kind,currency,balance,balance_at,source,provider_id) VALUES(?,?,?,'other',?,?,?,'simplefin',?) ON CONFLICT(id) DO UPDATE SET balance=CASE WHEN excluded.balance_at>=accounts.balance_at THEN excluded.balance ELSE accounts.balance END,balance_at=MAX(accounts.balance_at,excluded.balance_at),institution=excluded.institution",
        ).bind(
          accountId,
          account.name,
          institution,
          account.currency,
          balance,
          captured,
          account.id,
        ),
      );
      statements.push(
        env.DB.prepare(
          "INSERT OR IGNORE INTO balance_snapshots(id,account_id,balance,captured_at) VALUES(?,?,?,?)",
        ).bind(id(), accountId, balance, captured),
      );
    }
  }
  for (const { account, tx } of records.slice(offset, end)) {
    if (!/^[A-Z]{3}$/.test(account.currency)) continue;
    const accountId = "sf:" + account.id;
    const amount = parseMoney(tx.amount);
    const posted = new Date(
      (tx.posted || tx.transacted_at || account["balance-date"]) * 1000,
    )
      .toISOString()
      .slice(0, 10);
    const raw = {
      account_id: accountId,
      amount,
      description: tx.description,
      merchant: "",
      posted,
    };
    const rule = rules.find((r) => ruleMatches(r, raw));
    const type =
      categories.find((c) => c.id === rule?.category_id)?.type ??
      (amount >= 0 ? "income" : "expense");
    statements.push(
      env.DB.prepare(
        "INSERT INTO transactions(id,account_id,provider_id,posted,amount,description,type,category_id,pending,source,raw_json,rule_id) VALUES(?,?,?,?,?,?,?,?,?,'simplefin',?,?) ON CONFLICT(account_id,provider_id) DO UPDATE SET raw_json=excluded.raw_json,pending=excluded.pending,posted=CASE WHEN transactions.user_edited=0 THEN excluded.posted ELSE transactions.posted END,amount=CASE WHEN transactions.user_edited=0 THEN excluded.amount ELSE transactions.amount END,description=CASE WHEN transactions.user_edited=0 THEN excluded.description ELSE transactions.description END,revision=transactions.revision+1",
      ).bind(
        id(),
        accountId,
        tx.id,
        posted,
        amount,
        tx.description,
        type,
        rule?.category_id ?? null,
        +(tx.pending ?? false),
        JSON.stringify(tx),
        rule?.id ?? null,
      ),
    );
  }
  // Commit financial records and their checkpoint together, including the terminal state.
  const done = end >= records.length;
  const finished = done && windowEnd >= payload.end;
  const next: SyncPayload = done
    ? {
        generation: payload.generation,
        cursor: windowEnd,
        end: payload.end,
        initialCursor: payload.initialCursor,
        problems: payload.problems,
      }
    : { ...payload, offset: end };
  const problems = payload.problems ?? [];
  statements.push(
    env.DB.prepare(
      "UPDATE jobs SET payload=?,status=?,lease_until=0,progress=?,error=?,updated_at=CURRENT_TIMESTAMP WHERE id=?",
    ).bind(
      JSON.stringify(next),
      finished ? "complete" : "queued",
      finished
        ? problems.length
          ? "Sync complete with provider warnings; failed history will be retried"
          : "Sync complete"
        : `${end} of ${records.length} records imported in this window`,
      finished && problems.length ? problems.join("\n").slice(0, 4000) : null,
      jobId,
    ),
  );
  if (finished)
    statements.push(
      env.DB.prepare(
        "UPDATE connections SET last_success=CASE WHEN ?=0 THEN ? ELSE last_success END,resume_from=CASE WHEN ?=0 THEN NULL ELSE MIN(COALESCE(resume_from,?),?) END,last_error=?,status=? WHERE id='simplefin'",
      ).bind(
        problems.length,
        new Date(payload.end * 1000).toISOString(),
        problems.length,
        payload.initialCursor ?? payload.cursor,
        payload.initialCursor ?? payload.cursor,
        problems.length ? problems.join("\n").slice(0, 4000) : null,
        problems.length ? "attention" : "connected",
      ),
    );
  statements.push(
    env.DB.prepare("DELETE FROM write_guards WHERE id=?").bind(guard),
  );
  await env.DB.batch(statements);
  if (done) {
    try {
      await env.FILES.delete(payload.stageKey);
    } catch {
      /* Lifecycle cleanup can retry without changing completed financial work. */
    }
  }
  if (!finished)
    await env.JOBS.send({ jobId }, { delaySeconds: done ? 60 : 0 });
}

export async function claimJob(env: AppEnv, jobId: string) {
  return env.DB.prepare(
    "UPDATE jobs SET status='running',lease_until=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND status IN ('queued','running') AND lease_until<? RETURNING *",
  )
    .bind(now() + 180, jobId, now())
    .first<{ id: string; kind: string; payload: string }>();
}
