import { amountInput, parseMoney } from "../shared/money";

export function amountFilterText(cents: string | null): string {
  if (cents === null || cents === "") return "";
  const amount = Number(cents);
  return Number.isSafeInteger(amount) ? amountInput(amount) : cents;
}

export function amountFilterQuery(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  // Accept natural decimal entry at commit time without rounding extra precision.
  const normalized = trimmed
    .replace(/^(-?)\.(?=\d)/, (_, sign: string) => `${sign}0.`)
    .replace(/^(-?\d+)\.$/, "$1.0");
  return String(parseMoney(normalized));
}
