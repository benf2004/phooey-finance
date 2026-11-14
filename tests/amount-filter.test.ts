import { describe, expect, it } from "vitest";
import {
  amountFilterQuery,
  amountFilterText,
} from "../src/client/amount-filter";

describe("transaction amount filter conversion", () => {
  it.each([
    ["", ""],
    ["  ", ""],
    ["0", "0"],
    ["-0.00", "0"],
    ["12.50", "1250"],
    ["-12.50", "-1250"],
    ["0.29", "29"],
    ["1.", "100"],
    [".50", "50"],
    ["-.50", "-50"],
    ["1,234.56", "123456"],
    ["10000000000.00", "1000000000000"],
  ])("commits %j as integer-cent query %j", (input, expected) => {
    expect(amountFilterQuery(input)).toBe(expected);
  });
  it.each(["-", ".", "1.005", "1e2", "Infinity", "10000000000.01"])(
    "rejects invalid or excessive precision without rounding: %j",
    (input) => {
      expect(() => amountFilterQuery(input)).toThrow();
    },
  );
  it.each([
    [null, ""],
    ["", ""],
    ["0", "0.00"],
    ["1250", "12.50"],
    ["-29", "-0.29"],
    ["1000000000000", "10000000000.00"],
  ])("displays existing URL cents %j as %j", (input, expected) => {
    expect(amountFilterText(input)).toBe(expected);
    expect(amountFilterQuery(amountFilterText(input))).toBe(input ?? "");
  });
});
