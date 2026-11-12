import { DeleteAccountButton } from "./DeleteAccount";
import type { Account } from "../../shared/models";
import { useEffect, useState } from "react";
import { ExternalLink, RefreshCw } from "lucide-react";
import { useWorkspace } from "../context";
import { post } from "../api";
import { Button, ErrorNotice, Field, Panel } from "../ui";
export type BankConnectionState = {
  status: string;
  last_success: string | null;
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
}: {
  connection: BankConnectionState | null | undefined;
}) {
  const { refresh, notify } = useWorkspace();
  const imported = connection?.importedAccounts ?? [];
  const [token, setToken] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [removeUnselected, setRemoveUnselected] = useState(false);
  const [start, setStart] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setSelected(connection?.selectedAccounts ?? []);
    setRemoveUnselected(false);
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
    !dirty;
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
                    await post("/sync", {});
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
                disabled={busy}
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
              <div className="actions">
                <Button busy={busy} disabled={!choices.length}>
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
                      await post("/sync", {});
                      notify("Sync queued");
                    })
                  }
                >
                  <RefreshCw size={14} />
                  Sync now
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
                      value={start}
                      onChange={(e) => setStart(e.target.value)}
                    />
                  </Field>
                  <Button
                    variant="secondary"
                    disabled={!canSync || !start || busy}
                    onClick={() =>
                      void run(async () => {
                        await post("/sync", { start });
                        notify("History queued");
                      })
                    }
                  >
                    Import history
                  </Button>
                </div>
                <p className="inline-note">
                  Selected accounts only, in 45-day requests.
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
