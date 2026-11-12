import { z } from "zod";
export const moneySchema = z.number().int().safe().min(-1e12).max(1e12);
export const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(
    (v) =>
      !Number.isNaN(Date.parse(v)) &&
      new Date(v).toISOString().slice(0, 10) === v,
    "Use a valid date",
  );
export const typeSchema = z.enum(["income", "expense", "transfer"]);
export const categorySchema = z.object({
  name: z.string().trim().min(1).max(80),
  type: typeSchema,
  tax_treatment: z
    .enum([
      "personal",
      "business_income",
      "business_expense",
      "tax_payment",
      "excluded",
    ])
    .default("personal"),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .default("#28634a"),
});
export const accountSchema = z.object({
  name: z.string().trim().min(1).max(100),
  institution: z.string().max(100).default(""),
  kind: z
    .enum([
      "checking",
      "savings",
      "credit",
      "cash",
      "investment",
      "loan",
      "other",
    ])
    .default("checking"),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .default("USD"),
  balance: moneySchema.default(0),
});
export const splitSchema = z.object({
  amount: moneySchema,
  category_id: z.string().nullable(),
  type: typeSchema,
  notes: z.string().max(2000).default(""),
});
export const transactionSchema = z
  .object({
    account_id: z.string().min(1),
    posted: dateSchema,
    amount: moneySchema,
    description: z.string().trim().min(1).max(500),
    merchant: z.string().max(200).default(""),
    category_id: z.string().nullable().default(null),
    type: typeSchema,
    notes: z.string().max(4000).default(""),
    reviewed: z.boolean().default(true),
    pending: z.boolean().default(false),
    splits: z.array(splitSchema).max(30).default([]),
  })
  .superRefine((v, c) => {
    if (
      v.splits.length &&
      v.splits.reduce((s, x) => s + x.amount, 0) !== v.amount
    )
      c.addIssue({
        code: "custom",
        message: "Split amounts must equal the transaction total",
        path: ["splits"],
      });
  });
export const ruleSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    priority: z.number().int().min(0).max(10000).default(100),
    enabled: z.boolean().default(true),
    pattern: z.string().trim().min(1).max(200),
    match_field: z.enum(["description", "merchant"]).default("description"),
    account_id: z.string().nullable().default(null),
    min_amount: moneySchema.nullable().default(null),
    max_amount: moneySchema.nullable().default(null),
    direction: z.enum(["any", "in", "out"]).default("any"),
    category_id: z.string().min(1),
  })
  .refine(
    (v) =>
      v.min_amount === null ||
      v.max_amount === null ||
      v.min_amount <= v.max_amount,
    "Minimum must not exceed maximum",
  );
export const filterSchema = z.object({
  q: z.string().max(200).default(""),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .optional(),
  from: dateSchema.optional(),
  to: dateSchema.optional(),
  account: z.string().optional(),
  category: z.string().optional(),
  type: typeSchema.optional(),
  reviewed: z.enum(["0", "1"]).optional(),
  pending: z.enum(["0", "1"]).optional(),
  source: z.enum(["manual", "simplefin", "csv"]).optional(),
  min: z.coerce.number().int().safe().optional(),
  max: z.coerce.number().int().safe().optional(),
  page: z.coerce.number().int().min(1).max(100000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type Filters = z.infer<typeof filterSchema>;
export type Account = z.infer<typeof accountSchema> & {
  id: string;
  source: string;
  provider_id: string | null;
  balance_at: string | null;
  archived: number;
};
export type Category = z.infer<typeof categorySchema> & { id: string };
export type Rule = Omit<z.infer<typeof ruleSchema>, "enabled"> & {
  id: string;
  enabled: number;
};
export type TransactionInput = z.infer<typeof transactionSchema>;
export type Transaction = Omit<
  TransactionInput,
  "reviewed" | "pending" | "splits"
> & {
  id: string;
  reviewed: number;
  pending: number;
  revision: number;
  source: string;
  account_name: string;
  currency: string;
  category_name: string | null;
  rule_name: string | null;
  user_edited: number;
  split_count: number;
  transfer_id: string | null;
};
export const scopes = [
  "finance:read",
  "transactions:write",
  "rules:write",
  "tax:write",
  "sync:write",
] as const;
export type Scope = (typeof scopes)[number];
export const scopeSchema = z.array(z.enum(scopes)).min(1);
export const paymentSchema = z.object({
  year: z.number().int().min(2000).max(2100),
  jurisdiction: z.enum(["federal", "state"]),
  paid_on: dateSchema,
  amount: moneySchema.refine((x) => x > 0),
  notes: z.string().max(1000).default(""),
  transaction_id: z.string().nullable().default(null),
});
export type Payment = z.infer<typeof paymentSchema> & { id: string };
