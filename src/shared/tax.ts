import { z } from "zod";
import { dateSchema, moneySchema, type Payment } from "./models";
export const bracketSchema = z.object({
  upTo: moneySchema.nullable(),
  rate: z.number().min(0).max(1),
});
export const bracketsSchema = z
  .array(bracketSchema)
  .min(1)
  .max(20)
  .refine(
    (b) =>
      b.at(-1)?.upTo === null &&
      b
        .slice(0, -1)
        .every(
          (v, i) =>
            v.upTo !== null &&
            v.upTo > 0 &&
            (i === 0 || v.upTo > (b[i - 1].upTo ?? Infinity)),
        ),
    "Brackets must increase and end with an unlimited band",
  );
export const taxSchema = z
  .object({
    year: z.number().int().min(2000).max(2100),
    filingStatus: z.enum(["single", "joint", "separate", "head"]),
    mode: z.enum(["manual", "ytd"]),
    asOf: dateSchema,
    businessProfit: moneySchema,
    otherIncome: moneySchema,
    deduction: moneySchema.refine((v) => v >= 0),
    adjustments: moneySchema,
    credits: moneySchema.refine((v) => v >= 0),
    withholding: moneySchema.refine((v) => v >= 0),
    federalBrackets: bracketsSchema,
    selfEmployment: z.boolean(),
    ssWages: moneySchema.refine((v) => v >= 0),
    ssCap: moneySchema.refine((v) => v >= 0),
    additionalMedicareThreshold: moneySchema.refine((v) => v >= 0),
    stateName: z.string().max(80),
    stateMode: z.enum(["none", "flat", "graduated"]),
    stateRate: z.number().min(0).max(1),
    stateBrackets: bracketsSchema,
    stateDeduction: moneySchema.refine((v) => v >= 0),
    stateAdjustments: moneySchema,
    stateCredits: moneySchema.refine((v) => v >= 0),
    stateWithholding: moneySchema.refine((v) => v >= 0),
    priorTax: moneySchema.nullable(),
    priorAGI: moneySchema.nullable(),
    priorFullYear: z.boolean(),
    paymentMethod: z.enum(["projected", "safe-harbor"]),
    federalDueDates: z.array(dateSchema).length(4),
    stateDueDates: z.array(dateSchema).length(4),
    stateInstallments: z
      .array(z.number().min(0).max(1))
      .length(4)
      .refine(
        (a) => Math.abs(a.reduce((s, v) => s + v, 0) - 1) < 1e-8,
        "Installments must total 100%",
      ),
    source: z.string().max(1000),
    notes: z.string().max(4000),
  })
  .refine(
    (v) => v.asOf.startsWith(String(v.year)),
    "As-of date must be in the tax year",
  );
export type TaxProfile = z.infer<typeof taxSchema>;
const rates = [0.1, 0.12, 0.22, 0.24, 0.32, 0.35, 0.37];
const thresholds = {
  single: [12400, 50400, 105700, 201775, 256225, 640600],
  joint: [24800, 100800, 211400, 403550, 512450, 768700],
  separate: [12400, 50400, 105700, 201775, 256225, 384350],
  head: [17700, 67450, 105700, 201750, 256200, 640600],
};
export function federalPreset(status: TaxProfile["filingStatus"]) {
  return {
    federalBrackets: [
      ...thresholds[status].map((upTo, i) => ({
        upTo: upTo * 100,
        rate: rates[i],
      })),
      { upTo: null, rate: 0.37 },
    ],
    deduction:
      { single: 16100, joint: 32200, separate: 16100, head: 24150 }[status] *
      100,
    additionalMedicareThreshold:
      { single: 200000, joint: 250000, separate: 125000, head: 200000 }[
        status
      ] * 100,
  };
}
function businessDay(date: string) {
  const d = new Date(date + "T12:00:00Z");
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6)
    d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
export function defaultTaxProfile(year = 2026): TaxProfile {
  return {
    year,
    filingStatus: "single",
    mode: "manual",
    asOf: `${year}-12-31`,
    businessProfit: 0,
    otherIncome: 0,
    ...federalPreset("single"),
    adjustments: 0,
    credits: 0,
    withholding: 0,
    selfEmployment: true,
    ssWages: 0,
    ssCap: 18450000,
    stateName: "My state",
    stateMode: "none",
    stateRate: 0,
    stateBrackets: [{ upTo: null, rate: 0 }],
    stateDeduction: 0,
    stateAdjustments: 0,
    stateCredits: 0,
    stateWithholding: 0,
    priorTax: null,
    priorAGI: null,
    priorFullYear: false,
    paymentMethod: "projected",
    federalDueDates: [
      `${year}-04-15`,
      `${year}-06-15`,
      `${year}-09-15`,
      `${year + 1}-01-15`,
    ].map(businessDay),
    stateDueDates: [
      `${year}-04-15`,
      `${year}-06-15`,
      `${year}-09-15`,
      `${year + 1}-01-15`,
    ].map(businessDay),
    stateInstallments: [0.25, 0.25, 0.25, 0.25],
    source:
      "2026 federal: https://www.irs.gov/irb/2025-45_IRB; Social Security: https://www.ssa.gov/oact/cola/cbb.html",
    notes:
      year === 2026
        ? ""
        : "Rates copied from 2026. Verify and update all rates, deductions, limits, and due dates for this tax year.",
  };
}
export function progressiveTax(
  taxable: number,
  brackets: z.infer<typeof bracketsSchema>,
) {
  let lower = 0;
  const bands = brackets.map((b) => {
    const base = Math.max(0, Math.min(taxable, b.upTo ?? taxable) - lower);
    const tax = Math.round(base * b.rate);
    const band = { from: lower, to: b.upTo, rate: b.rate, taxable: base, tax };
    lower = b.upTo ?? taxable;
    return band;
  });
  return { tax: bands.reduce((s, b) => s + b.tax, 0), bands };
}
export function estimateTax(
  input: TaxProfile,
  payments: Payment[] = [],
  ledgerProfit = 0,
) {
  const p = taxSchema.parse(input);
  const start = new Date(`${p.year}-01-01T00:00:00Z`).getTime(),
    end = new Date(`${p.year + 1}-01-01T00:00:00Z`).getTime(),
    elapsed =
      (new Date(p.asOf + "T00:00:00Z").getTime() - start) / 86400000 + 1;
  const factor = (end - start) / 86400000 / elapsed;
  const profit =
    p.mode === "ytd" ? Math.round(ledgerProfit * factor) : p.businessProfit;
  const netSE = Math.round(Math.max(0, profit) * 0.9235);
  const se =
    p.selfEmployment && netSE >= 40000
      ? Math.round(
          Math.min(netSE, Math.max(0, p.ssCap - p.ssWages)) * 0.124 +
            netSE * 0.029,
        )
      : 0;
  const extraMedicare =
    p.selfEmployment && netSE >= 40000
      ? Math.round(
          Math.max(
            0,
            netSE - Math.max(0, p.additionalMedicareThreshold - p.ssWages),
          ) * 0.009,
        )
      : 0;
  const seDeduction = Math.round(se / 2);
  const adjustedIncome = profit + p.otherIncome + p.adjustments - seDeduction;
  const taxable = Math.max(0, adjustedIncome - p.deduction);
  const federal = progressiveTax(taxable, p.federalBrackets);
  const federalTotal =
    Math.max(0, federal.tax - p.credits) + se + extraMedicare;
  const stateTaxable = Math.max(
    0,
    adjustedIncome + p.stateAdjustments - p.stateDeduction,
  );
  const state =
    p.stateMode === "graduated"
      ? progressiveTax(stateTaxable, p.stateBrackets)
      : progressiveTax(stateTaxable, [
          { upTo: null, rate: p.stateMode === "flat" ? p.stateRate : 0 },
        ]);
  const stateTotal =
    p.stateMode === "none" ? 0 : Math.max(0, state.tax - p.stateCredits);
  const priorEligible =
    p.priorFullYear &&
    p.priorTax !== null &&
    p.priorTax >= 0 &&
    p.priorAGI !== null;
  const priorMultiplier =
    (p.priorAGI ?? 0) > (p.filingStatus === "separate" ? 7500000 : 15000000)
      ? 1.1
      : 1;
  const safeTarget = priorEligible
    ? Math.min(
        Math.round(federalTotal * 0.9),
        Math.round(p.priorTax! * priorMultiplier),
      )
    : Math.round(federalTotal * 0.9);
  const target = p.paymentMethod === "safe-harbor" ? safeTarget : federalTotal;
  const federalRequired = Math.max(0, target - p.withholding);
  const stateRequired = Math.max(0, stateTotal - p.stateWithholding);
  const all = payments.filter((x) => x.year === p.year);
  const paidFederal = all
      .filter((x) => x.jurisdiction === "federal")
      .reduce((s, x) => s + x.amount, 0),
    paidState = all
      .filter((x) => x.jurisdiction === "state")
      .reduce((s, x) => s + x.amount, 0);
  const schedule = (
    jurisdiction: "federal" | "state",
    required: number,
    dates: string[],
    weights: number[],
  ) => {
    let cumulative = 0;
    return dates.map((due, i) => {
      const previous = Math.round(required * cumulative);
      cumulative += weights[i];
      const cumulativeTarget = Math.round(required * cumulative);
      const paidByDue = all
        .filter((x) => x.jurisdiction === jurisdiction && x.paid_on <= due)
        .reduce((s, x) => s + x.amount, 0);
      return {
        quarter: i + 1,
        due,
        target: cumulativeTarget - previous,
        cumulativeTarget,
        paidByDue,
        shortfall: Math.max(0, cumulativeTarget - paidByDue),
      };
    });
  };
  return {
    year: p.year,
    currency: "USD",
    profit,
    projectionFactor: p.mode === "ytd" ? factor : 1,
    adjustedIncome,
    taxable,
    seDeduction,
    selfEmploymentTax: se,
    additionalMedicare: extraMedicare,
    federalIncomeTax: federal.tax,
    federalTotal,
    stateTaxable,
    stateTotal,
    total: federalTotal + stateTotal,
    effectiveRate:
      profit + p.otherIncome > 0
        ? (federalTotal + stateTotal) / (profit + p.otherIncome)
        : 0,
    federalBands: federal.bands,
    stateBands: state.bands,
    safeHarborTarget: safeTarget,
    priorEligible,
    priorMultiplier,
    federalRequired,
    stateRequired,
    paidFederal,
    paidState,
    remainingFederal: Math.max(0, federalRequired - paidFederal),
    remainingState: Math.max(0, stateRequired - paidState),
    federalSchedule: schedule(
      "federal",
      federalRequired,
      p.federalDueDates,
      [0.25, 0.25, 0.25, 0.25],
    ),
    stateSchedule: schedule(
      "state",
      stateRequired,
      p.stateDueDates,
      p.stateInstallments,
    ),
    assumptions: [
      "USD ordinary-income planning estimate. Capital gains, AMT, QBI, special deductions and multi-state allocation require manual adjustments.",
      "YTD projection is a straight-line forecast, not the IRS annualized-income installment method.",
      "Withholding is allocated evenly. Due dates are editable; verify holidays and state rules.",
      "Safe-harbor targets apply to the general individual rules; special taxpayer exceptions are not modeled.",
      ...(p.year !== 2026
        ? ["Default rates originate in 2026; verify this year’s saved rates."]
        : []),
    ],
  };
}
export type TaxEstimate = ReturnType<typeof estimateTax>;
