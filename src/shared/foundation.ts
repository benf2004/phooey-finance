export const foundationViews = [
  [
    "spending-trends",
    "Spending Trends",
    "Foundation",
    "Income, spending and cash flow by month.",
  ],
  [
    "monthly-budget",
    "Monthly Budget",
    "Foundation",
    "Compare a month's plan with posted income and expenses.",
  ],
  [
    "yearly-budget",
    "Yearly Budget",
    "Foundation",
    "See annual targets and actuals by category.",
  ],
  [
    "transactions",
    "Transactions",
    "Foundation",
    "Review the posted ledger and its split allocations.",
  ],
  [
    "categories",
    "Categories",
    "Foundation",
    "Organize income, expenses and business activity.",
  ],
  [
    "accounts",
    "Accounts",
    "Foundation",
    "See the institutions and accounts in your ledger.",
  ],
  [
    "balances",
    "Balances",
    "Foundation",
    "See assets, liabilities and net worth.",
  ],
  [
    "balance-history",
    "Balance History",
    "Foundation",
    "Inspect dated balance observations.",
  ],
  [
    "autocat",
    "AutoCat",
    "Foundation",
    "Review automatic categorization rules in priority order.",
  ],
  [
    "transaction-tracker",
    "Transaction Tracker",
    "Reports",
    "Find transactions by description, category or account.",
  ],
  [
    "business-dashboard",
    "Business Dashboard",
    "Reports",
    "Compare business income, expenses and profit by month.",
  ],
  [
    "quarterly-earnings",
    "Quarterly Earnings",
    "Reports",
    "Track business revenue, expenses and profit by calendar quarter.",
  ],
  [
    "estimated-tax",
    "Estimated Quarterly Tax",
    "Reports",
    "Review estimated payments using the tax year's filing assumptions.",
  ],
  [
    "archived-tax",
    "Archived Estimated Tax",
    "Reports",
    "Review a previous tax year with its saved assumptions.",
  ],
] as const;
export type ViewId = (typeof foundationViews)[number][0];
export type Entry = {
  posted: string;
  description: string;
  amount: number;
  type: string;
  category: string;
  account: string;
  currency: string;
  business: number;
};
export type FoundationData = {
  year: number;
  entries: Entry[];
  accounts: {
    id: string;
    name: string;
    institution: string;
    kind: string;
    currency: string;
    balance: number;
  }[];
  history: {
    captured_at: string;
    name: string;
    currency: string;
    balance: number;
  }[];
  categories: {
    id: string;
    name: string;
    type: string;
    tax_treatment: string;
  }[];
  rules: {
    name: string;
    pattern: string;
    match_field: string;
    category: string;
    priority: number;
    enabled: number;
  }[];
  budgets: Record<string, number>;
};
export const budgetKey = (currency: string, month: number, category: string) =>
  [currency, String(month).padStart(2, "0"), category].join("/");
export const monthNames = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];
export type ReportCell = string | number;
export type Report = {
  columns: string[];
  rows: ReportCell[][];
  money: number[];
};
export function foundationReport(
  d: FoundationData,
  view: ViewId,
  currency: string,
  month: number,
  search = "",
  account = "",
  category = "",
): Report {
  const entries = d.entries.filter((e) => e.currency === currency),
    accounts = d.accounts.filter((a) => a.currency === currency);
  const make = (
    columns: string[],
    rows: ReportCell[][],
    money: number[] = [],
  ): Report => ({ columns, rows, money });
  const totals = (rows: Entry[]) => {
    let income = 0,
      expenses = 0;
    for (const e of rows) {
      if (e.type === "income") income += e.amount;
      else if (e.type === "expense") expenses -= e.amount;
    }
    return [income, expenses, income - expenses];
  };
  const matchMonth = (e: Entry, m: number) =>
    Number(e.posted.slice(5, 7)) === m;
  if (
    view === "business-dashboard" ||
    view === "quarterly-earnings" ||
    view === "spending-trends"
  ) {
    const business = view !== "spending-trends",
      quarter = view === "quarterly-earnings";
    const selected = business ? entries.filter((e) => e.business) : entries;
    return make(
      [
        quarter ? "Calendar quarter" : "Month",
        "Income",
        "Expenses",
        "Net " + (business ? "profit" : "cash flow"),
      ],
      Array.from({ length: quarter ? 4 : 12 }, (_, i) => [
        quarter ? "Q" + (i + 1) : monthNames[i],
        ...totals(
          selected.filter((e) =>
            quarter
              ? Math.floor((Number(e.posted.slice(5, 7)) - 1) / 3) === i
              : matchMonth(e, i + 1),
          ),
        ),
      ]),
      [1, 2, 3],
    );
  }
  if (view === "transactions" || view === "transaction-tracker")
    return make(
      ["Date", "Description", "Category", "Account", "Amount"],
      entries
        .filter(
          (e) =>
            (!month || matchMonth(e, month)) &&
            (!account || e.account === account) &&
            (!category || e.category === category) &&
            [e.description, e.account, e.category]
              .join(" ")
              .toLowerCase()
              .includes(search.toLowerCase()),
        )
        .map((e) => [
          e.posted,
          e.description,
          e.category || "Uncategorized",
          e.account,
          e.amount,
        ]),
      [4],
    );
  if (view === "accounts")
    return make(
      ["Account", "Institution", "Account type", "Currency"],
      accounts.map((a) => [a.name, a.institution, a.kind, a.currency]),
    );
  if (view === "balances")
    return make(
      ["Account", "Class", "Net balance"],
      accounts.map((a) => [
        a.name,
        ["credit", "loan"].includes(a.kind) ? "Liability" : "Asset",
        a.balance,
      ]),
      [2],
    );
  if (view === "balance-history")
    return make(
      ["Observed", "Account", "Balance"],
      d.history
        .filter((b) => b.currency === currency)
        .map((b) => [b.captured_at, b.name, b.balance]),
      [2],
    );
  if (view === "categories")
    return make(
      ["Category", "Type", "Tax treatment"],
      d.categories.map((c) => [
        c.name,
        c.type,
        c.tax_treatment.replaceAll("_", " "),
      ]),
    );
  if (view === "autocat")
    return make(
      ["Priority", "Rule", "Match field", "Contains", "Category", "Status"],
      d.rules.map((r) => [
        r.priority,
        r.name,
        r.match_field,
        r.pattern,
        r.category,
        r.enabled ? "Active" : "Paused",
      ]),
    );
  if (view === "monthly-budget" || view === "yearly-budget") {
    const m = view === "monthly-budget" ? month : 0;
    const actuals = new Map<string, number>();
    for (const e of entries) {
      if (e.type === "transfer" || (m && !matchMonth(e, m))) continue;
      const key = e.type + "/" + e.category;
      actuals.set(
        key,
        (actuals.get(key) || 0) + (e.type === "expense" ? -e.amount : e.amount),
      );
    }
    const categories = d.categories
      .filter((c) => c.type !== "transfer")
      .concat(
        ["income", "expense"]
          .filter((type) => actuals.has(type + "/"))
          .map((type) => ({ id: "", name: "", type, tax_treatment: "" })),
      );
    return make(
      ["Category", "Type", "Budget", "Actual", "Favorable variance"],
      categories.map((c) => {
        const target = (m ? [m] : monthNames.map((_, i) => i + 1)).reduce(
            (s, n) => s + (d.budgets[budgetKey(currency, n, c.id)] || 0),
            0,
          ),
          actual = actuals.get(c.type + "/" + c.name) || 0;
        return [
          c.name || "Uncategorized",
          c.type,
          target,
          actual,
          c.type === "income" ? actual - target : target - actual,
        ];
      }),
      [2, 3, 4],
    );
  }
  throw Error("Open the tax planner for this report.");
}
