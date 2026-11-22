import { useState } from "react";
import { sampleTiller, tillerGroups } from "../../shared/tiller";
import { post } from "../api";
import { useWorkspace } from "../context";
import type { Account, Category } from "../../shared/models";

type Group = ReturnType<typeof tillerGroups>[number];
type Preview = {
  row: number;
  posted: string;
  description: string;
  amount: number;
  error: string | null;
  duplicate: string | null;
};
const quote = (s: string) => '"' + s.replaceAll('"', '""') + '"';
export function PublicTillerPreview() {
  return (
    <main className="content">
      <a href="/business/">phooey! finance</a>
      <h1>Preview a transactions CSV</h1>
      <p>
        Your file stays in this browser. Choose destination accounts and check
        bank duplicates after signing in.
      </p>
      <ImportForm accounts={[]} categories={[]} demo />
    </main>
  );
}
export default function TillerImport() {
  const { accounts, categories } = useWorkspace();
  return <ImportForm accounts={accounts} categories={categories} />;
}
function ImportForm({
  accounts,
  categories,
  demo = false,
}: {
  accounts: Account[];
  categories: Category[];
  demo?: boolean;
}) {
  const [groups, setGroups] = useState<Group[]>([]),
    [message, setMessage] = useState("");
  const load = (text: string) => {
    try {
      setGroups(tillerGroups(text));
      setMessage("");
    } catch (e) {
      setGroups([]);
      setMessage((e as Error).message);
    }
  };
  const [version, setVersion] = useState(0);
  return (
    <div className="form-stack">
      <label>
        Transactions CSV
        <input
          type="file"
          accept=".csv,text/csv"
          onChange={async (e) => {
            const f = e.target.files?.[0];
            if (f) {
              setVersion((n) => n + 1);
              if (f.size > 1500000) {
                setGroups([]);
                setMessage("Choose a CSV smaller than 1.5 MB.");
              } else load(await f.text());
            }
          }}
        />
      </label>
      {demo && (
        <button
          onClick={() => {
            setVersion((n) => n + 1);
            load(sampleTiller);
          }}
        >
          Try example data
        </button>
      )}
      <p role="status">{message}</p>
      {groups.map((g) => (
        <GroupPreview
          key={version + g.account}
          group={g}
          accounts={accounts}
          categories={categories}
          demo={demo}
        />
      ))}
    </div>
  );
}
function GroupPreview({
  group,
  accounts,
  categories,
  demo,
}: {
  group: Group;
  accounts: Account[];
  categories: Category[];
  demo: boolean;
}) {
  const [account, setAccount] = useState(""),
    [mapped, setMapped] = useState<Record<string, string>>({}),
    [preview, setPreview] = useState<Preview[] | null>(null),
    [skip, setSkip] = useState<number[]>([]),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false),
    [done, setDone] = useState(false);
  const names = [
      ...new Set(
        group.rows.map((r) => r.category).filter((c): c is string => !!c),
      ),
    ],
    resolve = (n: string) =>
      mapped[n] ??
      categories.find((c) => c.name.toLowerCase() === n.toLowerCase())?.id ??
      "";
  const data = () => ({
    name: "Imported – " + group.account,
    account_id: account,
    text: [
      [
        "Date",
        "Description",
        "Amount",
        "Category",
        "Notes",
        "Tags",
        "Merchant",
        "Type",
        "Pending",
        "Reviewed",
      ],
      ...group.rows.map((r) => [
        r.posted,
        r.description,
        (r.amount / 100).toFixed(2),
        r.category ? resolve(r.category) : "",
        r.notes ?? "",
        JSON.stringify(r.tags ?? ["Business"]),
        r.merchant ?? "",
        r.type ?? "",
        String(r.pending ?? false),
        String(r.reviewed ?? false),
      ]),
    ]
      .map((row) => row.map(quote).join(","))
      .join("\n"),
    mapping: {
      date: 0,
      description: 1,
      amount: 2,
      category: 3,
      notes: 4,
      tags: 5,
      merchant: 6,
      type: 7,
      pending: 8,
      reviewed: 9,
      dateFormat: "iso",
      invert: false,
    },
  });
  async function run(commit: boolean) {
    setBusy(true);
    setMessage("");
    try {
      if (commit) {
        const result = await post<{ alreadyImported?: boolean }>("/import", {
          data: data(),
          skipRows: skip,
        });
        setMessage(
          result.alreadyImported ? "Already imported." : "Import queued.",
        );
        setDone(true);
      } else {
        const { rows } = await post<{ rows: Preview[] }>(
          "/import/preview",
          data(),
        );
        setPreview(rows);
        setSkip(rows.filter((r) => r.error || r.duplicate).map((r) => r.row));
      }
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <details open>
      <summary>
        {group.account} · {group.rows.length} transactions
      </summary>
      {!demo && (
        <fieldset disabled={busy || done}>
          <label>
            Destination account
            <select
              value={account}
              onChange={(e) => {
                setAccount(e.target.value);
                setPreview(null);
              }}
            >
              <option value="">Choose account</option>
              {accounts
                .filter((a) => !group.currency || a.currency === group.currency)
                .map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} ({a.currency})
                  </option>
                ))}
            </select>
          </label>
          {names.map((n) => (
            <label key={n}>
              {n}
              <select
                value={resolve(n)}
                onChange={(e) => {
                  setMapped({ ...mapped, [n]: e.target.value });
                  setPreview(null);
                }}
              >
                <option value="">Leave uncategorized</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
          ))}
        </fieldset>
      )}
      <div style={{ maxHeight: 300, overflow: "auto" }}>
        <table>
          <thead>
            <tr>
              <th>Source row</th>
              <th>Date</th>
              <th>Description</th>
              <th>Amount</th>
              <th>Import</th>
            </tr>
          </thead>
          <tbody>
            {group.rows.map((r, i) => {
              const check = preview?.[i];
              return (
                <tr key={r.row}>
                  <td>{r.row}</td>
                  <td>{r.posted}</td>
                  <td>{r.description}</td>
                  <td>{(r.amount / 100).toFixed(2)}</td>
                  <td>
                    {r.error ||
                      check?.error ||
                      (check ? (
                        <label>
                          <input
                            type="checkbox"
                            disabled={busy || done}
                            checked={!skip.includes(check.row)}
                            onChange={() =>
                              setSkip(
                                skip.includes(check.row)
                                  ? skip.filter((x) => x !== check.row)
                                  : [...skip, check.row],
                              )
                            }
                          />
                          {check.duplicate ? "Possible duplicate" : "Include"}
                        </label>
                      ) : (
                        r.category
                      ))}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {!demo && (
        <button
          disabled={
            !account ||
            busy ||
            done ||
            group.rows.some((r) => r.error) ||
            (!!preview && skip.length === preview.length)
          }
          onClick={() => run(!!preview)}
        >
          {preview
            ? "Import " + (preview.length - skip.length) + " selected rows"
            : "Preview and check duplicates"}
        </button>
      )}
      <p role="status">{message}</p>
    </details>
  );
}
