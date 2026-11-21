import {
  budgetKey,
  type Entry,
  type FoundationData,
} from "../shared/foundation";

// Fictional records from the public Google Sheets master.
export function exampleBook(year: number): FoundationData {
  const account = {
    id: "sample",
    name: "Studio checking",
    institution: "Example Bank",
    kind: "checking",
    currency: "USD",
    balance: 1003500,
  };
  const categories = [
    {
      id: "projects",
      name: "Client work",
      type: "income",
      tax_treatment: "business_income",
    },
    {
      id: "software",
      name: "Software",
      type: "expense",
      tax_treatment: "business_expense",
    },
    { id: "food", name: "Food", type: "expense", tax_treatment: "personal" },
  ];
  const sample: [string, string, number, number][] = [
    ["2026-03-13", "Design milestone", 0, 460000],
    ["2026-03-17", "Creative tools", 1, -12000],
    ["2026-04-09", "Studio supplies", 1, -4500],
    ["2026-06-15", "Design milestone", 0, 560000],
    ["2026-09-03", "Market", 2, -7500],
    ["2025-03-04", "Previous year project", 0, 240000],
  ];
  const entries: Entry[] = sample
    .filter((r) => r[0].startsWith(year + "-"))
    .map(([posted, description, index, amount]) => {
      const c = categories[index];
      return {
        posted,
        description,
        amount,
        type: c.type,
        category: c.name,
        account: account.name,
        currency: "USD",
        business: c.tax_treatment.startsWith("business_") ? 1 : 0,
      };
    })
    .sort((a, b) => b.posted.localeCompare(a.posted));
  const budgets =
    year === 2026
      ? Object.fromEntries(
          categories.map((c, i) => [
            budgetKey("USD", 3, c.id),
            [500000, 15000, 30000][i],
          ]),
        )
      : {};
  return {
    year,
    entries,
    accounts: [account],
    categories,
    budgets,
    history:
      year === 2026
        ? [
            {
              captured_at: "2026-06-15",
              name: account.name,
              currency: "USD",
              balance: 1003500,
            },
            {
              captured_at: "2026-03-17",
              name: account.name,
              currency: "USD",
              balance: 448000,
            },
          ]
        : [],
    rules: [
      {
        name: "Creative tools",
        priority: 1,
        match_field: "description",
        pattern: "Creative tools",
        category: "Software",
        enabled: 1,
      },
    ],
  };
}
