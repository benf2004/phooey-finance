import { parseMoney } from "./money";
import { dateSchema } from "./models";
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
export function mapCSV(
  text: string,
  mapping: {
    date: number;
    description: number;
    amount: number;
    dateFormat: "iso" | "mdy" | "dmy";
    invert: boolean;
  },
) {
  const rows = parseCSV(text);
  if (rows.length > 5001) throw new Error("Import up to 5,000 rows at a time");
  return rows.slice(1).map((r, i) => {
    try {
      return {
        row: i + 2,
        posted: normalizeDate(r[mapping.date] ?? "", mapping.dateFormat),
        description: (r[mapping.description] ?? "").trim(),
        amount: parseMoney(r[mapping.amount] ?? "") * (mapping.invert ? -1 : 1),
        error: null,
      };
    } catch (e) {
      return {
        row: i + 2,
        posted: "",
        description: r[mapping.description] ?? "",
        amount: 0,
        error: e instanceof Error ? e.message : "Invalid row",
      };
    }
  });
}
