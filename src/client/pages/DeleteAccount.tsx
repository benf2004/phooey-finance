import { useState } from "react";
import { createPortal } from "react-dom";
import { Trash2 } from "lucide-react";
import type { Account } from "../../shared/models";
import { post } from "../api";
import { useWorkspace } from "../context";
import { Button, ErrorNotice, Field, Modal } from "../ui";
export function DeleteAccountButton({
  account,
  disabled = false,
}: {
  account: Account;
  disabled?: boolean;
}) {
  const { refresh, notify } = useWorkspace();
  const [open, setOpen] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <button
        type="button"
        className="icon-button"
        disabled={disabled}
        aria-label={"Delete " + account.name}
        title="Delete account"
        onClick={() => {
          setConfirmation("");
          setError(null);
          setOpen(true);
        }}
      >
        <Trash2 size={15} />
      </button>
      {open &&
        createPortal(
          <Modal
            title={"Delete " + account.name}
            onClose={() => {
              if (!busy) setOpen(false);
            }}
          >
            <form
              className="form-stack"
              onSubmit={async (e) => {
                e.preventDefault();
                e.stopPropagation();
                setBusy(true);
                setError(null);
                try {
                  await post(
                    "/accounts/" + encodeURIComponent(account.id),
                    { confirmation },
                    "DELETE",
                  );
                  refresh();
                  notify("Account deleted");
                  setOpen(false);
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              <p>
                Deletes this account, its transactions, and account-specific
                rules. Recorded tax payments stay.
                {account.source === "simplefin" &&
                  " This account will be deselected from bank sync."}
              </p>
              <ErrorNotice error={error} />
              <Field label="Type DELETE ACCOUNT to confirm">
                <input
                  autoFocus
                  value={confirmation}
                  onChange={(e) => setConfirmation(e.target.value)}
                  disabled={busy}
                  autoComplete="off"
                  spellCheck={false}
                />
              </Field>
              <div className="actions">
                <Button
                  type="button"
                  variant="secondary"
                  disabled={busy}
                  onClick={() => setOpen(false)}
                >
                  Cancel
                </Button>
                <Button
                  variant="danger"
                  busy={busy}
                  disabled={confirmation !== "DELETE ACCOUNT"}
                >
                  Delete account
                </Button>
              </div>
            </form>
          </Modal>,
          document.body,
        )}
    </>
  );
}
