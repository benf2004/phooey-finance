import {
  defaultTaxProfile,
  taxSchema,
  estimateTax,
  type TaxProfile,
} from "../shared/tax";
import { paymentSchema, type Payment } from "../shared/models";
import { Ledger } from "./ledger";
import { id, assert } from "./util";
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
  const report = await ledger.report(`${year}-01-01`, profile.asOf);
  const usd = report.groups.USD;
  const profit = (usd?.businessIncome ?? 0) - (usd?.businessExpenses ?? 0);
  return {
    profile,
    revision: saved?.revision ?? 0,
    payments,
    ledgerProfit: profit,
    excludedCurrencies: report.currencies.filter((c) => c !== "USD"),
    estimate: estimateTax(profile, payments, profit),
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
