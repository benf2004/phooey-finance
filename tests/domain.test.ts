import { describe, it, expect } from "vitest";
import { parseMoney } from "../src/shared/money";
import { parseCSV, encodeCSV, normalizeDate } from "../src/shared/csv";
import {
  defaultTaxProfile,
  estimateTax,
  progressiveTax,
  taxSchema,
} from "../src/shared/tax";
import { transactionSchema } from "../src/shared/models";
import { ruleMatches } from "../src/server/ledger";
describe("money and import correctness", () => {
  it("converts decimal strings without floating point drift", () => {
    expect(parseMoney("1.01")).toBe(101);
    expect(parseMoney("($1,234.56)")).toBe(-123456);
    expect(() => parseMoney("1.001")).toThrow();
    expect(() => parseMoney("Infinity")).toThrow();
  });
  it("parses quoted commas, quotes, CRLF and embedded newlines", () =>
    expect(
      parseCSV(
        'date,description,amount\r\n2026-01-01,"A, ""nice""\nshop",-1.20',
      ),
    ).toEqual([
      ["date", "description", "amount"],
      ["2026-01-01", 'A, "nice"\nshop', "-1.20"],
    ]));
  it("rejects broken dates and ambiguous dates unless a format is chosen", () => {
    expect(normalizeDate("11/02/2026", "mdy")).toBe("2026-11-02");
    expect(() => normalizeDate("2026-02-30")).toThrow();
  });
  it("protects spreadsheet formulas while preserving numeric amounts", () => {
    expect(encodeCSV([['=HYPERLINK("bad")', -1.25]])).toContain(
      "\"'=HYPERLINK",
    );
    expect(encodeCSV([[-1.25]])).toContain('"-1.25"');
  });
  it("requires split totals to reconcile", () => {
    expect(() =>
      transactionSchema.parse({
        account_id: "a",
        posted: "2026-01-01",
        amount: -100,
        description: "A",
        type: "expense",
        splits: [{ amount: -99, category_id: null, type: "expense" }],
      }),
    ).toThrow();
  });
});
describe("tax engine", () => {
  it("taxes only the income within each marginal band", () => {
    const b = [
      { upTo: 1000000, rate: 0.1 },
      { upTo: null, rate: 0.2 },
    ];
    expect(progressiveTax(1000000, b).tax).toBe(100000);
    expect(progressiveTax(1000100, b).tax).toBe(100020);
    expect(progressiveTax(-100, b).tax).toBe(0);
  });
  it("matches the published 2026 single bracket boundary", () => {
    const p = defaultTaxProfile();
    expect(progressiveTax(5040000, p.federalBrackets).tax).toBe(580000);
    expect(progressiveTax(10570000, p.federalBrackets).tax).toBe(1796600);
  });
  it("caps Social Security and accounts for wages already taxed", () => {
    const p = {
      ...defaultTaxProfile(),
      businessProfit: 10000000,
      ssWages: 18450000,
      otherIncome: 0,
    };
    const e = estimateTax(p);
    expect(e.selfEmploymentTax).toBe(Math.round(9235000 * 0.029));
  });
  it("keeps tax credits from offsetting self-employment tax", () => {
    const e = estimateTax({
      ...defaultTaxProfile(),
      businessProfit: 5000000,
      credits: 10000000,
    });
    expect(e.federalTotal).toBe(e.selfEmploymentTax + e.additionalMedicare);
  });
  it("supports state flat rates, separate deductions, and no-tax state", () => {
    const p = {
      ...defaultTaxProfile(),
      selfEmployment: false,
      businessProfit: 10000000,
      stateMode: "flat" as const,
      stateRate: 0.05,
      stateDeduction: 1000000,
    };
    expect(estimateTax(p).stateTotal).toBe(450000);
    expect(estimateTax({ ...p, stateMode: "none" }).stateTotal).toBe(0);
  });
  it("allocates cents across installments without losing money", () => {
    const p = {
      ...defaultTaxProfile(),
      selfEmployment: false,
      businessProfit: 10000001,
      withholding: 12345,
    };
    const e = estimateTax(p);
    expect(e.federalSchedule.reduce((s, q) => s + q.target, 0)).toBe(
      e.federalRequired,
    );
  });
  it("does not count late payments as timely", () => {
    const p = {
      ...defaultTaxProfile(),
      selfEmployment: false,
      businessProfit: 10000000,
    };
    const e = estimateTax(p, [
      {
        id: "p",
        year: 2026,
        paid_on: "2026-08-01",
        jurisdiction: "federal",
        amount: 100000,
        notes: "",
        transaction_id: null,
      },
    ]);
    expect(e.federalSchedule[0].paidByDue).toBe(0);
    expect(e.federalSchedule[2].paidByDue).toBe(100000);
  });
  it("uses higher income prior-year safe harbor only for a full-year return", () => {
    const p = {
      ...defaultTaxProfile(),
      selfEmployment: false,
      businessProfit: 100000000,
      priorTax: 1000000,
      priorAGI: 20000000,
      priorFullYear: true,
      paymentMethod: "safe-harbor" as const,
    };
    expect(estimateTax(p).safeHarborTarget).toBe(1100000);
    expect(estimateTax({ ...p, priorFullYear: false }).priorEligible).toBe(
      false,
    );
  });
  it("rejects descending brackets and invalid allocation weights", () => {
    expect(
      taxSchema.safeParse({
        ...defaultTaxProfile(),
        stateInstallments: [0.2, 0.2, 0.2, 0.2],
      }).success,
    ).toBe(false);
    expect(
      taxSchema.safeParse({
        ...defaultTaxProfile(),
        federalBrackets: [
          { upTo: 200, rate: 0.1 },
          { upTo: 100, rate: 0.2 },
          { upTo: null, rate: 0.3 },
        ],
      }).success,
    ).toBe(false);
  });
});

it("round-trips its own BOM-prefixed export", () => {
  expect(
    parseCSV(
      encodeCSV([
        ["Date", "Description", "Amount"],
        ["2026-01-01", "Office", -12.34],
      ]),
    )[1],
  ).toEqual(["2026-01-01", "Office", "-12.34"]);
});
