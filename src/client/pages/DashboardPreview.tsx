import { useState } from "react";
import { Panel } from "../ui";
import { formatMoney } from "../../shared/money";
import {
  CashFlowChart,
  CashFlowControls,
  type FlowView,
  type FlowPeriod,
} from "./CashFlowChart";

// Each report, category, and register row is derived from the same fictional ledger.
const records = [3000, 4500, 4000, 6000, 5500, 7000]
  .flatMap((income, i) => {
    const month = "2026-" + String(i + 1).padStart(2, "0");
    const costs = [1000, 1250, 1500, 1750, 1500, 2000];
    return [
      {
        date: month + "-20",
        description: i % 2 ? "Studio North" : "Tern Design",
        category: "Client services",
        amount: income * 100,
      },
      {
        date: month + "-12",
        description: "Cedar Print",
        category: "Production",
        amount: -(costs[i] - 250) * 100,
      },
      {
        date: month + "-05",
        description: "Studio software",
        category: "Software",
        amount: -25000,
      },
    ];
  })
  .sort((a, b) => b.date.localeCompare(a.date));

export default function DashboardPreview() {
  const [quarter, setQuarter] = useState("all");
  const [view, setView] = useState<FlowView>("Line");
  const [grouping, setGrouping] = useState<FlowPeriod>("Monthly");
  const [filter, setFilter] = useState("All transactions");
  const from = quarter === "q2" ? "2026-04-01" : "2026-01-01";
  const to = quarter === "q1" ? "2026-03-31" : "2026-06-30";
  const rows = records.filter((row) => row.date >= from && row.date <= to);
  const months: Record<string, { income: number; expenses: number }> = {};
  const categories: Record<string, number> = {};
  let income = 0,
    expenses = 0;
  for (const row of rows) {
    const month = (months[row.date.slice(0, 7)] ??= { income: 0, expenses: 0 });
    if (row.amount > 0) {
      income += row.amount;
      month.income += row.amount;
    } else {
      expenses -= row.amount;
      month.expenses -= row.amount;
      categories[row.category] = (categories[row.category] ?? 0) - row.amount;
    }
  }
  const entries = rows.filter(
    (r) =>
      filter === "All transactions" ||
      (filter === "Income"
        ? r.amount > 0
        : filter === "Expenses"
          ? r.amount < 0
          : r.category === filter),
  );
  const dashboard =
    location.protocol === "file:" || location.hostname === "getfinance.phooey.foo"
      ? "https://finance.phooey.foo/dashboard"
      : "/dashboard";
  function showTransactions(value: string) {
    setFilter(value);
    document
      .getElementById("transactions")
      ?.scrollIntoView({ block: "nearest" });
  }
  return (
    <main className="dashboard-preview explorer">
      <header className="preview-brand">
        <strong>phooey! finance</strong>
        <a href={dashboard}>Open dashboard</a>
      </header>
      <header className="explorer-header">
        <div>
          <h1>Overview</h1>
          <p className="muted">Dashboard preview · Example business · USD</p>
        </div>
        <select
          aria-label="Report period"
          value={quarter}
          onChange={(e) => setQuarter(e.target.value)}
        >
          <option value="all">Jan–Jun 2026</option>
          <option value="q1">Jan–Mar 2026</option>
          <option value="q2">Apr–Jun 2026</option>
        </select>
      </header>
      <section className="flow-panel" aria-label="Cash flow">
        <div className="flow-head">
          <div className="flow-metrics">
            {Object.entries({
              Income: income,
              Expenses: expenses,
              Net: income - expenses,
            }).map(([label, amount]) => (
              <button
                key={label}
                onClick={() =>
                  showTransactions(label === "Net" ? "All transactions" : label)
                }
              >
                <span>{label}</span>
                <strong>{formatMoney(amount, "USD", 0)}</strong>
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
        <CashFlowChart
          months={months}
          from={from}
          to={to}
          currency="USD"
          period={grouping}
          view={view}
          theme="light"
        />
      </section>
      <div className="explorer-lower">
        <div id="transactions">
          <Panel
            title="Transactions"
            action={
              <select
                aria-label="Filter transactions"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              >
                {[
                  "All transactions",
                  "Income",
                  "Expenses",
                  ...Object.keys(categories),
                ].map((v) => (
                  <option key={v}>{v}</option>
                ))}
              </select>
            }
          >
            <div className="table-scroll">
              <table className="flow-register">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Description</th>
                    <th>Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map((r) => (
                    <tr key={r.date}>
                      <td>{r.date.slice(5)}</td>
                      <td>{r.description}</td>
                      <td>{formatMoney(r.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>
        </div>
        <Panel title="Expenses by category">
          <div className="flow-categories">
            {Object.entries(categories)
              .sort((a, b) => b[1] - a[1])
              .map(([name, amount]) => (
                <button key={name} onClick={() => showTransactions(name)}>
                  <span>{name}</span>
                  <i>
                    <b style={{ width: (100 * amount) / expenses + "%" }} />
                  </i>
                  <strong>{formatMoney(amount)}</strong>
                </button>
              ))}
          </div>
        </Panel>
      </div>
    </main>
  );
}
