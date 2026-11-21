import { describe, expect, it } from "vitest";
import { foundationReport, budgetKey } from "../src/shared/foundation";
import { exampleBook } from "../src/client/foundation-example";
import { taxPeriods } from "../src/shared/tax";
describe("Foundation reports", () => {
  it("reports June business profit in calendar Q2 and tax period three, and keeps personal entries, transfers and other currencies out", () => {
    const d = exampleBook(2026),
      e = {
        ...d.entries[0],
        posted: "2026-06-01",
        currency: "USD",
        business: 1,
        amount: 25000,
        type: "income",
      };
    d.entries = [
      e,
      { ...e, type: "expense", amount: -4000 },
      { ...e, business: 0 },
      { ...e, currency: "EUR" },
      { ...e, type: "transfer" },
    ];
    const q = foundationReport(d, "quarterly-earnings", "USD", 0);
    expect(q.rows[1]).toEqual(["Q2", 25000, 4000, 21000]);
    expect(
      taxPeriods(2026).find((p) => e.posted >= p.start && e.posted <= p.end)
        ?.quarter,
    ).toBe(3);
    expect(foundationReport(d, "spending-trends", "USD", 0).rows[5]).toEqual([
      "Jun",
      50000,
      4000,
      46000,
    ]);
  });
  it("adds only the selected year's monthly budget targets, and tracks favorable expense variance", () => {
    const d = exampleBook(2026);
    d.budgets = {
      [budgetKey("USD", 3, "software")]: 150000,
      [budgetKey("USD", 4, "software")]: 50000,
      [budgetKey("CAD", 2, "software")]: 9000,
    };
    expect(
      foundationReport(d, "monthly-budget", "USD", 3).rows.find(
        (r) => r[0] === "Software",
      ),
    ).toEqual(["Software", "expense", 150000, 12000, 138000]);
    expect(
      foundationReport(d, "yearly-budget", "USD", 0).rows.find(
        (r) => r[0] === "Software",
      )?.[2],
    ).toBe(200000);
    expect(
      foundationReport(
        d,
        "transaction-tracker",
        "USD",
        3,
        "tools",
        "Studio checking",
        "Software",
      ).rows,
    ).toHaveLength(1);
  });
});
