import { useState } from "react";
import { post } from "../api";
import { useWorkspace } from "../context";
import { Button, ErrorNotice, Field, Modal, Panel } from "../ui";
export function DataReset() {
  const { refresh, notify } = useWorkspace();
  const [scope, setScope] = useState<"transactions" | "everything" | null>(
    null,
  );
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const title =
    scope === "everything" ? "Reset app data" : "Delete all transactions";
  const required =
    scope === "everything" ? "RESET EVERYTHING" : "DELETE TRANSACTIONS";
  const open = (value: "transactions" | "everything") => {
    setScope(value);
    setConfirmation("");
    setError(null);
  };
  return (
    <>
      <Panel title="Delete data">
        <div className="panel-body">
          <div className="actions">
            <Button variant="secondary" onClick={() => open("transactions")}>
              Delete all transactions
            </Button>
            <Button variant="danger" onClick={() => open("everything")}>
              Reset app data
            </Button>
          </div>
        </div>
      </Panel>
      {scope && (
        <Modal
          title={title}
          onClose={() => {
            if (!busy) setScope(null);
          }}
        >
          <form
            className="form-stack"
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              setError(null);
              try {
                await post("/settings/reset", { scope, confirmation });
                refresh();
                setScope(null);
                notify(
                  scope === "everything"
                    ? "App data reset"
                    : "Transactions deleted; bank sync paused",
                );
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            <p>
              {scope === "everything"
                ? "Deletes accounts, transactions, categories, rules, tax plans, payments, bank connection, and MCP access. Your admin login stays."
                : "Deletes every transaction and split. Keeps accounts, categories, rules, and tax payments. Bank sync pauses."}
            </p>
            <p className="inline-note">
              This cannot be undone. <a href="/api/backup">Download a backup</a>{" "}
              first if needed. Stored import and export files will also be
              deleted.
            </p>
            <ErrorNotice error={error} />
            <Field label={`Type ${required} to confirm`}>
              <input
                value={confirmation}
                onChange={(e) => setConfirmation(e.target.value)}
                autoComplete="off"
                spellCheck={false}
                autoFocus
                disabled={busy}
              />
            </Field>
            <div className="actions">
              <Button
                type="button"
                variant="secondary"
                disabled={busy}
                onClick={() => setScope(null)}
              >
                Cancel
              </Button>
              <Button
                variant="danger"
                busy={busy}
                disabled={confirmation !== required}
              >
                {title}
              </Button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}
