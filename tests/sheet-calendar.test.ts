import { describe, expect, it } from "vitest";
import {
  calendarDate,
  monthDays,
  moveCalendarMonth,
  normalizeSheetDate,
  readSheetDate,
} from "../src/client/sheet-calendar";
import { localDateString } from "../src/shared/money";

describe("spreadsheet date picker", () => {
  it("accepts ISO and US dates without shifting the day across timezones", () => {
    expect(normalizeSheetDate("2026-11-22")).toBe("2026-11-22");
    expect(normalizeSheetDate(" 2/9/2024 ")).toBe("2024-02-09");
    expect(readSheetDate("2026-11-22")?.getDate()).toBe(22);
  });
  it("validates leap years and rejects rollover dates", () => {
    expect(normalizeSheetDate("2/29/2024")).toBe("2024-02-29");
    for (const value of [
      "2026-02-29",
      "2026-04-31",
      "13/1/2026",
      "2026-00-01",
      "2026-01-00",
      "",
      "tomorrow",
      "1/1/26",
    ]) {
      expect(readSheetDate(value)).toBeNull();
      expect(() => normalizeSheetDate(value)).toThrow("Enter a valid date");
    }
  });
  it("shows six full Sunday-first weeks including adjacent months", () => {
    const days = monthDays(calendarDate(2026, 10, 22));
    expect(days).toHaveLength(42);
    expect(localDateString(days[0])).toBe("2026-11-01");
    expect(localDateString(days[41])).toBe("2026-12-12");
    expect(localDateString(monthDays(calendarDate(2026, 11, 1))[0])).toBe(
      "2026-11-29",
    );
  });
  it("clamps month navigation at shorter months and crosses year boundaries", () => {
    expect(
      localDateString(moveCalendarMonth(calendarDate(2024, 0, 31), 1)),
    ).toBe("2024-02-29");
    expect(
      localDateString(moveCalendarMonth(calendarDate(2026, 0, 31), 1)),
    ).toBe("2026-02-28");
    expect(
      localDateString(moveCalendarMonth(calendarDate(2026, 0, 1), -1)),
    ).toBe("2025-12-01");
    expect(
      localDateString(moveCalendarMonth(calendarDate(2026, 11, 31), 1)),
    ).toBe("2027-01-31");
  });
});
