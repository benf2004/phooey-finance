import { useState } from "react";
import { ArrowRight, ArrowUpRight, CalendarDays, Plus } from "lucide-react";
import {
  DateRangeSelect,
  calendarRanges,
  type CalendarPeriod,
} from "../DateRangeSelect";
import {
  CashFlowChart,
  CashFlowControls,
  type FlowView,
  type FlowPeriod,
} from "./CashFlowChart";
import { useWorkspace } from "../context";
import { TransactionAmount } from "../TransactionAmount";
import { api } from "../api";
import { Button, Panel, Empty, ErrorNotice, TextLink, useAsync } from "../ui";
import { formatMoney, today } from "../../shared/money";
import type { Ledger } from "../../server/ledger";
import type { taxState } from "../../server/taxes";
import type { Transaction } from "../../shared/models";
type Report = Awaited<ReturnType<Ledger["report"]>>;
type TaxState = Awaited<ReturnType<typeof taxState>>;
export default function Overview() {
  const { accounts, navigate, version, theme } = useWorkspace();
  const date = today();
  const [period, setPeriod] = useState<CalendarPeriod | "custom">(
    "year-to-date",
  );
  const ranges = calendarRanges();
  const [customRange, setCustomRange] = useState<{ from: string; to: string }>(
    ranges["year-to-date"],
  );
  const { from, to } = period === "custom" ? customRange : ranges[period];
  const [currency, setCurrency] = useState("USD");
  const valid = Boolean(from && to && from <= to);
  const report = useAsync(
    () =>
      valid
        ? api<Report>(`/report?from=${from}&to=${to}`)
        : Promise.resolve(null),
    [from, to, version],
  );
  const tax = useAsync(async () => {
    const year = Number(date.slice(0, 4));
    const plans = await Promise.all([
      api<TaxState>("/taxes/" + (year - 1)),
      api<TaxState>("/taxes/" + year),
    ]);
    return plans;
  }, [version, date]);
  const recent = useAsync(
    () =>
      valid
        ? api<{ items: Transaction[] }>(
            `/transactions?limit=8&from=${from}&to=${to}&currency=${currency}&pending=0`,
          )
        : Promise.resolve({ items: [] }),
    [from, to, currency, version],
  );
  const ready =
    valid &&
    !report.loading &&
    !report.error &&
    report.data?.from === from &&
    report.data?.to === to;
  const g = ready ? report.data?.groups[currency] : undefined;
  const [view, setView] = useState<FlowView>("Line");
  const [grouping, setGrouping] = useState<FlowPeriod>("Monthly");
  const cash = accounts
    .filter(
      (a) =>
        !a.archived &&
        a.currency === currency &&
        ["checking", "savings", "cash"].includes(a.kind),
    )
    .reduce((s, a) => s + a.balance, 0);
  const plans = tax.data ?? [];
  const upcoming = plans
    .flatMap((plan) =>
      plan.estimate.federalSchedule.map((q) => ({
        ...q,
        year: plan.profile.year,
        plan,
      })),
    )
    .filter((q) => q.due >= date)
    .sort((a, b) => a.due.localeCompare(b.due));
  const next = upcoming[0];
  const selectedPlan = next?.plan ?? plans.at(-1);
  const stateNext = plans
    .flatMap((plan) => plan.estimate.stateSchedule)
    .filter((q) => q.due >= date)
    .sort((a, b) => a.due.localeCompare(b.due))[0];
  const reserve = (next?.target ?? 0) + (stateNext?.target ?? 0);
  const categories = Object.entries(g?.categories ?? {})
    .sort((a, b) => b[1].amount - a[1].amount)
    .slice(0, 8);
  const txPath = `/transactions?from=${from}&to=${to}&pending=0&currency=${currency}`;
  return (
    <div className="explorer">
      <header className="explorer-header">
        <h1>Overview</h1>
        <Button onClick={() => navigate("/transactions?new=1")}>
          <Plus size={16} /> Add transaction
        </Button>
        <div className="explorer-filters">
          <DateRangeSelect
            ranges={ranges}
            value={period}
            onChange={(value) => {
              if (value === "all") return;
              if (value === "custom") setCustomRange({ from, to });
              setPeriod(value);
            }}
          />
          {period === "custom" && (
            <div className="date-range">
              <CalendarDays size={16} className="muted" />
              <input
                aria-label="Report start date"
                type="date"
                value={from}
                onChange={(e) => {
                  setPeriod("custom");
                  setCustomRange({ from: e.target.value, to });
                }}
              />
              <span className="muted">—</span>
              <input
                aria-label="Report end date"
                type="date"
                value={to}
                onChange={(e) => {
                  setPeriod("custom");
                  setCustomRange({ from, to: e.target.value });
                }}
              />
            </div>
          )}
          <select
            aria-label="Report currency"
            className="report-currency"
            value={currency}
            onChange={(e) => setCurrency(e.target.value)}
          >
            {[...new Set(["USD", ...accounts.map((a) => a.currency)])].map(
              (c) => (
                <option key={c}>{c}</option>
              ),
            )}
          </select>
        </div>
      </header>
      <ErrorNotice
        error={
          !valid
            ? "Choose an end date on or after the start date."
            : report.error
        }
      />
      <section className="flow-panel" aria-label="Cash flow">
        <div className="flow-head">
          <div className="flow-metrics">
            {[
              {
                label: "Income",
                value: g?.income,
                path: txPath + "&type=income",
              },
              {
                label: "Expenses",
                value: g?.expenses,
                path: txPath + "&type=expense",
              },
              { label: "Net", value: g?.net, path: txPath },
            ].map((m) => (
              <button
                key={m.label}
                disabled={!ready}
                onClick={() => navigate(m.path)}
              >
                <span>{m.label}</span>
                <strong>
                  {ready ? formatMoney(m.value ?? 0, currency, 0) : "—"}
                </strong>
              </button>
            ))}
          </div>
          <CashFlowControls
            view={view}
            setView={setView}
            grouping={grouping}
            setGrouping={setGrouping}
          />
        </div>
        {ready && g && Object.keys(g.months).length ? (
          <CashFlowChart
            months={g.months}
            from={from}
            to={to}
            period={grouping}
            view={view}
            theme={theme}
            currency={currency}
          />
        ) : (
          <div className="flow-empty">
            {report.loading ? (
              <p role="status">Loading cash flow…</p>
            ) : ready ? (
              <Empty
                title="No posted transactions in this period"
                detail="Choose another period or add a transaction."
                action={
                  <TextLink onClick={() => navigate("/accounts")}>
                    Manage accounts
                  </TextLink>
                }
              />
            ) : (
              <p>Cash flow is unavailable for this period.</p>
            )}
          </div>
        )}
      </section>
      <div className="explorer-lower">
        <Panel
          title="Recent transactions"
          action={
            <TextLink onClick={() => navigate(txPath)}>View all</TextLink>
          }
        >
          <ErrorNotice error={recent.error} />
          {recent.loading ? (
            <p className="flow-message" role="status">
              Loading transactions…
            </p>
          ) : valid && !recent.error && recent.data?.items.length ? (
            <div className="table-scroll">
              <table className="flow-register">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Description</th>
                    <th className="hide-mobile">Category</th>
                    <th>Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {recent.data.items.map((t) => (
                    <tr key={t.id}>
                      <td>
                        {new Date(t.posted + "T12:00:00").toLocaleDateString(
                          "en-US",
                          { month: "short", day: "numeric" },
                        )}
                      </td>
                      <td>
                        <button
                          className="transaction-name"
                          onClick={() => navigate("/transactions?edit=" + t.id)}
                        >
                          {t.description}
                        </button>
                      </td>
                      <td className="hide-mobile">
                        {t.category_name ?? "Uncategorized"}
                      </td>
                      <td>
                        <TransactionAmount
                          amount={t.amount}
                          currency={t.currency}
                          showPositiveSign
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            !recent.error && (
              <p className="flow-message">
                No transactions to show for this period.
              </p>
            )
          )}
        </Panel>
        <Panel
          title="Expenses by category"
          action={
            <span className="flow-total">
              {g && formatMoney(g.expenses, currency)}
            </span>
          }
        >
          {categories.length ? (
            <div className="flow-categories">
              {categories.map(([key, c]) => (
                <button
                  key={key}
                  onClick={() =>
                    navigate(
                      txPath +
                        "&type=expense&category=" +
                        encodeURIComponent(key),
                    )
                  }
                >
                  <span>{c.name}</span>
                  <i>
                    <b
                      style={{
                        width:
                          Math.max(
                            0,
                            (c.amount / Math.max(1, categories[0][1].amount)) *
                              100,
                          ) + "%",
                      }}
                    />
                  </i>
                  <strong>{formatMoney(c.amount, currency)}</strong>
                </button>
              ))}
            </div>
          ) : (
            <p className="flow-message">
              {report.loading
                ? "Loading expenses…"
                : ready
                  ? "No posted expenses in this period."
                  : "Category totals unavailable."}
            </p>
          )}
        </Panel>
      </div>
      <div className="explorer-details">
        <Panel
          title="Account balances"
          action={
            <TextLink onClick={() => navigate("/accounts")}>
              View accounts
            </TextLink>
          }
        >
          <div className="account-summary">
            <span>Cash on hand · {currency}</span>
            <strong>{formatMoney(cash, currency)}</strong>
          </div>
          {!!report.data?.reviewCount && (
            <div className="account-summary">
              <span>{report.data.reviewCount} transactions need review</span>
              <TextLink onClick={() => navigate("/transactions?reviewed=0")}>
                Review
              </TextLink>
            </div>
          )}
        </Panel>
        <div>
          <ErrorNotice error={tax.error} />
          <section className="panel tax-card">
            <header className="panel-heading">
              <h2>Quarterly taxes</h2>
              <CalendarDays size={16} />
            </header>
            <div className="panel-body">
              <span className="due">
                <CalendarDays size={13} />
                {tax.loading
                  ? "Loading estimate…"
                  : tax.error
                    ? "Estimate unavailable"
                    : next
                      ? `Next quarterly estimate · ${new Date(next.due + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" })}`
                      : "No upcoming installment"}
              </span>
              <div className="tax-amount">
                {tax.loading || tax.error
                  ? "—"
                  : formatMoney(reserve, "USD", 2)}
              </div>
              <p style={{ fontSize: 12 }}>Upcoming estimated payment targets</p>
              <div style={{ marginTop: 18 }}>
                <div className="tax-split">
                  <span>Federal</span>
                  <span className="money">
                    {tax.loading || tax.error
                      ? "—"
                      : formatMoney(next?.target ?? 0)}
                  </span>
                </div>
                <div className="tax-split">
                  <span>{selectedPlan?.profile.stateName ?? "State"}</span>
                  <span className="money">
                    {tax.loading || tax.error
                      ? "—"
                      : formatMoney(stateNext?.target ?? 0)}
                  </span>
                </div>
              </div>
              <Button
                onClick={() =>
                  navigate(
                    "/taxes?year=" +
                      (selectedPlan?.profile.year ?? date.slice(0, 4)),
                  )
                }
              >
                {selectedPlan?.revision ? "Tax planner" : "Set up taxes"}
                <ArrowUpRight size={15} />
              </Button>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
