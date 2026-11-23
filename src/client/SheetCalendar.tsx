import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { localDateString } from "../shared/money";
import {
  calendarDate,
  monthDays,
  moveCalendarMonth,
  readSheetDate,
} from "./sheet-calendar";

export function SheetCalendar({
  value,
  disabled,
  onSelect,
}: {
  value: string;
  disabled: boolean;
  onSelect: (value: string) => void;
}) {
  const [month, setMonth] = useState(() => readSheetDate(value) ?? new Date());
  const [focused, setFocused] = useState(() =>
    localDateString(readSheetDate(value) ?? new Date()),
  );
  const grid = useRef<HTMLDivElement>(null);
  const selected = readSheetDate(value);
  const selectedValue = selected ? localDateString(selected) : "";
  const today = localDateString(new Date());
  useEffect(() => {
    const date = readSheetDate(value);
    if (date) {
      setMonth(date);
      setFocused(localDateString(date));
    }
  }, [value]);
  function changeMonth(offset: number) {
    const next = moveCalendarMonth(month, offset);
    setMonth(next);
    setFocused(localDateString(next));
  }
  function moveFocus(event: KeyboardEvent<HTMLButtonElement>, date: Date) {
    const offsets: Record<string, number> = {
      ArrowLeft: -1,
      ArrowRight: 1,
      ArrowUp: -7,
      ArrowDown: 7,
      Home: -date.getDay(),
      End: 6 - date.getDay(),
    };
    const offset = offsets[event.key];
    const next =
      event.key === "PageUp" || event.key === "PageDown"
        ? moveCalendarMonth(
            date,
            (event.key === "PageUp" ? -1 : 1) * (event.shiftKey ? 12 : 1),
          )
        : offset !== undefined
          ? calendarDate(
              date.getFullYear(),
              date.getMonth(),
              date.getDate() + offset,
            )
          : null;
    if (!next) return;
    event.preventDefault();
    event.stopPropagation();
    setMonth(next);
    setFocused(localDateString(next));
    requestAnimationFrame(() =>
      grid.current
        ?.querySelector<HTMLButtonElement>(
          `[data-date="${localDateString(next)}"]`,
        )
        ?.focus(),
    );
  }
  return (
    <>
      <div className="sheet-calendar-heading">
        <span aria-live="polite">
          {month.toLocaleDateString("en-US", {
            month: "long",
            year: "numeric",
          })}
        </span>
        <button
          type="button"
          aria-label="Previous month"
          disabled={disabled}
          onClick={() => changeMonth(-1)}
        >
          <ChevronLeft size={16} />
        </button>
        <button
          type="button"
          aria-label="Next month"
          disabled={disabled}
          onClick={() => changeMonth(1)}
        >
          <ChevronRight size={16} />
        </button>
      </div>
      <div className="sheet-calendar-days" ref={grid}>
        {[
          "Sunday",
          "Monday",
          "Tuesday",
          "Wednesday",
          "Thursday",
          "Friday",
          "Saturday",
        ].map((day) => (
          <span key={day} className="sheet-calendar-weekday" aria-label={day}>
            {day[0]}
          </span>
        ))}
        {monthDays(month).map((date) => {
          const key = localDateString(date),
            active = key === selectedValue;
          return (
            <button
              key={key}
              type="button"
              data-date={key}
              data-selected={active}
              aria-label={date.toLocaleDateString("en-US", {
                month: "long",
                day: "numeric",
                year: "numeric",
              })}
              aria-pressed={active}
              aria-current={key === today ? "date" : undefined}
              tabIndex={key === focused ? 0 : -1}
              disabled={disabled}
              className={`sheet-calendar-day${active ? " is-selected" : ""}${date.getMonth() !== month.getMonth() ? " is-outside" : ""}`}
              onKeyDown={(event) => moveFocus(event, date)}
              onClick={() => onSelect(key)}
            >
              {date.getDate()}
            </button>
          );
        })}
      </div>
      <button
        type="button"
        className="sheet-calendar-today"
        disabled={disabled}
        onClick={() => onSelect(today)}
      >
        Today
      </button>
    </>
  );
}
