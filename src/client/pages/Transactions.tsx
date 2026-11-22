import { ViewSwitch, useGridView } from "../LedgerGrid";
import { TransactionGrid } from "../TransactionGrid";
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
  Paperclip,
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
import type { Transaction, TransactionFieldEdit, TransactionInput } from "../../shared/models";
import ImportDialog from "./ImportDialog";
import TransactionTags from "../TransactionTags";
import {
  DateRangeSelect,
  calendarRanges,
  type CalendarPeriod,
} from "../DateRangeSelect";
import AmountFilter from "../AmountFilter";
import { TransactionAmount } from "../TransactionAmount";
import {
  AttachmentPicker,
  UploadFeedback,
  useAttachmentUpload,
} from "../AttachmentUpload";
import { TransactionField } from "../TransactionField";
import { TransactionAttachments } from "../TransactionAttachments";
import { formatEnumLabel } from "../labels";
const fresh = (account: string): TransactionInput => ({
  account_id: account,
  posted: today(),
  amount: 0,
  description: "",
  merchant: "",
  category_id: null,
  type: "expense",
  notes: "",
  tags: ["Business"],
  reviewed: true,
  pending: false,
  splits: [],
});
export function TransactionEditor({
  transactionId,
  onClose,
  focusAttachments = false,
}: {
  transactionId?: string;
  onClose: () => void;
  focusAttachments?: boolean;
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
    [attachmentBusy, setAttachmentBusy] = useState(false),
    [attachmentPreviewOpen, setAttachmentPreviewOpen] = useState(false),
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
    if (attachmentBusy) return;
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
      onClose={() => { if (!attachmentBusy && !attachmentPreviewOpen) onClose(); }}
      className="transaction-editor"
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
          <div className="field-row transaction-classification">
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
          </div>
          <div className="field-row transaction-annotations">
            <TransactionTags
              value={data.tags}
              onChange={(tags) => set("tags", tags)}
            />
            <Field label="Notes">
              <textarea
                rows={3}
                value={data.notes}
                onChange={(e) => set("notes", e.target.value)}
              />
            </Field>
          </div>
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
          <TransactionAttachments transactionId={transactionId} disabled={busy} onBusyChange={setAttachmentBusy} onPreviewChange={setAttachmentPreviewOpen} autoFocus={focusAttachments} />
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
                disabled={busy || attachmentBusy}
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
            <Button type="button" variant="secondary" disabled={attachmentBusy} onClick={onClose}>
              Cancel
            </Button>
            <Button busy={busy} disabled={attachmentBusy} type="submit">
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
function categoryBadgeStyle(color?: string) {
  if (!color || !/^#[0-9a-f]{6}$/i.test(color)) return undefined;
  const channels = [1, 3, 5].map((offset) => {
    const channel = parseInt(color.slice(offset, offset + 2), 16) / 255;
    return channel <= 0.04045
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4;
  });
  const luminance =
    0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  const blackContrast = (luminance + 0.05) / 0.05;
  const whiteContrast = 1.05 / (luminance + 0.05);
  // Choose the higher-contrast foreground for the configured background in either theme.
  return {
    backgroundColor: color,
    color: blackContrast >= whiteContrast ? "#000000" : "#ffffff",
  };
}
export default function Transactions() {
  const tagsOnly = location.pathname === "/tags";
  const view = useGridView("transactions");
  const { accounts, categories, version, refresh, navigate, notify } =
    useWorkspace();
  const receiptUpload = useAttachmentUpload();
  const params = new URLSearchParams(location.search);
  const period = params.get("period") ?? "";
  const customDates =
    period === "custom" || params.has("from") || params.has("to");
  const [query, setQuery] = useState(params.get("q") ?? ""),
    [filtersOpen, setFiltersOpen] = useState(customDates),
    [editor, setEditor] = useState<string | null>(
      params.has("new") ? "new" : params.get("edit"),
    ),
    [focusAttachments, setFocusAttachments] = useState(false),
    [importing, setImporting] = useState(false),
    [selected, setSelected] = useState<Set<string>>(new Set()),
    [bulk, setBulk] = useState(""),
    [error, setError] = useState<string | null>(null),
    [saved, setSaved] = useState<{ name: string; query: string }[]>([]);
  const queryString = params.toString();
  const ranges = calendarRanges();
  const range = Object.hasOwn(ranges, period)
    ? ranges[period as CalendarPeriod]
    : undefined;
  const requestParams = new URLSearchParams(params);
  requestParams.delete("period");
  if (range) {
    requestParams.set("from", range.from);
    requestParams.set("to", range.to);
  }
  const requestQuery = requestParams.toString();
  const bounds = {
    from: requestParams.get("from") ?? "",
    to: requestParams.get("to") ?? "",
  };
  const tags = useAsync(() => api<string[]>("/tags"), [version]);
  const data = useAsync(
    () =>
      api<{ items: Transaction[]; total: number; page: number; limit: number }>(
        "/transactions?" + requestQuery,
      ),
    [requestQuery, version],
  );
  useEffect(() => {
    if (customDates) setFiltersOpen(true);
    setFocusAttachments(false);
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
    changeFilters({ [key]: value });
  }
  function changeFilters(values: Record<string, string>) {
    const p = new URLSearchParams(location.search);
    p.delete("new");
    p.delete("edit");
    p.delete("focus");
    for (const [key, value] of Object.entries(values)) {
      if (value) p.set(key, value);
      else p.delete(key);
    }
    if (!("page" in values)) p.delete("page");
    navigate(location.pathname + "?" + p.toString());
  }
  function closeEditor() {
    setEditor(null);
    setFocusAttachments(false);
    const p = new URLSearchParams(location.search);
    p.delete("new");
    p.delete("edit");
    navigate(location.pathname + "?" + p.toString());
  }
  function openEditor(id: string, attachments = false) {
    setFocusAttachments(attachments);
    setEditor(id);
  }
  function fieldSaved(original: Transaction, edit: TransactionFieldEdit, revision: number) {
    const category = edit.field === "category_id" ? categories.find((c) => c.id === edit.value) : null;
    const changes = edit.field === "category_id"
      ? { category_id: edit.value, category_name: category?.name ?? null, type: category?.type ?? original.type }
      : edit.field === "reviewed" ? { reviewed: Number(edit.value) } : { [edit.field]: edit.value };
    data.setData((page) => page && ({
      ...page,
      items: page.items.map((row) => row.id === original.id && row.revision === original.revision
        ? { ...row, ...changes, revision }
        : row),
    }));
    refresh();
  }
  const items = data.data?.items ?? [];
  const selectedItems = items.filter((item) => selected.has(item.id));
  const categoryColors = new Map(categories.map((c) => [c.id, c.color]));
  return (
    <>
      <PageHeading
        title={tagsOnly ? "Tags" : "Transactions"}
        actions={
          <>
            <Button variant="secondary" onClick={() => setImporting(true)}>
              <Upload size={15} />
              Import
            </Button>
            <Button
              onClick={() => openEditor("new")}
              disabled={!accounts.length}
            >
              <Plus size={16} />
              Add transaction
            </Button>
          </>
        }
      />
      {tagsOnly ? <div className="tag-shelf" role="group" aria-label="Filter tag assignments">
        <button aria-pressed={!params.get("tag")} onClick={()=>change("tag","")}>All transactions</button>
        {tags.data?.map(tag=><button key={tag} aria-pressed={params.get("tag")===tag} onClick={()=>change("tag",tag)}>{tag}</button>)}
      </div> : <ViewSwitch {...view} normal="Ledger"/>}
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
        <DateRangeSelect
          allowAll
          ranges={ranges}
          value={range ? period : customDates ? "custom" : "all"}
          onChange={(value) => {
            changeFilters({
              period: value === "all" ? "" : value,
              ...(value === "custom" ? bounds : { from: "", to: "" }),
            });
          }}
        />
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
        <a className="button secondary" href={"/api/export?" + requestQuery}>
          <Download size={15} />
          Export
        </a>
      </div>
      {filtersOpen && (
        <div className="filters-panel">
          {[
            ["from", "From", "date"],
            ["to", "To", "date"],
          ].map(([key, label, type]) => (
            <Field key={key} label={label}>
              <input
                type={type}
                value={requestParams.get(key) ?? ""}
                onChange={(e) =>
                  changeFilters({
                    period: "custom",
                    ...bounds,
                    [key]: e.target.value,
                  })
                }
              />
            </Field>
          ))}
          <AmountFilter
            label="Minimum amount"
            value={params.get("min")}
            navigationKey={queryString}
            onCommit={(value) => change("min", value)}
          />
          <AmountFilter
            label="Maximum amount"
            value={params.get("max")}
            navigationKey={queryString}
            onCommit={(value) => change("max", value)}
          />
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
          <Field label="Tag">
            <select
              value={params.get("tag") ?? ""}
              onChange={(e) => change("tag", e.target.value)}
            >
              <option value="">All tags</option>
              {[
                ...new Set([
                  ...(tags.data ?? ["Business"]),
                  ...(params.get("tag") ? [params.get("tag")!] : []),
                ]),
              ].map((tag) => (
                <option key={tag} value={tag}>
                  {tag}
                </option>
              ))}
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
      {selectedItems.length > 0 && (
        <div className="review-banner">
          <span>{selectedItems.length} selected</span>
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
                  items: selectedItems.map((t) => ({ id: t.id, revision: t.revision })),
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
          {selectedItems.length === 2 && (
            <Button
              variant="secondary"
              onClick={async () => {
                try {
                  const [first, second] = selectedItems.map((item) => item.id);
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
      <UploadFeedback upload={receiptUpload} />
      <div className="panel">
        {data.loading && !data.data ? (
          <Loading />
        ) : items.length ? (
          <>
            {tagsOnly || view.grid ? <TransactionGrid rows={items} tagsOnly={tagsOnly} onSaved={fieldSaved}/> : <div className="table-scroll">
              <table className="transactions-table">
                <thead>
                  <tr>
                    <th>
                      <input
                        type="checkbox"
                        aria-label="Select all visible transactions"
                        checked={selectedItems.length === items.length}
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
                    <th>Description</th>
                    <th>Merchant</th>
                    <th className="hide-mobile">Type</th>
                    <th className="hide-mobile">Account</th>
                    <th>Category</th>
                    <th className="align-right">Amount</th>
                    <th className="receipts-column">Receipts</th>
                    <th className="hide-mobile">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((t) => (
                    <tr
                      key={t.id}
                      onClick={(e) => {
                        if (
                          (e.target as HTMLElement).closest(
                            "button, input, a, select, textarea, label",
                          )
                        )
                          return;
                        openEditor(t.id);
                      }}
                    >
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
                      <td className="muted transaction-date">
                        <time dateTime={t.posted}>
                          {new Date(t.posted + "T12:00:00").toLocaleDateString(
                            "en-US",
                            { month: "short", day: "numeric", year: "numeric" },
                          )}
                        </time>
                      </td>
                      <td className="transaction-description">
                        <TransactionField transaction={t} field="description" onSaved={fieldSaved}>
                          <button
                            type="button"
                            className="transaction-name"
                            aria-haspopup="dialog"
                            onClick={() => openEditor(t.id)}
                          >
                            {t.description}
                          </button>
                        </TransactionField>
                        <div
                          className={`transaction-meta transaction-tag-list ${
                            t.split_count || t.transfer_id || t.tags.length
                              ? ""
                              : "transaction-meta-type-only"
                          }`}
                        >
                          <small className="transaction-mobile-type muted">
                            {formatEnumLabel(t.type)}
                          </small>
                          {(t.split_count > 0 || t.transfer_id) && (
                            <small className="muted">
                              {[
                                t.split_count > 0 ? `${t.split_count} splits` : "",
                                t.transfer_id ? "Linked" : "",
                              ].filter(Boolean).join(" · ")}
                            </small>
                          )}
                          {t.tags.map((tag) => (
                            <span key={tag} className="badge neutral">
                              {tag}
                            </span>
                          ))}
                        </div>
                      </td>
                      <td className="transaction-merchant">
                        <TransactionField transaction={t} field="merchant" onSaved={fieldSaved}>
                          <span className={t.merchant ? undefined : "muted"}>{t.merchant || "—"}</span>
                        </TransactionField>
                      </td>
                      <td className="hide-mobile">{formatEnumLabel(t.type)}</td>
                      <td className="hide-mobile">{t.account_name}</td>
                      <td>
                        {t.split_count || t.transfer_id ? (
                          <button type="button" className="ledger-category-trigger"
                            title={t.split_count ? "Edit split categories in transaction details" : "View linked transfer"}
                            onClick={() => openEditor(t.id)}>
                            <span className="badge neutral">{t.split_count ? "Split transaction" : (t.category_name ?? "Linked transfer")}</span>
                          </button>
                        ) : (
                          <TransactionField transaction={t} field="category_id" onSaved={fieldSaved}>
                            <span className={`badge ${t.category_name ? "neutral" : "amber"}`}
                              style={categoryBadgeStyle(t.category_id ? categoryColors.get(t.category_id) : undefined)}>
                              {t.category_name ?? "Uncategorized"}
                            </span>
                          </TransactionField>
                        )}
                      </td>
                      <td className="align-right money">
                        <TransactionAmount amount={t.amount} currency={t.currency} showPositiveSign />
                      </td>
                      <td className="receipts-column">
                        {t.attachment_count > 0 && (
                          <button
                            type="button"
                            className="receipt-count"
                            aria-label={`View ${t.attachment_count} ${t.attachment_count === 1 ? "attachment" : "attachments"} for ${t.description}`}
                            aria-haspopup="dialog"
                            title="View receipts and invoices"
                            onClick={() => openEditor(t.id, true)}
                          >
                            <Paperclip size={14} aria-hidden="true" />
                            <span aria-hidden="true">{t.attachment_count}</span>
                          </button>
                        )}
                        <AttachmentPicker
                          label={`Upload receipts for ${t.description}`}
                          className="receipt-count receipt-upload"
                          count={t.attachment_count}
                          disabled={receiptUpload.busy}
                          onChoose={(files) =>
                            receiptUpload.choose(t, t.attachment_count, files)
                          }
                        >
                          <Upload size={14} aria-hidden="true" />
                          {t.attachment_count === 0 && "Add"}
                        </AttachmentPicker>
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
            </div>}
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
          focusAttachments={focusAttachments}
        />
      )}{" "}
      {importing && <ImportDialog onClose={() => setImporting(false)} />}
    </>
  );
}
