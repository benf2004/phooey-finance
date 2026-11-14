# Quarterly tax estimates

The tax screen uses recorded profit through the selected date, without annualizing it or forecasting future earnings. Choose one transaction tag to include; the selection is saved separately for each tax year. Existing and new transactions default to `Business`. Tags can be added, removed, and reused in transaction details, and transactions can be filtered by tag.

## Included transactions

The selected tag is matched without regard to case. Posted USD income and expenses contribute to profit, including uncategorized entries. Transfers, pending or deleted transactions, archived accounts, and categories with `tax_payment` or `excluded` treatment do not contribute. Other currencies are excluded and identified in the UI. For split transactions, each split's type and category determine whether its amount contributes; the parent transaction's tags apply to all splits. Expense refunds reduce expenses.

## Spreadsheet calculation

The periods match the supplied Tiller workbook: January–March, April–May, June–August, and September–December. A period includes only transactions through the selected cutoff. Future periods remain uncalculated.

For each started period, federal tax uses cumulative profit:

1. Self-employment net earnings = positive cumulative profit × 92.35%.
2. Self-employment tax = 12.4% of net earnings up to the remaining Social Security wage base, plus 2.9% of net earnings. Round to whole dollars, as in the workbook. Additional Medicare tax uses the configured threshold when applicable.
3. Deduct half of self-employment tax, rounded to whole dollars, and the accrued annual federal deduction (one fourth per started period).
4. Apply the editable federal brackets marginally to remaining taxable income. Round federal income tax to whole dollars, apply nonrefundable credits, and add self-employment taxes.
5. The quarter's estimate is the cumulative tax minus the previous quarter's cumulative tax. A negative change reduces the estimate; it is not a refund.

State tax uses cumulative profit **before** the federal self-employment deduction, matching the spreadsheet's simplified state formula. The configured flat rate or graduated brackets, state adjustments, accrued state deduction, and credits apply. State cumulative totals round to cents, so the difference between consecutive totals can differ by one cent from rounding a quarter independently.

Other taxable income, adjustments, credits, and withholding entered to date are allocated evenly across started periods. Deductions are annual amounts. Net wage deposits are not a substitute for gross wages and withholding. Recorded estimated payments reduce unpaid totals separately from quarterly changes; payment dates determine whether a payment was made by a quarter's due date.

## Rates and limitations

The 2026 federal preset references [IRS Revenue Procedure 2025-32 / IRB 2025-45](https://www.irs.gov/irb/2025-45_IRB) and the [SSA contribution and benefit bases](https://www.ssa.gov/oact/cola/cbb.html). Filing status changes do not silently replace custom rates. Use “Load 2026 federal rates” to replace the federal assumptions with that preset. Other years require verified rates and dates. Existing state rates and other assumptions are preserved during the tag migration.

This is the workbook's simplified estimate, not a filing, penalty, safe-harbor, or IRS annualized-income installment calculation. It does not implement QBI, AMT, preferential capital-gains rates, itemized-deduction eligibility, refundable-credit eligibility, or state-specific credits. Whole-dollar federal rounding and calculation on small amounts intentionally follow the workbook. Legacy `manual` and `ytd` modes remain supported by the calculation API for compatibility, but saved profiles migrate to `quarterly` and the UI uses actual quarterly estimates.

Tag and cutoff changes reload ledger totals before displaying an estimate. A failed refresh cannot silently reuse totals for another tag or date. Tags survive bank syncs, appear in CSV exports, and round-trip in portable backups. Older backups without tags receive the `Business` default.
