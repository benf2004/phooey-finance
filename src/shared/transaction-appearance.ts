import { z } from "zod";
import { formatMoney } from "./money";

export const transactionAppearanceSchema = z
  .object({
    negativeAmountColor: z.enum(["normal", "red"]),
    showNegativeSign: z.boolean(),
  })
  .strict();
export type TransactionAppearance = z.infer<typeof transactionAppearanceSchema>;
export const defaultTransactionAppearance: TransactionAppearance = {
  negativeAmountColor: "normal",
  showNegativeSign: true,
};
export const storedTransactionAppearanceSchema = z
  .object({
    negativeAmountColor: z.enum(["normal", "red"]).catch("normal"),
    showNegativeSign: z.boolean().catch(true),
  })
  .catch(defaultTransactionAppearance);

export function presentTransactionAmount(
  amount: number,
  currency = "USD",
  appearance = defaultTransactionAppearance,
  showPositiveSign = false,
) {
  const hiddenMinus = amount < 0 && !appearance.showNegativeSign;
  return {
    text:
      (amount > 0 && showPositiveSign ? "+" : "") +
      formatMoney(hiddenMinus ? Math.abs(amount) : amount, currency),
    accessibleText: `${amount < 0 ? "Outgoing" : amount > 0 ? "Incoming" : "Zero amount"}, ${formatMoney(amount, currency)}`,
    hiddenMinus,
  };
}
