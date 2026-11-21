import type { Ledger } from "./ledger";
import { assert } from "./util";

// Fetch the three feed tables at one database revision. Tiller reports join on
// category names and account IDs; the workbook adapter resolves the latter.
export async function tillerFeed(ledger: Ledger, from: string) {
  const db = ledger.db;
  const [accounts, categories, transactions, balances] = await db.batch<Record<string, unknown>>([
    db.prepare(
      "SELECT id,name,institution,kind,currency,balance,balance_at FROM accounts WHERE archived=0",
    ),
    db.prepare(
      "SELECT id,name,type,tax_treatment FROM categories ORDER BY name",
    ),
    db
      .prepare(
        `SELECT t.id, t.account_id,t.posted,t.description,t.tags,t.revision,
      coalesce(s.amount,t.amount) amount, CASE WHEN s.id IS NULL THEN t.category_id ELSE s.category_id END category_id,
      coalesce(s.type,t.type) type, row_number() OVER(PARTITION BY t.id ORDER BY s.rowid)-1 part
      FROM transactions t JOIN accounts a ON a.id=t.account_id LEFT JOIN splits s ON s.transaction_id=t.id
      WHERE t.deleted=0 AND t.pending=0 AND a.archived=0 AND t.posted>=? ORDER BY t.posted,t.id,s.rowid LIMIT 5001`,
      )
      .bind(from),
    db
      .prepare(
        "SELECT b.account_id,b.balance,b.captured_at FROM balance_snapshots b JOIN accounts a ON a.id=b.account_id WHERE a.archived=0 AND b.captured_at>=? ORDER BY b.captured_at,b.id LIMIT 5001",
      )
      .bind(from),
  ]);
  assert(
    transactions.results.length <= 5000 && balances.results.length <= 5000,
    413,
    "Choose a later starting date. Each feed supports 5,000 rows per sync.",
  );
  return {
    accounts: accounts.results,
    categories: categories.results,
    transactions: transactions.results.map((t) => ({
      ...t,
      tags: JSON.parse(String(t.tags)),
    })),
    balances: balances.results,
  };
}
