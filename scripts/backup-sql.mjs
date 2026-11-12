import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
const local = process.argv.includes("--local");
const output =
  process.argv.find((arg) => arg.startsWith("--output="))?.slice(9) ??
  ".private/finance.sql";
await mkdir(".private", { recursive: true, mode: 0o700 });
const tables = [
  "accounts",
  "categories",
  "rules",
  "imports",
  "transactions",
  "splits",
  "balance_snapshots",
  "settings",
  "tax_payments",
  "audit",
];
const args = [
  "d1",
  "export",
  "phooey-finance",
  local ? "--local" : "--remote",
  ...(!local ? ["--env", "production"] : []),
  "--no-schema",
  "--output",
  output,
  "--skip-confirmation",
  ...tables.flatMap((table) => ["--table", table]),
];
const result = spawnSync("node_modules/.bin/wrangler", args, {
  encoding: "utf8",
  maxBuffer: 1024 * 1024,
});
if (result.status !== 0) {
  console.error(
    "D1 export failed. Check Cloudflare authentication, database configuration, and output path.",
  );
  process.exit(1);
}
const dump = await readFile(output, "utf8");
await writeFile(
  output,
  "-- Restore ONLY into a freshly migrated, disconnected database.\nPRAGMA defer_foreign_keys=ON;\nDELETE FROM categories;\n" +
    dump +
    "\nINSERT INTO transaction_search(transaction_search) VALUES('rebuild');\n",
  { mode: 0o600 },
);
console.log(
  `SQL backup saved to ${output}. Finish pending imports before using this as a complete backup. It excludes credentials and requires a fresh migrated database to restore.`,
);
