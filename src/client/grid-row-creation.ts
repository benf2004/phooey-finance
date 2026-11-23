import {
  accountSchema,
  categorySchema,
  ruleSchema,
  transactionSchema,
  type Category,
} from "../shared/models";
import { parseMoney } from "../shared/money";

export type GridDraft = Record<string, string>;

// Keep the key on a retry, but never deduplicate two intentionally identical rows.
export function createRowRequest() {
  let last: { body: string; key: string } | undefined;
  return (values: GridDraft) => {
    const body = JSON.stringify(values);
    if (last?.body !== body) last = { body, key: crypto.randomUUID() };
    return last.key;
  };
}
export function missingRowFields(values: GridDraft, required: string[]) {
  return required.filter((key) => !values[key]?.trim());
}
export function transactionFromGrid(values: GridDraft, categories: Category[]) {
  const amount = parseMoney(values.amount);
  const category = categories.find((c) => c.id === values.category);
  return transactionSchema.parse({
    account_id: values.account,
    posted: values.posted,
    description: values.description,
    amount,
    category_id: values.category || null,
    type: category?.type ?? (amount >= 0 ? "income" : "expense"),
    tags: JSON.parse(values.tags || "[]"),
    merchant: values.merchant || "",
    notes: values.notes || "",
    reviewed: values.reviewed === "1",
  });
}
export function accountFromGrid(values: GridDraft) {
  return accountSchema.parse({
    ...values,
    balance: parseMoney(values.balance || "0"),
  });
}
export function categoryFromGrid(values: GridDraft) {
  return categorySchema.parse(values);
}
export function ruleFromGrid(values: GridDraft) {
  return ruleSchema.parse({
    ...values,
    priority: /^\d+$/.test(values.priority.trim())
      ? Number(values.priority)
      : NaN,
    enabled: values.enabled === "1",
  });
}
