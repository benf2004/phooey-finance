import { useEffect, useRef, useState } from "react";
import {
  ArrowDownLeft,
  ArrowUpRight,
  ArrowRight,
  Plus,
  CalendarDays,
  SlidersHorizontal,
  Wallet,
  TrendingUp,
  Receipt,
  Info,
} from "lucide-react";
import {
  Chart,
  BarController,
  BarElement,
  CategoryScale,
  LinearScale,
  Tooltip,
} from "chart.js";
import { useWorkspace } from "../context";
import { api } from "../api";
import {
  PageHeading,
  Panel,
  Button,
  TextLink,
  Empty,
  ErrorNotice,
  useAsync,
} from "../ui";
import { formatMoney, today } from "../../shared/money";
import type { Ledger } from "../../server/ledger";
import type { taxState } from "../../server/taxes";
import type { Transaction } from "../../shared/models";
Chart.register(BarController, BarElement, CategoryScale, LinearScale, Tooltip);
type Report = Awaited<ReturnType<Ledger["report"]>>;
type TaxState = Awaited<ReturnType<typeof taxState>>;
function CashChart({
  months,
  currency,
}: {
  months: Record<string, { income: number; expenses: number }>;
  currency: string;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (!canvas.current) return;
    const keys = Object.keys(months).sort();
    const dark = document.documentElement.dataset.theme === "dark";
    const chart = new Chart(canvas.current, {
      type: "bar",
      data: {
        labels: keys.map((k) =>
          new Date(k + "-15").toLocaleDateString("en-US", { month: "short" }),
        ),
        datasets: [
          {
            label: "Income",
            data: keys.map((k) => months[k].income / 100),
            backgroundColor: dark ? "#8cbd9b" : "#3e7054",
            borderRadius: 3,
            barPercentage: 0.65,
            categoryPercentage: 0.65,
          },
          {
            label: "Spending",
            data: keys.map((k) => months[k].expenses / 100),
            backgroundColor: dark ? "#556750" : "#c0cbb6",
            borderRadius: 3,
            barPercentage: 0.65,
            categoryPercentage: 0.65,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: (c) =>
                `${c.dataset.label}: ${formatMoney(Number(c.raw) * 100, currency)}`,
            },
          },
        },
        scales: {
          x: {
            grid: { display: false },
            border: { display: false },
            ticks: {
              color: "#8b9387",
              font: {
                family: "-apple-system, BlinkMacSystemFont, sans-serif",
                size: 11,
              },
            },
          },
          y: {
            grid: { color: dark ? "#354036" : "#edf0e8" },
            border: { display: false },
            ticks: {
              maxTicksLimit: 5,
              color: "#8b9387",
              font: {
                family: "-apple-system, BlinkMacSystemFont, sans-serif",
                size: 11,
              },
              callback: (v) =>
                currency +
                " " +
                (Number(v) >= 1000 ? Number(v) / 1000 + "k" : v),
            },
          },
        },
      },
    });
    return () => chart.destroy();
  }, [months, currency]);
  return (
    <div className="chart-container">
      <canvas
        ref={canvas}
        aria-label="Income and spending by month"
        role="img"
      />
    </div>
  );
}
export default function Overview() {
  const { accounts, navigate, version } = useWorkspace();
  const date = today();
  const [from, setFrom] = useState(date.slice(0, 4) + "-01-01"),
    [to, setTo] = useState(date),
    [currency, setCurrency] = useState("USD");
  const report = useAsync(
    () => api<Report>(`/report?from=${from}&to=${to}`),
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
    () => api<{ items: Transaction[] }>("/transactions?limit=5"),
    [version],
  );
  const g = report.data?.groups[currency];
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
  const reserve = (next?.shortfall ?? 0) + (stateNext?.shortfall ?? 0);
  const categories = Object.entries(g?.categories ?? {})
    .sort((a, b) => b[1].amount - a[1].amount)
    .slice(0, 5);
  const txPath = `/transactions?from=${from}&to=${to}&pending=0&currency=${currency}`;
  return (
    <>
      <PageHeading
        title="Overview"
        actions={
          <Button
            variant="secondary"
            onClick={() => navigate("/transactions?new=1")}
          >
            <Plus size={16} />
            Add transaction
          </Button>
        }
      />
      <div className="toolbar">
        <div className="date-range">
          <CalendarDays size={16} className="muted" />
          <input
            aria-label="Report start date"
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
          <span className="muted">—</span>
          <input
            aria-label="Report end date"
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
          />
        </div>
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
      <ErrorNotice error={report.error} />
      <div className="stat-grid">
        {[
          {
            label: "Cash on hand",
            value: cash,
            icon: Wallet,
            note: "Across your cash accounts",
            path: "/accounts",
          },
          {
            label: "Income",
            value: g?.income ?? 0,
            icon: ArrowDownLeft,
            note: "Posted income in this period",
            path: txPath + "&type=income",
          },
          {
            label: "Expenses",
            value: g?.expenses ?? 0,
            icon: ArrowUpRight,
            note: "Transfers excluded",
            path: txPath + "&type=expense",
          },
          {
            label: "Net cash flow",
            value: g?.net ?? 0,
            icon: TrendingUp,
            note: "Income less spending",
            path: txPath,
          },
        ].map((s, i) => (
          <div className="stat" key={s.label}>
            <button
              className="metric-click"
              title={s.note}
              onClick={() => navigate(s.path)}
            >
              <span className="stat-label">
                <s.icon size={15} />
                {s.label}
              </span>
              <div className={`stat-value ${i === 3 ? "positive" : ""}`}>
                {formatMoney(s.value, currency, 0)}
              </div>
            </button>
          </div>
        ))}
      </div>
      <div className="dashboard-grid">
        <Panel
          title="Cash flow"
          action={
            <div className="chart-legend">
              <span>
                <i className="dot" />
                Income
              </span>
              <span>
                <i className="dot pale" />
                Spending
              </span>
            </div>
          }
        >
          {g && Object.keys(g.months).length ? (
            <CashChart months={g.months} currency={currency} />
          ) : (
            <Empty
              title="No transactions"
              detail="Add an account or import transactions."
              action={
                <Button
                  variant="secondary"
                  onClick={() => navigate("/accounts")}
                >
                  Add account <ArrowRight size={15} />
                </Button>
              }
            />
          )}
          <div className="chart-footer">
            <span>Posted transactions · {currency}</span>
            <TextLink onClick={() => navigate(txPath)}>Transactions</TextLink>
          </div>
        </Panel>
        <section className="panel tax-card">
          <header className="panel-heading">
            <h2>Quarterly taxes</h2>
            <CalculatorIcon />
          </header>
          <div className="panel-body">
            <span className="due">
              <CalendarDays size={13} />
              {next
                ? `Next federal installment · ${new Date(next.due + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" })}`
                : "No upcoming installment"}
            </span>
            <div className="tax-amount">{formatMoney(reserve, "USD", 0)}</div>
            <p style={{ fontSize: 12 }}>Remaining installment target</p>
            <div style={{ marginTop: 18 }}>
              <div className="tax-split">
                <span>Federal</span>
                <span className="money">
                  {formatMoney(next?.shortfall ?? 0)}
                </span>
              </div>
              <div className="tax-split">
                <span>{selectedPlan?.profile.stateName ?? "State"}</span>
                <span className="money">
                  {formatMoney(stateNext?.shortfall ?? 0)}
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
      {!!report.data?.reviewCount && (
        <div className="review-banner">
          <Info size={17} />
          <span>
            <strong>{report.data.reviewCount} transactions</strong> need review.
          </span>
          <TextLink onClick={() => navigate("/transactions?reviewed=0")}>
            Review transactions
          </TextLink>
        </div>
      )}
      <div className="dashboard-grid bottom">
        <Panel
          title="Recent activity"
          action={
            <TextLink onClick={() => navigate("/transactions")}>
              View all
            </TextLink>
          }
        >
          {recent.data?.items.length ? (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Transaction</th>
                    <th className="hide-mobile">Category</th>
                    <th className="align-right">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {recent.data.items.map((t) => (
                    <tr key={t.id}>
                      <td>
                        <div className="merchant-cell">
                          <span className="merchant-icon">
                            {t.description.slice(0, 1).toUpperCase()}
                          </span>
                          <div>
                            <button
                              className="transaction-name"
                              onClick={() =>
                                navigate("/transactions?edit=" + t.id)
                              }
                            >
                              {t.description}
                            </button>
                            <small>
                              {t.account_name} ·{" "}
                              {new Date(
                                t.posted + "T12:00:00",
                              ).toLocaleDateString("en-US", {
                                month: "short",
                                day: "numeric",
                              })}
                            </small>
                          </div>
                        </div>
                      </td>
                      <td className="hide-mobile">
                        <span
                          className={`badge ${t.category_name ? "neutral" : "amber"}`}
                        >
                          {t.category_name ?? "Uncategorized"}
                        </span>
                      </td>
                      <td
                        className={`align-right money ${t.amount > 0 ? "positive" : ""}`}
                      >
                        {t.amount > 0 ? "+" : ""}
                        {formatMoney(t.amount, t.currency)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty
              title="No recent transactions"
              detail="Add a transaction to get started."
            />
          )}
        </Panel>
        <Panel
          title="Spending by category"
          action={<Receipt size={17} className="muted" />}
        >
          {categories.length ? (
            <div className="spending-list">
              {categories.map(([key, c], i) => (
                <div className="spending-row" key={key}>
                  <div>
                    <button
                      onClick={() => navigate(txPath + "&category=" + key)}
                    >
                      {c.name}
                    </button>
                    <span className="money">
                      {formatMoney(c.amount, currency, 0)}
                    </span>
                  </div>
                  <div className="bar-track">
                    <div
                      className="bar-fill"
                      style={{
                        width: `${Math.max(0, (c.amount / Math.max(1, categories[0][1].amount)) * 100)}%`,
                        opacity: 1 - i * 0.12,
                      }}
                    />
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <Empty
              title="No categorized expenses"
              detail="Categorize expenses to see totals."
            />
          )}
        </Panel>
      </div>
    </>
  );
}
function CalculatorIcon() {
  return <SlidersHorizontal size={17} color="#c4d6c8" />;
}
