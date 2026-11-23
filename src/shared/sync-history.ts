export type HistorySample = {
  from: string;
  to: string;
  accounts: {
    id: string;
    name: string;
    returned: boolean;
    count: number;
    oldest: string | null;
    newest: string | null;
    missingFromLedger: number;
  }[];
  warnings: string[];
};

export type HistoryCheck = {
  checkedAt: string;
  samples: HistorySample[];
};

export function historyFinding(check: HistoryCheck, accountId: string) {
  const [older, recent] = check.samples;
  const oldAccount = older?.accounts.find((a) => a.id === accountId);
  const recentAccount = recent?.accounts.find((a) => a.id === accountId);
  if (oldAccount?.count) {
    return oldAccount.missingFromLedger
      ? `SimpleFIN returned older history, including ${oldAccount.missingFromLedger} transactions missing from your ledger. The provider is not limiting this account to 90 days; retry importing this period.`
      : "SimpleFIN returned older history, and those transactions are already in your ledger. Check the account and date filters in Transactions.";
  }
  if (
    !oldAccount?.returned ||
    !recentAccount?.returned ||
    older.warnings.length ||
    recent.warnings.length
  )
    return "Inconclusive: an account was omitted or the provider reported warnings. Resolve those issues before drawing a conclusion.";
  if (recentAccount.count)
    return "SimpleFIN returned recent transactions but no transactions for the older sample. If your bank statement shows activity in that period, this supports a provider history limitation. It does not prove an exact 90-day cutoff.";
  return "Inconclusive: neither sample returned posted transactions. Check that this account had activity in those periods.";
}
