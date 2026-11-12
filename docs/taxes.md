# Tax estimation model

The planner estimates US federal ordinary-income and self-employment taxes plus one configurable state income tax. It is an editable planning model, not a filing or penalty-calculation engine.

Choose a manual annual business-profit forecast, or annualize year-to-date business income minus business expenses from tax-coded USD ledger entries. Pending transactions and transfers are excluded. Other taxable income, adjustments, deductions, credits, wage withholding and estimated payments are explicit inputs. Net wage deposits are not a substitute for gross wages and withholding.

Federal brackets apply marginally to each band. The 2026 preset is based on [IRS Revenue Procedure 2025-32 / IRB 2025-45](https://www.irs.gov/irb/2025-45_IRB); the Social Security wage base follows [SSA contribution and benefit bases](https://www.ssa.gov/oact/cola/cbb.html). Filing status changes do not silently replace customized rates; use “Load 2026 federal rates” to load matching preset assumptions. Other years require verified rates and dates.

Self-employment calculations apply the net-earnings factor, Social Security cap after entered wages, Medicare and the additional Medicare threshold. The deductible portion reduces federal income. State tax can be disabled, flat, or graduated, with its own adjustments, deductions, credits and withholding. All bracket boundaries and rates are editable.

The full-liability target subtracts expected withholding from estimated tax. The optional general federal safe-harbor target compares the current-year percentage with an eligible prior-year target, using entered prior tax, AGI and full-year eligibility. State targets use the full state estimate. Installment due dates and state allocation weights are editable. Recorded payments reduce cumulative shortfalls according to their dates; late payments do not appear as paid before their recorded date.

The YTD forecast is straight-line annualization, **not** the IRS annualized-income installment method. The model does not implement QBI, AMT, preferential capital-gains rates, itemized-deduction eligibility, refundable-credit eligibility, multi-state allocation, local taxes, or special filing/safe-harbor exceptions. Use explicit adjustments and verify the assumptions for your situation. Holiday changes and state-specific installment rules need review; the planner exposes the due dates rather than claiming universal schedules.

The UI exposes calculation bands, assumptions and source notes. Current YTD totals must load successfully before an estimate is shown; a failed refresh cannot silently reuse profit from a different cutoff.
