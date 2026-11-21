import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const base = fileURLToPath(new URL("../", import.meta.url));
const { build } = await import("vite");
await build({ configFile: false, build: {
  outDir: "dist/client", emptyOutDir: false, copyPublicDir: false,
  lib: {entry: "src/client/hosted-security.ts", name: "FinanceSecurity", formats:["iife"], fileName:()=>"finance-security.js"}
}});
const run = spawnSync(
  process.execPath,
  [
    base + "node_modules/wrangler/bin/wrangler.js",
    "deploy",
    "--dry-run",
    "--config",
    "hosted/worker.example.json",
    "--outdir",
    base + "dist/hosted",
  ],
  { cwd: base, stdio: "inherit" },
);
process.exitCode = run.status ?? 1;
