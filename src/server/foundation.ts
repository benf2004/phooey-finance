import type { Ledger } from "./ledger";
import type { FoundationData, Entry } from "../shared/foundation";
import { assert } from "./util";

export async function foundationData(
  ledger: Ledger,
  year: number,
): Promise<FoundationData> {
  const db = ledger.db,
    from = year + "-01-01",
    until = year + 1 + "-01-01";
  const [entries, history, budgets, accounts, categories, rules] =
    await Promise.all([
      db
        .prepare(
          `SELECT e.posted,t.description,e.amount,e.type,coalesce(c.name,'') category,a.name account,e.currency,
 CASE WHEN e.type IN ('income','expense') AND coalesce(c.tax_treatment,'personal') NOT IN ('excluded','tax_payment') AND
 (c.tax_treatment IN ('business_income','business_expense') OR EXISTS(SELECT 1 FROM json_each(t.tags) WHERE value='Business' COLLATE NOCASE)) THEN 1 ELSE 0 END business
 FROM ledger_entries e JOIN transactions t ON t.id=e.transaction_id JOIN accounts a ON a.id=e.account_id LEFT JOIN categories c ON c.id=e.category_id
 WHERE e.deleted=0 AND e.pending=0 AND a.archived=0 AND e.posted>=? AND e.posted<? ORDER BY e.posted DESC,e.id LIMIT 5001`,
        )
        .bind(from, until)
        .all<Entry>(),
      db
        .prepare(
          "SELECT b.captured_at,a.name,a.currency,b.balance FROM balance_snapshots b JOIN accounts a ON a.id=b.account_id WHERE a.archived=0 AND b.captured_at>=? AND b.captured_at<? ORDER BY b.captured_at DESC,b.id LIMIT 5001",
        )
        .bind(from, until)
        .all<FoundationData["history"][number]>(),
      db
        .prepare("SELECT key,value FROM settings WHERE key LIKE ?")
        .bind("budget/" + year + "/%")
        .all<{ key: string; value: string }>(),
      ledger.accounts(),
      ledger.categories(),
      ledger.rules(),
    ]);
  assert(
    entries.results.length <= 5000 && history.results.length <= 5000,
    413,
    "This workbook supports 5,000 posted allocations and balance observations per year.",
  );
  return {
    year,
    entries: entries.results,
    history: history.results,
    accounts,
    categories,
    budgets: Object.fromEntries(
      budgets.results.map((b) => [
        b.key.slice(("budget/" + year + "/").length),
        Number(b.value),
      ]),
    ),
    rules: rules.map((r) => ({
      ...r,
      category: categories.find((c) => c.id === r.category_id)?.name || "",
    })),
  };
}
