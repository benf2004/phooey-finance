import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AppEnv } from "../src/server/auth";
import { rateLimit } from "../src/server/auth";
import { fetchSimplefinAccounts } from "../src/server/sync";
import { checkSyncHistory } from "../src/server/sync-history";
import { historyFinding } from "../src/shared/sync-history";
import { BankHistoryCheck } from "../src/client/pages/BankHistoryCheck";

vi.mock("../src/server/auth", async (original) => ({
  ...(await original<typeof import("../src/server/auth")>()),
  rateLimit: vi.fn(),
}));
vi.mock("../src/server/sync", async (original) => ({
  ...(await original<typeof import("../src/server/sync")>()),
  fetchSimplefinAccounts: vi.fn(),
}));

const tx = (id: string, date: string, pending = false) => ({
  id,
  posted: Date.parse(date) / 1000,
  amount: "-10.00",
  description: "Test",
  pending,
});
const account = (transactions: ReturnType<typeof tx>[]) => ({
  id: "bank",
  name: "Checking",
  currency: "USD",
  balance: "10.00",
  "balance-date": Date.parse("2026-11-23") / 1000,
  transactions,
});
let env: AppEnv;
let generation: string;
let active: boolean;
let stored: Set<string>;
let writes: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-23T12:00:00Z"));
  vi.clearAllMocks();
  generation = "original";
  active = false;
  stored = new Set(["recent"]);
  writes = vi.fn();
  env = {
    DB: {
      batch: writes,
      prepare: (sql: string) => {
        let args: unknown[] = [];
        const statement = {
          bind: (...values: unknown[]) => {
            args = values;
            return statement;
          },
          run: writes,
          first: async () => {
            if (sql.includes("SELECT secret"))
              return {
                secret: "encrypted",
                generation: "original",
                selection_ready: 1,
                selected_accounts: '["bank"]',
                available_accounts: '[{"id":"bank","name":"Checking"}]',
              };
            if (sql.includes("FROM jobs"))
              return active ? { id: "sync" } : null;
            if (sql.includes("SELECT generation")) return { generation };
            if (sql.includes("COUNT(*)")) {
              expect(args[0]).toBe("sf:bank");
              const ids: string[] = JSON.parse(args[1] as string);
              return { count: ids.filter((id) => stored.has(id)).length };
            }
            throw new Error("Unexpected query: " + sql);
          },
        };
        return statement;
      },
    },
  } as unknown as AppEnv;
  vi.mocked(fetchSimplefinAccounts)
    .mockReset()
    .mockResolvedValueOnce({ accounts: [account([tx("older", "2025-12-01")])] })
    .mockResolvedValueOnce({
      accounts: [account([tx("recent", "2026-11-01")])],
    });
});
afterEach(() => vi.useRealTimers());

describe("direct provider history check", () => {
  it("checks the selected older period and recent control, comparing provider IDs without importing", async () => {
    const result = await checkSyncHistory(env, "2025-11-23");
    expect(fetchSimplefinAccounts).toHaveBeenCalledTimes(2);
    const params = vi
      .mocked(fetchSimplefinAccounts)
      .mock.calls.map((call) => call[2]);
    expect(params[0].get("start-date")).toBe(
      String(Date.parse("2025-11-23") / 1000),
    );
    for (const sample of params) {
      expect(
        Number(sample.get("end-date")) - Number(sample.get("start-date")),
      ).toBeLessThanOrEqual(45 * 86400);
      expect(sample.getAll("account")).toEqual(["bank"]);
      expect(sample.has("pending")).toBe(false);
    }
    expect(Number(params[1].get("end-date"))).toBe(Date.now() / 1000 + 1);
    expect(result.samples[0].accounts[0]).toMatchObject({
      count: 1,
      missingFromLedger: 1,
      oldest: "2025-12-01",
    });
    expect(result.samples[1].accounts[0]).toMatchObject({
      count: 1,
      missingFromLedger: 0,
    });
    expect(historyFinding(result, "bank")).toContain(
      "not limiting this account to 90 days",
    );
    expect(rateLimit).toHaveBeenCalledWith(env.DB, "history-check", 2, 3600);
    expect(writes).not.toHaveBeenCalled();
    const html = renderToStaticMarkup(
      createElement(BankHistoryCheck, { check: result }),
    );
    expect(html).toContain("1 missing from ledger");
    expect(html).toContain("no transactions changed");
  });

  it("identifies already imported older history", async () => {
    stored.add("older");
    const result = await checkSyncHistory(env, "2025-11-23");
    expect(historyFinding(result, "bank")).toContain("already in your ledger");
  });

  it("treats an empty older sample as evidence, not proof of a precise cutoff", async () => {
    vi.mocked(fetchSimplefinAccounts)
      .mockReset()
      .mockResolvedValueOnce({ accounts: [account([])] })
      .mockResolvedValueOnce({
        accounts: [account([tx("recent", "2026-11-01")])],
      });
    const result = await checkSyncHistory(env, "2025-11-23");
    expect(historyFinding(result, "bank")).toContain(
      "If your bank statement shows activity",
    );
    expect(historyFinding(result, "bank")).toContain(
      "does not prove an exact 90-day cutoff",
    );
  });

  it.each(["omitted", "warning", "empty", "out-of-range"])(
    "reports %s responses as inconclusive",
    async (scenario) => {
      vi.mocked(fetchSimplefinAccounts)
        .mockReset()
        .mockResolvedValueOnce({
          accounts:
            scenario === "omitted"
              ? []
              : [
                  account(
                    scenario === "out-of-range"
                      ? [tx("recent", "2026-11-01")]
                      : [],
                  ),
                ],
          errlist:
            scenario === "warning"
              ? [
                  {
                    code: "act.missingdata",
                    msg: "Incomplete transaction listing",
                  },
                ]
              : [],
        })
        .mockResolvedValueOnce({
          accounts: [
            account(scenario === "empty" ? [] : [tx("recent", "2026-11-01")]),
          ],
        });
      const result = await checkSyncHistory(env, "2025-11-23");
      expect(historyFinding(result, "bank")).toContain("Inconclusive");
      expect(result.samples[0].accounts[0].count).toBe(0);
    },
  );

  it("ignores pending transactions and unselected accounts", async () => {
    vi.mocked(fetchSimplefinAccounts)
      .mockReset()
      .mockResolvedValue({
        accounts: [
          account([tx("pending", "2025-12-01", true)]),
          { ...account([tx("personal", "2025-12-01")]), id: "personal" },
        ],
      });
    const result = await checkSyncHistory(env, "2025-11-23");
    expect(result.samples[0].accounts).toHaveLength(1);
    expect(result.samples[0].accounts[0].count).toBe(0);
  });

  it("rejects changed connections, active syncs and invalid dates", async () => {
    generation = "changed";
    await expect(checkSyncHistory(env, "2025-11-23")).rejects.toThrow(
      "Connection changed",
    );
    vi.mocked(fetchSimplefinAccounts).mockClear();
    active = true;
    await expect(checkSyncHistory(env, "2025-11-23")).rejects.toThrow(
      "Wait for the current sync",
    );
    for (const date of ["1969-12-31", "2026-11-01", "2027-01-01", "2026-02-30"])
      await expect(checkSyncHistory(env, date)).rejects.toThrow();
    expect(fetchSimplefinAccounts).not.toHaveBeenCalled();
  });
});
