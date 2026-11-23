import { useEffect, useRef, useState } from "react";
import { LedgerGrid, type GridColumn } from "./LedgerGrid";
import {
  createRowRequest,
  missingRowFields,
  type GridDraft,
} from "./grid-row-creation";

export type GridRowCreation<R> = {
  defaults: () => GridDraft;
  required: string[];
  fields?: Record<
    string,
    { editable?: boolean; options?: { value: string; label: string }[] }
  >;
  reload?: (id: string) => Promise<R>;
  create: (values: GridDraft, requestKey: string) => Promise<R>;
};
type Item<R> = { id: string; record: R } | { id: string; values: GridDraft };

export function CreatableLedgerGrid<R extends { id: string }>({
  rows,
  columns,
  label,
  creation,
}: {
  rows: R[];
  columns: GridColumn<R>[];
  label: string;
  creation: GridRowCreation<R>;
}) {
  const [draft, setDraft] = useState(() => ({
    id: crypto.randomUUID(),
    values: creation.defaults(),
    dirty: false,
  }));
  const [added, setAdded] = useState<R[]>([]);
  useEffect(() => {
    setAdded((old) =>
      old.filter((record) => !rows.some((row) => row.id === record.id)),
    );
  }, [rows]);
  const draftRef = useRef(draft);
  const aliases = useRef(new Map<string, string>());
  const request = useRef(createRowRequest());
  const visible = [
    ...rows,
    ...added.filter((row) => !rows.some((r) => r.id === row.id)),
  ];
  const items: Item<R>[] = [
    ...visible.map((record) => ({
      id: aliases.current.get(record.id) ?? record.id,
      record,
    })),
    draft,
  ];
  const missing = missingRowFields(draft.values, creation.required);
  const firstColumn = missing[0] ?? creation.required[0] ?? columns[0]?.key;
  const hint = missing.length
    ? `New row · Add ${missing.map((key) => columns.find((c) => c.key === key)?.title.toLowerCase() ?? key).join(", ")} to save`
    : "New row · Finish editing to add";
  useEffect(() => {
    if (!draft.dirty) return;
    const unload = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", unload);
    return () => window.removeEventListener("beforeunload", unload);
  }, [draft.dirty]);
  async function saveDraft(key: string, value: string) {
    const next = {
      ...draftRef.current,
      values: { ...draftRef.current.values, [key]: value },
      dirty: true,
    };
    if (missingRowFields(next.values, creation.required).length) {
      draftRef.current = next;
      setDraft(next);
      return;
    }
    const record = await creation.create(
      next.values,
      request.current(next.values),
    );
    // Preserve the cell address while a draft becomes a saved record and refreshes.
    aliases.current.set(record.id, next.id);
    setAdded((old) => [...old, record]);
    const empty = {
      id: crypto.randomUUID(),
      values: creation.defaults(),
      dirty: false,
    };
    draftRef.current = empty;
    setDraft(empty);
    request.current = createRowRequest();
  }
  const mapped: GridColumn<Item<R>>[] = columns.map((column) => {
    const field = creation.fields?.[column.key];
    const options = field?.options ?? column.options;
    return {
      ...column,
      options,
      value: (item) =>
        "record" in item
          ? column.value(item.record)
          : (item.values[column.key] ?? ""),
      display: (item) => {
        if ("record" in item)
          return column.display
            ? column.display(item.record)
            : (column.options?.find(
                (o) => o.value === column.value(item.record),
              )?.label ?? column.value(item.record));
        const value = item.values[column.key] ?? "";
        if (column.type === "tags")
          return (
            <span className="grid-chips">
              {(JSON.parse(value || "[]") as string[]).map((tag) => (
                <span key={tag}>{tag}</span>
              ))}
            </span>
          );
        return (
          options?.find((o) => o.value === value)?.label ??
          (value || (
            <span className="sheet-new-placeholder">
              {creation.required.includes(column.key)
                ? `Add ${column.title.toLowerCase()}`
                : ""}
            </span>
          ))
        );
      },
      locked: (item) =>
        "record" in item
          ? !column.save || !!column.locked?.(item.record)
          : !(field?.editable ?? !!column.save),
      save: async (item, value) => {
        if ("record" in item) {
          await column.save?.(item.record, value);
          if (
            creation.reload &&
            added.some((row) => row.id === item.record.id)
          ) {
            const updated = await creation.reload(item.record.id);
            setAdded((old) =>
              old.map((row) => (row.id === updated.id ? updated : row)),
            );
          }
        } else await saveDraft(column.key, value);
      },
    };
  });
  return (
    <LedgerGrid
      rows={items}
      columns={mapped}
      label={label}
      newRow={{ id: draft.id, firstColumn, hint, pending: draft.dirty }}
    />
  );
}
