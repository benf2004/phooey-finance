// Build an isolated preview of the production grid, with synthetic data only.
// node scripts/preview-spreadsheet.mjs --serve
import { context } from "esbuild";
import { mkdir, writeFile, cp } from "node:fs/promises";
const outdir = ".private/spreadsheet-preview";
await mkdir(outdir, { recursive: true });
await cp("public/business/fonts", outdir + "/business/fonts", {
  recursive: true,
});
await cp("public/business/assets", outdir + "/business/assets", {
  recursive: true,
});
await writeFile(
  outdir + "/index.html",
  '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Phooey spreadsheet preview</title><link rel="stylesheet" href="./preview.css"></head><body><div id="root"></div><script src="./preview.js"></script></body></html>',
);
const preview = await context({
  entryPoints: ["tests/fixtures/spreadsheet-preview.tsx"],
  outfile: outdir + "/preview.js",
  bundle: true,
  external: ["/business/*"],
  format: "iife",
  platform: "browser",
  jsx: "automatic",
  define: { "process.env.NODE_ENV": '"development"' },
  logLevel: "info",
});
await preview.rebuild();
if (process.argv.includes("--serve")) {
  await preview.watch();
  const server = await preview.serve({
    host: "127.0.0.1",
    port: 5174,
    servedir: outdir,
  });
  console.log(`Spreadsheet preview: http://127.0.0.1:${server.port}`);
} else await preview.dispose();
