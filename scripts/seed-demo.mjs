import { writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
const quote = (v) => "'" + String(v).replaceAll("'", "''") + "'";
const statements = [
  "INSERT OR IGNORE INTO categories(id,name,type,tax_treatment,color) VALUES\n('income','Business income','income','business_income','#28634a'),('salary','Salary','income','personal','#28634a'),('software','Software & subscriptions','expense','business_expense','#28634a'),('office','Office & equipment','expense','business_expense','#8c7864'),('travel','Business travel','expense','business_expense','#8c7864'),('dining','Food & dining','expense','personal','#b88a43'),('groceries','Groceries','expense','personal','#8c7864'),('home','Home & utilities','expense','personal','#8c7864'),('shopping','Shopping','expense','personal','#8c7864'),('tax','Tax payments','expense','tax_payment','#b88a43'),('transfer','Transfers','transfer','excluded','#78877d');",
  "INSERT OR REPLACE INTO settings(key,value) VALUES('demo','true');",
  "INSERT OR IGNORE INTO accounts(id,name,institution,kind,currency,balance,balance_at) VALUES('demo-checking','Everyday checking','Demo Bank','checking','USD',1246800,'2026-11-12T08:00:00Z'),('demo-business','Business checking','Demo Bank','checking','USD',1824500,'2026-11-12T08:00:00Z'),('demo-savings','Rainy day fund','Demo Bank','savings','USD',2250000,'2026-11-12T08:00:00Z'),('demo-credit','Everyday card','Demo Bank','credit','USD',-146800,'2026-11-12T08:00:00Z');",
];
const entries = [
  [
    "Studio North · Client payment",
    "income",
    860000,
    "income",
    "demo-business",
  ],
  ["Adobe Creative Cloud", "software", -5999, "expense", "demo-business"],
  ["Whole Foods Market", "groceries", -8642, "expense", "demo-checking"],
  ["Monthly rent", "home", -185000, "expense", "demo-checking"],
  ["Figma", "software", -1500, "expense", "demo-business"],
  ["Little Owl Coffee", "dining", -1450, "expense", "demo-checking"],
  ["Internet & utilities", "home", -16200, "expense", "demo-checking"],
  ["Design retainer", "income", 275000, "income", "demo-business"],
  ["Office supplies", "office", -12450, "expense", "demo-business"],
  ["A good book", "shopping", -2800, "expense", "demo-checking"],
];
for (let month = 1; month <= 11; month++) {
  for (let i = 0; i < entries.length; i++) {
    const [description, category, base, type, account] = entries[i];
    const amount = type === "income" ? base + month * 2300 : base - month * 110;
    const day = month === 11 ? Math.min(12, i + 2) : i * 2 + 2;
    statements.push(
      `INSERT OR IGNORE INTO transactions(id,account_id,posted,amount,description,category_id,type,reviewed,source,user_edited) VALUES(${quote("demo-" + month + "-" + i)},${quote(account)},${quote("2026-" + String(month).padStart(2, "0") + "-" + String(day).padStart(2, "0"))},${amount},${quote(description)},${month === 11 && i > 6 ? "NULL" : quote(category)},${quote(type)},${month === 11 && i > 6 ? 0 : 1},'manual',1);`,
    );
  }
}
statements.push(
  "INSERT OR IGNORE INTO rules(id,name,pattern,category_id,priority) VALUES('demo-rule','Creative tools','Adobe','software',10);",
);
const path = join(tmpdir(), "phooey-demo-" + Date.now() + ".sql");
await writeFile(path, statements.join("\n"));
try {
  execFileSync(
    "npx",
    ["wrangler", "d1", "execute", "phooey-finance", "--local", "--file", path],
    { stdio: "inherit" },
  );
} finally {
  await rm(path);
}
console.log("Loaded clearly labeled demo fixtures into LOCAL storage only.");
