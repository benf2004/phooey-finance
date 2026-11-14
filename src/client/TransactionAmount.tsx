import { useWorkspace } from "./context";
import {
  presentTransactionAmount,
  type TransactionAppearance,
} from "../shared/transaction-appearance";

export function TransactionAmount({
  amount,
  currency,
  showPositiveSign = false,
  appearance,
}: {
  amount: number;
  currency?: string;
  showPositiveSign?: boolean;
  appearance?: TransactionAppearance;
}) {
  const { transactionAppearance } = useWorkspace();
  const settings = appearance ?? transactionAppearance;
  const display = presentTransactionAmount(
    amount,
    currency,
    settings,
    showPositiveSign,
  );
  const tone =
    amount < 0
      ? settings.negativeAmountColor === "red"
        ? "negative"
        : "transaction-amount-normal"
      : amount > 0 && showPositiveSign
        ? "positive"
        : "";
  return (
    <span className={`transaction-amount ${tone}`}>
      <span aria-hidden="true">{display.text}</span>
      <span className="transaction-amount-accessible">
        {display.accessibleText}
      </span>
    </span>
  );
}
