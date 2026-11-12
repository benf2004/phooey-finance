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
import type { taxState } from "../../server/taxes";
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
  useEffect(() => {
    if (state.data) setProfile(state.data.profile);
  }, [state.data]);
  const profitReport = useAsync(async () => {
    if (!profile) return null;
    const report = await api<{
      groups: Record<
        string,
        { businessIncome: number; businessExpenses: number }
      >;
    }>(`/report?from=${year}-01-01&to=${profile.asOf}`);
    return {
      year,
      asOf: profile.asOf,
      version,
      profit:
        (report.groups.USD?.businessIncome ?? 0) -
        (report.groups.USD?.businessExpenses ?? 0),
    };
  }, [year, profile?.asOf, version]);
  const freshProfit =
    profitReport.data?.year === year &&
    profitReport.data?.asOf === profile?.asOf &&
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
    if (p.mode === "ytd" && !freshProfit) {
      calculationError = profitReport.error ?? "Updating ledger totals…";
    } else result = estimateTax(p, state.data.payments, ledgerProfit);
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
      {state.data.excludedCurrencies.length > 0 && (
        <div className="notice">
          Tax estimates use USD only. Excluded currencies:{" "}
          {state.data.excludedCurrencies.join(", ")}.
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
                    <Field label="Income projection">
                      <select
                        value={p.mode}
                        onChange={(e) =>
                          set("mode", e.target.value as TaxProfile["mode"])
                        }
                      >
                        <option value="manual">Manual annual forecast</option>
                        <option value="ytd">
                          Annualize year-to-date ledger
                        </option>
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
                  {p.mode === "manual" ? (
                    money(
                      "businessProfit",
                      "Annual business profit",
                      "Revenue minus business expenses.",
                    )
                  ) : (
                    <div className="notice">
                      Ledger business profit through {p.asOf}:{" "}
                      <strong>
                        {freshProfit
                          ? formatMoney(ledgerProfit)
                          : "Unavailable"}
                      </strong>
                      . This is a straight-line forecast; it is not the IRS
                      annualized-income method.
                    </div>
                  )}
                  <div className="field-row">
                    {money(
                      "otherIncome",
                      "Other annual taxable income",
                      "Use gross income, before withholding.",
                    )}
                    {money(
                      "adjustments",
                      "Federal income adjustments",
                      "Signed adjustment; negative reduces income.",
                    )}
                  </div>
                  <div className="field-row">
                    {money("deduction", "Federal deduction")}
                    {money("credits", "Federal tax credits")}
                  </div>
                  <div className="field-row">
                    {money("withholding", "Annual federal withholding")}
                    {money("stateWithholding", "Annual state withholding")}
                  </div>
                  <div className="field-row">
                    {money("stateDeduction", "State deduction")}
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
                  <Field label="Payment target">
                    <select
                      value={p.paymentMethod}
                      onChange={(e) =>
                        set(
                          "paymentMethod",
                          e.target.value as TaxProfile["paymentMethod"],
                        )
                      }
                    >
                      <option value="projected">
                        Full projected tax liability
                      </option>
                      <option value="safe-harbor">
                        General federal safe-harbor target
                      </option>
                    </select>
                  </Field>
                  {p.paymentMethod === "safe-harbor" && (
                    <>
                      <div className="field-row">
                        <Field label="Prior-year total tax (optional)">
                          <input
                            type="number"
                            step="0.01"
                            min="0"
                            value={p.priorTax === null ? "" : p.priorTax / 100}
                            onChange={(e) =>
                              set(
                                "priorTax",
                                e.target.value
                                  ? Math.round(Number(e.target.value) * 100)
                                  : null,
                              )
                            }
                          />
                        </Field>
                        <Field label="Prior-year adjusted gross income">
                          <input
                            type="number"
                            step="0.01"
                            value={p.priorAGI === null ? "" : p.priorAGI / 100}
                            onChange={(e) =>
                              set(
                                "priorAGI",
                                e.target.value
                                  ? Math.round(Number(e.target.value) * 100)
                                  : null,
                              )
                            }
                          />
                        </Field>
                      </div>
                      <label className="checkbox-label">
                        <input
                          type="checkbox"
                          checked={p.priorFullYear}
                          onChange={(e) =>
                            set("priorFullYear", e.target.checked)
                          }
                        />
                        Prior return covered a full 12-month year
                      </label>
                      <p className="notice">
                        Uses the lower of 90% of projected tax and an eligible
                        prior-year target (100% or 110%). Payment timing and
                        special rules still matter. State targets use the full
                        state estimate.
                      </p>
                    </>
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
                  <h3>Payment dates & state allocations</h3>
                  {p.federalDueDates.map((_, i) => (
                    <div className="field-row three" key={i}>
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
                      <Field label="State allocation (%)">
                        <input
                          type="number"
                          step="0.1"
                          min="0"
                          max="100"
                          value={p.stateInstallments[i] * 100}
                          onChange={(e) =>
                            set(
                              "stateInstallments",
                              p.stateInstallments.map((x, j) =>
                                j === i ? Number(e.target.value) / 100 : x,
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
            <Panel title="Annual estimate">
              {result && (
                <div className="panel-body annual-summary">
                  <div className="tax-total">
                    <span className="muted">Projected tax</span>
                    <div
                      className="stat-value"
                      style={{ fontSize: 28, marginTop: 6 }}
                    >
                      {formatMoney(result.total, "USD", 0)}
                    </div>
                    <small>
                      {(result.effectiveRate * 100).toFixed(1)}% effective rate
                    </small>
                  </div>
                  {[
                    ["Projected business profit", result.profit],
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
                    <span>Remaining payment target</span>
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
              <h2>Quarterly payments</h2>
              <p className="inline-note">
                Shortfalls include earlier unpaid installments.
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
                  <th>Quarter</th>
                  <th>Federal due</th>
                  <th>State due</th>
                  <th className="align-right">Target</th>
                  <th className="align-right">Federal shortfall</th>
                  <th className="align-right">State shortfall</th>
                </tr>
              </thead>
              <tbody>
                {result.federalSchedule.map((q, i) => (
                  <tr key={q.quarter}>
                    <td>Q{q.quarter}</td>
                    <td>{q.due}</td>
                    <td>{result.stateSchedule[i].due}</td>
                    <td className="align-right money">
                      {formatMoney(q.target + result.stateSchedule[i].target)}
                    </td>
                    <td className="align-right money">
                      {formatMoney(q.shortfall)}
                    </td>
                    <td className="align-right money">
                      {formatMoney(result.stateSchedule[i].shortfall)}
                    </td>
                  </tr>
                ))}
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
