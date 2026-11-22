// Run after the hosted control migration, before deploying the MCP gateway.
// Only SHA-256 routing hashes leave the ledger; no bearer tokens are read.
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
const [manifest, configs] = process.argv.slice(2);
if (!manifest || !configs) throw Error("Pass the hosted resource manifest and configuration directory.");
const { slots } = JSON.parse(await readFile(manifest, "utf8"));
const run = (args) => {
  const result = spawnSync(resolve("node_modules/.bin/wrangler"), args, { encoding: "utf8" });
  if (result.status !== 0) throw Error(result.stderr || "Wrangler failed.");
  return JSON.parse(result.stdout);
};
const directory = await mkdtemp(join(tmpdir(), "phooey-mcp-"));
try {
  for (const slot of slots) {
    if (!/^[a-z][a-z0-9-]{0,23}$/.test(slot.id)) throw Error("Invalid workspace ID.");
    const output = run(["d1", "execute", "DB", "--remote", "--config", resolve(configs, slot.id + ".json"),
      "--command", "SELECT token_hash,expires_at FROM access_tokens WHERE expires_at>unixepoch()", "--json"]);
    const rows = output.flatMap(result => result.results ?? []);
    const sql = rows.map(row => {
      if (!/^[0-9a-f]{64}$/.test(row.token_hash) || !Number.isSafeInteger(row.expires_at))
        throw Error("Invalid credential routing record.");
      return `INSERT INTO mcp_routes(kind,digest,workspace,expires) VALUES('token','${row.token_hash}','${slot.id}',${row.expires_at}) ON CONFLICT(kind,digest) DO NOTHING;`;
    });
    if (sql.length) {
      const file = join(directory, "routes.sql");
      await writeFile(file, sql.join("\n"), { mode: 0o600 });
      run(["d1", "execute", "CONTROL", "--remote", "--config", resolve(configs, "portal.json"), "--file", file, "--json"]);
    }
    console.log(`Indexed ${rows.length} existing MCP credentials for ${slot.id}.`);
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}
