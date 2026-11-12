export function parseMoney(input: string): number {
  const normalized = input
    .trim()
    .replace(/[$,\s]/g, "")
    .replace(/^\((.*)\)$/, "-$1");
  if (!/^-?\d+(\.\d{1,2})?$/.test(normalized))
    throw new Error("Enter an amount with at most two decimal places");
  const negative = normalized.startsWith("-");
  const [whole, frac = ""] = normalized.replace("-", "").split(".");
  const cents = Number(whole) * 100 + Number(frac.padEnd(2, "0"));
  if (!Number.isSafeInteger(cents) || cents > 1e12)
    throw new Error("Amount is too large");
  return negative ? -cents : cents;
}
export function formatMoney(cents: number, currency = "USD", digits = 2) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(cents / 100);
}
export function amountInput(cents: number) {
  return (cents / 100).toFixed(2);
}
export function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
