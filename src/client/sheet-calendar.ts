import { localDateString } from "../shared/money";

export function calendarDate(year: number, month: number, day: number) {
  const date = new Date(0);
  date.setFullYear(year, month, day);
  date.setHours(12, 0, 0, 0);
  return date;
}
export function readSheetDate(value: string): Date | null {
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value.trim());
  if (!iso && !us) return null;
  const [year, month, day] = iso
    ? [Number(iso[1]), Number(iso[2]), Number(iso[3])]
    : [Number(us![3]), Number(us![1]), Number(us![2])];
  const date = calendarDate(year, month - 1, day);
  return year >= 1 &&
    date.getFullYear() === year &&
    date.getMonth() === month - 1 &&
    date.getDate() === day
    ? date
    : null;
}
export function normalizeSheetDate(value: string) {
  const date = readSheetDate(value);
  if (!date) throw Error("Enter a valid date as YYYY-MM-DD or M/D/YYYY.");
  return localDateString(date).padStart(10, "0");
}
export function monthDays(month: Date) {
  const first = calendarDate(month.getFullYear(), month.getMonth(), 1);
  return Array.from({ length: 42 }, (_, index) =>
    calendarDate(
      first.getFullYear(),
      first.getMonth(),
      1 - first.getDay() + index,
    ),
  );
}
export function moveCalendarMonth(date: Date, offset: number) {
  const first = calendarDate(date.getFullYear(), date.getMonth() + offset, 1);
  const last = calendarDate(
    first.getFullYear(),
    first.getMonth() + 1,
    0,
  ).getDate();
  return calendarDate(
    first.getFullYear(),
    first.getMonth(),
    Math.min(last, date.getDate()),
  );
}
