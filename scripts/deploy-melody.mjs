// Install the pinned upstream server as a private Worker for Finance.
import { execFileSync } from "node:child_process";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const dir = join(root, ".private/launch");
const source = join(dir, "melody-source");
const server = join(source, "server");
const pin = "da208cd90545b7f5b42891d7e3dd83f91c5e984f";
const name = "phooey-finance-melody";
const app = "https://finance.phooey.foo";
const config = join(server, "phooey.wrangler.json");
const overlay = join(root, "hosted/melody");
const run = (cmd, args, cwd, capture = false) => execFileSync(cmd, args, {
  cwd, encoding: "utf8", stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
});
const git = (args, capture) => run("git", args, source, capture);
const wr = (args, cfg, capture) => run(join(root, "node_modules/.bin/wrangler"), [...args, "--config", cfg], root, capture);
const read = (file) => JSON.parse(readFileSync(file, "utf8"));

function install() {
  mkdirSync(source, { recursive: true, mode: 0o700 });
  if (!existsSync(join(source, ".git"))) git(["init", "--quiet"]);
  if (runGitCheck(["cat-file", "-e", pin]) === false)
    git(["fetch", "--depth=1", "https://github.com/ValueMelody/melody-auth.git", pin]);
  git(["checkout", "--quiet", "--detach", pin]);
  const patches = ["verified-profile.patch", "finance-auth.patch", "finance-signup.patch"];
  // This is a generated upstream checkout. Restore only overlay targets before
  // applying in order so edits to an earlier patch remain repeatable.
  const targets = [...new Set(patches.flatMap(name =>
    [...readFileSync(join(overlay, name), "utf8").matchAll(/^--- a\/(\S+)/gm)].map(match => match[1])
  ))];
  git(["restore", "--source", pin, "--worktree", "--", ...targets]);
  for (const name of patches) {
    const patch = join(overlay, name);
    git(["apply", patch]);
  }
  copyFileSync(join(overlay, "FinanceMethods.tsx"), join(server, "src/pages/blocks/FinanceMethods.tsx"));
  copyFileSync(join(overlay, "finance.css"), join(server, "src/pages/finance.css"));
  copyFileSync(join(overlay, "FinanceSignup.test.ts"), join(server, "src/__tests__/FinanceSignup.test.ts"));
  run("npm", ["ci", "--no-audit", "--no-fund"], server);
  run("npm", ["run", "build"], server);
}
function runGitCheck(args) {
  try { execFileSync("git", args, { cwd: source, stdio: "ignore" }); return true; }
  catch { return false; }
}
function deploy() {
  const providers = read(join(dir, "providers.json"));
  for (const field of ["googleLoginClient", "appleLoginClient", "APPLE_LOGIN_SECRET", "RESEND_SENDER_ADDRESS", "RESEND_API_KEY"])
    if (!providers[field]?.trim()) throw Error("Set " + field + " in .private/launch/providers.json.");
  install();
  const gateway = join(dir, "portal.json");
  const listD1 = () => JSON.parse(wr(["d1", "list", "--json"], gateway, true));
  const control = read(join(dir, "resources.json")).controlDatabaseId;
  if (!listD1().some(d => d.name === "phooey-hosted-control" && d.uuid === control))
    throw Error("Select the Cloudflare account that owns the Finance control database.");
  let db = listD1().find(d => d.name === name);
  if (!db) {
    wr(["d1", "create", name, "--no-update-config"], gateway);
    db = listD1().find(d => d.name === name);
  }
  const listKV = () => JSON.parse(wr(["kv", "namespace", "list"], gateway, true));
  let kv = listKV().find(k => k.title === name);
  if (!kv) {
    wr(["kv", "namespace", "create", name, "--no-update-config"], gateway);
    kv = listKV().find(k => k.title === name);
  }
  if (!db?.uuid || !kv?.id) throw Error("Could not resolve the Melody D1 database and KV namespace.");

  const toml = createRequire(join(server, "package.json"))("toml");
  const cfg = toml.parse(readFileSync(join(server, "wrangler.toml"), "utf8"));
  Object.assign(cfg, { name, main: "src/index.tsx", workers_dev: false, preview_urls: false, routes: [] });
  Object.assign(cfg.vars, {
    ENVIRONMENT: "prod", AUTH_SERVER_URL: app, SERVER_SESSION_EXPIRES_IN: 0,
    GOOGLE_AUTH_CLIENT_ID: providers.googleLoginClient, APPLE_AUTH_CLIENT_ID: providers.appleLoginClient,
    ENABLE_NAMES: false, NAMES_IS_REQUIRED: false, ENABLE_SIGN_UP: true, ENABLE_PASSWORD_SIGN_IN: true, ENABLE_PASSWORD_RESET: true,
    ALLOW_PASSKEY_ENROLLMENT: false, OTP_MFA_IS_REQUIRED: false, EMAIL_MFA_IS_REQUIRED: false, SMS_MFA_IS_REQUIRED: false,
    AUTHORIZATION_CODE_EXPIRES_IN: 600, ENABLE_MFA_REMEMBER_DEVICE: false,
    EMAIL_PROVIDER_NAME: "resend", RESEND_SENDER_ADDRESS: providers.RESEND_SENDER_ADDRESS,
    ENABLE_EMAIL_VERIFICATION: true, ENABLE_USER_APP_CONSENT: false, ENFORCE_ONE_MFA_ENROLLMENT: [],
    COMPANY_LOGO_URL: app + "/business/assets/wordmark.svg",
    TERMS_LINK: "https://getfinance.phooey.foo/business/terms/",
    PRIVACY_POLICY_LINK: "https://getfinance.phooey.foo/business/privacy/",
  });
  cfg.kv_namespaces[0].id = kv.id;
  Object.assign(cfg.d1_databases[0], { database_name: name, database_id: db.uuid });
  writeFileSync(config, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  wr(["d1", "migrations", "apply", "DB", "--remote"], config);
  wr(["d1", "execute", "DB", "--remote", "--file", resolve(root, "hosted/melody/client.sql")], config);
  const temp = mkdtempSync(join(dir, "melody-release-"));
  try {
    const keys = ["sessionSecret", "jwtPrivateSecret", "jwtPublicSecret"];
    const present = keys.filter(key => {
      const list = wr(["kv", "key", "list", "--prefix", key, "--binding", "KV", "--remote"], config, true);
      return JSON.parse(list).some(item => item.name === key);
    });
    if (present.length !== keys.length) {
      if (present.length) throw Error("Restore the missing Melody keys before deploying.");
      const pair = generateKeyPairSync("rsa", {
        modulusLength: 2048, privateKeyEncoding: { format: "pem", type: "pkcs8" },
        publicKeyEncoding: { format: "pem", type: "spki" },
      });
      const values = [randomBytes(32).toString("hex"), pair.privateKey, pair.publicKey];
      const keyFile = join(temp, "init.json");
      writeFileSync(keyFile, JSON.stringify(keys.map((key, i) => ({ key, value: values[i] }))), { mode: 0o600 });
      wr(["kv", "bulk", "put", keyFile, "--binding", "KV", "--remote"], config);
    }
    const secrets = join(temp, "provider.json");
    writeFileSync(secrets, JSON.stringify({ APPLE_AUTH_CLIENT_SECRET: providers.APPLE_LOGIN_SECRET, RESEND_API_KEY: providers.RESEND_API_KEY }), { mode: 0o600 });
    wr(["deploy", "--minify", "--secrets-file", secrets], config);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}
try {
  if (process.argv[2] === "build") install();
  else if (process.argv[2] === "deploy") deploy();
  else throw Error("Use build or deploy.");
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
}
