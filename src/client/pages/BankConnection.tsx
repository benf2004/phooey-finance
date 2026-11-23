import { DeleteAccountButton } from "./DeleteAccount";
import { BankHistoryCheck } from "./BankHistoryCheck";
import type { HistoryCheck } from "../../shared/sync-history";
import type { Account } from "../../shared/models";
import { useEffect, useState } from "react";
import { ExternalLink, RefreshCw } from "lucide-react";
import { useWorkspace } from "../context";
import { post } from "../api";
import { Button, ErrorNotice, Field, Panel } from "../ui";
export type BankConnectionState = {
  status: string;
  last_success: string | null;
  initial_sync_start: string | null;
  last_error: string | null;
  generation: string;
  selectionReady: boolean;
  importedAccounts: Account[];
  selectedAccounts: string[];
  accounts: {
    id: string;
    name: string;
    institution: string;
    currency: string;
  }[];
};
export function BankConnection({
  connection,
  syncing = false,
}: {
  connection: BankConnectionState | null | undefined;
  syncing?: boolean;
}) {
  const { refresh, notify } = useWorkspace();
  const imported = connection?.importedAccounts ?? [];
  const [token, setToken] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [removeUnselected, setRemoveUnselected] = useState(false);
  const [start, setStart] = useState("");
  const [firstStart, setFirstStart] = useState("");
  const [historyCheck, setHistoryCheck] = useState<HistoryCheck | null>(null);
  const today = new Date().toLocaleDateString("en-CA");
  const needsStart =
    !!connection && !connection.initial_sync_start && !connection.last_success;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setSelected(connection?.selectedAccounts ?? []);
    setRemoveUnselected(false);
    setFirstStart(connection?.initial_sync_start ?? "");
    setHistoryCheck(null);
  }, [connection?.generation]);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      refresh();
    }
  };
  const removed = imported.filter(
    (a) => a.source === "simplefin" && !selected.includes(a.provider_id ?? ""),
  );
  const choices = [
    ...(connection?.accounts ?? []),
    ...imported
      .filter(
        (a) =>
          a.source === "simplefin" &&
          a.provider_id &&
          !connection?.accounts.some((c) => c.id === a.provider_id),
      )
      .map((a) => ({
        id: a.provider_id!,
        name: a.name,
        institution: a.institution,
        currency: a.currency,
      })),
  ];
  const dirty =
    JSON.stringify([...selected].sort()) !==
    JSON.stringify([...(connection?.selectedAccounts ?? [])].sort());
  const canSync =
    !!connection?.selectionReady &&
    !!connection.selectedAccounts.length &&
    !dirty &&
    !syncing &&
    (!needsStart ||
      (!!firstStart && firstStart >= "1970-01-01" && firstStart <= today));
  const tokenForm = (
    <form
      className="form-stack"
      onSubmit={(e) => {
        e.preventDefault();
        void run(async () => {
          await post("/sync/connect", { token });
          setToken("");
          notify("Choose accounts to import");
        });
      }}
    >
      <Field label="SimpleFIN setup token">
        <input
          type="password"
          autoComplete="off"
          required
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="Paste setup token"
        />
      </Field>
      <div className="actions">
        <Button busy={busy} disabled={!token}>
          Connect SimpleFIN
        </Button>
        <a
          className="text-link"
          href="https://bridge.simplefin.org/simplefin/create"
          target="_blank"
          rel="noreferrer"
        >
          Get a setup token <ExternalLink size={13} />
        </a>
      </div>
    </form>
  );
  return (
    <Panel title="Bank connection">
      <div className="panel-body">
        <ErrorNotice error={error ?? connection?.last_error ?? null} />
        {!connection ? (
          tokenForm
        ) : (
          <>
            <form
              className="form-stack"
              onSubmit={(e) => {
                e.preventDefault();
                if (
                  removeUnselected &&
                  removed.length &&
                  !confirm(
                    `Remove these accounts and all their transactions?\n\n${removed.map((a) => a.name).join("\n")}\n\nManual edits and account-specific rules will be deleted. Recorded tax payments will be kept.`,
                  )
                )
                  return;
                void run(async () => {
                  await post("/sync/accounts", {
                    generation: connection.generation,
                    accountIds: selected,
                    removeUnselected,
                  });
                  if (selected.length) {
                    await post(
                      "/sync",
                      needsStart ? { start: firstStart } : {},
                    );
                    notify("Selected accounts queued for import");
                  } else notify("Bank sync paused");
                });
              }}
            >
              <div className="bank-account-heading">
                <h3>Accounts to import</h3>
                <Button
                  type="button"
                  variant="ghost"
                  busy={busy}
                  onClick={() =>
                    void run(async () => {
                      await post("/sync/discover", {});
                    })
                  }
                >
                  <RefreshCw size={14} />
                  Refresh list
                </Button>
              </div>
              <fieldset
                className="bank-account-list"
                disabled={busy || syncing}
                aria-label="Accounts to import"
              >
                {choices.map((account) => {
                  const available = connection.accounts.some(
                    (a) => a.id === account.id,
                  );
                  return (
                    <div className="bank-account-choice" key={account.id}>
                      <label className="bank-account-label">
                        <input
                          type="checkbox"
                          checked={selected.includes(account.id)}
                          disabled={
                            !available && !selected.includes(account.id)
                          }
                          onChange={(e) =>
                            setSelected((current) =>
                              e.target.checked
                                ? [...current, account.id]
                                : current.filter((id) => id !== account.id),
                            )
                          }
                        />
                        <span>
                          <strong>{account.name}</strong>
                          <small>
                            {account.institution || account.currency}
                            {!available && " · Unavailable"}
                          </small>
                        </span>
                        <small>{account.currency}</small>
                      </label>
                      {imported.find((a) => a.provider_id === account.id) && (
                        <DeleteAccountButton
                          account={imported.find(
                            (a) => a.provider_id === account.id,
                          )!}
                          disabled={busy}
                        />
                      )}
                    </div>
                  );
                })}
                {!choices.length && (
                  <p className="muted">
                    No accounts found. Refresh the list to try again.
                  </p>
                )}
              </fieldset>
              {removed.length > 0 && (
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={removeUnselected}
                    onChange={(e) => setRemoveUnselected(e.target.checked)}
                    disabled={busy}
                  />
                  Remove {removed.length} previously imported, unselected{" "}
                  {removed.length === 1 ? "account" : "accounts"} and their
                  transactions
                </label>
              )}
              {needsStart && (
                <Field
                  label="Sync transactions from"
                  hint="Request transactions from this date through today. Available history depends on your bank; some only provide the last 90 days. Import a bank CSV for older history."
                >
                  <input
                    type="date"
                    required={selected.length > 0}
                    min="1970-01-01"
                    max={today}
                    value={firstStart}
                    disabled={busy || syncing}
                    onChange={(e) => setFirstStart(e.target.value)}
                  />
                </Field>
              )}
              <div className="actions">
                <Button
                  busy={busy}
                  disabled={
                    !choices.length ||
                    syncing ||
                    (needsStart && selected.length > 0 && !firstStart)
                  }
                >
                  {selected.length
                    ? connection.selectionReady
                      ? "Save & sync"
                      : "Import selected"
                    : "Pause syncing"}
                </Button>
                <span className="muted">{selected.length} selected</span>
              </div>
            </form>
            <div className="form-section">
              <div className="actions">
                <Button
                  variant="secondary"
                  busy={busy}
                  disabled={!canSync}
                  onClick={() =>
                    void run(async () => {
                      await post(
                        "/sync",
                        needsStart ? { start: firstStart } : {},
                      );
                      notify("Sync queued");
                    })
                  }
                >
                  <RefreshCw size={14} />
                  {syncing ? "Sync in progress" : "Sync now"}
                </Button>
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() => {
                    if (
                      confirm(
                        "Disconnect SimpleFIN? Existing transactions stay in your ledger.",
                      )
                    )
                      void run(async () => {
                        await post("/sync", {}, "DELETE");
                        notify("Bank disconnected");
                      });
                  }}
                >
                  Disconnect
                </Button>
              </div>
              <p className="inline-note">
                {!connection.selectionReady
                  ? "Choose accounts before importing."
                  : connection.selectedAccounts.length
                    ? connection.last_success
                      ? "Last synced " +
                        new Date(connection.last_success).toLocaleString()
                      : "Syncs twice daily."
                    : "Sync paused."}
              </p>
              <details>
                <summary>Import older transactions</summary>
                <div className="field-row">
                  <Field label="From">
                    <input
                      type="date"
                      min="1970-01-01"
                      max={today}
                      value={start}
                      onChange={(e) => {
                        setStart(e.target.value);
                        setHistoryCheck(null);
                      }}
                    />
                  </Field>
                  <Button
                    variant="secondary"
                    disabled={!canSync || !start || start > today || busy}
                    onClick={() =>
                      void run(async () => {
                        await post("/sync", { start });
                        notify("History queued");
                      })
                    }
                  >
                    Import history
                  </Button>
                  <Button
                    variant="secondary"
                    busy={busy}
                    disabled={
                      !connection.selectionReady ||
                      !selected.length ||
                      dirty ||
                      syncing ||
                      !start ||
                      busy
                    }
                    onClick={() =>
                      void run(async () => {
                        setHistoryCheck(null);
                        setHistoryCheck(
                          await post<HistoryCheck>("/sync/check-history", {
                            start,
                          }),
                        );
                      })
                    }
                  >
                    Check available history
                  </Button>
                </div>
                <p className="inline-note">
                  To verify missing history, choose a date more than 90 days ago
                  and check available history. This compares up to 45 days from
                  that date with the most recent 45 days using two provider
                  requests, without importing transactions.
                </p>
                {historyCheck && <BankHistoryCheck check={historyCheck} />}
                <p className="inline-note">
                  Available history depends on your bank; some only provide the
                  last 90 days. Choosing an earlier date cannot retrieve history
                  the bank does not provide. Use Settings → Import transactions
                  to add older history from a bank CSV.
                </p>
              </details>
              <details>
                <summary>Replace connection</summary>
                {tokenForm}
              </details>
            </div>
          </>
        )}
      </div>
    </Panel>
  );
}
