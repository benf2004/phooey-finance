import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type KeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import {
  Check,
  ChevronDown,
  LockKeyhole,
  Maximize2,
  Minimize2,
  Table2,
  WrapText,
} from "lucide-react";
import TransactionTags from "./TransactionTags";
import { createCellAutosave } from "./cell-autosave";
import "./ledger-grid.css";

export type GridColumn<R> = {
  key: string;
  title: string;
  value: (row: R) => string;
  display?: (row: R) => ReactNode;
  options?: { value: string; label: string }[];
  type?: "tags" | "number" | "date";
  width?: number;
  save?: (row: R, draft: string) => Promise<void>;
  locked?: (row: R) => boolean;
};

type Cell = { row: string; column: string };
const sameCell = (a: Cell | null, b: Cell) =>
  a?.row === b.row && a.column === b.column;
function columnWidth<R>(col: GridColumn<R>) {
  return (
    col.width ??
    (col.type === "number"
      ? 130
      : col.type === "date"
        ? 124
        : ["description", "notes", "pattern"].includes(col.key)
          ? 280
          : 180)
  );
}
function columnLetter(index: number): string {
  return index < 26
    ? String.fromCharCode(65 + index)
    : columnLetter(Math.floor(index / 26) - 1) + columnLetter(index % 26);
}

export function useGridView(page: string) {
  const key = "phooey-grid-" + page;
  const [grid, setGrid] = useState(() => localStorage.getItem(key) === "true");
  function change(next: boolean) {
    setGrid(next);
    localStorage.setItem(key, String(next));
  }
  return { grid, change };
}

export function ViewSwitch({
  grid,
  change,
  normal,
}: {
  grid: boolean;
  change: (v: boolean) => void;
  normal: string;
}) {
  return (
    <div className="view-switch" role="group" aria-label="Page view">
      <button type="button" aria-pressed={!grid} onClick={() => change(false)}>
        {normal}
      </button>
      <button type="button" aria-pressed={grid} onClick={() => change(true)}>
        <Table2 size={14} />
        Spreadsheet
      </button>
    </div>
  );
}

export function LedgerGrid<R extends { id: string }>({
  rows,
  columns,
  label,
}: {
  rows: R[];
  columns: GridColumn<R>[];
  label: string;
}) {
  type Editor = {
    cell: Cell;
    row: R;
    column: GridColumn<R>;
    original: string;
    draft: string;
    selectAll: boolean;
  };
  const [editor, setEditor] = useState<Editor | null>(null);
  // The ref changes synchronously so blur + click / Enter cannot submit a draft twice.
  const current = useRef<Editor | null>(null);
  const [autosave] = useState(createCellAutosave);
  const latest = useRef({ rows, columns });
  latest.current = { rows, columns };
  const [selected, setSelected] = useState<Cell | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [wrap, setWrap] = useState(
    () => localStorage.getItem("phooey-sheet-wrap") === "true",
  );
  const [position, setPosition] = useState({
    left: 8,
    top: 8,
    width: 360,
    maxHeight: 400,
  });
  const table = useRef<HTMLTableElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const hintId = useId();
  const errorId = useId();
  const rowIndex = rows.findIndex((row) => row.id === selected?.row);
  const colIndex = columns.findIndex((col) => col.key === selected?.column);
  const activeCell =
    rowIndex >= 0 && colIndex >= 0
      ? selected
      : rows[0] && columns[0]
        ? { row: rows[0].id, column: columns[0].key }
        : null;
  const address =
    rowIndex >= 0 && colIndex >= 0
      ? columnLetter(colIndex) + (rowIndex + 1)
      : "—";
  const activeRow = rows[rowIndex];
  const activeCol = columns[colIndex];
  const readonly =
    activeRow &&
    activeCol &&
    (!activeCol.save || activeCol.locked?.(activeRow));
  const fullValue =
    activeRow && activeCol
      ? activeCol.type === "tags"
        ? JSON.parse(activeCol.value(activeRow)).join(", ")
        : (activeCol.options?.find(
            (o) => o.value === activeCol.value(activeRow),
          )?.label ?? activeCol.value(activeRow))
      : "";

  function cellElement(cell: Cell) {
    const ri = rows.findIndex((row) => row.id === cell.row);
    const ci = columns.findIndex((col) => col.key === cell.column);
    return table.current?.tBodies[0]?.rows[ri]?.cells[ci + 1];
  }
  function focusCell(cell: Cell) {
    setSelected(cell);
    requestAnimationFrame(() => {
      if (current.current) return;
      const element = cellElement(cell);
      element?.focus({ preventScroll: true });
      element?.scrollIntoView({ block: "nearest", inline: "nearest" });
    });
  }
  function updateEditor(next: Editor | null) {
    current.current = next;
    setEditor(next);
  }
  function draft(value: string) {
    if (current.current && !autosave.pending)
      updateEditor({ ...current.current, draft: value });
  }
  function focusInput() {
    popup.current?.querySelector<HTMLElement>("textarea,input,select")?.focus();
  }
  function close() {
    updateEditor(null);
    setError("");
  }
  function commit(): Promise<boolean> {
    if (autosave.pending) return autosave.pending;
    const edit = current.current;
    if (!edit) return Promise.resolve(true);
    if (edit.draft === edit.original) {
      close();
      return Promise.resolve(true);
    }
    setBusy(true);
    setError("");
    return autosave.save(() => edit.column.save!(edit.row, edit.draft), {
      saved: () => {
        close();
        setStatus("Saved");
      },
      failed: (e) => {
        setError(
          e instanceof Error
            ? e.message
            : "Could not save this cell. Try again.",
        );
        requestAnimationFrame(focusInput);
      },
      settled: () => setBusy(false),
    });
  }
  async function select(cell: Cell) {
    if (current.current && sameCell(current.current.cell, cell)) return;
    if (await commit()) focusCell(cell);
  }
  async function open(row: R, column: GridColumn<R>, replacement?: string) {
    if (!column.save || column.locked?.(row)) return;
    const cell = { row: row.id, column: column.key };
    if (current.current && sameCell(current.current.cell, cell)) {
      focusInput();
      return;
    }
    const wasEditing = !!current.current;
    if (!(await commit())) return;
    if (wasEditing)
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => resolve()),
      );
    const freshRow = latest.current.rows.find((r) => r.id === row.id);
    const freshColumn = latest.current.columns.find(
      (c) => c.key === column.key,
    );
    if (!freshRow || !freshColumn?.save || freshColumn.locked?.(freshRow))
      return;
    row = freshRow;
    column = freshColumn;
    const original = column.value(row);
    setSelected(cell);
    setExpanded(false);
    setError("");
    setStatus("");
    updateEditor({
      cell,
      row,
      column,
      original,
      draft: replacement ?? original,
      selectAll: replacement === undefined,
    });
  }
  function destination(cell: Cell, dr: number, dc: number, tab = false): Cell {
    let ri = rows.findIndex((row) => row.id === cell.row) + dr;
    let ci = columns.findIndex((col) => col.key === cell.column) + dc;
    if (tab && ci >= columns.length) {
      ci = 0;
      ri++;
    }
    if (tab && ci < 0) {
      ci = columns.length - 1;
      ri--;
    }
    if (ri < 0 || ri >= rows.length || ci < 0 || ci >= columns.length)
      return cell;
    return { row: rows[ri].id, column: columns[ci].key };
  }
  async function finishAt(cell: Cell) {
    if (await commit()) focusCell(cell);
  }
  function cellKey(
    event: KeyboardEvent<HTMLTableCellElement>,
    row: R,
    col: GridColumn<R>,
  ) {
    if (event.nativeEvent.isComposing) return;
    const cell = { row: row.id, column: col.key };
    const directions: Record<string, [number, number]> = {
      ArrowUp: [-1, 0],
      ArrowDown: [1, 0],
      ArrowLeft: [0, -1],
      ArrowRight: [0, 1],
    };
    if (directions[event.key]) {
      event.preventDefault();
      void select(destination(cell, ...directions[event.key]));
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      void select({
        row:
          event.ctrlKey || event.metaKey
            ? rows[event.key === "Home" ? 0 : rows.length - 1].id
            : row.id,
        column: columns[event.key === "Home" ? 0 : columns.length - 1].key,
      });
    } else if (event.key === "Tab") {
      const next = destination(cell, 0, event.shiftKey ? -1 : 1, true);
      if (!sameCell(cell, next)) {
        event.preventDefault();
        void select(next);
      }
    } else if (event.key === "Enter" || event.key === "F2") {
      event.preventDefault();
      void open(row, col);
    } else if (
      event.key.length === 1 &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey &&
      col.type !== "tags" &&
      !col.options
    ) {
      event.preventDefault();
      void open(row, col, event.key);
    }
  }

  const editingRow = editor?.cell.row;
  const editingColumn = editor?.cell.column;
  useLayoutEffect(() => {
    if (!editor) return;
    const place = () => {
      const rect = cellElement(editor.cell)?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.min(
        expanded ? 560 : Math.max(rect.width, 340),
        window.innerWidth - 16,
      );
      const height = Math.min(
        popup.current?.offsetHeight || 220,
        window.innerHeight - 16,
      );
      setPosition({
        left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
        top: Math.max(8, Math.min(rect.top, window.innerHeight - height - 8)),
        width,
        maxHeight: window.innerHeight - 16,
      });
    };
    place();
    const observer = new ResizeObserver(place);
    if (popup.current) observer.observe(popup.current);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [editingRow, editingColumn, expanded, rows, columns]);
  useEffect(() => {
    if (!editingRow) return;
    focusInput();
    const input = popup.current?.querySelector<
      HTMLTextAreaElement | HTMLInputElement
    >("textarea,input");
    if (input && input.type !== "date") {
      if (current.current?.selectAll) input.select();
      else input.setSelectionRange(input.value.length, input.value.length);
    }
  }, [editingRow, editingColumn]);
  useEffect(() => {
    if (!editor) return;
    const outside = (event: PointerEvent) => {
      if (!popup.current?.contains(event.target as Node)) {
        // Blur first so a pending tag is added before the cell is committed.
        (document.activeElement as HTMLElement | null)?.blur?.();
        void commit();
      }
    };
    const unload = (event: BeforeUnloadEvent) => {
      if (
        autosave.pending ||
        (current.current && current.current.draft !== current.current.original)
      )
        event.preventDefault();
    };
    document.addEventListener("pointerdown", outside);
    window.addEventListener("beforeunload", unload);
    return () => {
      document.removeEventListener("pointerdown", outside);
      window.removeEventListener("beforeunload", unload);
    };
  }, [!!editor]);

  return (
    <section
      className={`ledger-sheet${wrap ? " sheet-wrap" : ""}`}
      aria-label={label}
    >
      <div className="sheet-toolbar">
        <span className="sheet-address" aria-label="Selected cell">
          {address}
        </span>
        <button
          type="button"
          className="sheet-tool"
          aria-pressed={wrap}
          onClick={() => {
            setWrap(!wrap);
            localStorage.setItem("phooey-sheet-wrap", String(!wrap));
          }}
        >
          <WrapText size={15} />
          Wrap text
        </button>
        <span
          className={`sheet-save-status${error ? " has-error" : ""}`}
          role="status"
        >
          {busy ? (
            "Saving…"
          ) : error ? (
            "Not saved"
          ) : status ? (
            <>
              <Check size={13} />
              {status}
            </>
          ) : (
            "Changes save automatically"
          )}
        </span>
      </div>
      <div className="sheet-value-bar">
        <span>{activeCol?.title ?? "Cell value"}</span>
        <div title={fullValue}>
          {editor && editor.column.type !== "tags"
            ? editor.draft || "—"
            : fullValue || "—"}
        </div>
        {readonly && (
          <span className="sheet-readonly">
            <LockKeyhole size={12} />
            Read only
          </span>
        )}
      </div>
      <div className="table-scroll sheet-scroll">
        <table
          ref={table}
          role="grid"
          aria-label={label}
          aria-describedby={hintId}
          aria-rowcount={rows.length + 1}
          aria-colcount={columns.length + 1}
          style={{
            width:
              44 + columns.reduce((total, col) => total + columnWidth(col), 0),
          }}
        >
          <colgroup>
            <col style={{ width: 44 }} />
            {columns.map((col) => (
              <col key={col.key} style={{ width: columnWidth(col) }} />
            ))}
          </colgroup>
          <thead>
            <tr>
              <th scope="col" aria-label="Row number" className="sheet-corner">
                #
              </th>
              {columns.map((col, i) => (
                <th
                  key={col.key}
                  scope="col"
                  className={
                    activeCell?.column === col.key ? "sheet-active-heading" : ""
                  }
                >
                  <span className="sheet-column-letter">{columnLetter(i)}</span>
                  {col.title}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={row.id}>
                <th
                  scope="row"
                  className={
                    activeCell?.row === row.id ? "sheet-active-heading" : ""
                  }
                >
                  {i + 1}
                </th>
                {columns.map((col) => {
                  const editable = !!col.save && !col.locked?.(row);
                  const cell = { row: row.id, column: col.key };
                  const editing = sameCell(editor?.cell ?? null, cell);
                  const active = sameCell(activeCell, cell);
                  const value = col.display
                    ? col.display(row)
                    : (col.options?.find((o) => o.value === col.value(row))
                        ?.label ?? col.value(row));
                  return (
                    <td
                      key={col.key}
                      role="gridcell"
                      tabIndex={active ? 0 : -1}
                      aria-selected={active}
                      aria-readonly={!editable}
                      aria-label={
                        col.title +
                        ", row " +
                        (i + 1) +
                        ": " +
                        (typeof value === "string" ? value : col.value(row))
                      }
                      className={`${active ? "selected-cell " : ""}${editing ? "editing-cell " : ""}${!editable ? "fixed-cell " : ""}${col.type === "number" ? "number-cell" : ""}`}
                      onClick={() => void select(cell)}
                      onDoubleClick={() => void open(row, col)}
                      onFocus={() => {
                        if (!current.current) setSelected(cell);
                      }}
                      onKeyDown={(e) => cellKey(e, row, col)}
                      onCopy={(e) => {
                        e.clipboardData.setData(
                          "text/plain",
                          col.type === "tags"
                            ? JSON.parse(col.value(row)).join(", ")
                            : col.value(row),
                        );
                        e.preventDefault();
                      }}
                      onPaste={(e) => {
                        if (editable && !col.options && col.type !== "tags") {
                          e.preventDefault();
                          void open(
                            row,
                            col,
                            e.clipboardData.getData("text/plain"),
                          );
                        }
                      }}
                    >
                      <div
                        className="grid-value"
                        title={
                          typeof value === "string" ? value : col.value(row)
                        }
                      >
                        {value || <span className="grid-blank">—</span>}
                        {editable && col.options && (
                          <ChevronDown
                            className="sheet-select-indicator"
                            size={12}
                          />
                        )}
                      </div>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!rows.length && <p className="sheet-empty">No records in this view.</p>}
      <div className="sheet-footer">
        <span>
          {rows.length.toLocaleString()} {rows.length === 1 ? "row" : "rows"} ·{" "}
          {columns.length} columns
        </span>
        <span id={hintId}>
          Double-click to edit · Enter or Tab to finish · Esc to discard
        </span>
      </div>
      {editor &&
        createPortal(
          <div
            ref={popup}
            className={`sheet-cell-editor${expanded ? " is-expanded" : ""}`}
            style={position}
            role="dialog"
            aria-label={`Edit ${editor.column.title}`}
            aria-busy={busy}
            onBlur={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null))
                void commit();
            }}
            onKeyDown={(e) => {
              if (busy || e.nativeEvent.isComposing || e.defaultPrevented)
                return;
              if (e.key === "Escape") {
                e.preventDefault();
                const cell = editor.cell;
                close();
                focusCell(cell);
                return;
              }
              if (e.target instanceof HTMLButtonElement) return;
              if (
                e.key === "Tab" ||
                (e.key === "Enter" &&
                  !e.shiftKey &&
                  editor.column.type !== "tags")
              ) {
                e.preventDefault();
                void finishAt(
                  destination(
                    editor.cell,
                    e.key === "Enter" ? 1 : 0,
                    e.key === "Tab" ? (e.shiftKey ? -1 : 1) : 0,
                    e.key === "Tab",
                  ),
                );
              }
            }}
          >
            <div className="sheet-editor-heading">
              <span>
                {address}
                <b>{editor.column.title}</b>
              </span>
              {!editor.column.options &&
                editor.column.type !== "tags" &&
                editor.column.type !== "date" &&
                editor.column.type !== "number" && (
                  <button
                    type="button"
                    className="sheet-tool"
                    aria-label={expanded ? "Shrink editor" : "Expand editor"}
                    onClick={() => {
                      setExpanded(!expanded);
                      requestAnimationFrame(focusInput);
                    }}
                  >
                    {expanded ? (
                      <Minimize2 size={14} />
                    ) : (
                      <Maximize2 size={14} />
                    )}
                  </button>
                )}
            </div>
            <fieldset disabled={busy}>
              {editor.column.type === "tags" ? (
                <TransactionTags
                  value={JSON.parse(editor.draft)}
                  commitOnBlur
                  onChange={(tags) => draft(JSON.stringify(tags))}
                />
              ) : editor.column.options ? (
                <select
                  aria-label={editor.column.title}
                  value={editor.draft}
                  onChange={(e) => draft(e.target.value)}
                >
                  {editor.column.options.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              ) : editor.column.type === "date" ||
                editor.column.type === "number" ? (
                <input
                  aria-label={editor.column.title}
                  aria-invalid={!!error}
                  aria-describedby={error ? errorId : undefined}
                  type={editor.column.type === "date" ? "date" : "text"}
                  inputMode={
                    editor.column.type === "number" ? "decimal" : undefined
                  }
                  value={editor.draft}
                  onChange={(e) => draft(e.target.value)}
                />
              ) : (
                <textarea
                  aria-label={editor.column.title}
                  aria-invalid={!!error}
                  aria-describedby={error ? errorId : undefined}
                  rows={expanded ? 9 : 3}
                  value={editor.draft}
                  onChange={(e) => draft(e.target.value)}
                />
              )}
            </fieldset>
            <div className="sheet-editor-hint">
              {busy
                ? "Saving…"
                : editor.column.type === "tags"
                  ? "Tab or click outside to finish"
                  : editor.column.options || editor.column.type
                    ? "Enter or Tab to finish · Esc to discard"
                    : "Enter to finish · Shift+Enter for a new line"}
            </div>
            {error && (
              <p id={errorId} role="alert" className="sheet-editor-error">
                {error}{" "}
                <span>
                  Your edit is kept here. Press Enter or Tab to retry; Esc to
                  discard.
                </span>
              </p>
            )}
          </div>,
          document.body,
        )}
    </section>
  );
}
