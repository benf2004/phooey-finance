import { parseMoney } from "./money";
import { z } from "zod";
import { dateSchema, tagsSchema, typeSchema } from "./models";

const columnIndex = z.number().int().min(0).max(100);
// Unmapped null and omitted columns have identical semantics and retry keys.
const optionalColumn = columnIndex
  .nullish()
  .transform((value) => value ?? undefined);
export const csvMappingSchema = z.object({
  date: columnIndex,
  description: columnIndex,
  amount: columnIndex,
  dateFormat: z.enum(["iso", "mdy", "dmy"]),
  invert: z.boolean(),
  tags: optionalColumn,
  merchant: optionalColumn,
  notes: optionalColumn,
  category: optionalColumn,
  type: optionalColumn,
  pending: optionalColumn,
  reviewed: optionalColumn,
});
export type CSVMapping = z.input<typeof csvMappingSchema>;
export const optionalCSVColumns = [
  {
    key: "tags",
    label: "Tags",
    aliases: ["tags", "tag", "labels"],
    hint: "Separate tags with semicolons, or use a JSON string array. Up to 20 tags, 50 characters each. Blank means no tags; not imported defaults to Business.",
  },
  {
    key: "merchant",
    label: "Merchant",
    aliases: ["merchant", "merchant name", "vendor"],
    hint: "Up to 200 characters.",
  },
  {
    key: "notes",
    label: "Notes",
    aliases: ["notes", "note", "comments", "comment"],
    hint: "Up to 4,000 characters. Quote cells containing commas or line breaks.",
  },
  {
    key: "category",
    label: "Category",
    aliases: ["category", "category name", "category id"],
    hint: "An existing category name (case-insensitive) or ID. Blank allows matching rules; unknown or ambiguous names must be corrected.",
  },
  {
    key: "type",
    label: "Type",
    aliases: ["type", "transaction type"],
    hint: "income, expense, or transfer. Blank uses the amount sign. Matching category rules can set the type.",
  },
  {
    key: "pending",
    label: "Pending",
    aliases: ["pending", "is pending"],
    hint: "true/false, yes/no, or 1/0. Blank defaults to false.",
  },
  {
    key: "reviewed",
    label: "Reviewed",
    aliases: ["reviewed", "is reviewed"],
    hint: "true/false, yes/no, or 1/0. Blank defaults to false.",
  },
] as const;

export function detectCSVMapping(headers: string[]): CSVMapping {
  const normalized = headers.map((h) =>
    h.trim().toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " "),
  );
  const find = (aliases: readonly string[]) =>
    normalized.findIndex((h) => aliases.includes(h));
  const required = (aliases: string[], fallback: number, legacy: RegExp) => {
    const exact = find(aliases);
    const index =
      exact < 0 ? normalized.findIndex((h) => legacy.test(h)) : exact;
    return index < 0 ? fallback : index;
  };
  const mapping: CSVMapping = {
    date: required(
      ["date", "posted", "posted date", "transaction date", "posting date"],
      0,
      /date/i,
    ),
    description: required(
      ["description", "memo", "payee", "transaction description"],
      1,
      /description|memo|payee/i,
    ),
    amount: required(
      ["amount", "transaction amount", "net amount"],
      2,
      /amount/i,
    ),
    dateFormat: "iso",
    invert: false,
  };
  for (const { key, aliases } of optionalCSVColumns) {
    const index = find(aliases);
    if (index >= 0) mapping[key] = index;
  }
  return mapping;
}

export type CSVImportRow = {
  row: number;
  posted: string;
  description: string;
  amount: number;
  tags?: string[];
  merchant?: string;
  notes?: string;
  category?: string;
  category_id?: string | null;
  type?: z.infer<typeof typeSchema>;
  pending?: boolean;
  reviewed?: boolean;
  error: string | null;
};

function parseTags(value: string) {
  if (!value.trim()) return [];
  let tags: unknown;
  if (value.trim().startsWith("[")) {
    try {
      tags = JSON.parse(value);
    } catch {
      throw new Error(
        'Use a valid JSON string array, such as ["Business","Client A"]',
      );
    }
  } else tags = value.split(";");
  return tagsSchema.parse(tags);
}

function parseBoolean(value: string) {
  const normalized = value.trim().toLowerCase();
  if (["true", "yes", "1"].includes(normalized)) return true;
  if (["", "false", "no", "0"].includes(normalized)) return false;
  throw new Error("Use true/false, yes/no, or 1/0");
}
export function parseCSV(text: string): string[][] {
  text = text.replace(/^\uFEFF/, "");
  const rows: string[][] = [];
  let row: string[] = [],
    cell = "",
    quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      if (quoted && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (!quoted && cell.length)
        throw new Error("Invalid quote in CSV");
      else quoted = !quoted;
    } else if (c === "," && !quoted) {
      row.push(cell);
      cell = "";
    } else if ((c === "\n" || c === "\r") && !quoted) {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      if (row.some((v) => v.trim())) rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  if (quoted) throw new Error("Unclosed quote in CSV");
  row.push(cell);
  if (row.some((v) => v.trim())) rows.push(row);
  if (rows[0]?.[0]) rows[0][0] = rows[0][0].replace(/^\uFEFF/, "");
  return rows;
}
export function csvCell(v: unknown) {
  let s = String(v ?? "");
  if (/^[\s]*[=+@-]/.test(s) && typeof v !== "number") s = "'" + s;
  return '"' + s.replace(/"/g, '""') + '"';
}
export function encodeCSV(rows: unknown[][], bom = true) {
  return (
    (bom ? "\uFEFF" : "") +
    rows.map((r) => r.map(csvCell).join(",")).join("\r\n")
  );
}
export function normalizeDate(
  s: string,
  format: "iso" | "mdy" | "dmy" = "iso",
) {
  let value = s.trim();
  if (format !== "iso") {
    const p = value.split(/[\/.\-]/);
    if (p.length !== 3) throw new Error("Invalid date");
    const [a, b, y] = p;
    value = `${y}-${(format === "mdy" ? a : b).padStart(2, "0")}-${(format === "mdy" ? b : a).padStart(2, "0")}`;
  }
  return dateSchema.parse(value);
}
export function mapCSV(text: string, mapping: CSVMapping): CSVImportRow[] {
  const rows = parseCSV(text);
  if (rows.length > 5001) throw new Error("Import up to 5,000 rows at a time");
  return rows.slice(1).map((r, i) => {
    const row: CSVImportRow = {
      row: i + 2,
      posted: "",
      description: r[mapping.description] ?? "",
      amount: 0,
      error: null,
    };
    let field = "Date";
    const cell = (index: number) => {
      if (index >= r.length) throw new Error("Missing cell for mapped column");
      return r[index];
    };
    try {
      row.posted = normalizeDate(cell(mapping.date), mapping.dateFormat);
      field = "Description";
      row.description = cell(mapping.description).trim();
      field = "Amount";
      row.amount = parseMoney(cell(mapping.amount)) * (mapping.invert ? -1 : 1);
      for (const { key, label } of optionalCSVColumns) {
        const index = mapping[key];
        if (index == null) continue;
        field = label;
        const value = cell(index);
        if (key === "tags") row.tags = parseTags(value);
        else if (key === "pending" || key === "reviewed")
          row[key] = parseBoolean(value);
        else if (key === "type") {
          if (value.trim())
            row.type = typeSchema.parse(value.trim().toLowerCase());
        } else row[key] = key === "notes" ? value : value.trim();
      }
    } catch (e) {
      const message =
        e instanceof z.ZodError
          ? e.issues.map((issue) => issue.message).join("; ")
          : e instanceof Error
            ? e.message
            : "Invalid value";
      row.error = `${field}: ${message}`;
    }
    return row;
  });
}
