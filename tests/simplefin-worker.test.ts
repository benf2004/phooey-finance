import type { AppEnv } from "../src/server/auth";
import { beforeEach, afterEach, it, expect } from "vitest";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { readFile, readdir } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { hash } from "bcryptjs";

let mf: Miniflare, cookie: string;
let db: Awaited<ReturnType<Miniflare["getD1Database"]>>;
let redirectAt: "claim" | "accounts" | undefined;
const requests: {
  host: string;
  path: string;
  method: string;
  auth: string | null;
  query: string;
}[] = [];
const accessURL = "https://test:password@bridge.simplefin.org/simplefin";
const setupToken = btoa("https://bridge.simplefin.org/simplefin/claim/test");
beforeEach(async () => {
  redirectAt = undefined;
  requests.length = 0;
  mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      scriptPath: "dist/phooey_finance/index.js",
      compatibilityDate: "2026-11-12",
      compatibilityFlags: ["nodejs_compat"],
      d1Databases: { DB: "simplefin-worker" },
      r2Buckets: ["FILES"],
      queueProducers: { JOBS: "jobs" },
      bindings: {
        ADMIN_USERNAME: "admin",
        ADMIN_PASSWORD_HASH: await hash("test-password", 4),
        ENCRYPTION_KEY: randomBytes(32).toString("base64"),
      },
      outboundService: async (request) => {
        const url = new URL(request.url);
        requests.push({
          host: url.hostname,
          path: url.pathname,
          method: request.method,
          auth: request.headers.get("Authorization"),
          query: url.search,
        });
        const stage = url.pathname.includes("/claim/") ? "claim" : "accounts";
        if (redirectAt === stage)
          return new Response(null, {
            status: 302,
            headers: { Location: "https://unexpected.example/redirect" },
          });
        if (stage === "claim") return new Response(accessURL);
        return Response.json({
          accounts: [
            {
              id: "personal",
              name: "Personal",
              currency: "USD",
              balance: "200.00",
              "balance-date": 1794000000,
              transactions: [
                {
                  id: "personal-tx",
                  posted: 1793000000,
                  amount: "-20.00",
                  description: "Personal purchase",
                },
              ],
            },
            {
              id: "bank",
              name: "Checking",
              currency: "USD",
              balance: "100.00",
              "balance-date": 1794000000,
              transactions: [
                {
                  id: "tx",
                  posted: 1793000000,
                  amount: "-10.00",
                  description: "Test transaction",
                },
              ],
            },
          ],
        });
      },
    }),
  );
  db = await mf.getD1Database("DB");
  for (const file of (await readdir("migrations")).sort())
    await db.exec(
      (await readFile("migrations/" + file, "utf8")).replaceAll("\n", " "),
    );
  const login = await mf.dispatchFetch("http://localhost/api/login", {
    method: "POST",
    headers: { Origin: "http://localhost", "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "test-password" }),
  });
  expect(login.status).toBe(200);
  cookie = login.headers.get("Set-Cookie")!.split(";")[0];
});
afterEach(async () => {
  await mf?.dispose();
});
async function post(path: string, body: unknown) {
  return mf.dispatchFetch("http://localhost/api" + path, {
    method: "POST",
    headers: {
      Origin: "http://localhost",
      Cookie: cookie,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}
async function connect() {
  return post("/sync/connect", { token: setupToken });
}
async function selection(accountIds = ["bank"], removeUnselected = false) {
  const connection = await db
    .prepare("SELECT generation FROM connections")
    .first<{ generation: string }>();
  const response = await post("/sync/accounts", {
    generation: connection!.generation,
    accountIds,
    removeUnselected,
  });
  expect(response.status, await response.clone().text()).toBe(200);
  return response.json();
}
async function queue(start?: string) {
  const response = await post("/sync", start ? { start } : {});
  expect(response.status).toBe(200);
  return ((await response.json()) as { jobId: string }).jobId;
}
async function finish(jobId: string) {
  for (let i = 0; i < 12; i++) {
    const job = await consume(jobId);
    expect(job?.error).toBeNull();
    if (job?.status === "complete") return;
  }
  throw new Error("Sync did not complete");
}
async function consume(jobId: string) {
  const worker = await mf.getWorker();
  if (!("queue" in worker) || typeof worker.queue !== "function")
    throw new Error("Worker queue handler unavailable");
  await worker.queue("jobs", [
    {
      id: crypto.randomUUID(),
      timestamp: new Date(),
      attempts: 1,
      body: { jobId },
    },
  ]);
  return db
    .prepare("SELECT status,error FROM jobs WHERE id=?")
    .bind(jobId)
    .first<{ status: string; error: string | null }>();
}
it("discovers accounts without importing and syncs only the explicit selection", async () => {
  const response = await connect();
  expect(response.status).toBe(200);
  const connection = (await response.json()) as {
    accounts: unknown[];
    selectedAccounts: string[];
  };
  expect(connection.accounts).toHaveLength(2);
  expect(connection.selectedAccounts).toEqual([]);
  for (const table of ["accounts", "transactions", "jobs", "balance_snapshots"])
    expect(
      await db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first(),
    ).toEqual({ count: 0 });
  expect(requests[1].query).toContain("balances-only=1");
  expect((await post("/sync", {})).status).toBe(400);
  await selection();
  const jobId = await queue();
  await consume(jobId);
  const staged = await (
    await mf.getBindings<AppEnv>()
  ).FILES.get(
    "sync/" +
      jobId +
      "/" +
      JSON.parse(
        (await db
          .prepare("SELECT payload FROM jobs WHERE id=?")
          .bind(jobId)
          .first<{ payload: string }>())!.payload,
      ).cursor,
  );
  expect(
    (await staged!.json<{ accounts: { id: string }[] }>()).accounts.map(
      (a) => a.id,
    ),
  ).toEqual(["bank"]);
  await finish(jobId);
  expect(
    await db.prepare("SELECT amount,category_id FROM transactions").all(),
  ).toMatchObject({ results: [{ amount: -1000, category_id: null }] });
  expect(
    (
      await db
        .prepare("SELECT secret FROM connections")
        .first<{ secret: string }>()
    )?.secret,
  ).not.toContain(accessURL);
  expect(requests).toHaveLength(3);
  expect(new URLSearchParams(requests[2].query).getAll("account")).toEqual([
    "bank",
  ]);
  expect(requests[2].auth).toBe("Basic " + btoa("test:password"));
});
it("rejects claim redirects without following them", async () => {
  redirectAt = "claim";
  const response = await connect();
  expect(response.status).toBe(400);
  expect(
    await db.prepare("SELECT COUNT(*) AS count FROM connections").first(),
  ).toEqual({ count: 0 });
  expect(requests).toHaveLength(1);
});
it("rejects account redirects without forwarding bank credentials", async () => {
  const response = await connect();
  expect(response.status).toBe(200);
  await selection();
  const jobId = await queue();
  redirectAt = "accounts";
  const job = await consume(jobId);
  expect(job?.status).toBe("queued");
  expect(job?.error).toBe("SimpleFIN is temporarily unavailable");
  expect(requests).toHaveLength(3);
  expect(requests.every((r) => r.host === "bridge.simplefin.org")).toBe(true);
});

it("splits history into contiguous windows no longer than 45 days", async () => {
  await connect();
  await selection();
  const start = new Date(Date.now() - 120 * 86400000)
    .toISOString()
    .slice(0, 10);
  await finish(await queue(start));
  const windows = requests
    .map((r) => new URLSearchParams(r.query))
    .filter((p) => p.has("start-date"));
  expect(windows).toHaveLength(3);
  expect(Number(windows[0].get("start-date"))).toBe(Date.parse(start) / 1000);
  windows.forEach((p, i) => {
    expect(
      Number(p.get("end-date")) - Number(p.get("start-date")),
    ).toBeLessThanOrEqual(45 * 86400);
    expect(p.getAll("account")).toEqual(["bank"]);
    if (i) expect(p.get("start-date")).toBe(windows[i - 1].get("end-date"));
  });
  expect(
    (await db.prepare("SELECT COUNT(*) AS count FROM transactions").first())
      ?.count,
  ).toBe(1);
});
it("cancels staged imports when selection changes and blocks syncing when paused", async () => {
  await connect();
  await selection();
  const oldJob = await queue();
  await consume(oldJob);
  await selection(["personal"]);
  await consume(oldJob);
  expect(
    (await db.prepare("SELECT COUNT(*) AS count FROM accounts").first())?.count,
  ).toBe(0);
  await finish(await queue());
  expect(
    (await db.prepare("SELECT provider_id FROM accounts").first())?.provider_id,
  ).toBe("personal");
  await selection([]);
  expect((await post("/sync", {})).status).toBe(400);
  const worker = await mf.getWorker();
  if (!("scheduled" in worker) || typeof worker.scheduled !== "function")
    throw new Error("Missing scheduled handler");
  const before = requests.length;
  await worker.scheduled({ scheduledTime: Date.now(), cron: "17 6,18 * * *" });
  expect(requests).toHaveLength(before);
  expect(
    (
      await db
        .prepare(
          "SELECT COUNT(*) AS count FROM jobs WHERE status IN ('queued','running')",
        )
        .first()
    )?.count,
  ).toBe(0);
});
it("only removes previously imported accounts when cleanup is explicitly requested", async () => {
  await connect();
  await selection(["bank", "personal"]);
  await finish(await queue());
  await db.exec(
    "INSERT INTO accounts(id,name) VALUES('manual','Manual'); INSERT INTO tax_payments(id,year,jurisdiction,paid_on,amount,transaction_id) SELECT 'payment',2026,'federal','2026-10-01',2000,id FROM transactions WHERE account_id='sf:personal'; INSERT INTO splits(id,transaction_id,amount,type) SELECT 'split',id,-2000,'expense' FROM transactions WHERE account_id='sf:personal'; UPDATE transactions SET transfer_id='pair';",
  );
  await selection(["bank"]);
  expect(
    (await db.prepare("SELECT COUNT(*) AS count FROM accounts").first())?.count,
  ).toBe(3);
  await selection(["bank"], true);
  expect(
    (await db.prepare("SELECT id FROM accounts ORDER BY id").all()).results,
  ).toEqual([{ id: "manual" }, { id: "sf:bank" }]);
  expect(
    (await db.prepare("SELECT account_id,transfer_id FROM transactions").all())
      .results,
  ).toEqual([{ account_id: "sf:bank", transfer_id: null }]);
  expect(
    (await db.prepare("SELECT transaction_id FROM tax_payments").first())
      ?.transaction_id,
  ).toBeNull();
  expect(
    (await db.prepare("SELECT COUNT(*) AS count FROM splits").first())?.count,
  ).toBe(0);
  await finish(await queue());
  expect(
    (await db.prepare("SELECT COUNT(*) AS count FROM accounts").first())?.count,
  ).toBe(2);
});
it("keeps a claimed connection available when discovery fails", async () => {
  redirectAt = "accounts";
  expect((await connect()).status).toBe(502);
  expect(
    (await db.prepare("SELECT COUNT(*) AS count FROM connections").first())
      ?.count,
  ).toBe(1);
  expect(
    (await db.prepare("SELECT COUNT(*) AS count FROM jobs").first())?.count,
  ).toBe(0);
  redirectAt = undefined;
  expect((await post("/sync/discover", {})).status).toBe(200);
  expect(requests.filter((r) => r.path.includes("claim"))).toHaveLength(1);
});
it("rejects stale selection and unknown account IDs", async () => {
  await connect();
  const original = await db
    .prepare("SELECT generation FROM connections")
    .first<{ generation: string }>();
  expect(
    (
      await post("/sync/accounts", {
        generation: original!.generation,
        accountIds: ["unknown"],
      })
    ).status,
  ).toBe(400);
  await selection();
  expect(
    (
      await post("/sync/accounts", {
        generation: original!.generation,
        accountIds: [],
        removeUnselected: true,
      })
    ).status,
  ).toBe(409);
});

it("exposes reset only to the signed-in admin and validates typed confirmation", async () => {
  const anonymous = await mf.dispatchFetch(
    "http://localhost/api/settings/reset",
    {
      method: "POST",
      headers: {
        Origin: "http://localhost",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        scope: "everything",
        confirmation: "RESET EVERYTHING",
      }),
    },
  );
  expect(anonymous.status).toBe(401);
  await connect();
  await selection();
  await finish(await queue());
  expect(
    (
      await post("/settings/reset", {
        scope: "transactions",
        confirmation: "wrong",
      })
    ).status,
  ).toBe(400);
  const response = await post("/settings/reset", {
    scope: "transactions",
    confirmation: "DELETE TRANSACTIONS",
  });
  expect(response.status).toBe(200);
  const { jobId } = (await response.json()) as { jobId: string };
  await consume(jobId);
  expect(
    (await db.prepare("SELECT COUNT(*) AS count FROM transactions").first())
      ?.count,
  ).toBe(0);
  expect((await post("/sync", {})).status).toBe(400);
});

async function get(path: string) {
  return mf.dispatchFetch("http://localhost/api" + path, {
    headers: { Cookie: cookie },
  });
}
async function removeAccount(
  accountId: string,
  confirmation = "DELETE ACCOUNT",
) {
  return mf.dispatchFetch(
    "http://localhost/api/accounts/" + encodeURIComponent(accountId),
    {
      method: "DELETE",
      headers: {
        Cookie: cookie,
        Origin: "http://localhost",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ confirmation }),
    },
  );
}
it("hides unselected accounts and their history across lists, totals, and exports", async () => {
  await connect();
  await selection(["bank", "personal"]);
  await finish(await queue());
  const manual = await post("/accounts", { name: "Manual" });
  expect(manual.status).toBe(200);
  const personalTx = await db
    .prepare("SELECT id FROM transactions WHERE account_id='sf:personal'")
    .first<{ id: string }>();
  await selection(["bank"]);
  const accounts = (await (await get("/accounts")).json()) as {
    id: string;
    name: string;
  }[];
  expect(accounts.map((a) => a.name).sort()).toEqual(["Checking", "Manual"]);
  expect(await (await get("/transactions")).json()).toMatchObject({ total: 1 });
  expect((await get("/transactions/" + personalTx!.id)).status).toBe(404);
  expect(
    await (await get("/report?from=2026-01-01&to=2026-12-31")).json(),
  ).toMatchObject({ groups: { USD: { expenses: 1000 } } });
  expect(await (await get("/export")).text()).not.toContain(
    "Personal purchase",
  );
  expect(
    (await db.prepare("SELECT COUNT(*) AS count FROM transactions").first())
      ?.count,
  ).toBe(2);
  const state = (await (await get("/sync")).json()) as {
    connection: { importedAccounts: { id: string }[] };
  };
  expect(state.connection.importedAccounts).toHaveLength(2);
  await selection(["bank", "personal"]);
  expect(await (await get("/transactions")).json()).toMatchObject({ total: 2 });
  expect((await get("/transactions/" + personalTx!.id)).status).toBe(200);
});
it("deletes one bank account, clears its dependencies, and prevents queued sync from restoring it", async () => {
  await connect();
  await selection(["bank", "personal"]);
  await finish(await queue());
  await db.exec(
    "INSERT INTO categories(id,name,type) VALUES('test-category','Test','expense'); INSERT INTO rules(id,name,pattern,category_id,account_id) VALUES('personal-rule','Personal','purchase','test-category','sf:personal'); INSERT INTO tax_payments(id,year,jurisdiction,paid_on,amount,transaction_id) SELECT 'payment',2026,'federal','2026-10-01',2000,id FROM transactions WHERE account_id='sf:personal'; INSERT INTO splits(id,transaction_id,amount,type) SELECT 'split',id,-2000,'expense' FROM transactions WHERE account_id='sf:personal'; UPDATE transactions SET transfer_id='pair';",
  );
  const staleJob = await queue();
  await consume(staleJob);
  expect((await removeAccount("sf:personal", "wrong")).status).toBe(400);
  expect((await removeAccount("sf:personal")).status).toBe(200);
  await consume(staleJob);
  expect((await db.prepare("SELECT id FROM accounts").all()).results).toEqual([
    { id: "sf:bank" },
  ]);
  expect(
    (await db.prepare("SELECT transfer_id FROM transactions").first())
      ?.transfer_id,
  ).toBeNull();
  expect(
    (await db.prepare("SELECT transaction_id FROM tax_payments").first())
      ?.transaction_id,
  ).toBeNull();
  for (const table of ["splits", "rules"])
    expect(
      (await db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first())
        ?.count,
    ).toBe(0);
  expect(
    JSON.parse(
      (await db
        .prepare("SELECT selected_accounts FROM connections")
        .first<{ selected_accounts: string }>())!.selected_accounts,
    ),
  ).toEqual(["bank"]);
  await finish(await queue());
  expect((await db.prepare("SELECT id FROM accounts").all()).results).toEqual([
    { id: "sf:bank" },
  ]);
  expect((await removeAccount("sf:bank")).status).toBe(200);
  expect((await post("/sync", {})).status).toBe(400);
});
it("deletes manual accounts and requires an authenticated request", async () => {
  const created = (await (
    await post("/accounts", { name: "Manual" })
  ).json()) as { id: string };
  await post("/transactions", {
    account_id: created.id,
    posted: "2026-10-01",
    amount: -100,
    type: "expense",
    description: "Manual purchase",
  });
  const anonymous = await mf.dispatchFetch(
    "http://localhost/api/accounts/" + created.id,
    {
      method: "DELETE",
      headers: {
        Origin: "http://localhost",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ confirmation: "DELETE ACCOUNT" }),
    },
  );
  expect(anonymous.status).toBe(401);
  expect((await removeAccount(created.id)).status).toBe(200);
  expect(
    (await db.prepare("SELECT COUNT(*) AS count FROM transactions").first())
      ?.count,
  ).toBe(0);
  expect(
    (await db.prepare("SELECT COUNT(*) AS count FROM accounts").first())?.count,
  ).toBe(0);
  expect((await removeAccount(created.id)).status).toBe(404);
});
