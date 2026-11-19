import {
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { Check, ChevronDown, LoaderCircle, Pencil, X } from "lucide-react";
import { useSubmit } from "./api";
import { useWorkspace } from "./context";
import type { Transaction, TransactionFieldEdit } from "../shared/models";
import "./transaction-field.css";

type FieldName = TransactionFieldEdit["field"];
const labels = {
  description: "Description",
  merchant: "Merchant",
  category_id: "Category",
};

export function TransactionField({
  transaction,
  field,
  children,
  onSaved,
}: {
  transaction: Transaction;
  field: FieldName;
  children: ReactNode;
  onSaved: (
    row: Transaction,
    edit: TransactionFieldEdit,
    revision: number,
  ) => void;
}) {
  const { categories, refresh, notify } = useWorkspace();
  const submit = useSubmit();
  const [draft, setDraft] = useState<{
    row: Transaction;
    value: string;
  } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);
  const editing = draft !== null;
  useLayoutEffect(() => {
    if (!editing && restoreFocus.current) {
      if (document.activeElement === document.body)
        trigger.current?.focus({ preventScroll: true });
      restoreFocus.current = false;
    }
  }, [editing]);

  function close() {
    restoreFocus.current = true;
    setDraft(null);
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!draft || busy) return;
    const value = field === "description" ? draft.value.trim() : draft.value;
    if (field === "description" && !value) {
      setError("Enter a description.");
      return;
    }
    if (value === (draft.row[field] ?? "")) {
      close();
      return;
    }
    const edit: TransactionFieldEdit =
      field === "category_id"
        ? { field, value: value || null }
        : { field, value };
    setBusy(true);
    setError("");
    try {
      const { revision } = await submit<{ revision: number }>(
        "/transactions/" + draft.row.id,
        { edit, revision: draft.row.revision },
        "PATCH",
      );
      onSaved(draft.row, edit, revision);
      notify(labels[field] + " saved");
      close();
    } catch (e) {
      setError((e as Error).message);
      refresh();
    } finally {
      setBusy(false);
    }
  }

  const label = labels[field];
  if (draft)
    return (
      <form
        className="ledger-field-editor"
        onSubmit={save}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape" && !busy) {
            e.preventDefault();
            e.stopPropagation();
            close();
          }
        }}
      >
        {field === "category_id" ? (
          <select
            autoFocus
            aria-label={label}
            value={draft.value}
            disabled={busy}
            onChange={(e) => setDraft({ ...draft, value: e.target.value })}
          >
            <option value="">Uncategorized</option>
            {categories.map((category) => (
              <option key={category.id} value={category.id}>
                {category.name}
              </option>
            ))}
          </select>
        ) : (
          <input
            autoFocus
            aria-label={label}
            value={draft.value}
            disabled={busy}
            required={field === "description"}
            maxLength={field === "merchant" ? 200 : 500}
            onFocus={(e) => e.target.select()}
            onChange={(e) => {
              setError("");
              setDraft({ ...draft, value: e.target.value });
            }}
          />
        )}
        {error && (
          <small className="ledger-field-error" role="alert">
            {error}
          </small>
        )}
        <div className="ledger-field-actions">
          <button
            type="submit"
            disabled={busy}
            aria-label={`Save ${label.toLowerCase()}`}
          >
            {busy ? (
              <LoaderCircle size={13} className="spin" />
            ) : (
              <Check size={13} />
            )}{" "}
            Save
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={close}
            aria-label={`Cancel ${label.toLowerCase()} edit`}
          >
            <X size={13} /> Cancel
          </button>
        </div>
      </form>
    );
  const action = `Edit ${label.toLowerCase()} for ${transaction.description}`;
  return (
    <div className="ledger-field">
      {field !== "category_id" && children}
      <button
        ref={trigger}
        type="button"
        className={
          field === "category_id" ? "ledger-category-trigger" : "ledger-pencil"
        }
        aria-label={
          field === "category_id"
            ? `${action}. Current category: ${transaction.category_name ?? "Uncategorized"}`
            : action
        }
        title={action}
        onClick={() => {
          setError("");
          setDraft({ row: transaction, value: transaction[field] ?? "" });
        }}
      >
        {field === "category_id" ? (
          <>
            {children}
            <ChevronDown size={12} />
          </>
        ) : (
          <Pencil size={13} />
        )}
      </button>
    </div>
  );
}
