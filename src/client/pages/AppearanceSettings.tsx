import { Palette } from "lucide-react";
import { useWorkspace } from "../context";
import { TransactionAmount } from "../TransactionAmount";
import { Field, Panel } from "../ui";
import { AppearanceSaveStatus } from "../AppearanceSaveStatus";

export function AppearanceSettings() {
  const { transactionAppearance, updateTransactionAppearance } = useWorkspace();
  return (
    <Panel
      title="Transaction appearance"
      action={<Palette size={19} className="muted" />}
    >
      <div className="panel-body form-stack">
        <p>
          Choose how outgoing transaction amounts look. Changes save
          automatically.
        </p>
        <Field label="Negative amount color">
          <select
            value={transactionAppearance.negativeAmountColor}
            onChange={(event) =>
              updateTransactionAppearance({
                ...transactionAppearance,
                negativeAmountColor:
                  event.target.value === "red" ? "red" : "normal",
              })
            }
          >
            <option value="normal">Normal text</option>
            <option value="red">Red</option>
          </select>
        </Field>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={transactionAppearance.showNegativeSign}
            onChange={(event) =>
              updateTransactionAppearance({
                ...transactionAppearance,
                showNegativeSign: event.target.checked,
              })
            }
          />
          Show minus sign for negative amounts
        </label>
        <div
          className="notice"
          role="group"
          aria-label="Transaction amount preview"
        >
          Sample outgoing transaction: <TransactionAmount amount={-12345} />
        </div>
        <p className="inline-note">
          Normal text follows your theme. Editing, exports and calculations
          keep their original signed values.
        </p>
        <AppearanceSaveStatus />
      </div>
    </Panel>
  );
}
