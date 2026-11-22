import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const account = process.argv[2];
if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(account ?? "")) {
  console.error(
    "Copy your Account ID from finance.phooey.foo/cloud/account and run npm run hosted:admin -- YOUR_ACCOUNT_ID",
  );
  process.exit(1);
}
const root = fileURLToPath(new URL("../", import.meta.url));
const sql = `INSERT INTO account_admins(customer)
  SELECT id FROM customers WHERE id='${account}' AND pending_free=0 ON CONFLICT(customer) DO NOTHING;
  SELECT customer FROM account_admins WHERE customer='${account}';`;
const output = execFileSync(
  "node_modules/.bin/wrangler",
  [
    "d1",
    "execute",
    "phooey-hosted-control",
    "--remote",
    "--config",
    ".private/launch/portal.json",
    "--json",
    "--command",
    sql,
  ],
  { cwd: root, encoding: "utf8" },
);
if (
  !JSON.parse(output)
    .at(-1)
    ?.results?.some((row) => row.customer === account)
) {
  console.error(
    "Account not found. Sign in to hosted Finance and copy your Account ID.",
  );
  process.exit(1);
}
console.log(
  "Administrator access granted. Open https://finance.phooey.foo/admin",
);
