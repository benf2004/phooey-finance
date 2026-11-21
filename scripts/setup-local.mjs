import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
const key = randomBytes(32).toString("hex");
try {
  await writeFile(".dev.vars",
    `ADMIN_KEY="${key}"\nENCRYPTION_KEY="${randomBytes(32).toString("base64")}"\n`,
    { mode: 0o600, flag: "wx" });
  console.log("Local admin key saved in .dev.vars. Use ADMIN_KEY to sign in.");
} catch (error) {
  if (error.code !== "EEXIST") throw error;
  console.log(".dev.vars already exists. Your current login still works.");
}
