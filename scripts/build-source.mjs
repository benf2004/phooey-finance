import { mkdir, access } from "node:fs/promises";
import { spawnSync } from "node:child_process";
// Explicit allowlist: never package credentials, databases, staging files or dependencies.
const paths = [
  "README.md",
  "LICENSE",
  "package.json",
  "package-lock.json",
  ".nvmrc",
  ".dev.vars.example",
  ".gitignore",
  "wrangler.jsonc",
  "vite.config.ts",
  "vitest.config.ts",
  "tsconfig.json",
  "worker-configuration.d.ts",
  "index.html",
  "src",
  "migrations",
  "public",
  "scripts",
  "tests",
  "docs",
  ".github",
];
for (const path of paths) await access(path);
await mkdir("dist/client", { recursive: true });
const result = spawnSync(
  "tar",
  ["-czf", "dist/client/source.tar.gz", ...paths],
  { stdio: "inherit" },
);
if (result.status !== 0) throw new Error("Source archive creation failed");
console.log(
  "Packaged source at /source.tar.gz (no secrets or application data).",
);
