import { describe, it, expect } from "vitest";
import { defaultTaxProfile, estimateTax, taxPeriods } from "../src/shared/tax";

const profile = () => ({
  ...defaultTaxProfile(2026),
  asOf: "2026-11-12",
  stateMode: "flat" as const,
  stateRate: 0.0445,
});
const periods = (profits: number[]) =>
  taxPeriods(2026).map((q, i) => ({
    ...q,
    profit: profits[i],
    income: Math.max(0, profits[i]),
    expenses: Math.max(0, -profits[i]),
  }));

describe("actual quarterly estimates", () => {
  it("follows spreadsheet rounding, including negative quarterly adjustments", () => {
    const e = estimateTax(
      profile(),
      [],
      293000,
      periods([10000, -2000, 300000, -15000]),
    );
    expect(e.profit).toBe(293000);
    expect(e.projectionFactor).toBe(1);
    expect(e.selfEmploymentTax).toBe(41400);
    expect(e.seDeduction).toBe(20700);
    expect(e.federalIncomeTax).toBe(0);
    expect(e.federalSchedule.map((q) => q.target)).toEqual([
      1400, -300, 42400, -2100,
    ]);
    expect(e.stateSchedule.map((q) => q.target)).toEqual([
      445, -89, 13350, -667,
    ]);
    expect(e.total).toBe(54439);
  });

  it("never projects earnings or calculates future periods", () => {
    const e = estimateTax(
      { ...profile(), asOf: "2026-05-31" },
      [],
      8000,
      periods([10000, -2000, 99999999, 99999999]),
    );
    expect(e.profit).toBe(8000);
    expect(e.selfEmploymentTax).toBe(1100);
    expect(e.federalSchedule.map((q) => q.target)).toEqual([1400, -300, 0, 0]);
    expect(e.stateSchedule.map((q) => q.target)).toEqual([445, -89, 0, 0]);
    expect(e.total).toBe(1456);
  });

  it("accrues the deduction by quarter and taxes cumulative profit marginally", () => {
    const e = estimateTax(
      { ...profile(), selfEmployment: false },
      [],
      2000000,
      periods([500000, 500000, 500000, 500000]),
    );
    expect(e.federalSchedule.map((q) => q.target)).toEqual([
      9800, 9700, 9800, 9700,
    ]);
    expect(e.taxable).toBe(390000);
    expect(e.stateTotal).toBe(89000);
  });

  it("does not turn cumulative losses into a negative tax bill", () => {
    const e = estimateTax(
      profile(),
      [],
      -10000,
      periods([10000, -20000, 0, 0]),
    );
    expect(e.total).toBe(0);
    expect(e.federalSchedule.map((q) => q.target)).toEqual([1400, -1400, 0, 0]);
    expect(e.remainingFederal).toBe(0);
  });

  it("keeps payments separate from quarterly tax changes and respects their dates", () => {
    const p = {
      id: "p",
      year: 2026,
      jurisdiction: "federal" as const,
      paid_on: "2026-08-01",
      amount: 1000,
      notes: "",
      transaction_id: null,
    };
    const e = estimateTax(
      profile(),
      [p],
      293000,
      periods([10000, -2000, 300000, -15000]),
    );
    expect(e.federalSchedule[0].paidByDue).toBe(0);
    expect(e.federalSchedule[2].paidByDue).toBe(1000);
    expect(e.federalSchedule[3].target).toBe(-2100);
    expect(e.remainingFederal).toBe(40400);
  });

  it("requires real period totals instead of silently using a forecast", () => {
    expect(() => estimateTax(profile())).toThrow("Quarterly ledger totals");
    expect(defaultTaxProfile().transactionTag).toBe("Business");
  });
});
