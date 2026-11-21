import { detectCSVMapping, mapCSV, parseCSV } from "./csv";
export const sampleTiller =
  "Date,Description,Amount,Account,Account #,Category\n11/02/2026,Studio North invoice,2800,Checking,1234,Client income\n11/03/2026,Design software,-59,Business card,5678,Software";
export function tillerGroups(text: string) {
  if (text.length > 1_500_000) throw Error("Choose a CSV smaller than 1.5 MB.");
  const [header, ...rows] = parseCSV(text);
  if (!header || !rows.length || rows.length > 5000)
    throw Error("Choose a Transactions CSV with 1–5,000 entries.");
  const normalized = header.map((h) => h.trim().toLowerCase());
  for (const field of ["date", "description", "amount", "account"])
    if (!normalized.includes(field))
      throw Error("Missing Tiller column: " + field);
  const mapping = detectCSVMapping(header);
  mapping.dateFormat = /^\d{4}-/.test((rows[0][mapping.date] ?? "").trim())
    ? "iso"
    : "mdy";
  const parsed = mapCSV(text, mapping),
    groups = new Map<
      string,
      { account: string; currency: string; rows: typeof parsed }
    >();
  rows.forEach((r, i) => {
    const name = r[normalized.indexOf("account")]?.trim(),
      number = r[normalized.indexOf("account #")]?.trim();
    if (!name) throw Error("Missing account on row " + (i + 2));
    const label = [
      name,
      number,
      r[normalized.indexOf("institution")]?.trim(),
      r[normalized.indexOf("currency")]?.trim().toUpperCase(),
    ]
      .filter(Boolean)
      .join(" · ");
    const group = groups.get(label) ?? {
      account: label,
      currency: r[normalized.indexOf("currency")]?.trim().toUpperCase() ?? "",
      rows: [],
    };
    group.rows.push(parsed[i]);
    groups.set(label, group);
  });
  return [...groups.values()];
}
