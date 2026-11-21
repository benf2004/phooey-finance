import { randomBytes } from "node:crypto";
import { writeFile, mkdir, access } from "node:fs/promises";
await mkdir(".private", { recursive: true, mode: 0o700 });
try {
  await access(".private/production-secrets.json");
  console.log("Production secrets already exist; leaving them unchanged.");
} catch {
  const key = randomBytes(32).toString("hex");
  await writeFile(
    ".private/production-secrets.json",
    JSON.stringify(
      {
        ADMIN_KEY: key,
        ENCRYPTION_KEY: randomBytes(32).toString("base64"),
      },
      null,
      2,
    ),
    { mode: 0o600, flag: "wx" },
  );
  await writeFile(
    ".private/production-access.txt",
    `Admin key: ${key}\n\nProduction credentials. Keep private; this file is not part of the source archive.\n`,
    { mode: 0o600, flag: "wx" },
  );
  console.log(
    "Created .private/production-secrets.json and .private/production-access.txt. Secret values were not printed.",
  );
}
