import { historyFinding, type HistoryCheck } from "../../shared/sync-history";

export function BankHistoryCheck({ check }: { check: HistoryCheck }) {
  return (
    <div aria-live="polite">
      <p className="inline-note">
        Direct SimpleFIN response · {new Date(check.checkedAt).toLocaleString()}
        . Two sample periods checked; no transactions changed.
      </p>
      {check.samples[0]?.accounts.map((account) => (
        <section key={account.id}>
          <h4>{account.name}</h4>
          <p>{historyFinding(check, account.id)}</p>
          {check.samples.map((sample, index) => {
            const result = sample.accounts.find((a) => a.id === account.id);
            return (
              <p className="inline-note" key={index}>
                {index === 0 ? "Older sample" : "Recent sample"}: {sample.from}{" "}
                → {sample.to}
                {result?.returned ? (
                  <>
                    {" "}
                    · {result.count} posted transactions returned ·{" "}
                    {result.missingFromLedger} missing from ledger
                    {result.oldest && (
                      <>
                        {" "}
                        · Transaction dates: {result.oldest} → {result.newest}
                      </>
                    )}
                  </>
                ) : (
                  " · Account omitted by provider"
                )}
              </p>
            );
          })}
        </section>
      ))}
      {check.samples.flatMap((sample, index) =>
        sample.warnings.map((warning, i) => (
          <p className="bank-sync-error" key={`${index}-${i}`}>
            {sample.from}: {warning}
          </p>
        )),
      )}
    </div>
  );
}
