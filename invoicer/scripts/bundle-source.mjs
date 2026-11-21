import { execFileSync } from "node:child_process";
import { copyFileSync } from "node:fs";
const out = process.argv[2] || "dist";
const source = ["LICENSE", "README.md", "THIRD_PARTY_NOTICES.md", "package.json", "package-lock.json", "tsconfig.json", "vite.config.ts", "wrangler.jsonc", "worker-configuration.d.ts", "index.html", "src", "migrations", "public", "scripts", "tests", "docs"];
execFileSync("tar", ["-czf", out + "/source.tar.gz", ...source]);
copyFileSync("LICENSE", out + "/LICENSE.txt");
