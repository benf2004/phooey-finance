import React, { useState, useRef } from "react";
import { createRoot } from "react-dom/client";
import { type GridColumn } from "../../src/client/LedgerGrid";
import { CreatableLedgerGrid } from "../../src/client/CreatableLedgerGrid";
import { WorkspaceContext, type Workspace } from "../../src/client/context";
import { defaultTransactionAppearance } from "../../src/shared/transaction-appearance";
import { formatMoney, parseMoney } from "../../src/shared/money";
import "../../src/client/styles.css";
import "../../src/client/workspace.css";

// This preview is entirely synthetic. No application backend or credentials are used.
window.fetch = async () =>
  new Response(JSON.stringify(["Business", "Client", "Software", "Travel"]), {
    headers: { "Content-Type": "application/json" },
  });
const noop = () => {};
const workspace = {
  accounts: [],
  categories: [],
  refresh: noop,
  version: 0,
  navigate: noop,
  notify: noop,
  demo: true,
  sourceUrl: "",
  username: "preview",
  displayName: "Preview",
  updateProfile: noop,
  transactionAppearance: defaultTransactionAppearance,
  updateTransactionAppearance: noop,
  appearanceSaveState: { status: "saved", error: null },
  retryTransactionAppearance: noop,
  theme: "light",
  setTheme: noop,
} as Workspace;
type Row = {
  id: string;
  posted: string;
  description: string;
  tags: string[];
  category: string;
  amount: number;
  notes: string;
  reviewed: string;
};
const samples = [
  "Figma subscription",
  "Client project payment",
  "Office supplies",
  "Cloud hosting",
  "Coffee with client",
  "Train to client office",
  "Print production",
  "Website maintenance",
  "Team lunch",
  "Adobe Creative Cloud",
];
function Preview() {
  const [rows, setRows] = useState<Row[]>(
    samples.map((description, i) => ({
      id: String(i),
      posted: `2026-11-${String(22 - i).padStart(2, "0")}`,
      description,
      tags: i % 3 ? ["Business"] : ["Business", "Software"],
      category:
        i === 1 ? "Client services" : i % 2 ? "Software" : "Office supplies",
      amount: i === 1 ? 250000 : -(1500 + i * 275),
      notes:
        i === 0
          ? "Annual plan for the design team. Includes collaboration tools and five seats."
          : "",
      reviewed: i % 3 ? "Reviewed" : "Needs review",
    })),
  );
  const [fail, setFail] = useState(false);
  const failNext = useRef(false);
  const save = async (row: Row, key: keyof Row, value: unknown) => {
    if (failNext.current) {
      failNext.current = false;
      setFail(false);
      throw Error("Could not save. Your draft is still in the cell.");
    }
    setRows((old) =>
      old.map((r) => (r.id === row.id ? { ...r, [key]: value } : r)),
    );
  };
  const cols: GridColumn<Row>[] = [
    {
      key: "posted",
      title: "Date",
      type: "date",
      width: 110,
      value: (r) => r.posted,
      save: (r, v) => save(r, "posted", v),
    },
    {
      key: "description",
      title: "Description",
      width: 220,
      value: (r) => r.description,
      save: (r, v) => save(r, "description", v),
    },
    {
      key: "tags",
      title: "Tags",
      type: "tags",
      width: 150,
      value: (r) => JSON.stringify(r.tags),
      display: (r) => (
        <span className="grid-chips">
          {r.tags.map((t) => (
            <span key={t}>{t}</span>
          ))}
        </span>
      ),
      save: (r, v) => save(r, "tags", JSON.parse(v)),
    },
    {
      key: "category",
      title: "Category",
      width: 160,
      value: (r) => r.category,
      options: [
        "Client services",
        "Office supplies",
        "Software",
        "Travel",
        "Meals",
      ].map((value) => ({ value, label: value })),
      save: (r, v) => save(r, "category", v),
    },
    {
      key: "amount",
      title: "Amount",
      type: "number",
      width: 115,
      value: (r) => (r.amount / 100).toFixed(2),
      display: (r) => formatMoney(r.amount),
      save: (r, v) => save(r, "amount", parseMoney(v)),
    },
    {
      key: "notes",
      title: "Notes",
      width: 240,
      value: (r) => r.notes,
      save: (r, v) => save(r, "notes", v),
    },
    {
      key: "reviewed",
      title: "Review",
      width: 150,
      value: (r) => r.reviewed,
      options: ["Reviewed", "Needs review"].map((value) => ({
        value,
        label: value,
      })),
      save: (r, v) => save(r, "reviewed", v),
    },
  ];
  return (
    <WorkspaceContext value={workspace}>
      <main style={{ padding: "24px", maxWidth: "1600px", margin: "auto" }}>
        <header
          style={{
            display: "flex",
            alignItems: "center",
            gap: 16,
            marginBottom: 20,
          }}
        >
          <h1 style={{ margin: 0, fontSize: 22 }}>Transactions</h1>
          <span style={{ color: "var(--muted)" }}>
            Local preview · Fictional data
          </span>
          <button
            style={{ marginLeft: "auto" }}
            onClick={() => {
              failNext.current = true;
              setFail(true);
            }}
          >
            {fail ? "Next save will fail" : "Simulate failed save"}
          </button>
        </header>
        <CreatableLedgerGrid
          rows={rows}
          columns={cols}
          label="Transactions spreadsheet"
          creation={{
            defaults: () => ({
              posted: "2026-11-22",
              description: "",
              tags: '["Business"]',
              category: "Office supplies",
              amount: "",
              notes: "",
              reviewed: "Reviewed",
            }),
            required: ["description", "amount"],
            create: async (values, key) => {
              if (failNext.current) {
                failNext.current = false;
                setFail(false);
                throw Error("Could not save. Your draft is still in the cell.");
              }
              const record: Row = {
                ...values,
                id: key,
                posted: values.posted,
                description: values.description,
                tags: JSON.parse(values.tags),
                category: values.category,
                amount: parseMoney(values.amount),
                notes: values.notes,
                reviewed: values.reviewed,
              };
              setRows((old) => [...old, record]);
              return record;
            },
          }}
        />
      </main>
    </WorkspaceContext>
  );
}
createRoot(document.getElementById("root")!).render(<Preview />);
