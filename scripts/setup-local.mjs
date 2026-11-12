import { randomBytes } from "node:crypto";
import { writeFile, access } from "node:fs/promises";
import { hash } from "bcryptjs";
try {
  await access(".dev.vars");
  console.log(".dev.vars already exists; leaving credentials unchanged.");
} catch {
  const password = randomBytes(18).toString("base64url");
  await writeFile(
    ".dev.vars",
    `ADMIN_USERNAME="admin"\nADMIN_PASSWORD_HASH="${await hash(password, 12)}"\nENCRYPTION_KEY="${randomBytes(32).toString("base64")}"\n`,
    { mode: 0o600 },
  );
  console.log(
    `Local admin: admin\nLocal password: ${password}\nSaved server secrets to ignored .dev.vars. These credentials are local only.`,
  );
}
