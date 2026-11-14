import { useEffect, useState } from "react";
import { Save, Plus, Trash2, Calculator, ArrowUpRight } from "lucide-react";
import { useWorkspace } from "../context";
import { api, post, useSubmit } from "../api";
import {
  Button,
  Field,
  MoneyInput,
  Modal,
  PageHeading,
  Panel,
  ErrorNotice,
  Loading,
  useAsync,
} from "../ui";
import { estimateTax, federalPreset, type TaxProfile } from "../../shared/tax";
import { formatMoney, today } from "../../shared/money";
import type { taxState, taxLedger } from "../../server/taxes";
type State = Awaited<ReturnType<typeof taxState>>;
export default function Taxes() {
  const { version, refresh, notify } = useWorkspace();
  const [year, setYear] = useState(() => {
      const value = Number(new URLSearchParams(location.search).get("year"));
      return value >= 2000 && value <= 2100
        ? value
        : Number(today().slice(0, 4));
    }),
    [profile, setProfile] = useState<TaxProfile | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null),
    [payment, setPayment] = useState(false),
    [tab, setTab] = useState("plan");
  const state = useAsync(() => api<State>("/taxes/" + year), [year, version]);
  const tags = useAsync(() => api<string[]>("/tags"), [version]);
  useEffect(() => {
    if (state.data) setProfile({ ...state.data.profile, mode: "quarterly" });
  }, [state.data]);
  const profitReport = useAsync(async () => {
    if (!profile) return null;
    const report = await api<Awaited<ReturnType<typeof taxLedger>>>(
      `/taxes/${year}/ledger?${new URLSearchParams({ asOf: profile.asOf, tag: profile.transactionTag })}`,
    );
    return {
      year,
      asOf: profile.asOf,
      tag: profile.transactionTag,
      version,
      ...report,
    };
  }, [year, profile?.asOf, profile?.transactionTag, version]);
  const freshProfit =
    profitReport.data?.year === year &&
    profitReport.data?.asOf === profile?.asOf &&
    profitReport.data?.tag === profile?.transactionTag &&
    profitReport.data?.version === version &&
    !profitReport.loading &&
    !profitReport.error;
  const ledgerProfit = freshProfit ? profitReport.data!.profit : 0;
  if (!profile || !state.data)
    return (
      <>
        <ErrorNotice error={state.error} />
        <Loading />
      </>
    );
  const p = profile;
  const set = <K extends keyof TaxProfile>(key: K, value: TaxProfile[K]) =>
    setProfile((old) => (old ? { ...old, [key]: value } : old));
  let result: ReturnType<typeof estimateTax> | null = null,
    calculationError: string | null = null;
  try {
    if (!freshProfit) {
      calculationError = profitReport.error ?? "Updating ledger totals…";
    } else
      result = estimateTax(
        p,
        state.data.payments,
        ledgerProfit,
        profitReport.data!.periods,
      );
  } catch {
    calculationError =
      "Finish entering valid rates and dates to update the estimate.";
  }
  const money = (key: keyof TaxProfile, label: string, hint?: string) => (
    <Field label={label} hint={hint}>
      <MoneyInput
        value={Number(p[key] ?? 0)}
        onChange={(v) => set(key, v as never)}
      />
    </Field>
  );
  async function save(e?: React.FormEvent) {
    e?.preventDefault();
    const form = document.getElementById(
      "tax-plan-form",
    ) as HTMLFormElement | null;
    if (calculationError || (form && !form.reportValidity())) return;
    setBusy(true);
    setError(null);
    try {
      await post(
        "/taxes/" + year,
        { profile: p, revision: state.data!.revision },
        "PUT",
      );
      notify("Tax plan saved");
      refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <PageHeading
        title="Quarterly taxes"
        actions={
          <>
            <select
              aria-label="Tax year"
              value={year}
              style={{ width: 100 }}
              onChange={(e) => {
                setProfile(null);
                setYear(Number(e.target.value));
              }}
            >
              {[...new Set([year, 2025, 2026, 2027, 2028])].sort().map((y) => (
                <option key={y}>{y}</option>
              ))}
            </select>
            <Button
              busy={busy}
              disabled={!!calculationError}
              onClick={() => void save()}
            >
              <Save size={15} />
              Save plan
            </Button>
          </>
        }
      />
      <ErrorNotice error={error ?? state.error ?? calculationError} />
      {freshProfit && profitReport.data!.excludedCurrencies.length > 0 && (
        <div className="notice">
          Tax estimates use USD only. Excluded currencies:{" "}
          {profitReport.data!.excludedCurrencies.join(", ")}.
        </div>
      )}
      <div className="tabs">
        <button
          className={tab === "plan" ? "active" : ""}
          onClick={() => setTab("plan")}
        >
          Estimate
        </button>
        <button
          className={tab === "rates" ? "active" : ""}
          onClick={() => setTab("rates")}
        >
          Rates & assumptions
        </button>
        <button
          className={tab === "payments" ? "active" : ""}
          onClick={() => setTab("payments")}
        >
          Payments
        </button>
      </div>
      {tab === "plan" && (
        <Panel title="Transactions to include">
          <div className="panel-body form-stack">
            <div className="field-row">
              <Field label="Include transactions tagged">
                <select
                  value={p.transactionTag}
                  onChange={(e) => set("transactionTag", e.target.value)}
                >
                  {[
                    ...new Set([
                      "Business",
                      ...(tags.data ?? []),
                      p.transactionTag,
                    ]),
                  ].map((tag) => (
                    <option key={tag} value={tag}>
                      {tag}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Ledger as-of date">
                <input
                  type="date"
                  value={p.asOf}
                  min={`${year}-01-01`}
                  max={`${year}-12-31`}
                  onChange={(e) => set("asOf", e.target.value)}
                />
              </Field>
            </div>
            <div className="notice">
              {p.transactionTag} profit through {p.asOf}:{" "}
              <strong>
                {freshProfit ? formatMoney(ledgerProfit) : "Unavailable"}
              </strong>
              . Uses actual transactions in Tiller's four tax periods. No future
              earnings are projected.
            </div>
          </div>
        </Panel>
      )}
      {tab === "payments" ? (
        <Panel
          title="Payments"
          action={
            <Button variant="secondary" onClick={() => setPayment(true)}>
              <Plus size={15} />
              Record payment
            </Button>
          }
        >
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Jurisdiction</th>
                  <th>Notes</th>
                  <th className="align-right">Amount</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {state.data.payments.map((t) => (
                  <tr key={t.id}>
                    <td>{t.paid_on}</td>
                    <td>{t.jurisdiction}</td>
                    <td>{t.notes}</td>
                    <td className="align-right money">
                      {formatMoney(t.amount)}
                    </td>
                    <td>
                      <button
                        className="icon-button"
                        aria-label="Delete payment"
                        onClick={async () => {
                          if (!confirm("Remove this payment record?")) return;
                          try {
                            await post("/tax-payments/" + t.id, {}, "DELETE");
                            refresh();
                          } catch (e) {
                            setError((e as Error).message);
                          }
                        }}
                      >
                        <Trash2 size={15} />
                      </button>
                    </td>
                  </tr>
                ))}
                {!state.data.payments.length && (
                  <tr>
                    <td colSpan={5} className="muted">
                      No payments recorded for {year}.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </Panel>
      ) : (
        <div className="tax-layout">
          <details
            className="panel tax-inputs"
            key={tab}
            open={tab === "rates" ? true : undefined}
          >
            <summary>
              <span>
                {tab === "plan" ? "Income & deductions" : "Rates & assumptions"}
              </span>
              <span className="disclosure-hint">Edit</span>
            </summary>
            <form
              id="tax-plan-form"
              className="panel-body form-stack"
              onSubmit={save}
              onInvalidCapture={(event) => {
                const disclosure = event.currentTarget.closest("details");
                if (disclosure) disclosure.open = true;
              }}
            >
              {tab === "plan" ? (
                <>
                  <div className="field-row">
                    {money(
                      "otherIncome",
                      "Other taxable income to date",
                      "Gross income before withholding; allocated evenly across started periods.",
                    )}
                    {money(
                      "adjustments",
                      "Federal income adjustments",
                      "Signed adjustment; negative reduces income.",
                    )}
                  </div>
                  <div className="field-row">
                    {money("deduction", "Annual federal deduction")}
                    {money("credits", "Federal tax credits")}
                  </div>
                  <div className="field-row">
                    {money("withholding", "Federal withholding to date")}
                    {money("stateWithholding", "State withholding to date")}
                  </div>
                  <div className="field-row">
                    {money("stateDeduction", "Annual state deduction")}
                    {money("stateCredits", "State credits")}
                  </div>
                  {money("stateAdjustments", "State income adjustments")}
                  <label className="checkbox-label">
                    <input
                      type="checkbox"
                      checked={p.selfEmployment}
                      onChange={(e) => set("selfEmployment", e.target.checked)}
                    />
                    Include self-employment tax
                  </label>
                  {p.selfEmployment &&
                    money(
                      "ssWages",
                      "Wages already subject to Social Security",
                      "Reduces the remaining wage base.",
                    )}
                </>
              ) : (
                <>
                  <Field label="Filing status">
                    <select
                      value={p.filingStatus}
                      onChange={(e) =>
                        set(
                          "filingStatus",
                          e.target.value as TaxProfile["filingStatus"],
                        )
                      }
                    >
                      <option value="single">Single</option>
                      <option value="joint">Married filing jointly</option>
                      <option value="separate">
                        Married filing separately
                      </option>
                      <option value="head">Head of household</option>
                    </select>
                  </Field>
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() =>
                      setProfile({ ...p, ...federalPreset(p.filingStatus) })
                    }
                  >
                    Load 2026 federal rates
                  </Button>
                  <div className="notice">
                    Changing filing status does not overwrite customized
                    brackets. Load the preset to update brackets, the standard
                    deduction, and the additional Medicare threshold together.
                    Verify any year other than 2026.
                  </div>
                  <h3>Federal graduated rates</h3>
                  <BracketEditor
                    value={p.federalBrackets}
                    onChange={(v) => set("federalBrackets", v)}
                  />
                  <div className="field-row">
                    {money("ssCap", "Social Security wage base")}
                    {money(
                      "additionalMedicareThreshold",
                      "Additional Medicare threshold",
                    )}
                  </div>
                  <div className="field-row">
                    <Field label="State name">
                      <input
                        value={p.stateName}
                        onChange={(e) => set("stateName", e.target.value)}
                      />
                    </Field>
                    <Field label="State tax structure">
                      <select
                        value={p.stateMode}
                        onChange={(e) =>
                          set(
                            "stateMode",
                            e.target.value as TaxProfile["stateMode"],
                          )
                        }
                      >
                        <option value="none">No income tax</option>
                        <option value="flat">Flat rate</option>
                        <option value="graduated">Graduated rates</option>
                      </select>
                    </Field>
                  </div>
                  {p.stateMode === "flat" && (
                    <Field label="State flat rate (%)">
                      <input
                        type="number"
                        min="0"
                        max="100"
                        step="0.001"
                        value={p.stateRate * 100}
                        onChange={(e) =>
                          set("stateRate", Number(e.target.value) / 100)
                        }
                      />
                    </Field>
                  )}
                  {p.stateMode === "graduated" && (
                    <BracketEditor
                      value={p.stateBrackets}
                      onChange={(v) => set("stateBrackets", v)}
                    />
                  )}
                  <h3>Payment dates</h3>
                  {p.federalDueDates.map((_, i) => (
                    <div className="field-row" key={i}>
                      <Field label={`Q${i + 1} federal due`}>
                        <input
                          type="date"
                          value={p.federalDueDates[i]}
                          onChange={(e) =>
                            set(
                              "federalDueDates",
                              p.federalDueDates.map((x, j) =>
                                j === i ? e.target.value : x,
                              ),
                            )
                          }
                        />
                      </Field>
                      <Field label={`Q${i + 1} state due`}>
                        <input
                          type="date"
                          value={p.stateDueDates[i]}
                          onChange={(e) =>
                            set(
                              "stateDueDates",
                              p.stateDueDates.map((x, j) =>
                                j === i ? e.target.value : x,
                              ),
                            )
                          }
                        />
                      </Field>
                    </div>
                  ))}
                  <Field label="Sources and rate references">
                    <textarea
                      value={p.source}
                      onChange={(e) => set("source", e.target.value)}
                    />
                  </Field>
                  <Field label="Planning notes">
                    <textarea
                      value={p.notes}
                      onChange={(e) => set("notes", e.target.value)}
                    />
                  </Field>
                </>
              )}
              <div className="form-footer">
                <Button busy={busy} disabled={!!calculationError}>
                  Save plan
                </Button>
              </div>
            </form>
          </details>
          <aside className="tax-summary">
            <Panel title="Estimate to date">
              {result && (
                <div className="panel-body annual-summary">
                  <div className="tax-total">
                    <span className="muted">
                      Estimated tax through {p.asOf}
                    </span>
                    <div
                      className="stat-value"
                      style={{ fontSize: 28, marginTop: 6 }}
                    >
                      {formatMoney(result.total, "USD", 2)}
                    </div>
                    <small>
                      {(result.effectiveRate * 100).toFixed(1)}% effective rate
                    </small>
                  </div>
                  {[
                    [p.transactionTag + " profit", result.profit],
                    ["Taxable federal income", result.taxable],
                    ["Federal income tax", result.federalIncomeTax],
                    [
                      "Self-employment tax",
                      result.selfEmploymentTax + result.additionalMedicare,
                    ],
                    ["Federal total after credits", result.federalTotal],
                    [p.stateName + " total", result.stateTotal],
                    [
                      "Estimated payments recorded",
                      result.paidFederal + result.paidState,
                    ],
                  ].map(([label, value]) => (
                    <div className="summary-line" key={String(label)}>
                      <span>{label}</span>
                      <span className="money">
                        {formatMoney(Number(value))}
                      </span>
                    </div>
                  ))}
                  <div className="summary-line total">
                    <span>Unpaid estimate to date</span>
                    <span className="money">
                      {formatMoney(
                        result.remainingFederal + result.remainingState,
                      )}
                    </span>
                  </div>
                  <details className="details">
                    <summary>Federal calculation</summary>
                    <div>
                      <table>
                        <thead>
                          <tr>
                            <th>Rate</th>
                            <th>Income in band</th>
                            <th>Tax</th>
                          </tr>
                        </thead>
                        <tbody>
                          {result.federalBands
                            .filter((b) => b.taxable > 0)
                            .map((b, i) => (
                              <tr key={i}>
                                <td>{b.rate * 100}%</td>
                                <td>{formatMoney(b.taxable)}</td>
                                <td>{formatMoney(b.tax)}</td>
                              </tr>
                            ))}
                        </tbody>
                      </table>
                      <p className="inline-note">
                        Self-employment deduction:{" "}
                        {formatMoney(result.seDeduction)}. Credits,
                        self-employment tax, and withholding are applied
                        separately.
                      </p>
                    </div>
                  </details>
                  <details className="details tax-method">
                    <summary>Assumptions & limitations</summary>
                    <div>
                      {result.assumptions.map((a) => (
                        <p key={a} style={{ marginBottom: 8 }}>
                          {a}
                        </p>
                      ))}
                    </div>
                  </details>
                </div>
              )}
            </Panel>
          </aside>
        </div>
      )}
      {tab !== "payments" && result && (
        <>
          <div className="section-title">
            <div>
              <h2>Quarterly estimates</h2>
              <p className="inline-note">
                Quarterly changes follow actual profit. Negative amounts reduce
                the estimate; payments and cumulative unpaid totals are tracked
                separately.
              </p>
            </div>
            <Button variant="secondary" onClick={() => setPayment(true)}>
              <Plus size={15} />
              Record payment
            </Button>
          </div>
          <div className="panel table-scroll">
            <table className="tax-schedule">
              <thead>
                <tr>
                  <th>Period</th>
                  <th>Payment dates</th>
                  <th className="align-right">Profit</th>
                  <th className="align-right">Federal</th>
                  <th className="align-right">State</th>
                  <th className="align-right">Quarter total</th>
                  <th className="align-right">Unpaid to date</th>
                </tr>
              </thead>
              <tbody>
                {result.federalSchedule.map((q, i) => {
                  const period = result.periods[i];
                  const active = period.start <= p.asOf;
                  const stateQuarter = result.stateSchedule[i];
                  return (
                    <tr key={q.quarter}>
                      <td>
                        Q{q.quarter}
                        <small>
                          {period.start.slice(5)} – {period.end.slice(5)}
                        </small>
                      </td>
                      <td>
                        {q.due}
                        <small>State: {stateQuarter.due}</small>
                      </td>
                      <td className="align-right money">
                        {active ? formatMoney(period.profit) : "Not started"}
                      </td>
                      <td className="align-right money">
                        {active ? formatMoney(q.target) : "—"}
                      </td>
                      <td className="align-right money">
                        {active ? formatMoney(stateQuarter.target) : "—"}
                      </td>
                      <td className="align-right money">
                        {active
                          ? formatMoney(q.target + stateQuarter.target)
                          : "—"}
                      </td>
                      <td className="align-right money">
                        {active
                          ? formatMoney(q.shortfall + stateQuarter.shortfall)
                          : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
      {payment && (
        <PaymentEditor year={year} onClose={() => setPayment(false)} />
      )}
    </>
  );
}
function BracketEditor({
  value,
  onChange,
}: {
  value: TaxProfile["federalBrackets"];
  onChange: (v: TaxProfile["federalBrackets"]) => void;
}) {
  return (
    <div className="bracket-editor">
      {value.map((b, i) => (
        <div className="bracket-row" key={i}>
          <Field label={i === 0 ? "Income up to (USD)" : ""}>
            {b.upTo === null ? (
              <input value="Unlimited" disabled />
            ) : (
              <MoneyInput
                value={b.upTo}
                onChange={(v) =>
                  onChange(
                    value.map((x, j) => (j === i ? { ...x, upTo: v } : x)),
                  )
                }
              />
            )}
          </Field>
          <Field label={i === 0 ? "Marginal rate (%)" : ""}>
            <input
              type="number"
              min="0"
              max="100"
              step="0.001"
              value={b.rate * 100}
              onChange={(e) =>
                onChange(
                  value.map((x, j) =>
                    j === i ? { ...x, rate: Number(e.target.value) / 100 } : x,
                  ),
                )
              }
            />
          </Field>
          <button
            type="button"
            className="icon-button"
            aria-label="Remove bracket"
            disabled={b.upTo === null}
            onClick={() => onChange(value.filter((_, j) => i !== j))}
          >
            <Trash2 size={15} />
          </button>
        </div>
      ))}
      <Button
        type="button"
        variant="ghost"
        onClick={() =>
          onChange([
            ...value.slice(0, -1),
            {
              upTo: (value.at(-2)?.upTo ?? 0) + 1000000,
              rate: value.at(-1)!.rate,
            },
            value.at(-1)!,
          ])
        }
      >
        <Plus size={14} />
        Add a bracket
      </Button>
    </div>
  );
}
function PaymentEditor({
  year,
  onClose,
}: {
  year: number;
  onClose: () => void;
}) {
  const submit = useSubmit();
  const { refresh, notify } = useWorkspace();
  const [data, setData] = useState({
      year,
      jurisdiction: "federal",
      paid_on: today(),
      amount: 0,
      notes: "",
    }),
    [error, setError] = useState<string | null>(null),
    [busy, setBusy] = useState(false);
  return (
    <Modal title="Record a tax payment" onClose={onClose}>
      <form
        className="form-stack"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            await submit("/tax-payments", data);
            refresh();
            notify("Payment recorded");
            onClose();
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <Field label="Jurisdiction">
          <select
            value={data.jurisdiction}
            onChange={(e) => setData({ ...data, jurisdiction: e.target.value })}
          >
            <option value="federal">Federal</option>
            <option value="state">State</option>
          </select>
        </Field>
        <div className="field-row">
          <Field label="Payment date">
            <input
              type="date"
              value={data.paid_on}
              required
              onChange={(e) => setData({ ...data, paid_on: e.target.value })}
            />
          </Field>
          <Field label="Amount paid">
            <MoneyInput
              value={data.amount}
              required
              onChange={(v) => setData({ ...data, amount: v })}
            />
          </Field>
        </div>
        <Field label="Notes">
          <input
            value={data.notes}
            onChange={(e) => setData({ ...data, notes: e.target.value })}
          />
        </Field>
        <ErrorNotice error={error} />
        <div className="form-footer">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button busy={busy}>Record payment</Button>
        </div>
      </form>
    </Modal>
  );
}
