import { useEffect, useMemo, useRef } from "react";
import {
  Chart,
  LineController,
  LineElement,
  PointElement,
  BarController,
  BarElement,
  CategoryScale,
  LinearScale,
  Tooltip,
} from "chart.js";
import { formatMoney } from "../../shared/money";

Chart.register(
  LineController,
  LineElement,
  PointElement,
  BarController,
  BarElement,
  CategoryScale,
  LinearScale,
  Tooltip,
);
type Totals = { income: number; expenses: number };
export type FlowView = "Line" | "Bars" | "Table";
export type FlowPeriod = "Monthly" | "Quarterly";

export function flowRows(
  months: Record<string, Totals>,
  from: string,
  to: string,
  period: FlowPeriod,
) {
  const grouped = new Map<string, Totals>();
  const entries = { ...months };
  const start = new Date(from.slice(0, 7) + "-01T00:00:00Z");
  const end = new Date(to.slice(0, 7) + "-01T00:00:00Z");
  if (end.getUTCFullYear() - start.getUTCFullYear() <= 20) {
    for (let d = start; d <= end; d.setUTCMonth(d.getUTCMonth() + 1))
      entries[d.toISOString().slice(0, 7)] ??= { income: 0, expenses: 0 };
  }
  for (const [month, value] of Object.entries(entries).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const date = new Date(month + "-01T00:00:00Z");
    const label =
      period === "Quarterly"
        ? `Q${Math.ceil((date.getUTCMonth() + 1) / 3)} ${date.getUTCFullYear()}`
        : date.toLocaleDateString("en-US", {
            month: "short",
            year: "2-digit",
            timeZone: "UTC",
          });
    const row = grouped.get(label) ?? { income: 0, expenses: 0 };
    row.income += value.income;
    row.expenses += value.expenses;
    grouped.set(label, row);
  }
  return Array.from(grouped, ([label, values]) => ({ label, ...values }));
}

export function CashFlowChart({
  months,
  from,
  to,
  currency,
  period,
  view,
  theme,
}: {
  months: Record<string, Totals>;
  from: string;
  to: string;
  currency: string;
  period: FlowPeriod;
  view: FlowView;
  theme: string;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const rows = useMemo(
    () => flowRows(months, from, to, period),
    [months, from, to, period],
  );
  useEffect(() => {
    if (!ref.current || view === "Table") return;
    const colors = getComputedStyle(ref.current);
    const color = (name: string) => colors.getPropertyValue(name).trim();
    const chart = new Chart(ref.current, {
      type: view === "Line" ? "line" : "bar",
      data: {
        labels: rows.map((r) => r.label),
        datasets: (["income", "expenses"] as const).map((key) => ({
          label: key === "income" ? "Income" : "Expenses",
          data: rows.map((r) => r[key] / 100),
          borderColor: color("--flow-" + key),
          backgroundColor: color("--flow-" + key),
          pointBackgroundColor: color("--surface"),
          pointRadius: rows.length > 24 ? 0 : 3,
          pointHoverRadius: 5,
          borderWidth: view === "Line" ? 2.5 : 0,
          maxBarThickness: 40,
        })),
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: "#143c35",
            padding: 12,
            callbacks: {
              label: (c) =>
                c.dataset.label +
                "  " +
                formatMoney(Math.round(Number(c.raw) * 100), currency),
            },
          },
        },
        scales: {
          x: {
            grid: { display: false },
            border: { display: false },
            ticks: {
              color: color("--muted"),
              maxRotation: 0,
              maxTicksLimit: 12,
            },
          },
          y: {
            beginAtZero: true,
            border: { display: false },
            grid: { color: color("--line") },
            ticks: {
              color: color("--muted"),
              maxTicksLimit: 7,
              callback: (n) =>
                new Intl.NumberFormat("en-US", {
                  style: "currency",
                  currency,
                  notation: "compact",
                  maximumFractionDigits: 1,
                }).format(Number(n)),
            },
          },
        },
      },
    });
    return () => chart.destroy();
  }, [rows, currency, view, theme]);
  if (view === "Table")
    return (
      <div className="flow-table">
        <table>
          <caption className="sr-only">
            Cash flow by period in {currency}
          </caption>
          <thead>
            <tr>
              <th>Period</th>
              <th>Income</th>
              <th>Expenses</th>
              <th>Net</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.label}>
                <th scope="row">{r.label}</th>
                <td>{formatMoney(r.income, currency)}</td>
                <td>{formatMoney(r.expenses, currency)}</td>
                <td>{formatMoney(r.income - r.expenses, currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  return (
    <>
      <div className="flow-canvas">
        <canvas
          ref={ref}
          role="img"
          aria-label={
            period +
            " income and expenses in " +
            currency +
            ". Select Table for exact figures."
          }
        />
      </div>
      <div className="flow-legend">
        <span>Income</span>
        <span>Expenses</span>
      </div>
    </>
  );
}

export function CashFlowControls({
  view,
  setView,
  grouping,
  setGrouping,
}: {
  view: FlowView;
  setView: (view: FlowView) => void;
  grouping: FlowPeriod;
  setGrouping: (period: FlowPeriod) => void;
}) {
  return (
    <div className="flow-controls">
      <div role="group" aria-label="Cash flow view" className="flow-switch">
        {(["Line", "Bars", "Table"] as const).map((v) => (
          <button key={v} aria-pressed={view === v} onClick={() => setView(v)}>
            {v}
          </button>
        ))}
      </div>
      <select
        aria-label="Group cash flow by"
        value={grouping}
        onChange={(e) => setGrouping(e.target.value as FlowPeriod)}
      >
        <option>Monthly</option>
        <option>Quarterly</option>
      </select>
    </div>
  );
}
