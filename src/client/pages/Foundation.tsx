import { useState, useEffect } from "react";
import { BookOpen, ChevronLeft, ChevronRight } from "lucide-react";
import { api, post } from "../api";
import { useAsync, ErrorNotice } from "../ui";
import {
  foundationReport,
  foundationViews,
  budgetKey,
  monthNames,
  type FoundationData,
  type Report,
  type ViewId,
} from "../../shared/foundation";
import type { taxState } from "../../server/taxes";
import "./foundation.css";

function selectedView(): ViewId {
  const key = location.hash.slice(1);
  return foundationViews.find((v) => v[0] === key)?.[0] ?? "spending-trends";
}
function TaxView({ year }: { year: number }) {
  const state = useAsync(
    () => api<Awaited<ReturnType<typeof taxState>>>("/taxes/" + year),
    [year],
  );
  if (state.error) return <ErrorNotice error={state.error} />;
  if (state.loading || !state.data) return <p>Loading tax year…</p>;
  const { estimate, profile, revision } = state.data;
  if (!revision && year !== 2026)
    return (
      <p>
        No saved filing assumptions for {year}.{" "}
        <a href={"/taxes?year=" + year}>Open tax planner</a>
      </p>
    );
  const report = {
    columns: [
      "Tax period",
      "Federal due",
      "Federal estimate",
      "State estimate",
      "Federal shortfall",
    ],
    money: [2, 3, 4],
    rows: estimate.federalSchedule.map((q, i) => [
      ["Jan–Mar", "Apr–May", "Jun–Aug", "Sep–Dec"][i],
      q.due,
      q.target,
      estimate.stateSchedule[i].target,
      q.shortfall,
    ]),
  };
  return (
    <>
      <p className="fd-caption">
        USD · {profile.filingStatus} filing status · Through {profile.asOf}
      </p>
      <ReportTable report={report} currency="USD" />
      <a href={"/taxes?year=" + year}>Open filing assumptions and payments ↗</a>
    </>
  );
}
function money(n: number, c: string) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: c,
  }).format(n / 100);
}
function ReportTable({
  report,
  currency,
}: {
  report: Report;
  currency: string;
}) {
  return (
    <div className="fd-grid">
      <table>
        <thead>
          <tr>
            {report.columns.map((c) => (
              <th key={c}>{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {report.rows.map((r, i) => (
            <tr key={i}>
              {r.map((c, j) => (
                <td
                  key={j}
                  className={report.money.includes(j) ? "fd-money" : undefined}
                >
                  {report.money.includes(j) ? money(Number(c), currency) : c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {!report.rows.length && <p>No matching records.</p>}
    </div>
  );
}
export default function Foundation() {
  const [view, setView] = useState<ViewId>(selectedView),
    [year, setYear] = useState(new Date().getFullYear()),
    [archiveYear, setArchiveYear] = useState(new Date().getFullYear() - 1),
    [currency, setCurrency] = useState("USD"),
    [month, setMonth] = useState(new Date().getMonth() + 1),
    [txMonth, setTxMonth] = useState(0),
    [search, setSearch] = useState(""),
    [account, setAccount] = useState(""),
    [category, setCategory] = useState(""),
    [offset, setOffset] = useState(0),
    [revision, refresh] = useState(0),
    [error, setError] = useState(""),
    [saving, setSaving] = useState(false),
    [draft, setDraft] = useState(""),
    [chosen, choose] = useState("");
  useEffect(() => {
    const change = () => {
      setView(selectedView());
      setOffset(0);
      setError("");
    };
    window.addEventListener("hashchange", change);
    return () => window.removeEventListener("hashchange", change);
  }, []);
  const state = useAsync(
    () => api<FoundationData>("/foundation/" + year),
    [year, revision],
  );
  const def = foundationViews.find((v) => v[0] === view)!;
  const selectYear = (n: number) => {
    setYear(n);
    setOffset(0);
  };
  const content = () => {
    if (state.error) return <ErrorNotice error={state.error} />;
    if (!state.data || state.loading) return <p>Loading reports…</p>;
    const d = state.data,
      currencies = [
        ...new Set([
          ...d.accounts.map((a) => a.currency),
          ...d.entries.map((e) => e.currency),
        ]),
      ].sort(),
      cur = currencies.includes(currency) ? currency : currencies[0] || "USD";
    const data = d;
    const tax = view === "estimated-tax" || view === "archived-tax",
      tx = view === "transactions" || view === "transaction-tracker",
      monthly = view === "monthly-budget";
    const r = tax
      ? null
      : foundationReport(
          data,
          view,
          cur,
          monthly ? month : txMonth,
          search,
          account,
          category,
        );
    const chart =
      r &&
      ["spending-trends", "business-dashboard", "quarterly-earnings"].includes(
        view,
      )
        ? r
        : null;
    const chartMax = chart
      ? Math.max(
          1,
          ...chart.rows.flatMap((row) => [
            Math.abs(Number(row[1])),
            Math.abs(Number(row[2])),
          ]),
        )
      : 1;
    const selectedCategory =
      chosen || d.categories.find((c) => c.type !== "transfer")?.id;
    return (
      <>
        <div className="fd-controls">
          <label>
            {view === "archived-tax" ? "Tax archive year" : "Report year"}
            <select
              value={view === "archived-tax" ? archiveYear : year}
              onChange={(e) =>
                (view === "archived-tax" ? setArchiveYear : selectYear)(
                  Number(e.target.value),
                )
              }
            >
              {Array.from({ length: 101 }, (_, i) => 2100 - i)
                .filter(
                  (y) =>
                    view !== "archived-tax" || y < new Date().getFullYear(),
                )
                .map((y) => (
                  <option key={y}>{y}</option>
                ))}
            </select>
          </label>
          {!tax && (
            <label>
              Currency
              <select
                value={cur}
                onChange={(e) => {
                  setCurrency(e.target.value);
                  setOffset(0);
                }}
              >
                {(currencies.length ? currencies : ["USD"]).map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
            </label>
          )}
          {(monthly || tx) && (
            <label>
              Month
              <select
                value={monthly ? month : txMonth}
                onChange={(e) => {
                  (monthly ? setMonth : setTxMonth)(Number(e.target.value));
                  setOffset(0);
                }}
              >
                {tx && <option value={0}>All months</option>}
                {monthNames.map((m, i) => (
                  <option value={i + 1} key={m}>
                    {m}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
        {tax ? (
          <TaxView year={view === "archived-tax" ? archiveYear : year} />
        ) : (
          r && (
            <>
              {chart && (
                <>
                  <div className="fd-metrics">
                    {chart.columns.slice(1).map((label, i) => (
                      <div key={label}>
                        <span>{label}</span>
                        <strong>
                          {money(
                            chart.rows.reduce(
                              (s, row) => s + Number(row[i + 1]),
                              0,
                            ),
                            cur,
                          )}
                        </strong>
                      </div>
                    ))}
                  </div>
                  <figure
                    className="fd-plot"
                    aria-label="Income and expenses by period"
                  >
                    <figcaption>
                      <span>Income</span>
                      <span>Expenses</span>
                    </figcaption>
                    <div>
                      {chart.rows.map((row) => (
                        <div
                          key={row[0]}
                          title={
                            row[0] +
                            ": " +
                            money(Number(row[1]), cur) +
                            " income, " +
                            money(Number(row[2]), cur) +
                            " expenses"
                          }
                        >
                          <div className="fd-bars">
                            <i
                              style={{
                                height:
                                  (Math.abs(Number(row[1])) / chartMax) * 100 +
                                  "%",
                              }}
                            />
                            <i
                              style={{
                                height:
                                  (Math.abs(Number(row[2])) / chartMax) * 100 +
                                  "%",
                              }}
                            />
                          </div>
                          <small>{row[0]}</small>
                        </div>
                      ))}
                    </div>
                  </figure>
                </>
              )}
              {view === "balances" && (
                <p className="fd-balance">
                  Net worth{" "}
                  <strong>
                    {money(
                      r.rows.reduce((sum, row) => sum + Number(row[2]), 0),
                      cur,
                    )}
                  </strong>
                </p>
              )}
              {tx && (
                <div className="fd-controls">
                  <label>
                    Search transactions
                    <input
                      value={search}
                      onChange={(e) => {
                        setSearch(e.target.value);
                        setOffset(0);
                      }}
                      placeholder="Description, account or category"
                    />
                  </label>
                  <label>
                    Account
                    <select
                      value={account}
                      onChange={(e) => {
                        setAccount(e.target.value);
                        setOffset(0);
                      }}
                    >
                      <option value="">All accounts</option>
                      {[
                        ...new Set(
                          d.accounts
                            .filter((a) => a.currency === cur)
                            .map((a) => a.name),
                        ),
                      ].map((n) => (
                        <option key={n}>{n}</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Category
                    <select
                      value={category}
                      onChange={(e) => {
                        setCategory(e.target.value);
                        setOffset(0);
                      }}
                    >
                      <option value="">All categories</option>
                      {d.categories.map((c) => (
                        <option key={c.id}>{c.name}</option>
                      ))}
                    </select>
                  </label>
                </div>
              )}
              {monthly && selectedCategory && (
                <form
                  className="fd-controls"
                  onSubmit={async (e) => {
                    e.preventDefault();
                    setSaving(true);
                    setError("");
                    const amount = Math.round(Number(draft) * 100);
                    try {
                      await post(
                        "/foundation/" + year + "/budget",
                        {
                          month,
                          category: selectedCategory,
                          currency: cur,
                          amount,
                        },
                        "PUT",
                      );
                      refresh((n) => n + 1);
                      setDraft("");
                    } catch (ex) {
                      setError((ex as Error).message);
                    } finally {
                      setSaving(false);
                    }
                  }}
                >
                  <label>
                    Budget category
                    <select
                      value={selectedCategory}
                      onChange={(e) => choose(e.target.value)}
                    >
                      {d.categories
                        .filter((c) => c.type !== "transfer")
                        .map((c) => (
                          <option value={c.id} key={c.id}>
                            {c.name}
                          </option>
                        ))}
                    </select>
                  </label>
                  <label>
                    Monthly target
                    <input
                      required
                      type="number"
                      step=".01"
                      min="0"
                      max="10000000000"
                      value={draft}
                      placeholder={String(
                        (data.budgets[
                          budgetKey(cur, month, selectedCategory)
                        ] || 0) / 100,
                      )}
                      onChange={(e) => setDraft(e.target.value)}
                    />
                  </label>
                  <button disabled={saving}>Save target</button>
                </form>
              )}
              <ReportTable
                report={{ ...r, rows: r.rows.slice(offset, offset + 50) }}
                currency={cur}
              />
              {r.rows.length > 50 && (
                <div className="fd-paging">
                  <button
                    disabled={!offset}
                    aria-label="Previous page"
                    onClick={() => setOffset(offset - 50)}
                  >
                    <ChevronLeft />
                  </button>
                  {offset + 1}–{Math.min(offset + 50, r.rows.length)} of{" "}
                  {r.rows.length}
                  <button
                    disabled={offset + 50 >= r.rows.length}
                    aria-label="Next page"
                    onClick={() => setOffset(offset + 50)}
                  >
                    <ChevronRight />
                  </button>
                </div>
              )}
              {["categories", "autocat", "accounts", "transactions"].includes(
                view,
              ) && (
                <a href={view === "autocat" ? "/categories" : "/" + view}>
                  Manage {view === "autocat" ? "rules" : view} ↗
                </a>
              )}
            </>
          )
        )}
        <ErrorNotice error={error || null} />
      </>
    );
  };
  return (
    <div className="fd-shell">
      <div className="fd-layout">
        <nav className="fd-nav" aria-label="Report navigation">
          <strong>
            <BookOpen size={18} />
            Reports
          </strong>
          {["Foundation", "Reports"].map((group) => (
            <div key={group}>
              <h2>{group === "Foundation" ? "Ledger" : "Analysis"}</h2>
              {foundationViews
                .filter((v) => v[2] === group)
                .map((v) => (
                  <a
                    href={"#" + v[0]}
                    key={v[0]}
                    aria-current={v[0] === view ? "page" : undefined}
                  >
                    {v[1]}
                  </a>
                ))}
            </div>
          ))}
        </nav>
        <section className="fd-sheet">
          <div className="fd-heading">
            <p>Financial reports</p>
            <h1>{def[1]}</h1>
            <p>{def[3]}</p>
          </div>
          {content()}
        </section>
      </div>
    </div>
  );
}
