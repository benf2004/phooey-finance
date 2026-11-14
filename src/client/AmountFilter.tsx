import { useEffect, useId, useState } from "react";
import { Field } from "./ui";
import { amountFilterQuery, amountFilterText } from "./amount-filter";

export default function AmountFilter({
  label,
  value,
  navigationKey,
  onCommit,
}: {
  label: string;
  value: string | null;
  navigationKey: string;
  onCommit: (value: string) => void;
}) {
  const [draft, setDraft] = useState(() => amountFilterText(value));
  const [error, setError] = useState("");
  const errorId = useId();
  useEffect(() => {
    setDraft(amountFilterText(value));
    setError("");
  }, [value, navigationKey]);

  function commit() {
    try {
      const query = amountFilterQuery(draft);
      setDraft(amountFilterText(query));
      setError("");
      if (query !== (value ?? "")) onCommit(query);
    } catch (cause) {
      setError((cause as Error).message);
    }
  }

  return (
    <Field label={label}>
      <input
        type="text"
        inputMode="decimal"
        autoComplete="off"
        placeholder="e.g. 12.50"
        value={draft}
        aria-label={label}
        aria-invalid={!!error}
        aria-describedby={error ? errorId : undefined}
        onChange={(event) => {
          setDraft(event.target.value);
          setError("");
        }}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.nativeEvent.isComposing) {
            event.preventDefault();
            commit();
          }
        }}
      />
      {error && (
        <small id={errorId} role="alert">
          {error}
        </small>
      )}
    </Field>
  );
}
