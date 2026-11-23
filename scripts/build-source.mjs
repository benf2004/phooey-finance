import { mkdir, access, copyFile } from "node:fs/promises";
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
  "wrangler.self-hosted.jsonc",
  "vite.config.ts",
  "vitest.config.ts",
  "tsconfig.json",
  "worker-configuration.d.ts",
  "index.html",
  "src",
  "ios/README.md",
  "ios/PhooeyFinance",
  "ios/PhooeyFinance.xcodeproj/project.pbxproj",
  ...["LICENSE", "README.md", "THIRD_PARTY_NOTICES.md", "package.json", "package-lock.json", "tsconfig.json", "vite.config.ts", "wrangler.jsonc", "worker-configuration.d.ts", "index.html", "src", "migrations", "public", "scripts", "tests", "docs"].map(name => "invoicer/" + name),
  "hosted/migrations",
  "hosted/melody",
  "hosted/worker.example.json",
  "hosted/reports.sql",
  "migrations",
  "public",
  "scripts",
  "tests",
  "docs",
  ".github",
];
for (const path of paths) await access(path);
await mkdir("dist/client", { recursive: true });
await copyFile("LICENSE", "dist/client/LICENSE.txt");
const result = spawnSync(
  "tar",
  ["-czf", "dist/client/source.tar.gz", ...paths],
  { stdio: "inherit" },
);
if (result.status !== 0) throw new Error("Source archive creation failed");
console.log(
  "Packaged source at /source.tar.gz (no secrets or application data).",
);
