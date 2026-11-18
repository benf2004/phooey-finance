import { localDateString } from "../shared/money";

export function calendarRanges(now = new Date()) {
  const year = now.getFullYear();
  const month = now.getMonth();
  const quarter = month - (month % 3);
  function period(label: string, startMonth: number, length: number) {
    return {
      label,
      from: localDateString(new Date(year, startMonth, 1)),
      to: localDateString(new Date(year, startMonth + length, 0)),
    };
  }
  return {
    "this-month": period("This month", month, 1),
    "this-quarter": period("This quarter", quarter, 3),
    "this-year": period("This year", 0, 12),
    "year-to-date": {
      label: "Year to date",
      from: localDateString(new Date(year, 0, 1)),
      to: localDateString(now),
    },
    "last-month": period("Last month", month - 1, 1),
    "last-quarter": period("Last quarter", quarter - 3, 3),
    "last-year": period("Last year", -12, 12),
  };
}

export type CalendarPeriod = keyof ReturnType<typeof calendarRanges>;

export function DateRangeSelect({
  value,
  ranges,
  onChange,
  allowAll = false,
}: {
  value: string;
  ranges: ReturnType<typeof calendarRanges>;
  onChange: (value: CalendarPeriod | "custom" | "all") => void;
  allowAll?: boolean;
}) {
  return (
    <select
      aria-label="Date range"
      value={value}
      onChange={(event) =>
        onChange(event.target.value as CalendarPeriod | "custom" | "all")
      }
    >
      {allowAll && <option value="all">All dates</option>}
      {Object.entries(ranges).map(([key, range]) => (
        <option key={key} value={key}>
          {range.label}
        </option>
      ))}
      <option value="custom">Custom range</option>
    </select>
  );
}
