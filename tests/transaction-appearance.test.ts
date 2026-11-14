import { expect, it } from "vitest";
import { amountInput, formatMoney } from "../src/shared/money";
import {
  presentTransactionAmount,
  storedTransactionAppearanceSchema,
} from "../src/shared/transaction-appearance";

it.each([
  ["normal", true, "-$123.45"],
  ["red", true, "-$123.45"],
  ["normal", false, "$123.45"],
  ["red", false, "$123.45"],
] as const)(
  "keeps color %s independent of sign visibility %s",
  (negativeAmountColor, showNegativeSign, text) => {
    const result = presentTransactionAmount(-12345, "USD", {
      negativeAmountColor,
      showNegativeSign,
    });
    expect(result.text).toBe(text);
    expect(result.accessibleText).toBe("Outgoing, -$123.45");
    expect(result.hiddenMinus).toBe(!showNegativeSign);
    expect(formatMoney(-12345)).toBe("-$123.45");
    expect(amountInput(-12345)).toBe("-123.45");
  },
);
it("preserves incoming/zero amounts and currencies", () => {
  const appearance = {
    negativeAmountColor: "red" as const,
    showNegativeSign: false,
  };
  expect(presentTransactionAmount(12345, "EUR", appearance, true)).toEqual({
    text: "+€123.45",
    accessibleText: "Incoming, €123.45",
    hiddenMinus: false,
  });
  expect(presentTransactionAmount(0, "USD", appearance)).toEqual({
    text: "$0.00",
    accessibleText: "Zero amount, $0.00",
    hiddenMinus: false,
  });
  expect(presentTransactionAmount(-1, "EUR", appearance).text).toBe("€0.01");
});
it("defaults existing or malformed preferences without discarding a valid independent setting", () => {
  for (const value of [
    undefined,
    null,
    {},
    "old",
    { negativeAmountColor: "blue", showNegativeSign: "false" },
  ]) {
    expect(storedTransactionAppearanceSchema.parse(value)).toEqual({
      negativeAmountColor: "normal",
      showNegativeSign: true,
    });
  }
  expect(
    storedTransactionAppearanceSchema.parse({ negativeAmountColor: "red" }),
  ).toEqual({ negativeAmountColor: "red", showNegativeSign: true });
});
