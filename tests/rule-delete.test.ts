import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { readFile, readdir } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { hash } from "bcryptjs";
import { Ledger } from "../src/server/ledger";
import type { AppEnv } from "../src/server/auth";

let mf: Miniflare, ledger: Ledger, cookie: string;
let accountId: string, categoryId: string, ruleId: string;
const origin = "http://127.0.0.1";
const input = {
  posted: "2026-01-02",
  amount: -1250,
  description: "Synthetic rule deletion purchase",
  type: "expense",
  notes: "Keep this note",
  tags: ["Personal"],
};

function remove(id = ruleId, headers: Record<string, string> = {}) {
  return mf.dispatchFetch(`${origin}/api/rules/${id}`, {
    method: "DELETE",
    headers: { Cookie: cookie, Origin: origin, ...headers },
  });
}
beforeEach(async () => {
  mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      scriptPath: "dist/phooey_finance/index.js",
      compatibilityDate: "2026-11-12",
      compatibilityFlags: ["nodejs_compat"],
      d1Databases: { DB: "rule-delete-test" },
      r2Buckets: ["FILES"],
      queueProducers: { JOBS: "jobs" },
      bindings: {
        ADMIN_USERNAME: "admin",
        ADMIN_PASSWORD_HASH: await hash("synthetic-test-password", 4),
        ENCRYPTION_KEY: randomBytes(32).toString("base64"),
      },
    }),
  );
  const env = await mf.getBindings<AppEnv>();
  ledger = new Ledger(env.DB);
  for (const file of (await readdir("migrations")).sort()) {
    await env.DB.exec(
      (await readFile("migrations/" + file, "utf8")).replaceAll("\n", " "),
    );
  }
  const login = await mf.dispatchFetch(`${origin}/api/login`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({
      username: "admin",
      password: "synthetic-test-password",
    }),
  });
  expect(login.status).toBe(200);
  cookie = login.headers.get("Set-Cookie")!.split(";")[0];
  accountId = (await ledger.saveAccount({ name: "Synthetic account" })).id;
  categoryId = (
    await ledger.saveCategory({ name: "Synthetic category", type: "expense" })
  ).id;
  ruleId = (
    await ledger.saveRule({
      name: "Synthetic rule",
      pattern: "Synthetic rule deletion",
      category_id: categoryId,
    })
  ).id;
});
afterEach(async () => await mf?.dispose());

describe("rule deletion", () => {
  it("requires an authenticated session and same-origin mutation", async () => {
    expect((await remove(ruleId, { Cookie: "" })).status).toBe(401);
    expect((await remove(ruleId, { Origin: "https://evil.test" })).status).toBe(
      403,
    );
    expect((await ledger.rules()).map((r) => r.id)).toContain(ruleId);
  });

  it("preserves transactions, splits and categories while removing only the deleted rule's references", async () => {
    const tx = await ledger.saveTransaction(
      { ...input, account_id: accountId },
      { auto: true, source: "csv" },
    );
    const split = await ledger.saveTransaction({
      ...input,
      account_id: accountId,
      splits: [{ amount: -1250, category_id: categoryId, type: "expense" }],
    });
    // Cover historical references on split and soft-deleted transactions too.
    await ledger.db
      .prepare("UPDATE transactions SET rule_id=?,deleted=1 WHERE id=?")
      .bind(ruleId, split.id)
      .run();
    const otherRule = await ledger.saveRule({
      name: "Other rule",
      pattern: "Other purchase",
      category_id: categoryId,
    });
    await ledger.saveTransaction(
      { ...input, account_id: accountId, description: "Other purchase" },
      { auto: true },
    );
    const before = (
      await ledger.db.prepare("SELECT * FROM transactions ORDER BY id").all()
    ).results;
    const splitsBefore = (
      await ledger.db.prepare("SELECT * FROM splits ORDER BY id").all()
    ).results;
    const categoryBefore = await ledger.categories();
    const headers = { "Idempotency-Key": "delete-rule-retry" };
    const response = await remove(ruleId, headers);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ deleted: true });
    // A lost response can be retried without duplicating the mutation or audit.
    expect((await remove(ruleId, headers)).status).toBe(200);
    expect((await ledger.rules()).map((r) => r.id)).toEqual([otherRule.id]);
    const after = (
      await ledger.db.prepare("SELECT * FROM transactions ORDER BY id").all()
    ).results;
    expect(after).toEqual(
      before.map((row) =>
        row.rule_id === ruleId
          ? { ...row, rule_id: null, revision: Number(row.revision) + 1 }
          : row,
      ),
    );
    expect(
      (await ledger.db.prepare("SELECT * FROM splits ORDER BY id").all())
        .results,
    ).toEqual(splitsBefore);
    expect(await ledger.categories()).toEqual(categoryBefore);
    expect((await ledger.transaction(tx.id)).category_id).toBe(categoryId);
    const audits = (
      await ledger.db
        .prepare("SELECT * FROM audit WHERE action='rule.delete'")
        .all()
    ).results;
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actor: "admin",
      entity_id: ruleId,
      after_json: null,
    });
    expect(JSON.parse(String(audits[0].before_json))).toMatchObject({
      id: ruleId,
      name: "Synthetic rule",
    });
  });

  it("stops future automatic categorization and rejects missing-rule edits and applies", async () => {
    const first = await ledger.saveTransaction(
      { ...input, account_id: accountId },
      { auto: true, source: "csv" },
    );
    expect(
      await ledger.db.prepare("SELECT rule_id FROM transactions WHERE id=?")
        .bind(first.id).first(),
    ).toEqual({ rule_id: ruleId });
    expect((await remove()).status).toBe(200);
    const next = await ledger.saveTransaction(
      { ...input, account_id: accountId },
      { auto: true, source: "csv" },
    );
    expect(await ledger.transaction(next.id)).toMatchObject({
      rule_id: null,
      category_id: null,
    });
    await expect(ledger.applyRule(ruleId, [next])).rejects.toThrow(
      "Rule not found",
    );
    await expect(
      ledger.saveRule(
        { name: "Stale editor", pattern: "Synthetic", category_id: categoryId },
        ruleId,
      ),
    ).rejects.toThrow("Rule not found");
    expect((await remove()).status).toBe(404);
    expect((await remove("missing-rule")).status).toBe(404);
  });

  it("rolls back reference cleanup if the rule cannot be deleted", async () => {
    const tx = await ledger.saveTransaction(
      { ...input, account_id: accountId },
      { auto: true },
    );
    const before = await ledger.transaction(tx.id);
    await ledger.db.exec(
      "CREATE TRIGGER block_rule_delete BEFORE DELETE ON rules BEGIN SELECT RAISE(ABORT,'Synthetic deletion failure'); END;",
    );
    expect((await remove()).status).toBe(500);
    expect(await ledger.transaction(tx.id)).toEqual(before);
    expect((await ledger.rules()).map((r) => r.id)).toContain(ruleId);
    expect(
      (
        await ledger.db
          .prepare("SELECT * FROM audit WHERE action='rule.delete'")
          .all()
      ).results,
    ).toEqual([]);
  });
});
