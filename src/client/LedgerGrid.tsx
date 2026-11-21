import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, Table2, X } from "lucide-react";
import TransactionTags from "./TransactionTags";

export type GridColumn<R> = {
  key: string;
  title: string;
  value: (row: R) => string;
  display?: (row: R) => ReactNode;
  options?: { value: string; label: string }[];
  type?: "tags" | "number";
  save?: (row: R, draft: string) => Promise<void>;
  locked?: (row: R) => boolean;
};

export function useGridView(page: string) {
  const key = "phooey-grid-" + page;
  const [grid, setGrid] = useState(() => localStorage.getItem(key) === "true");
  function change(next: boolean) {
    setGrid(next);
    localStorage.setItem(key, String(next));
  }
  return { grid, change };
}

export function ViewSwitch({ grid, change, normal }: { grid: boolean; change: (v: boolean) => void; normal: string }) {
  return <div className="view-switch" role="group" aria-label="Page view">
    <button type="button" aria-pressed={!grid} onClick={() => change(false)}>{normal}</button>
    <button type="button" aria-pressed={grid} onClick={() => change(true)}><Table2 size={14}/>Spreadsheet</button>
  </div>;
}

export function LedgerGrid<R extends { id: string }>({ rows, columns, label }: { rows: R[]; columns: GridColumn<R>[]; label: string }) {
  type Editor = { row: R; column: GridColumn<R>; original: string; draft: string };
  const [editor, setEditor] = useState<Editor | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);
  const table = useRef<HTMLTableElement>(null);
  const [status, setStatus] = useState("");
  const activeRow = editor?.row.id;
  const activeColumn = editor?.column.key;
  useEffect(() => {
    if (activeRow && activeColumn) {
      const input = table.current?.querySelector<HTMLElement>(".grid-editor input,.grid-editor select");
      input?.focus();
      if (input instanceof HTMLInputElement && input.type === "text") input.select();
    }
  }, [activeRow, activeColumn]);
  function open(row: R, column: GridColumn<R>) {
    if (saving.current || !column.save || column.locked?.(row)) return;
    if (editor && editor.draft !== editor.original) {
      setError("Save or cancel this cell before editing another.");
      return;
    }
    setError("");
    setStatus("");
    const original = column.value(row);
    setEditor({ row, column, original, draft: original });
  }
  function finish(step = 0, vertical = false) {
    const cell = table.current?.querySelector<HTMLTableCellElement>(".editing-cell");
    const rowIndex = cell?.parentElement instanceof HTMLTableRowElement ? cell.parentElement.rowIndex : 0;
    const buttons = Array.from(table.current?.querySelectorAll<HTMLTableCellElement>("td[data-editable]") ?? []);
    const next = vertical && cell ? table.current?.rows[rowIndex + step]?.cells[cell.cellIndex] : buttons[buttons.indexOf(cell!) + step];
    setEditor(null);
    setError("");
    requestAnimationFrame(() => ((next ?? cell)?.querySelector("button") ?? cell?.querySelector("button"))?.focus());
  }
  async function commit(step = 0, vertical = false) {
    if (!editor || saving.current) return;
    if (editor.original === editor.draft) { finish(step, vertical); return; }
    saving.current = true;
    setBusy(true);
    try {
      await editor.column.save!(editor.row, editor.draft);
      setStatus(editor.column.title + " saved");
      finish(step, vertical);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }
  return <section className="ledger-sheet" aria-label={label}>
    <div className="sheet-guide"><Table2 size={15}/><span>Select a cell to edit. Enter saves. Escape cancels.</span><span role="status">{status}</span></div>
    <div className="table-scroll"><table ref={table} aria-label={label}><thead><tr><th scope="col">#</th>{columns.map(c => <th key={c.key} scope="col">{c.title}</th>)}</tr></thead>
      <tbody>{rows.map((row, i) => <tr key={row.id}><th scope="row">{i+1}</th>{columns.map(col => {
        const editable = !!col.save && !col.locked?.(row);
        const editing = activeRow === row.id && activeColumn === col.key;
        const value = col.display ? col.display(row) : col.options?.find(o => o.value === col.value(row))?.label ?? col.value(row);
        return <td key={col.key} data-editable={editable || undefined} className={editing ? "editing-cell" : editable ? "" : "fixed-cell"}>
          {editing && editor ? <div className="grid-editor" onKeyDown={e => {
            if (busy || e.nativeEvent.isComposing || e.defaultPrevented) return;
            if (e.key === "Escape") { e.preventDefault(); finish(); }
            if (col.type === "tags" || (e.target instanceof HTMLButtonElement)) return;
            if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); void commit(e.shiftKey ? -1 : 1, e.key === "Enter"); }
          }}>
            {col.type === "tags" ? <TransactionTags value={JSON.parse(editor.draft)} onChange={tags => setEditor({...editor,draft:JSON.stringify(tags)})}/> :
              col.options ? <select aria-label={col.title} disabled={busy} value={editor.draft} onChange={e => setEditor({...editor, draft:e.target.value})}>{col.options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}</select> :
              <input aria-label={col.title} disabled={busy} inputMode={col.type === "number" ? "decimal" : "text"} value={editor.draft} onChange={e => setEditor({...editor,draft:e.target.value})}/>}
            <div className="grid-actions"><button disabled={busy} aria-label="Save cell" onClick={() => void commit()}><Check size={15}/>Save</button><button disabled={busy} aria-label="Cancel edit" onClick={() => finish()}><X size={15}/></button></div>
            {error && <small role="alert">{error}</small>}
          </div> : editable ? <button className="grid-value" aria-label={col.title + ", row " + (i+1) + ": " + (typeof value === "string" ? value : col.value(row))} onClick={() => open(row,col)} onKeyDown={e => {
            const dirs: Record<string, [number, number]> = {ArrowUp:[-1,0],ArrowDown:[1,0],ArrowLeft:[0,-1],ArrowRight:[0,1]};
            const dir = dirs[e.key]; if (!dir) return;
            const td = e.currentTarget.closest("td")!;
            const tr = td.parentElement as HTMLTableRowElement;
            let ri = tr.rowIndex + dir[0], ci = td.cellIndex + dir[1];
            while (table.current?.rows[ri]?.cells[ci]) {
              const target = table.current.rows[ri].cells[ci].querySelector<HTMLButtonElement>(".grid-value");
              if (target) {e.preventDefault();target.focus();break;}
              ri += dir[0]; ci += dir[1];
            }
          }}>{value || <span className="grid-blank">—</span>}</button> : <span>{value || "—"}</span>}
        </td>;
      })}</tr>)}</tbody></table></div>
      {!rows.length && <p className="sheet-empty">No records in this view.</p>}
    </section>;
}
