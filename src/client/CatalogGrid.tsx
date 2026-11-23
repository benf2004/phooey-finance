import type { Account, Category, Rule } from "../shared/models";
import { amountInput, formatMoney, parseMoney } from "../shared/money";
import { useWorkspace } from "./context";
import { formatEnumLabel } from "./labels";
import { GridColumn } from "./LedgerGrid";
import { CreatableLedgerGrid } from "./CreatableLedgerGrid";
import {
  accountFromGrid,
  categoryFromGrid,
  ruleFromGrid,
} from "./grid-row-creation";
import { api, post, useSubmit } from "./api";

export function options(values: string[]) {
  return values.map((value) => ({ value, label: formatEnumLabel(value) }));
}
export function CatalogGrid({
  table,
  rules = [],
}: {
  table: "accounts" | "categories" | "rules";
  rules?: Rule[];
}) {
  const { accounts, categories, refresh } = useWorkspace();
  const submit = useSubmit();
  function field<R, K extends keyof R>(
    key: K,
    title: string,
    extra: Partial<GridColumn<R>> = {},
    parse: (s: string) => string | number | boolean = (s) => s,
  ): GridColumn<R> {
    return {
      key: String(key),
      title,
      value: (r) => String(r[key] ?? ""),
      save: async (row, draft) => {
        try {
          await submit(
            "/" + table + "/" + (row as R & { id: string }).id,
            { field: key, previous: row[key], value: parse(draft) },
            "PATCH",
          );
        } finally {
          refresh();
        }
      },
      ...extra,
    };
  }
  if (table === "accounts") {
    const cols: GridColumn<Account>[] = [
      field("name", "Account"),
      field("institution", "Institution"),
      field("kind", "Type", {
        options: options([
          "checking",
          "savings",
          "credit",
          "cash",
          "investment",
          "loan",
          "other",
        ]),
      }),
      { key: "currency", title: "Currency", value: (r) => r.currency },
      field(
        "balance",
        "Balance",
        {
          type: "number",
          value: (r) => amountInput(r.balance),
          display: (r) => formatMoney(r.balance, r.currency),
          locked: (r) => r.source !== "manual",
        },
        parseMoney,
      ),
      {
        key: "source",
        title: "Source",
        value: (r) => (r.source === "manual" ? "Manual" : "SimpleFIN"),
      },
    ];
    return (
      <CreatableLedgerGrid
        key="accounts"
        rows={accounts}
        columns={cols}
        label="Accounts spreadsheet"
        creation={{
          defaults: () => ({
            name: "",
            institution: "",
            kind: "checking",
            currency: "USD",
            balance: "0.00",
            source: "Manual",
          }),
          required: ["name"],
          fields: { currency: { editable: true } },
          reload: async (id) =>
            (await api<Account[]>("/accounts")).find((row) => row.id === id)!,
          create: async (values, key) => {
            const record = await post<Account>(
              "/accounts",
              accountFromGrid(values),
              "POST",
              key,
            );
            refresh();
            return {
              ...record,
              source: "manual",
              provider_id: null,
              balance_at: null,
              archived: 0,
            };
          },
        }}
      />
    );
  }
  if (table === "categories") {
    const cols: GridColumn<Category>[] = [
      field("name", "Category"),
      field("type", "Type", {
        options: options(["expense", "income", "transfer"]),
      }),
      field("tax_treatment", "Tax treatment", {
        options: options([
          "personal",
          "business_income",
          "business_expense",
          "tax_payment",
          "excluded",
        ]),
      }),
      field("color", "Color", {
        display: (r) => (
          <>
            <i className="grid-swatch" style={{ background: r.color }} />
            {r.color}
          </>
        ),
      }),
    ];
    return (
      <CreatableLedgerGrid
        key="categories"
        rows={categories}
        columns={cols}
        label="Categories spreadsheet"
        creation={{
          defaults: () => ({
            name: "",
            type: "expense",
            tax_treatment: "personal",
            color: "#28634a",
          }),
          required: ["name"],
          reload: async (id) =>
            (await api<Category[]>("/categories")).find(
              (row) => row.id === id,
            )!,
          create: async (values, key) => {
            const record = await post<Category>(
              "/categories",
              categoryFromGrid(values),
              "POST",
              key,
            );
            refresh();
            return record;
          },
        }}
      />
    );
  }
  const cols: GridColumn<Rule>[] = [
    field("name", "Rule"),
    field("pattern", "Match text"),
    field("category_id", "Category", {
      options: categories.map((c) => ({ value: c.id, label: c.name })),
    }),
    field("priority", "Priority", { type: "number" }, (s) =>
      /^\d+$/.test(s.trim()) ? Number(s) : NaN,
    ),
    field(
      "enabled",
      "Status",
      {
        options: [
          { value: "1", label: "Enabled" },
          { value: "0", label: "Paused" },
        ],
      },
      (s) => s === "1",
    ),
  ];
  return (
    <CreatableLedgerGrid
      key="rules"
      rows={rules}
      columns={cols}
      label="Rules spreadsheet"
      creation={{
        defaults: () => ({
          name: "",
          pattern: "",
          category_id: "",
          priority: "100",
          enabled: "1",
        }),
        required: ["name", "pattern", "category_id"],
        fields: {
          category_id: {
            options: [
              { value: "", label: "Choose category" },
              ...categories.map((c) => ({ value: c.id, label: c.name })),
            ],
          },
        },
        reload: async (id) =>
          (await api<Rule[]>("/rules")).find((row) => row.id === id)!,
        create: async (values, key) => {
          const record = await post<Rule>(
            "/rules",
            ruleFromGrid(values),
            "POST",
            key,
          );
          refresh();
          return { ...record, enabled: Number(record.enabled) };
        },
      }}
    />
  );
}
