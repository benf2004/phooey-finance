import {
  defaultTaxProfile,
  taxSchema,
  estimateTax,
  taxPeriods,
  type TaxProfile,
} from "../shared/tax";
import {
  dateSchema,
  tagSchema,
  paymentSchema,
  type Payment,
} from "../shared/models";
import { Ledger } from "./ledger";
import { id, assert } from "./util";
export async function taxLedger(
  ledger: Ledger,
  year: number,
  asOf: string,
  tag: string,
) {
  dateSchema.parse(asOf);
  tag = tagSchema.parse(tag);
  assert(
    asOf.startsWith(`${year}-`),
    400,
    "As-of date must be in the tax year",
  );
  const periods = taxPeriods(year);
  const rows = await ledger.db
    .prepare(
      `SELECT CASE WHEN substr(e.posted,6,5)<'04-01' THEN 1 WHEN substr(e.posted,6,5)<'06-01' THEN 2 WHEN substr(e.posted,6,5)<'09-01' THEN 3 ELSE 4 END quarter,e.currency,e.type,SUM(e.amount) amount
     FROM ledger_entries e JOIN transactions t ON t.id=e.transaction_id LEFT JOIN categories c ON c.id=e.category_id
     WHERE e.deleted=0 AND e.pending=0 AND e.account_id IN (SELECT id FROM accounts WHERE archived=0)
     AND e.posted>=? AND e.posted<=? AND e.type IN ('income','expense')
     AND COALESCE(c.tax_treatment,'personal') NOT IN ('tax_payment','excluded')
     AND EXISTS(SELECT 1 FROM json_each(t.tags) WHERE value=? COLLATE NOCASE)
     GROUP BY quarter,e.currency,e.type`,
    )
    .bind(`${year}-01-01`, asOf, tag)
    .all<{ quarter: number; currency: string; type: string; amount: number }>();
  const excludedCurrencies = new Set<string>();
  for (const row of rows.results) {
    if (row.currency !== "USD") {
      excludedCurrencies.add(row.currency);
      continue;
    }
    const period = periods[row.quarter - 1];
    if (row.type === "income") period.income += row.amount;
    else period.expenses -= row.amount;
    period.profit += row.amount;
  }
  return {
    periods,
    profit: periods.reduce((s, q) => s + q.profit, 0),
    excludedCurrencies: [...excludedCurrencies].sort(),
  };
}
export async function taxState(
  ledger: Ledger,
  year: number,
  scenario?: TaxProfile,
) {
  const saved = await ledger.db
    .prepare("SELECT value,revision FROM settings WHERE key=?")
    .bind("tax:" + year)
    .first<{ value: string; revision: number }>();
  const profile =
    scenario ??
    (saved
      ? taxSchema.parse(JSON.parse(saved.value))
      : defaultTaxProfile(year));
  const payments = (
    await ledger.db
      .prepare("SELECT * FROM tax_payments WHERE year=? ORDER BY paid_on")
      .bind(year)
      .all<Payment>()
  ).results;
  const { periods, profit, excludedCurrencies } = await taxLedger(
    ledger,
    year,
    profile.asOf,
    profile.transactionTag,
  );
  return {
    profile,
    revision: saved?.revision ?? 0,
    payments,
    ledgerProfit: profit,
    periods,
    excludedCurrencies,
    estimate: estimateTax(profile, payments, profit, periods),
  };
}
export async function saveTax(
  ledger: Ledger,
  input: unknown,
  revision: number,
) {
  const profile = taxSchema.parse(input);
  const key = "tax:" + profile.year;
  const guard = id();
  await ledger.db.batch([
    ledger.db
      .prepare(
        "INSERT INTO write_guards VALUES(?,COALESCE((SELECT revision FROM settings WHERE key=?),0)=?)",
      )
      .bind(guard, key, revision),
    ledger.db
      .prepare(
        "INSERT INTO settings(key,value,revision) VALUES(?,?,1) ON CONFLICT(key) DO UPDATE SET value=excluded.value,revision=settings.revision+1",
      )
      .bind(key, JSON.stringify(profile)),
    ledger.auditStatement("tax.save", key, null, profile),
    ledger.db.prepare("DELETE FROM write_guards WHERE id=?").bind(guard),
  ]);
  return taxState(ledger, profile.year);
}
export async function addPayment(ledger: Ledger, input: unknown, key?: string) {
  const data = paymentSchema.parse(input);
  const request = await ledger.prepareRequest<Payment>(
    "tax.payment",
    data,
    key,
  );
  if (request.prior) return request.prior;
  if (data.transaction_id) {
    const tx = await ledger.transaction(data.transaction_id);
    assert(
      tx.currency === "USD" && tx.amount === -data.amount && !tx.pending,
      400,
      "Payment must match a posted USD outflow",
    );
  }
  const paymentId = id();
  await ledger.db.batch([
    ledger.db
      .prepare(
        "INSERT INTO tax_payments(id,year,jurisdiction,paid_on,amount,notes,transaction_id) VALUES(?,?,?,?,?,?,?)",
      )
      .bind(
        paymentId,
        data.year,
        data.jurisdiction,
        data.paid_on,
        data.amount,
        data.notes,
        data.transaction_id,
      ),
    ledger.auditStatement("tax.payment", paymentId, null, data),
    ...request.statements({ id: paymentId, ...data }),
  ]);
  return { id: paymentId, ...data };
}
