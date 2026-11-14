import { useState } from "react";
import { Upload, ArrowRight } from "lucide-react";
import { useWorkspace } from "../context";
import { post } from "../api";
import { Modal, Field, Button, ErrorNotice } from "../ui";
import {
  parseCSV,
  detectCSVMapping,
  optionalCSVColumns,
  type CSVImportRow,
  type CSVMapping,
} from "../../shared/csv";
import { TransactionAmount } from "../TransactionAmount";
type ImportRow = CSVImportRow & { duplicate: string | null };
export default function ImportDialog({ onClose }: { onClose: () => void }) {
  const { accounts, categories, notify, refresh, navigate } = useWorkspace();
  const [name, setName] = useState(""),
    [text, setText] = useState(""),
    [headers, setHeaders] = useState<string[]>([]),
    [account, setAccount] = useState(accounts[0]?.id ?? ""),
    [mapping, setMapping] = useState<CSVMapping>({
      date: 0,
      description: 1,
      amount: 2,
      dateFormat: "iso" as "iso" | "mdy" | "dmy",
      invert: false,
    }),
    [preview, setPreview] = useState<ImportRow[] | null>(null),
    [skip, setSkip] = useState<Set<number>>(new Set()),
    [error, setError] = useState<string | null>(null),
    [busy, setBusy] = useState(false);
  const payload = { name, account_id: account, text, mapping };
  return (
    <Modal title="Import transactions" onClose={onClose} wide>
      <div className="form-stack">
        <Field
          label="CSV file"
          hint="Up to 5,000 rows. Include a header row; amounts use two decimal places."
        >
          <input
            type="file"
            accept=".csv,text/csv"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              try {
                if (file.size > 1_500_000)
                  throw new Error("Choose a CSV smaller than 1.5 MB");
                const content = await file.text();
                setText(content);
                setName(file.name);
                const first = parseCSV(content)[0];
                if (!first) throw new Error("File is empty");
                setHeaders(first);
                setMapping(detectCSVMapping(first));
                setPreview(null);
                setError(null);
              } catch (e) {
                setText("");
                setHeaders([]);
                setPreview(null);
                setError((e as Error).message);
              }
            }}
          />
        </Field>
        <small>
          <a
            className="text-link"
            href="/phooey-transactions-template.csv"
            download="phooey-transactions-template.csv"
          >
            Download template
          </a>{" "}
          · Replace the sample rows. Use YYYY-MM-DD dates, negative expenses,
          and positive income.
        </small>
        <Field label="Import into account">
          <select
            value={account}
            onChange={(e) => {
              setAccount(e.target.value);
              setPreview(null);
            }}
          >
            <option value="">Select account</option>
            {accounts.map((a) => (
              <option value={a.id} key={a.id}>
                {a.name} · {a.currency}
              </option>
            ))}
          </select>
        </Field>
        {headers.length > 0 && (
          <>
            <div className="field-row three">
              {(["date", "description", "amount"] as const).map((key) => (
                <Field
                  label={key[0].toUpperCase() + key.slice(1) + " column"}
                  key={key}
                >
                  <select
                    value={mapping[key]}
                    onChange={(e) => {
                      setMapping((m) => ({
                        ...m,
                        [key]: Number(e.target.value),
                      }));
                      setPreview(null);
                    }}
                  >
                    {headers.map((h, i) => (
                      <option key={i} value={i}>
                        {h || "Column " + (i + 1)}
                      </option>
                    ))}
                  </select>
                </Field>
              ))}
            </div>
            <details>
              <summary>
                Optional columns · tags, merchant, notes, category, type, status
              </summary>
              <div className="form-stack">
                {optionalCSVColumns.map(({ key, label, hint }) => (
                  <Field key={key} label={`${label} column`} hint={hint}>
                    <select
                      value={mapping[key] ?? ""}
                      onChange={(e) => {
                        setMapping((m) => ({
                          ...m,
                          [key]:
                            e.target.value === ""
                              ? null
                              : Number(e.target.value),
                        }));
                        setPreview(null);
                      }}
                    >
                      <option value="">Do not import</option>
                      {headers.map((h, i) => (
                        <option key={i} value={i}>
                          {h || "Column " + (i + 1)}
                        </option>
                      ))}
                    </select>
                  </Field>
                ))}
                <small>
                  Account and currency come from the selected account. Splits,
                  attachments, and transaction IDs are not imported.
                </small>
              </div>
            </details>
            <div className="field-row">
              <Field label="Date format">
                <select
                  value={mapping.dateFormat}
                  onChange={(e) => {
                    setMapping((m) => ({
                      ...m,
                      dateFormat: e.target.value as typeof mapping.dateFormat,
                    }));
                    setPreview(null);
                  }}
                >
                  <option value="iso">YYYY-MM-DD</option>
                  <option value="mdy">MM/DD/YYYY</option>
                  <option value="dmy">DD/MM/YYYY</option>
                </select>
              </Field>
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={mapping.invert}
                  onChange={(e) => {
                    setMapping((m) => ({ ...m, invert: e.target.checked }));
                    setPreview(null);
                  }}
                />
                Invert amounts (positive expenses)
              </label>
            </div>
          </>
        )}
        {preview && (
          <>
            <div className="notice">
              {preview.length} rows ·{" "}
              {preview.filter((r) => r.duplicate).length} possible duplicates ·{" "}
              {preview.filter((r) => r.error).length} invalid rows. Possible
              duplicates are marked for review; select the rows you want to
              skip. Matching rules may set the category and type for
              uncategorized rows.
            </div>
            <div className="import-preview">
              <table>
                <thead>
                  <tr>
                    <th>Skip</th>
                    <th>Row</th>
                    <th>Date</th>
                    <th>Description</th>
                    <th>Amount</th>
                    <th>Details</th>
                    <th>Review</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.map((r) => (
                    <tr key={r.row}>
                      <td>
                        <input
                          type="checkbox"
                          checked={skip.has(r.row)}
                          aria-label={`Skip row ${r.row}`}
                          onChange={() =>
                            setSkip((s) => {
                              const n = new Set(s);
                              n.has(r.row) ? n.delete(r.row) : n.add(r.row);
                              return n;
                            })
                          }
                        />
                      </td>
                      <td>{r.row}</td>
                      <td>{r.posted}</td>
                      <td>{r.description}</td>
                      <td className="money">
                        <TransactionAmount
                          amount={r.amount}
                          currency={
                            accounts.find((a) => a.id === account)?.currency
                          }
                        />
                      </td>
                      <td>
                        <details>
                          <summary>
                            {(r.tags ?? ["Business"]).join(", ") || "No tags"}
                          </summary>
                          <div>Merchant: {r.merchant || "—"}</div>
                          <div>Notes: {r.notes || "—"}</div>
                          <div>
                            Category:{" "}
                            {categories.find((c) => c.id === r.category_id)
                              ?.name ||
                              r.category ||
                              "Automatic rules"}
                          </div>
                          <div>
                            Type:{" "}
                            {r.type ?? (r.amount >= 0 ? "income" : "expense")}
                          </div>
                          <div>
                            Pending: {r.pending ? "Yes" : "No"} · Reviewed:{" "}
                            {r.reviewed ? "Yes" : "No"}
                          </div>
                        </details>
                      </td>
                      <td>
                        {r.error ??
                          (r.duplicate ? "Possible duplicate" : "Ready")}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
        <ErrorNotice error={error} />
        <div className="form-footer">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          {!preview ? (
            <Button
              disabled={!text || !account}
              busy={busy}
              onClick={async () => {
                setBusy(true);
                setError(null);
                try {
                  const result = await post<{ rows: ImportRow[] }>(
                    "/import/preview",
                    payload,
                  );
                  setPreview(result.rows);
                  setSkip(
                    new Set(
                      result.rows.filter((r) => r.error).map((r) => r.row),
                    ),
                  );
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              Preview import <ArrowRight size={16} />
            </Button>
          ) : (
            <Button
              busy={busy}
              disabled={
                preview.every((r) => skip.has(r.row)) ||
                preview.some((r) => r.error && !skip.has(r.row))
              }
              onClick={async () => {
                setBusy(true);
                try {
                  const result = await post<{
                    alreadyImported?: boolean;
                    resumed?: boolean;
                  }>("/import", { data: payload, skipRows: [...skip] });
                  notify(
                    result.resumed
                      ? "Import resumed"
                      : result.alreadyImported
                        ? "Import already submitted"
                        : "Import queued",
                  );
                  refresh();
                  onClose();
                  navigate("/settings");
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              <Upload size={16} />
              Import {preview.length - skip.size} transactions
            </Button>
          )}
        </div>
      </div>
    </Modal>
  );
}
