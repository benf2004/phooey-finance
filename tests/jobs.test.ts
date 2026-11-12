import { resetData, cleanupFiles } from "../src/server/reset";
import { categoryFixtures } from "./fixtures";
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { readFile, readdir } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { Ledger } from "../src/server/ledger";
import { encrypt, type AppEnv } from "../src/server/auth";
import {
  queueImport,
  importChunk,
  backup,
  restore,
  queueExport,
  exportChunk,
  exportDownload,
} from "../src/server/files";
import {
  connectSimplefin,
  selectSimplefinAccounts,
  claimJob,
  requestSync,
  syncWindow,
} from "../src/server/sync";
import { parseCSV } from "../src/shared/csv";
import { addPayment } from "../src/server/taxes";
let mf: Miniflare, env: AppEnv, ledger: Ledger;
const sent: string[] = [];
beforeEach(async () => {
  mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: 'export default {fetch(){return new Response("ok")}}',
      d1Databases: { DB: "jobs" },
      r2Buckets: ["FILES"],
      bindings: { ENCRYPTION_KEY: randomBytes(32).toString("base64") },
    }),
  );
  env = await mf.getBindings<AppEnv>();
  env.JOBS = {
    send: async (body) => {
      sent.push((body as { jobId: string }).jobId);
      return {
        metadata: { metrics: { backlogCount: sent.length, backlogBytes: 0 } },
      };
    },
    sendBatch: async () => ({
      metadata: { metrics: { backlogCount: sent.length, backlogBytes: 0 } },
    }),
    metrics: async () => ({ backlogCount: sent.length, backlogBytes: 0 }),
  };
  for (const file of (await readdir("migrations")).sort())
    await env.DB.exec(
      (await readFile("migrations/" + file, "utf8")).replaceAll("\n", " "),
    );
  await env.DB.exec(categoryFixtures.replaceAll("\n", " "));
  ledger = new Ledger(env.DB);
  sent.length = 0;
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await mf.dispose();
});
async function run(id: string) {
  const job = await claimJob(env, id);
  expect(job).toBeTruthy();
  const payload = JSON.parse(job!.payload);
  if (job!.kind === "import") await importChunk(env, id, payload);
  if (job!.kind === "export") await exportChunk(env, id, payload);
  if (job!.kind === "cleanup") await cleanupFiles(env, id, payload);
  if (job!.kind === "sync") await syncWindow(env, id, payload);
  return env.DB.prepare("SELECT * FROM jobs WHERE id=?")
    .bind(id)
    .first<{ status: string; payload: string }>();
}
async function account() {
  return (await ledger.saveAccount({ name: "Test bank" })).id;
}
async function connection(generation = "one") {
  await env.DB.prepare(
    "INSERT INTO connections(id,secret,generation,selected_accounts,selection_ready) VALUES('simplefin',?,?, '[\"bank1\"]',1) ON CONFLICT(id) DO UPDATE SET generation=excluded.generation,secret=excluded.secret,last_success=NULL",
  )
    .bind(
      await encrypt(
        env,
        "https://demo:secret@beta-bridge.simplefin.org/simplefin",
      ),
      generation,
    )
    .run();
}
const providerData = (count = 205) => ({
  accounts: [
    {
      id: "bank1",
      name: "Checking",
      currency: "USD",
      balance: "1000.00",
      "balance-date": 1794000000,
      transactions: Array.from({ length: count }, (_, i) => ({
        id: "provider-" + i,
        posted: 1793000000,
        amount: "-10.00",
        description: "Store " + i,
        pending: i === 0,
      })),
    },
  ],
});
describe("durable jobs and recovery", () => {
  it("removes unused legacy defaults while preserving used and customized categories", async () => {
    const a = await account();
    await ledger.saveTransaction({
      account_id: a,
      posted: "2026-01-01",
      amount: -100,
      description: "Used category",
      type: "expense",
      category_id: "office",
    });
    await env.DB.exec(
      "INSERT INTO categories(id,name,type,tax_treatment,color) VALUES('salary','Custom salary name','income','personal','#28634a'),('tax','Tax payments','expense','tax_payment','#b88a43')",
    );
    await ledger.saveCategory(
      {
        name: "Tax payments",
        type: "expense",
        tax_treatment: "tax_payment",
        color: "#b88a43",
      },
      "tax",
    );
    await env.DB.exec(
      (
        await readFile("migrations/0004_remove_default_categories.sql", "utf8")
      ).replaceAll("\n", " "),
    );
    expect((await ledger.categories()).map((c) => c.id).sort()).toEqual([
      "office",
      "salary",
      "tax",
    ]);
  });
  it.skipIf(!process.env.SIMPLEFIN_LIVE)(
    "connects to the official SimpleFIN demo service",
    async () => {
      const html = await (
        await fetch("https://beta-bridge.simplefin.org/info/developers")
      ).text();
      const token = html.match(/aHR0cHM6Ly9[A-Za-z0-9+/=]+/)?.[0];
      expect(token).toBeTruthy();
      const connection = await connectSimplefin(env, token!);
      expect(connection!.accounts.length).toBeGreaterThan(0);
      expect((await ledger.accounts()).length).toBe(0);
      await selectSimplefinAccounts(env, {
        generation: connection!.generation,
        accountIds: [connection!.accounts[0].id],
      });
      const job = await requestSync(env);
      let complete = false;
      for (let i = 0; i < 15; i++) {
        const result = await run(job.jobId);
        if (result?.status === "complete") {
          complete = true;
          break;
        }
      }
      expect(complete).toBe(true);
      expect((await ledger.accounts()).length).toBeGreaterThan(0);
      expect((await ledger.transactions()).total).toBeGreaterThan(0);
    },
    60000,
  );
  it("resumes an interrupted import and refuses incomplete portable backups", async () => {
    const account_id = await account();
    await ledger.saveRule({
      name: "Office imports",
      pattern: "Row",
      category_id: "office",
      direction: "out",
    });
    const input = {
      name: "bank.csv",
      account_id,
      text:
        "Date,Description,Amount\n" +
        Array.from({ length: 65 }, (_, i) => `2026-01-01,Row ${i},-1.00`).join(
          "\n",
        ),
      mapping: {
        date: 0,
        description: 1,
        amount: 2,
        dateFormat: "iso",
        invert: false,
      },
    };
    const job = await queueImport(env, input, []);
    await run(job.jobId!);
    expect((await ledger.transactions()).total).toBe(50);
    await expect(backup(ledger)).rejects.toThrow("Finish or resume");
    await env.DB.prepare("UPDATE jobs SET status='failed' WHERE id=?")
      .bind(job.jobId)
      .run();
    const resumed = await queueImport(env, input, []);
    expect(resumed.resumed).toBe(true);
    expect((await run(resumed.jobId!))!.status).toBe("complete");
    expect((await ledger.transactions()).total).toBe(65);
    expect(
      (await ledger.transactions()).items.every(
        (t) => t.category_id === "office",
      ),
    ).toBe(true);
    expect(
      (
        await ledger.previewRule({
          name: "Preview",
          pattern: "Row",
          category_id: "office",
        })
      ).total,
    ).toBe(65);
    expect((await queueImport(env, input, [])).alreadyImported).toBe(true);
    expect((await backup(ledger)).tables.transactions).toHaveLength(65);
  });
  it("exports over a thousand rows in resumable chunks with one header", async () => {
    const a = await account();
    await env.DB.prepare(
      "INSERT INTO transactions(id,account_id,posted,amount,description,type) SELECT 'tx-'||value,?,'2026-01-01',-100,'Line '||value,'expense' FROM json_each(?)",
    )
      .bind(a, JSON.stringify(Array.from({ length: 1201 }, (_, i) => i)))
      .run();
    const job = await queueExport(env, {});
    await expect(exportDownload(env, job.jobId)).rejects.toThrow(
      "not complete",
    );
    for (let i = 0; i < 3; i++) await run(job.jobId);
    const text = await new Response(
      await exportDownload(env, job.jobId),
    ).text();
    expect(text.trim().split("\r\n")).toHaveLength(1202);
    expect(text.match(/Transaction ID/g)).toHaveLength(1);
    expect(text).toContain("Line 1200");
    expect(parseCSV(text)).toHaveLength(1202);
  });
  it("imports staged provider data in bounded batches and preserves manual edits", async () => {
    await connection();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(providerData())),
    );
    const job = await requestSync(env);
    await run(job.jobId); // stage
    await run(job.jobId);
    await run(job.jobId);
    expect((await run(job.jobId))!.status).toBe("complete");
    expect((await ledger.transactions()).total).toBe(205);
    expect((await ledger.accounts())[0].kind).toBe("other");
    expect(
      (await ledger.report("2026-01-01", "2026-12-31")).groups.USD.expenses,
    ).toBe(204000);
    const tx = (await ledger.transactions({ q: "Store 1" })).items[0];
    await ledger.saveTransaction(
      { ...tx, description: "My edit", pending: !!tx.pending, reviewed: true },
      { id: tx.id, revision: tx.revision },
    );
    const again = await requestSync(env);
    for (let i = 0; i < 4; i++) await run(again.jobId);
    expect((await ledger.transaction(tx.id)).description).toBe("My edit");
    expect((await ledger.transactions()).total).toBe(205);
  });
  it("does not checkpoint old provider data after replacing a connection during fetch", async () => {
    await connection();
    let resolve!: (v: Response) => void;
    let started!: () => void;
    const startedPromise = new Promise<void>((r) => {
      started = r;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        started();
        return new Promise<Response>((r) => {
          resolve = r;
        });
      }),
    );
    const job = await requestSync(env);
    const running = run(job.jobId);
    await startedPromise;
    await connection("replacement");
    await env.DB.prepare("UPDATE jobs SET status='cancelled' WHERE id=?")
      .bind(job.jobId)
      .run();
    resolve(Response.json(providerData(1)));
    await running;
    expect(
      (
        await env.DB.prepare("SELECT status FROM jobs WHERE id=?")
          .bind(job.jobId)
          .first()
      )?.status,
    ).toBe("cancelled");
    expect((await ledger.transactions()).total).toBe(0);
    expect(
      (await env.DB.prepare("SELECT last_success FROM connections").first())
        ?.last_success,
    ).toBeNull();
  });
  it("replays payment and rule requests without duplicate writes", async () => {
    const a = await ledger.saveAccount(
      { name: "Retry", balance: 10000 },
      undefined,
      "account-retry",
    );
    expect(
      (
        await ledger.saveAccount(
          { name: "Retry", balance: 10000 },
          undefined,
          "account-retry",
        )
      ).id,
    ).toBe(a.id);
    expect(await ledger.accounts()).toHaveLength(1);
    const payment = {
      year: 2026,
      jurisdiction: "federal",
      paid_on: "2026-04-15",
      amount: 10000,
    };
    const first = await addPayment(ledger, payment, "payment-retry");
    expect((await addPayment(ledger, payment, "payment-retry")).id).toBe(
      first.id,
    );
    await expect(
      addPayment(ledger, { ...payment, amount: 20000 }, "payment-retry"),
    ).rejects.toThrow("different data");
    const rule = { name: "Store", pattern: "Store", category_id: "office" };
    const r = await ledger.saveRule(rule, undefined, "rule-retry");
    expect((await ledger.saveRule(rule, undefined, "rule-retry")).id).toBe(
      r.id,
    );
    expect(await ledger.rules()).toHaveLength(1);
  });
  it("round-trips a portable backup with splits and rejects malformed split totals atomically", async () => {
    const a = await account();
    await ledger.saveTransaction({
      account_id: a,
      posted: "2026-01-01",
      amount: -100,
      description: "Split",
      type: "expense",
      category_id: "office",
      splits: [{ amount: -100, type: "expense", category_id: "groceries" }],
    });
    expect((await ledger.transactions({ category: "office" })).total).toBe(0);
    const b = await backup(ledger);
    await env.DB.exec(
      "DELETE FROM splits; DELETE FROM transactions; DELETE FROM accounts; DELETE FROM audit;",
    );
    const invalid = structuredClone(b) as typeof b & {
      tables: { splits: { amount: number }[] };
    };
    invalid.tables.splits[0].amount = -200;
    await expect(restore(ledger, invalid)).rejects.toThrow("Split amounts");
    expect(await ledger.accounts()).toHaveLength(0);
    await restore(ledger, b);
    expect((await ledger.transactions()).total).toBe(1);
    expect(
      (await ledger.report("2026-01-01", "2026-12-31")).groups.USD.expenses,
    ).toBe(100);
  });
});

describe("settings data deletion", () => {
  async function seedResetData() {
    const accountId = await account();
    const tx = await ledger.saveTransaction({
      account_id: accountId,
      posted: "2026-10-01",
      amount: -1000,
      description: "Reset test",
      type: "expense",
      splits: [{ amount: -1000, type: "expense", category_id: "office" }],
    });
    await addPayment(ledger, {
      year: 2026,
      jurisdiction: "federal",
      paid_on: "2026-10-01",
      amount: 1000,
      transaction_id: tx.id,
    });
    await connection();
    await env.DB.exec(
      "INSERT INTO settings(key,value) VALUES('preferences','{}'); INSERT INTO imports(id,name,fingerprint) VALUES('import','test.csv','fingerprint'); INSERT INTO idempotency(key,fingerprint,response) VALUES('request','fingerprint','{}'); INSERT INTO sessions(token_hash,expires_at,credential_version) VALUES('keep',9999999999,'test'),('other',9999999999,'test'); INSERT INTO access_tokens(id,name,token_hash,scopes,expires_at) VALUES('token','test','test','[]',9999999999);",
    );
    await ledger.saveRule({
      name: "Rule",
      pattern: "Reset",
      category_id: "office",
    });
    await env.FILES.put("imports/old.csv", "old financial data");
    return accountId;
  }
  it("requires exact confirmation and refuses deletion while a job is running", async () => {
    await seedResetData();
    await expect(
      resetData(env, { scope: "everything", confirmation: "yes" }, "keep"),
    ).rejects.toMatchObject({ status: 400 });
    await env.DB.exec(
      "INSERT INTO jobs(id,kind,status,lease_until) VALUES('active','sync','running',9999999999)",
    );
    await expect(
      resetData(
        env,
        { scope: "everything", confirmation: "RESET EVERYTHING" },
        "keep",
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect((await ledger.transactions()).total).toBe(1);
  });
  it("deletes all transactions, keeps account setup and payments, and pauses sync", async () => {
    await seedResetData();
    const reset = await resetData(
      env,
      { scope: "transactions", confirmation: "DELETE TRANSACTIONS" },
      "keep",
    );
    for (const table of [
      "transactions",
      "splits",
      "imports",
      "idempotency",
      "audit",
    ])
      expect(
        (await env.DB.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first())
          ?.count,
      ).toBe(0);
    expect((await ledger.accounts()).length).toBe(1);
    expect((await ledger.categories()).length).toBe(2);
    expect((await ledger.rules()).length).toBe(1);
    expect(
      (await env.DB.prepare("SELECT transaction_id FROM tax_payments").first())
        ?.transaction_id,
    ).toBeNull();
    expect(
      await env.DB.prepare(
        "SELECT selection_ready,selected_accounts FROM connections",
      ).first(),
    ).toEqual({ selection_ready: 0, selected_accounts: "[]" });
    await expect(requestSync(env)).rejects.toMatchObject({ status: 400 });
    await run(reset.jobId);
    expect(await env.FILES.get("imports/old.csv")).toBeNull();
  });
  it("resets app data and MCP access while preserving the current admin login", async () => {
    await seedResetData();
    const reset = await resetData(
      env,
      { scope: "everything", confirmation: "RESET EVERYTHING" },
      "keep",
    );
    for (const table of [
      "transactions",
      "splits",
      "accounts",
      "categories",
      "rules",
      "balance_snapshots",
      "tax_payments",
      "settings",
      "connections",
      "access_tokens",
      "oauth_clients",
      "oauth_codes",
      "imports",
      "idempotency",
      "audit",
    ])
      expect(
        (await env.DB.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first())
          ?.count,
      ).toBe(0);
    expect(
      (await env.DB.prepare("SELECT token_hash FROM sessions").all()).results,
    ).toEqual([{ token_hash: "keep" }]);
    const payload = JSON.parse(
      (await env.DB.prepare("SELECT payload FROM jobs WHERE id=?")
        .bind(reset.jobId)
        .first<{ payload: string }>())!.payload,
    );
    while (Date.now() <= payload.cutoff)
      await new Promise((r) => setTimeout(r, 2));
    await env.FILES.put("imports/new.csv", "new data after reset");
    await run(reset.jobId);
    expect(await env.FILES.get("imports/old.csv")).toBeNull();
    expect(await (await env.FILES.get("imports/new.csv"))!.text()).toBe(
      "new data after reset",
    );
  });
});
