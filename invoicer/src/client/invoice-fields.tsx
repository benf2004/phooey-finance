import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type TextareaHTMLAttributes,
} from "react";
import { type Party } from "../shared/model";
import { partyText, parsePartyText } from "../shared/party-text";

export function AutoTextarea(
  props: TextareaHTMLAttributes<HTMLTextAreaElement>,
) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const field = ref.current;
    if (!field) return;
    const resize = () => {
      field.style.height = "auto";
      field.style.height = `${field.scrollHeight + 2}px`;
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(field);
    return () => observer.disconnect();
  }, [props.value]);
  return <textarea {...props} ref={ref} />;
}

export function InvoiceParty({
  value,
  onChange,
  label,
  placeholder,
}: {
  value: Party;
  onChange: (party: Party) => void;
  label: string;
  placeholder: string;
}) {
  const serialized = partyText(value);
  const lastEmitted = useRef(serialized);
  const [text, setText] = useState(serialized);
  useEffect(() => {
    if (serialized !== lastEmitted.current) {
      setText(serialized);
      lastEmitted.current = serialized;
    }
  }, [serialized]);
  return (
    <AutoTextarea
      aria-label={label}
      placeholder={placeholder}
      rows={2}
      value={text}
      onChange={(event) => {
        const next = event.target.value;
        const party = parsePartyText(next, value);
        lastEmitted.current = partyText(party);
        setText(next);
        onChange(party);
      }}
    />
  );
}
