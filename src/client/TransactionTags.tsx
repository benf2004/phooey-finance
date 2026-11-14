import { useEffect, useId, useRef, useState } from "react";
import { useWorkspace } from "./context";
import { api } from "./api";
import { Button, useAsync } from "./ui";
import "./transaction-tags.css";

export default function TransactionTags({
  value,
  onChange,
}: {
  value: string[];
  onChange: (tags: string[]) => void;
}) {
  const { version } = useWorkspace();
  const available = useAsync(() => api<string[]>("/tags"), [version]);
  const [draft, setDraft] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const root = useRef<HTMLElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const id = useId();
  const query = draft.trim();
  const known = [
    ...new Map(
      (available.data ?? ["Business"]).map((tag) => [tag.toLowerCase(), tag]),
    ).values(),
  ];
  const selected = new Set(value.map((tag) => tag.toLowerCase()));
  const matches = known.filter(
    (tag) =>
      !selected.has(tag.toLowerCase()) &&
      tag.toLowerCase().includes(query.toLowerCase()),
  );
  const canAdd =
    !!query &&
    query.length <= 50 &&
    value.length < 20 &&
    !selected.has(query.toLowerCase());
  const canCreate =
    canAdd && !known.some((tag) => tag.toLowerCase() === query.toLowerCase());
  const options = [
    ...matches.map((tag) => ({ tag, create: false })),
    ...(canCreate ? [{ tag: query, create: true }] : []),
  ];
  const expanded = open && value.length < 20 && options.length > 0;
  const activeOption =
    expanded && active >= 0 && active < options.length
      ? `${id}-option-${active}`
      : undefined;

  useEffect(() => {
    const dismiss = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, []);
  useEffect(() => {
    const option = activeOption && document.getElementById(activeOption);
    const menu = list.current;
    if (!option || !menu) return;
    const itemBounds = option.getBoundingClientRect();
    const menuBounds = menu.getBoundingClientRect();
    if (itemBounds.top < menuBounds.top)
      menu.scrollTop -= menuBounds.top - itemBounds.top;
    else if (itemBounds.bottom > menuBounds.bottom)
      menu.scrollTop += itemBounds.bottom - menuBounds.bottom;
  }, [activeOption, draft, open]);

  function add(candidate = query) {
    const trimmed = candidate.trim();
    if (!trimmed || trimmed.length > 50 || value.length >= 20) return;
    const tag =
      known.find((item) => item.toLowerCase() === trimmed.toLowerCase()) ??
      trimmed;
    if (!selected.has(tag.toLowerCase())) onChange([...value, tag]);
    input.current?.focus();
    setDraft("");
    setActive(-1);
    setOpen(false);
  }

  return (
    <section
      ref={root}
      className="transaction-tags"
      aria-label="Transaction tags"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null))
          setOpen(false);
      }}
    >
      <div className="field">
        <label htmlFor={id}>Tags</label>
        <div className="tag-entry">
          <input
            ref={input}
            id={id}
            role="combobox"
            aria-label="Add a tag"
            aria-autocomplete="list"
            aria-expanded={expanded}
            aria-controls={expanded ? `${id}-suggestions` : undefined}
            aria-activedescendant={activeOption}
            aria-describedby={`${id}-hint`}
            autoComplete="off"
            placeholder="Search or create a tag…"
            value={draft}
            maxLength={50}
            disabled={value.length >= 20}
            onFocus={() => {
              setOpen(true);
              setActive(-1);
            }}
            onChange={(event) => {
              setDraft(event.target.value);
              setActive(0);
              setOpen(true);
            }}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                setOpen(true);
                const last = options.length - 1;
                setActive(
                  !expanded || active < 0
                    ? event.key === "ArrowDown"
                      ? 0
                      : last
                    : event.key === "ArrowDown"
                      ? Math.min(active + 1, last)
                      : Math.max(active - 1, 0),
                );
              } else if (event.key === "Enter") {
                event.preventDefault();
                add(activeOption ? options[active].tag : query);
              } else if (event.key === "Escape" && open) {
                event.preventDefault();
                event.stopPropagation();
                setOpen(false);
                setActive(-1);
              } else if (event.key === "Tab") {
                setOpen(false);
              }
            }}
          />
          <Button
            type="button"
            variant="secondary"
            onClick={() => add()}
            disabled={!canAdd}
          >
            Add tag
          </Button>
        </div>
        {expanded && (
          <ul
            ref={list}
            id={`${id}-suggestions`}
            className="tag-suggestions"
            role="listbox"
            aria-label="Tag suggestions"
          >
            {options.map((option, index) => (
              <li
                key={option.tag}
                id={`${id}-option-${index}`}
                role="option"
                aria-selected={active === index}
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => add(option.tag)}
              >
                {option.create ? `Create “${option.tag}”` : option.tag}
              </li>
            ))}
          </ul>
        )}
        <small id={`${id}-hint`}>
          Tags select which transactions count toward a quarterly tax estimate.
          New transactions start with Business.
        </small>
      </div>
      <div className="transaction-tag-list">
        {value.map((tag) => (
          <button
            type="button"
            className="badge neutral"
            key={tag}
            aria-label={`Remove tag ${tag}`}
            onClick={() => onChange(value.filter((t) => t !== tag))}
          >
            {tag}
            <span aria-hidden="true"> ×</span>
          </button>
        ))}
        {!value.length && <span className="muted">No tags</span>}
      </div>
    </section>
  );
}
