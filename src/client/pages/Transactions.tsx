import { useEffect, useState, useRef } from "react";
import {
  Plus,
  Download,
  Upload,
  Search,
  SlidersHorizontal,
  ChevronLeft,
  ChevronRight,
  Trash2,
  Split,
  Link2,
  Bookmark,
  Check,
} from "lucide-react";
import { useWorkspace } from "../context";
import { api, post } from "../api";
import {
  Button,
  Field,
  MoneyInput,
  Modal,
  Empty,
  PageHeading,
  ErrorNotice,
  Loading,
  useAsync,
} from "../ui";
import { formatMoney, today } from "../../shared/money";
import type { Transaction, TransactionInput } from "../../shared/models";
import ImportDialog from "./ImportDialog";
const fresh = (account: string): TransactionInput => ({
  account_id: account,
  posted: today(),
  amount: 0,
  description: "",
  merchant: "",
  category_id: null,
  type: "expense",
  notes: "",
  reviewed: true,
  pending: false,
  splits: [],
});
export function TransactionEditor({
  transactionId,
  onClose,
}: {
  transactionId?: string;
  onClose: () => void;
}) {
  const { accounts, categories, refresh, notify } = useWorkspace();
  const [data, setData] = useState<TransactionInput>(
      fresh(accounts[0]?.id ?? ""),
    ),
    [revision, setRevision] = useState(0),
    [source, setSource] = useState("manual"),
    [linked, setLinked] = useState(false),
    [history, setHistory] = useState<
      { action: string; actor: string; created_at: string }[]
    >([]),
    [error, setError] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(!!transactionId);
  useEffect(() => {
    if (transactionId)
      api<
        Transaction & {
          splits: TransactionInput["splits"];
          history: typeof history;
        }
      >("/transactions/" + transactionId)
        .then((t) => {
          setData({ ...t, reviewed: !!t.reviewed, pending: !!t.pending });
          setRevision(t.revision);
          setSource(t.source);
          setLinked(!!t.transfer_id);
          setHistory(t.history);
        })
        .catch((e) => setError(e.message))
        .finally(() => setLoading(false));
  }, [transactionId]);
  const set = <K extends keyof TransactionInput>(
    key: K,
    value: TransactionInput[K],
  ) => setData((d) => ({ ...d, [key]: value }));
  const submission = useRef<{ json: string; key: string } | null>(null);
  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const json = JSON.stringify({ data, revision });
    if (submission.current?.json !== json)
      submission.current = { json, key: crypto.randomUUID() };
    try {
      await post(
        transactionId ? "/transactions/" + transactionId : "/transactions",
        transactionId ? { transaction: data, revision } : data,
        transactionId ? "PUT" : "POST",
        submission.current!.key,
      );
      refresh();
      notify("Transaction saved");
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={transactionId ? "Transaction details" : "Add a transaction"}
      onClose={onClose}
      wide={data.splits.length > 0}
    >
      {loading ? (
        <Loading />
      ) : (
        <form onSubmit={save} className="form-stack">
          <div className="field-row">
            <Field label="Description">
              <input
                required
                value={data.description}
                onChange={(e) => set("description", e.target.value)}
              />
            </Field>
            <Field label="Merchant">
              <input
                value={data.merchant}
                onChange={(e) => set("merchant", e.target.value)}
              />
            </Field>
          </div>
          <div className="field-row">
            <Field label="Account">
              <select
                value={data.account_id}
                required
                onChange={(e) => set("account_id", e.target.value)}
              >
                <option value="" disabled>
                  Select an account
                </option>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} · {a.currency}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Date">
              <input
                type="date"
                value={data.posted}
                required
                onChange={(e) => set("posted", e.target.value)}
              />
            </Field>
          </div>
          <div className="field-row">
            <Field
              label="Amount"
              hint="Negative for money out; positive for money in."
            >
              <MoneyInput
                value={data.amount}
                onChange={(v) => set("amount", v)}
                required
              />
            </Field>
            <Field label="Type">
              <select
                value={data.type}
                onChange={(e) =>
                  set("type", e.target.value as TransactionInput["type"])
                }
              >
                <option value="expense">Expense</option>
                <option value="income">Income</option>
                <option value="transfer">Transfer</option>
              </select>
            </Field>
          </div>
          <Field label="Category">
            <select
              value={data.category_id ?? ""}
              onChange={(e) => {
                const cat = categories.find((c) => c.id === e.target.value);
                setData((d) => ({
                  ...d,
                  category_id: cat?.id ?? null,
                  type: cat?.type ?? d.type,
                }));
              }}
            >
              <option value="">Uncategorized</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Notes">
            <textarea
              value={data.notes}
              onChange={(e) => set("notes", e.target.value)}
            />
          </Field>
          <div className="actions">
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={data.reviewed}
                onChange={(e) => set("reviewed", e.target.checked)}
              />
              Reviewed
            </label>
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={data.pending}
                onChange={(e) => set("pending", e.target.checked)}
              />
              Pending
            </label>
            <Button
              type="button"
              variant="ghost"
              onClick={() =>
                set("splits", [
                  ...data.splits,
                  {
                    amount:
                      data.amount -
                      data.splits.reduce((s, x) => s + x.amount, 0),
                    category_id: null,
                    type: data.type,
                    notes: "",
                  },
                ])
              }
            >
              <Split size={15} />
              Split transaction
            </Button>
          </div>
          {data.splits.length > 0 && (
            <section>
              <h3>Split allocation</h3>
              {data.splits.map((s, i) => (
                <div className="split-row" key={i}>
                  <MoneyInput
                    aria-label={`Split ${i + 1} amount`}
                    value={s.amount}
                    onChange={(v) =>
                      set(
                        "splits",
                        data.splits.map((x, j) =>
                          j === i ? { ...x, amount: v } : x,
                        ),
                      )
                    }
                  />
                  <select
                    aria-label={`Split ${i + 1} category`}
                    value={s.category_id ?? ""}
                    onChange={(e) => {
                      const cat = categories.find(
                        (c) => c.id === e.target.value,
                      );
                      set(
                        "splits",
                        data.splits.map((x, j) =>
                          j === i
                            ? {
                                ...x,
                                category_id: cat?.id ?? null,
                                type: cat?.type ?? x.type,
                              }
                            : x,
                        ),
                      );
                    }}
                  >
                    <option value="">Uncategorized</option>
                    {categories.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                  <input
                    aria-label={`Split ${i + 1} note`}
                    placeholder="Note"
                    value={s.notes}
                    onChange={(e) =>
                      set(
                        "splits",
                        data.splits.map((x, j) =>
                          j === i ? { ...x, notes: e.target.value } : x,
                        ),
                      )
                    }
                  />
                  <button
                    type="button"
                    className="icon-button"
                    aria-label="Remove split"
                    onClick={() =>
                      set(
                        "splits",
                        data.splits.filter((_, j) => j !== i),
                      )
                    }
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              ))}
              <p className="inline-note">
                Unallocated:{" "}
                {formatMoney(
                  data.amount - data.splits.reduce((s, x) => s + x.amount, 0),
                )}
              </p>
            </section>
          )}
          {source === "simplefin" && (
            <p className="notice">
              Your changes are preserved during bank sync. Original provider
              details remain in the audit data.
            </p>
          )}
          {linked && (
            <Button
              type="button"
              variant="secondary"
              onClick={async () => {
                try {
                  await post("/transfers/" + transactionId, {}, "DELETE");
                  setLinked(false);
                  const tx = await api<Transaction>(
                    "/transactions/" + transactionId,
                  );
                  setRevision(tx.revision);
                  refresh();
                } catch (e) {
                  setError((e as Error).message);
                }
              }}
            >
              <Link2 size={15} />
              Unlink transfer
            </Button>
          )}
          <ErrorNotice error={error} />
          <div className="form-footer">
            {transactionId && (
              <Button
                type="button"
                variant="danger"
                disabled={busy}
                onClick={async () => {
                  if (
                    !confirm(
                      "Delete this transaction? Bank sync will preserve this deletion.",
                    )
                  )
                    return;
                  try {
                    await post(
                      "/transactions/" + transactionId,
                      { revision },
                      "DELETE",
                    );
                    refresh();
                    notify("Transaction deleted");
                    onClose();
                  } catch (e) {
                    setError((e as Error).message);
                  }
                }}
              >
                <Trash2 size={15} />
                Delete
              </Button>
            )}
            <Button type="button" variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button busy={busy} type="submit">
              Save transaction
            </Button>
          </div>
          {history.length > 0 && (
            <details className="details">
              <summary>Edit history</summary>
              <div>
                {history.map((h, i) => (
                  <div className="audit-entry" key={i}>
                    {h.action} · {h.actor}
                    <small> · {h.created_at}</small>
                  </div>
                ))}
              </div>
            </details>
          )}
        </form>
      )}
    </Modal>
  );
}
export default function Transactions() {
  const { accounts, categories, version, refresh, navigate, notify } =
    useWorkspace();
  const params = new URLSearchParams(location.search);
  const [query, setQuery] = useState(params.get("q") ?? ""),
    [filtersOpen, setFiltersOpen] = useState(false),
    [editor, setEditor] = useState<string | null>(
      params.has("new") ? "new" : params.get("edit"),
    ),
    [importing, setImporting] = useState(false),
    [selected, setSelected] = useState<Set<string>>(new Set()),
    [bulk, setBulk] = useState(""),
    [error, setError] = useState<string | null>(null),
    [saved, setSaved] = useState<{ name: string; query: string }[]>([]);
  const queryString = params.toString();
  const data = useAsync(
    () =>
      api<{ items: Transaction[]; total: number; page: number; limit: number }>(
        "/transactions?" + queryString,
      ),
    [queryString, version],
  );
  useEffect(() => {
    setEditor(params.has("new") ? "new" : params.get("edit"));
    if (params.get("focus") === "search")
      document.querySelector<HTMLInputElement>("#transaction-search")?.focus();
    setQuery(params.get("q") ?? "");
    setSelected(new Set());
  }, [queryString]);
  useEffect(() => {
    api<typeof saved>("/preferences/saved-filters")
      .then((v) => setSaved(v ?? []))
      .catch(() => {});
  }, []);
  function change(key: string, value: string) {
    const p = new URLSearchParams(location.search);
    p.delete("new");
    p.delete("edit");
    p.delete("focus");
    if (value) p.set(key, value);
    else p.delete(key);
    if (key !== "page") p.delete("page");
    navigate("/transactions?" + p.toString());
  }
  function closeEditor() {
    setEditor(null);
    const p = new URLSearchParams(location.search);
    p.delete("new");
    p.delete("edit");
    navigate("/transactions?" + p.toString());
  }
  const items = data.data?.items ?? [];
  return (
    <>
      <PageHeading
        title="Transactions"
        actions={
          <>
            <Button variant="secondary" onClick={() => setImporting(true)}>
              <Upload size={15} />
              Import
            </Button>
            <Button
              onClick={() => setEditor("new")}
              disabled={!accounts.length}
            >
              <Plus size={16} />
              Add transaction
            </Button>
          </>
        }
      />
      <div className="toolbar">
        <form
          className="search-box"
          onSubmit={(e) => {
            e.preventDefault();
            change("q", query);
          }}
        >
          <Search size={16} />
          <input
            id="transaction-search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search description, merchant, or notes…"
            aria-label="Search transactions"
          />
        </form>
        <select
          aria-label="Filter by account"
          value={params.get("account") ?? ""}
          onChange={(e) => change("account", e.target.value)}
        >
          <option value="">All accounts</option>
          {accounts.map((a) => (
            <option value={a.id} key={a.id}>
              {a.name}
            </option>
          ))}
        </select>
        <select
          aria-label="Filter by category"
          value={params.get("category") ?? ""}
          onChange={(e) => change("category", e.target.value)}
        >
          <option value="">All categories</option>
          <option value="uncategorized">Uncategorized</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <Button
          variant="secondary"
          onClick={() => setFiltersOpen(!filtersOpen)}
        >
          <SlidersHorizontal size={15} />
          Filters
        </Button>
        <a className="button secondary" href={"/api/export?" + queryString}>
          <Download size={15} />
          Export
        </a>
      </div>
      {filtersOpen && (
        <div className="filters-panel">
          {[
            ["from", "From", "date"],
            ["to", "To", "date"],
            ["min", "Min amount (cents)", "number"],
            ["max", "Max amount (cents)", "number"],
          ].map(([key, label, type]) => (
            <Field key={key} label={label}>
              <input
                type={type}
                value={params.get(key) ?? ""}
                onChange={(e) => change(key, e.target.value)}
              />
            </Field>
          ))}
          <Field label="Transaction type">
            <select
              value={params.get("type") ?? ""}
              onChange={(e) => change("type", e.target.value)}
            >
              <option value="">All types</option>
              <option value="income">Income</option>
              <option value="expense">Expense</option>
              <option value="transfer">Transfer</option>
            </select>
          </Field>
          <Field label="Review status">
            <select
              value={params.get("reviewed") ?? ""}
              onChange={(e) => change("reviewed", e.target.value)}
            >
              <option value="">All transactions</option>
              <option value="0">Needs review</option>
              <option value="1">Reviewed</option>
            </select>
          </Field>
          <Field label="Posting status">
            <select
              value={params.get("pending") ?? ""}
              onChange={(e) => change("pending", e.target.value)}
            >
              <option value="">All</option>
              <option value="0">Posted</option>
              <option value="1">Pending</option>
            </select>
          </Field>
          <Field label="Source">
            <select
              value={params.get("source") ?? ""}
              onChange={(e) => change("source", e.target.value)}
            >
              <option value="">All sources</option>
              <option value="manual">Manual</option>
              <option value="csv">CSV import</option>
              <option value="simplefin">SimpleFIN</option>
            </select>
          </Field>
          <div className="actions">
            <Button variant="ghost" onClick={() => navigate("/transactions")}>
              Clear filters
            </Button>
            <Button
              variant="secondary"
              onClick={async () => {
                const name = prompt("Name this saved view");
                if (!name) return;
                const list = [...saved, { name, query: queryString }].slice(
                  -20,
                );
                await post("/preferences/saved-filters", list, "PUT");
                setSaved(list);
                notify("View saved");
              }}
            >
              <Bookmark size={15} />
              Save view
            </Button>
          </div>
        </div>
      )}
      {saved.length > 0 && (
        <div className="saved-views">
          {saved.map((v, i) => (
            <button
              key={i}
              className="badge neutral"
              onClick={() => navigate("/transactions?" + v.query)}
            >
              {v.name}
            </button>
          ))}
        </div>
      )}
      {selected.size > 0 && (
        <div className="review-banner">
          <span>{selected.size} selected</span>
          <select
            style={{ width: 190 }}
            value={bulk}
            onChange={(e) => setBulk(e.target.value)}
          >
            <option value="">Choose a category</option>
            {categories.map((c) => (
              <option value={c.id} key={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <Button
            variant="secondary"
            disabled={!bulk}
            onClick={async () => {
              try {
                await post("/bulk-category", {
                  items: items
                    .filter((t) => selected.has(t.id))
                    .map((t) => ({ id: t.id, revision: t.revision })),
                  category_id: bulk,
                });
                setSelected(new Set());
                refresh();
                notify("Transactions categorized");
              } catch (e) {
                setError((e as Error).message);
              }
            }}
          >
            Apply
          </Button>
          {selected.size === 2 && (
            <Button
              variant="secondary"
              onClick={async () => {
                try {
                  const [first, second] = [...selected];
                  await post("/transfers", { first, second });
                  setSelected(new Set());
                  refresh();
                  notify("Transfer linked");
                } catch (e) {
                  setError((e as Error).message);
                }
              }}
            >
              <Link2 size={15} />
              Link transfer
            </Button>
          )}
        </div>
      )}
      <ErrorNotice error={error ?? data.error} />
      <div className="panel">
        {data.loading && !data.data ? (
          <Loading />
        ) : items.length ? (
          <>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>
                      <input
                        type="checkbox"
                        aria-label="Select all visible transactions"
                        checked={selected.size === items.length}
                        onChange={(e) =>
                          setSelected(
                            e.target.checked
                              ? new Set(items.map((t) => t.id))
                              : new Set(),
                          )
                        }
                      />
                    </th>
                    <th>Date</th>
                    <th>Transaction</th>
                    <th className="hide-mobile">Account</th>
                    <th>Category</th>
                    <th className="align-right">Amount</th>
                    <th className="hide-mobile">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((t) => (
                    <tr key={t.id}>
                      <td>
                        <input
                          type="checkbox"
                          aria-label={`Select ${t.description}`}
                          checked={selected.has(t.id)}
                          onChange={() =>
                            setSelected((s) => {
                              const next = new Set(s);
                              next.has(t.id)
                                ? next.delete(t.id)
                                : next.add(t.id);
                              return next;
                            })
                          }
                        />
                      </td>
                      <td className="muted" style={{ whiteSpace: "nowrap" }}>
                        {new Date(t.posted + "T12:00:00").toLocaleDateString(
                          "en-US",
                          { month: "short", day: "numeric" },
                        )}
                        <small>{t.posted.slice(0, 4)}</small>
                      </td>
                      <td>
                        <button
                          className="transaction-name"
                          onClick={() => setEditor(t.id)}
                        >
                          {t.description}
                        </button>
                        <small>
                          {t.merchant || t.type}
                          {t.split_count > 0
                            ? " · " + t.split_count + " splits"
                            : ""}
                          {t.transfer_id ? " · linked" : ""}
                        </small>
                      </td>
                      <td className="hide-mobile">{t.account_name}</td>
                      <td>
                        <span
                          className={`badge ${t.category_name ? "neutral" : "amber"}`}
                        >
                          {t.split_count
                            ? "Split transaction"
                            : (t.category_name ?? "Uncategorized")}
                        </span>
                      </td>
                      <td
                        className={`align-right money ${t.amount > 0 ? "positive" : ""}`}
                      >
                        {t.amount > 0 ? "+" : ""}
                        {formatMoney(t.amount, t.currency)}
                      </td>
                      <td className="hide-mobile">
                        {t.pending ? (
                          <span className="badge neutral">Pending</span>
                        ) : t.reviewed ? (
                          <Check size={15} className="positive" />
                        ) : (
                          <span className="badge amber">Review</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="pagination">
              <span>
                {(data.data!.page - 1) * data.data!.limit + 1}–
                {Math.min(data.data!.page * data.data!.limit, data.data!.total)}{" "}
                of {data.data!.total} transactions
              </span>
              <div className="actions">
                <Button
                  variant="ghost"
                  aria-label="Previous page"
                  disabled={data.data!.page === 1}
                  onClick={() => change("page", String(data.data!.page - 1))}
                >
                  <ChevronLeft size={16} />
                </Button>
                <span>Page {data.data!.page}</span>
                <Button
                  variant="ghost"
                  aria-label="Next page"
                  disabled={
                    data.data!.page * data.data!.limit >= data.data!.total
                  }
                  onClick={() => change("page", String(data.data!.page + 1))}
                >
                  <ChevronRight size={16} />
                </Button>
              </div>
            </div>
          </>
        ) : (
          <Empty
            title={accounts.length ? "No transactions" : "No accounts"}
            detail={
              queryString
                ? "Try a different search or clear your filters."
                : "Import a CSV or add a transaction."
            }
            action={
              <Button
                variant="secondary"
                onClick={() =>
                  accounts.length ? setImporting(true) : navigate("/accounts")
                }
              >
                {accounts.length ? "Import transactions" : "Add an account"}
              </Button>
            }
          />
        )}
      </div>
      {editor && (
        <TransactionEditor
          transactionId={editor === "new" ? undefined : editor}
          onClose={closeEditor}
        />
      )}{" "}
      {importing && <ImportDialog onClose={() => setImporting(false)} />}
    </>
  );
}
