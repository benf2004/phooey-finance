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
  Plus,
  ChevronDown,
  LockKeyhole,
  Table2,
  WrapText,
} from "lucide-react";
import { SheetCalendar } from "./SheetCalendar";
import { normalizeSheetDate } from "./sheet-calendar";
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
  newRow,
}: {
  rows: R[];
  columns: GridColumn<R>[];
  label: string;
  newRow?: { id: string; firstColumn: string; hint: string; pending?: boolean };
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
  const [optionIndex, setOptionIndex] = useState(0);
  const optionSearch = useRef({ text: "", time: 0 });
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
  const input = useRef<HTMLTextAreaElement>(null);
  const hintId = useId();
  const errorId = useId();
  const rowIndex = Math.max(
    0,
    rows.findIndex((row) => row.id === selected?.row),
  );
  const colIndex = Math.max(
    0,
    columns.findIndex((col) => col.key === selected?.column),
  );
  const activeCell =
    rows[rowIndex] && columns[colIndex]
      ? { row: rows[rowIndex].id, column: columns[colIndex].key }
      : null;
  const address =
    rowIndex >= 0 && colIndex >= 0
      ? columnLetter(colIndex) + (rowIndex + 2)
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
    if (current.current?.column.options) popup.current?.focus();
    else if (current.current?.column.type === "tags")
      popup.current?.querySelector<HTMLElement>("input")?.focus();
    else input.current?.focus();
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
    return autosave.save(
      () =>
        edit.column.save!(
          edit.row,
          edit.column.type === "date"
            ? normalizeSheetDate(edit.draft)
            : edit.draft,
        ),
      {
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
      },
    );
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
    setOptionIndex(
      Math.max(0, column.options?.findIndex((o) => o.value === original) ?? 0),
    );
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
    if (event.target !== event.currentTarget || event.nativeEvent.isComposing)
      return;
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
    } else if (
      event.key === "Enter" ||
      event.key === "F2" ||
      (event.key === " " && col.options)
    ) {
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

  function editorKey(e: KeyboardEvent<HTMLElement>) {
    if (busy || e.nativeEvent.isComposing || e.defaultPrevented) return;
    if (
      e.altKey &&
      e.key === "ArrowDown" &&
      current.current?.column.type === "date"
    ) {
      e.preventDefault();
      popup.current
        ?.querySelector<HTMLElement>('.sheet-calendar-day[tabindex="0"]')
        ?.focus();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      const cell = current.current?.cell;
      close();
      if (cell) focusCell(cell);
    } else if (
      e.key === "Tab" ||
      (e.key === "Enter" &&
        !e.shiftKey &&
        !e.altKey &&
        current.current?.column.type !== "tags")
    ) {
      e.preventDefault();
      const cell = current.current?.cell;
      if (cell)
        void finishAt(
          destination(
            cell,
            e.key === "Enter" ? 1 : 0,
            e.key === "Tab" ? (e.shiftKey ? -1 : 1) : 0,
            e.key === "Tab",
          ),
        );
    }
  }
  async function chooseOption(value: string) {
    const cell = current.current?.cell;
    if (!cell || autosave.pending) return;
    draft(value);
    if (await commit()) focusCell(cell);
  }
  function dropdownKey(e: KeyboardEvent<HTMLDivElement>) {
    const options = current.current?.column.options ?? [];
    if (busy || e.nativeEvent.isComposing) return;
    if (!options.length) {
      editorKey(e);
      return;
    }
    if (
      e.key === "ArrowDown" ||
      e.key === "ArrowUp" ||
      e.key === "Home" ||
      e.key === "End"
    ) {
      e.preventDefault();
      setOptionIndex((i) =>
        e.key === "Home"
          ? 0
          : e.key === "End"
            ? options.length - 1
            : (i + (e.key === "ArrowDown" ? 1 : -1) + options.length) %
              options.length,
      );
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      void chooseOption(options[optionIndex].value);
    } else if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const now = Date.now();
      const text =
        (now - optionSearch.current.time < 750
          ? optionSearch.current.text
          : "") + e.key.toLowerCase();
      optionSearch.current = { text, time: now };
      const index = options.findIndex((o) =>
        o.label.toLowerCase().startsWith(text),
      );
      if (index >= 0) setOptionIndex(index);
      e.preventDefault();
    } else editorKey(e);
  }
  const editingRow = editor?.cell.row;
  const editingColumn = editor?.cell.column;
  const isDate = editor?.column.type === "date";
  const hasMenu =
    !!editor &&
    (!!editor.column.options || editor.column.type === "tags" || isDate);
  useLayoutEffect(() => {
    if (!editor || !hasMenu) return;
    const place = () => {
      const rect = cellElement(editor.cell)?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.min(
        isDate
          ? 232
          : Math.max(rect.width, editor.column.type === "tags" ? 280 : 200),
        window.innerWidth - 16,
      );
      const height = Math.min(popup.current?.offsetHeight || 180, 320);
      const below = window.innerHeight - rect.bottom - 8;
      const above = rect.top - 8;
      const flip = below < height && above > below;
      setPosition({
        left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
        top: flip ? Math.max(8, rect.top - height - 1) : rect.bottom + 1,
        width,
        maxHeight: Math.max(80, Math.min(320, flip ? above : below)),
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
  }, [editingRow, editingColumn, hasMenu, isDate, rows, columns]);
  useLayoutEffect(() => {
    if (!editor || (hasMenu && !isDate) || !input.current) return;
    const sizeInput = () => {
      const element = input.current;
      const cell = cellElement(editor.cell);
      if (!element || !cell) return;
      const rect = cell.getBoundingClientRect();
      const bounds = table.current?.parentElement?.getBoundingClientRect();
      const measure = document.createElement("canvas").getContext("2d");
      if (measure) measure.font = "13px Arial";
      const textWidth =
        Math.max(
          0,
          ...editor.draft
            .split("\n")
            .map((line) => measure?.measureText(line).width ?? 0),
        ) + 16;
      const available = Math.max(
        rect.width,
        (bounds?.right ?? window.innerWidth) - rect.left - 2,
      );
      const width = wrap
        ? rect.width + 1
        : Math.min(available, Math.max(rect.width + 1, textWidth));
      element.style.width = width + "px";
      element.style.height = "0px";
      element.style.height =
        Math.min(260, Math.max(rect.height + 1, element.scrollHeight + 4)) +
        "px";
    };
    sizeInput();
    window.addEventListener("resize", sizeInput);
    return () => window.removeEventListener("resize", sizeInput);
  }, [
    editingRow,
    editingColumn,
    editor?.draft,
    wrap,
    rows,
    columns,
    hasMenu,
    isDate,
  ]);
  useEffect(() => {
    if (!editingRow) return;
    focusInput();
    if (input.current) {
      if (current.current?.selectAll) input.current.select();
      else
        input.current.setSelectionRange(
          input.current.value.length,
          input.current.value.length,
        );
    }
  }, [editingRow, editingColumn]);
  useEffect(() => {
    popup.current
      ?.querySelector<HTMLElement>(`[data-option-index="${optionIndex}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [optionIndex, editingRow, editingColumn]);
  useEffect(() => {
    if (!editor) return;
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        !popup.current?.contains(target) &&
        !input.current?.contains(target) &&
        !(
          current.current && cellElement(current.current.cell)?.contains(target)
        )
      ) {
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
        <button
          type="button"
          className="sheet-tool"
          aria-pressed={wrap}
          onClick={() => {
            setWrap(!wrap);
            localStorage.setItem("phooey-sheet-wrap", String(!wrap));
          }}
        >
          <WrapText size={16} />
          Wrap text
        </button>
        {newRow && (
          <button
            type="button"
            className="sheet-tool"
            disabled={busy}
            onClick={() => {
              const row = rows.find((r) => r.id === newRow.id),
                column = columns.find((c) => c.key === newRow.firstColumn);
              if (row && column) void open(row, column);
            }}
          >
            <Plus size={16} />
            Add row
          </button>
        )}
        <span
          className={`sheet-save-status${error ? " has-error" : ""}`}
          role="status"
        >
          {busy ? (
            "Saving…"
          ) : error ? (
            "Not saved"
          ) : newRow && (newRow.pending || activeRow?.id === newRow.id) ? (
            newRow?.hint
          ) : editor ? (
            "Editing…"
          ) : status ? (
            <>
              <Check size={14} />
              {status}
            </>
          ) : (
            "All changes saved"
          )}
        </span>
      </div>
      <div className="sheet-value-bar">
        <span className="sheet-address" aria-label="Selected cell">
          {rows.length ? address : "—"}
        </span>
        <span className="sheet-fx" aria-hidden="true">
          fx
        </span>
        <div
          title={fullValue}
          onDoubleClick={() => {
            if (activeRow && activeCol) void open(activeRow, activeCol);
          }}
        >
          {editor && editor.column.type !== "tags" ? editor.draft : fullValue}
        </div>
        {readonly && (
          <span className="sheet-readonly">
            <LockKeyhole size={12} />
            Read only
          </span>
        )}
      </div>
      {error && (
        <p id={errorId} role="alert" className="sheet-editor-error">
          {error}{" "}
          <span>
            Your edit is kept in the cell. Enter or Tab retries; Esc discards.
          </span>
        </p>
      )}
      <div className="table-scroll sheet-scroll">
        <table
          ref={table}
          role="grid"
          aria-label={label}
          aria-describedby={hintId}
          aria-rowcount={rows.length + 2}
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
            <tr className="sheet-letters">
              <th className="sheet-corner" aria-label="Row number" />
              {columns.map((col, i) => (
                <th
                  key={col.key}
                  scope="col"
                  className={
                    activeCell?.column === col.key ? "sheet-active-heading" : ""
                  }
                >
                  {columnLetter(i)}
                </th>
              ))}
            </tr>
            <tr className="sheet-labels">
              <th scope="row">1</th>
              {columns.map((col) => (
                <th key={col.key} scope="col">
                  {col.title}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr
                key={row.id}
                className={row.id === newRow?.id ? "sheet-new-row" : undefined}
              >
                <th
                  scope="row"
                  className={
                    activeCell?.row === row.id ? "sheet-active-heading" : ""
                  }
                >
                  {row.id === newRow?.id ? (
                    <span aria-label="New row">+</span>
                  ) : (
                    i + 2
                  )}
                </th>
                {columns.map((col) => {
                  const editable = !!col.save && !col.locked?.(row);
                  const cell = { row: row.id, column: col.key };
                  const editing = sameCell(editor?.cell ?? null, cell);
                  const active = sameCell(activeCell, cell);
                  const optionLabel =
                    col.options?.find((o) => o.value === col.value(row))
                      ?.label ?? col.value(row);
                  const value = col.display ? col.display(row) : optionLabel;
                  return (
                    <td
                      key={col.key}
                      role="gridcell"
                      tabIndex={active ? 0 : -1}
                      aria-selected={active}
                      aria-readonly={!editable}
                      aria-label={`${col.title}, row ${i + 1}: ${typeof value === "string" ? value : col.value(row)}`}
                      className={`${active ? "selected-cell " : ""}${editing ? "editing-cell " : ""}${!editable ? "fixed-cell " : ""}${col.type === "number" ? "number-cell" : ""}`}
                      onClick={(e) => {
                        if (
                          e.target === e.currentTarget ||
                          (e.target as HTMLElement).closest(".grid-value")
                        )
                          void select(cell);
                      }}
                      onDoubleClick={() => void open(row, col)}
                      onFocus={(e) => {
                        if (e.target === e.currentTarget && !current.current)
                          setSelected(cell);
                      }}
                      onKeyDown={(e) => cellKey(e, row, col)}
                      onCopy={(e) => {
                        if (e.target !== e.currentTarget) return;
                        e.clipboardData.setData(
                          "text/plain",
                          col.type === "tags"
                            ? JSON.parse(col.value(row)).join(", ")
                            : col.value(row),
                        );
                        e.preventDefault();
                      }}
                      onPaste={(e) => {
                        if (e.target !== e.currentTarget) return;
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
                        {col.options && editable ? (
                          <button
                            type="button"
                            tabIndex={-1}
                            className="sheet-dropdown-chip"
                            aria-label={`${col.title}: ${optionLabel}`}
                            aria-haspopup="listbox"
                            aria-expanded={editing}
                            onClick={(e) => {
                              e.stopPropagation();
                              void open(row, col);
                            }}
                          >
                            <span>{optionLabel || "—"}</span>
                            <ChevronDown size={12} />
                          </button>
                        ) : (
                          value || ""
                        )}
                      </div>
                      {editing &&
                        editor &&
                        !col.options &&
                        col.type !== "tags" && (
                          <textarea
                            ref={input}
                            className="sheet-inline-input"
                            aria-label={col.title}
                            aria-invalid={!!error}
                            aria-describedby={error ? errorId : hintId}
                            rows={1}
                            readOnly={busy}
                            inputMode={
                              col.type === "number" ? "decimal" : undefined
                            }
                            spellCheck={false}
                            value={editor.draft}
                            onChange={(e) => draft(e.target.value)}
                            onKeyDown={editorKey}
                            onBlur={(event) => {
                              if (
                                !popup.current?.contains(
                                  event.relatedTarget as Node | null,
                                )
                              )
                                void commit();
                            }}
                          />
                        )}
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
          <Table2 size={14} />
          {label.replace(/ spreadsheet$/, "")}
        </span>
        <span>
          {(rows.length - (newRow ? 1 : 0)).toLocaleString()}{" "}
          {rows.length - (newRow ? 1 : 0) === 1 ? "row" : "rows"}
        </span>
      </div>
      <span id={hintId} className="sheet-sr-only">
        Double-click or press Enter to edit. Enter or Tab saves. Shift+Enter
        adds a line. Escape discards.
      </span>
      {editor &&
        hasMenu &&
        createPortal(
          isDate ? (
            <div
              ref={popup}
              className="sheet-calendar"
              style={position}
              role="dialog"
              aria-label="Choose date"
              aria-busy={busy}
              onPointerDown={(event) => event.preventDefault()}
              onKeyDown={(event) => {
                if (event.key === "Escape" || event.key === "Tab")
                  editorKey(event);
              }}
              onBlur={(event) => {
                if (
                  !event.currentTarget.contains(
                    event.relatedTarget as Node | null,
                  ) &&
                  event.relatedTarget !== input.current
                )
                  void commit();
              }}
            >
              <SheetCalendar
                key={`${editor.cell.row}-${editor.cell.column}`}
                value={editor.draft}
                disabled={busy}
                onSelect={(value) => void chooseOption(value)}
              />
            </div>
          ) : editor.column.options ? (
            <div
              ref={popup}
              className="sheet-dropdown-menu"
              style={position}
              role="listbox"
              aria-label={editor.column.title}
              tabIndex={0}
              aria-activedescendant={`${hintId}-option-${optionIndex}`}
              aria-busy={busy}
              onKeyDown={dropdownKey}
              onBlur={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node | null))
                  void commit();
              }}
            >
              {editor.column.options.map((option, i) => (
                <div
                  key={option.value}
                  id={`${hintId}-option-${i}`}
                  role="option"
                  aria-selected={editor.draft === option.value}
                  data-option-index={i}
                  className={`sheet-dropdown-option${optionIndex === i ? " is-highlighted" : ""}`}
                  onPointerDown={(e) => e.preventDefault()}
                  onPointerMove={() => setOptionIndex(i)}
                  onClick={() => void chooseOption(option.value)}
                >
                  <span className="sheet-option-chip">{option.label}</span>
                  {editor.draft === option.value && <Check size={14} />}
                </div>
              ))}
            </div>
          ) : (
            <div
              ref={popup}
              className="sheet-tags-editor"
              style={position}
              role="dialog"
              aria-label={`Edit ${editor.column.title}`}
              aria-busy={busy}
              onKeyDown={editorKey}
              onBlur={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node | null))
                  void commit();
              }}
            >
              <fieldset disabled={busy}>
                <TransactionTags
                  value={JSON.parse(editor.draft)}
                  commitOnBlur
                  onChange={(tags) => draft(JSON.stringify(tags))}
                />
              </fieldset>
            </div>
          ),
          document.body,
        )}
    </section>
  );
}
