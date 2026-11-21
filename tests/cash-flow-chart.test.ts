import { describe, expect, it } from "vitest";
import { flowRows } from "../src/client/pages/CashFlowChart";

describe("cash-flow chart and table", () => {
  const months = {
    "2026-02": { income: 12005, expenses: 4000 },
    "2025-12": { income: 10000, expenses: 1000 },
    "2026-03": { income: 9000, expenses: -500 },
  };

  it("fills a silent month and sorts periods across the year boundary", () => {
    const rows = flowRows(months, "2025-12-12", "2026-03-31", "Monthly");
    expect(rows.map((row) => row.label)).toEqual([
      "Dec 25",
      "Jan 26",
      "Feb 26",
      "Mar 26",
    ]);
    expect(rows[1]).toMatchObject({ income: 0, expenses: 0 });
  });

  it("aggregates integer cents and refunds into calendar quarters", () => {
    expect(flowRows(months, "2025-12-12", "2026-03-31", "Quarterly")).toEqual([
      { label: "Q4 2025", income: 10000, expenses: 1000 },
      { label: "Q1 2026", income: 21005, expenses: 3500 },
    ]);
  });
});
