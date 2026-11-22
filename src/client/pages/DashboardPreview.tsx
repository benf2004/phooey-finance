import { LayoutDashboard, ArrowLeftRight, Landmark, Tags, Settings, FileText, Search, ArrowUpRight } from "lucide-react";
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
const initialRecords = [3000, 4500, 4000, 6000, 5500, 7000]
  .flatMap((income, i) => {
    const month = "2026-" + String(i + 1).padStart(2, "0");
    const costs = [1000, 1250, 1500, 1750, 1500, 2000];
    return [
      {
        id: month + "-20", account: "Business checking", reviewed: true,
        date: month + "-20",
        description: i % 2 ? "Studio North" : "Tern Design",
        category: "Client services",
        amount: income * 100,
      },
      {
        id: month + "-12", account: "Business checking", reviewed: i < 5,
        date: month + "-12",
        description: "Cedar Print",
        category: "Production",
        amount: -(costs[i] - 250) * 100,
      },
      {
        id: month + "-05", account: "Business card", reviewed: true,
        date: month + "-05",
        description: "Studio software",
        category: "Software",
        amount: -25000,
      },
    ];
  })
  .sort((a, b) => b.date.localeCompare(a.date));

export default function DashboardPreview() {
  const [records,setRecords] = useState(initialRecords);
  const [section,setSection] = useState("Overview");
  const [search,setSearch] = useState("");
  const [account,setAccount] = useState("All accounts");
  const [selected,setSelected] = useState<string>();
  const [reviewOnly,setReviewOnly] = useState(false);
  const [businessName,setBusinessName] = useState("Northline Studio");
  const selectedRecord = records.find(r => r.id === selected);
  const nav = [{name:"Overview",icon:LayoutDashboard},{name:"Transactions",icon:ArrowLeftRight},{name:"Accounts",icon:Landmark},{name:"Categories",icon:Tags},{name:"Settings",icon:Settings}];
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
      (account === "All accounts" || r.account === account) && (!reviewOnly || !r.reviewed) && (r.description + r.category).toLowerCase().includes(search.toLowerCase()) && (filter === "All transactions" ||
      (filter === "Income"
        ? r.amount > 0
        : filter === "Expenses"
          ? r.amount < 0
          : r.category === filter)),
  );
  const dashboard =
    location.protocol === "file:" || location.hostname === "getfinance.phooey.foo"
      ? "https://finance.phooey.foo/dashboard"
      : "/dashboard";
  function showTransactions(value: string) {
    setSection("Transactions");
    setFilter(value);
    document
      .getElementById("transactions")
      ?.scrollIntoView({ block: "nearest" });
  }
  return (
    <div className="preview-shell"><aside className="preview-sidebar"><a className="preview-logo" href="/business/"><img src="/business/assets/phooey.svg" alt="phooey!"/> finance</a><div className="preview-business"><strong>{businessName}</strong><small>Example business · USD</small></div><nav aria-label="Preview navigation">{nav.map(n => <button key={n.name} aria-current={section === n.name ? "page" : undefined} onClick={() => {setSection(n.name);setSelected(undefined);}}><n.icon size={18}/>{n.name}</button>)}<a href="https://getinvoicer.phooey.foo/"><FileText size={18}/> Invoicer <ArrowUpRight size={14}/></a></nav><a className="preview-signup" href="https://finance.phooey.foo/cloud/signup">Start free trial <ArrowUpRight size={15}/></a></aside><main className="dashboard-preview explorer">
      <header className="preview-brand">
        <span>Interactive preview · Fictional data</span>
<button onClick={() => {setRecords(initialRecords);setBusinessName("Northline Studio");setFilter("All transactions");setSearch("");setReviewOnly(false);setAccount("All accounts");setSelected(undefined);}}>Reset preview</button><a href={dashboard}>Open dashboard</a>
      </header>
      <header className="explorer-header">
        <div>
          <h1>{section}</h1>
          <p className="muted">{businessName} · USD</p>
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
      {section === "Overview" && <><section className="flow-panel" aria-label="Cash flow">
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
      <div className="preview-review-strip"><span><strong>{rows.filter(r => !r.reviewed).length}</strong> transaction{rows.filter(r => !r.reviewed).length === 1 ? "" : "s"} to review</span><button onClick={() => {setReviewOnly(true);setSection("Transactions");}}>Review transactions →</button><span>{records.length} sample transactions · 2 accounts</span></div></>}
      {(section === "Overview" || section === "Transactions") && <div className={section === "Overview" ? "explorer-lower" : "preview-register"}>
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
                  ...new Set([...Object.keys(categories), "Client services", "Office supplies"]),
                ].map((v) => (
                  <option key={v}>{v}</option>
                ))}
              </select>
            }
          >
            {section === "Transactions" && <div className="preview-register-tools"><label><Search size={16}/><input aria-label="Search preview transactions" placeholder="Search transactions…" value={search} onChange={e => setSearch(e.target.value)}/></label><select aria-label="Filter account" value={account} onChange={e => setAccount(e.target.value)}>{['All accounts','Business checking','Business card'].map(a => <option key={a}>{a}</option>)}</select><label><input type="checkbox" checked={reviewOnly} onChange={e => setReviewOnly(e.target.checked)}/> Needs review</label></div>}
            <div className="table-scroll">
              <table className="flow-register">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Description</th>
                    <th>Category</th><th>Account</th><th>Amount</th><th>Review</th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map((r) => (
                    <tr key={r.date}>
                      <td>{r.date.slice(5)}</td>
                      <td><button className="preview-row-link" onClick={() => setSelected(r.id)}>{r.description}</button></td><td>{r.category}</td><td>{r.account}</td>
                      <td className={r.amount > 0 ? "preview-income" : ""}>{formatMoney(r.amount)}</td><td><button className="preview-review" aria-label={`Mark ${r.description} ${r.date} ${r.reviewed ? "unreviewed" : "reviewed"}`} aria-pressed={r.reviewed} onClick={() => setRecords(old => old.map(x => x.id === r.id ? {...x,reviewed:!x.reviewed} : x))}>{r.reviewed ? "Reviewed" : "To review"}</button></td>
                    </tr>
                  ))}
                  {!entries.length && <tr><td colSpan={6}>No transactions match these filters.</td></tr>}
                </tbody>
              </table>
            </div>
          </Panel>
        </div>
        {section === "Overview" && <Panel title="Expenses by category">
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
        </Panel>}
      </div>}
      {section === "Accounts" && <Panel title="Business accounts"><div className="preview-account-grid">{['Business checking','Business card'].map((name,i) => { const movements = records.filter(r => r.account === name); const balance = (i ? 0 : 250000) + movements.reduce((sum,r) => sum+r.amount,0); return <button key={name} onClick={() => {setAccount(name);setFilter("All transactions");setSearch("");setReviewOnly(false);setSection("Transactions");}}><Landmark size={22}/><h2>{name}</h2><p>{i ? 'Credit card · Example Bank' : 'Checking · Example Bank'}</p><strong>{formatMoney(balance)}</strong><small>{movements.length} transactions · View activity →</small></button>; })}</div></Panel>}
      {section === "Categories" && <Panel title="Categories"><table className="flow-register"><thead><tr><th>Category</th><th>Type</th><th>Transactions</th><th>Period total</th></tr></thead><tbody>{['Client services','Production','Software','Office supplies'].map(name => { const matching = rows.filter(r => r.category === name); return <tr key={name}><td><button className="preview-row-link" onClick={() => {setAccount("All accounts");setReviewOnly(false);setSearch("");showTransactions(name);}}>{name}</button></td><td>{name === 'Client services' ? 'Income' : 'Expense'}</td><td>{matching.length}</td><td>{formatMoney(matching.reduce((sum,r) => sum+Math.abs(r.amount),0))}</td></tr>; })}</tbody></table></Panel>}
      {section === "Settings" && <Panel title="Business settings"><div className="preview-settings"><label>Business name<input value={businessName} onChange={e => setBusinessName(e.target.value)} maxLength={100}/></label><p>Changes here stay in this preview. Refresh or reset to start again.</p><h2>Bring your own records</h2><p>In your workspace, import CSV files, add transactions by hand, or connect optional bank syncing.</p><a href="https://finance.phooey.foo/cloud/signup">Create your workspace →</a><h2>Invoicing</h2><p>Manage clients, draft invoices, and track payments in the companion app.</p><a href="https://getinvoicer.phooey.foo/">Explore Invoicer →</a></div></Panel>}
      {selectedRecord && <div className="preview-detail" role="dialog" aria-label="Transaction details" onKeyDown={e => {if(e.key === 'Escape') setSelected(undefined);}}><div><button className="preview-close" onClick={() => setSelected(undefined)} autoFocus>Close ×</button><h2>{selectedRecord.description}</h2><p>{selectedRecord.date} · {selectedRecord.account}</p><strong>{formatMoney(selectedRecord.amount)}</strong><label>Category<select value={selectedRecord.category} onChange={e => setRecords(old => old.map(r => r.id === selected ? {...r,category:e.target.value} : r))}>{['Client services','Production','Software','Office supplies'].map(c => <option key={c}>{c}</option>)}</select></label><label><input type="checkbox" checked={selectedRecord.reviewed} onChange={e => setRecords(old => old.map(r => r.id === selected ? {...r,reviewed:e.target.checked} : r))}/> Reviewed</label><p>Edits update the sample reports immediately.</p></div></div>}
    </main></div>
  );
}
