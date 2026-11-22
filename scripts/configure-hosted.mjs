// Generate deployment configs only. This command never creates resources, uploads secrets, or deploys.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
const file = process.argv[2];
if (!file)
  throw Error(
    "Pass the path to your private hosted resource manifest. See docs/hosted-launch.md.",
  );
const m = JSON.parse(await readFile(file, "utf8"));
const origin = (value) => {
  const u = new URL(value);
  if (u.protocol !== "https:" || u.origin !== value)
    throw Error("Use a canonical HTTPS origin without a path.");
  return u.origin;
};
const base = JSON.parse(
  await readFile(resolve(root, "hosted/worker.example.json"), "utf8"),
);
const out = resolve(process.argv[3] ?? resolve(root, ".private/hosted"));
await mkdir(out, { recursive: true, mode: 0o700 });
base.main = resolve(root, "src/hosted/worker.ts");
base.assets.directory = resolve(root, "dist/client");
delete base.$schema;
const seen = new Set(),
  origins = new Set(),
  dbIds = new Set();
const uuid = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
function checkId(value) {
  value = String(value).toLowerCase();
  if (
    !uuid.test(value) ||
    dbIds.has(value) ||
    value === "a042ef56-cb1a-402a-b55b-375b31c08688"
  )
    throw Error("Each binding needs a distinct commercial database ID.");
  dbIds.add(value);
}
checkId(m.controlDatabaseId);
Object.assign(base.vars, {
  PORTAL_ORIGIN: origin(m.portalOrigin),
  APP_ORIGIN: m.appOrigin ? origin(m.appOrigin) : "",
  INVOICER_ORIGIN: m.invoicerOrigin ? origin(m.invoicerOrigin) : "",
  INVOICER_MARKETING_ORIGIN: m.invoicerMarketingOrigin ? origin(m.invoicerMarketingOrigin) : "",
  CANONICAL_APP: m.appOrigin ? "true" : "false",
  GOOGLE_LOGIN_CLIENT: m.googleLoginClient || "",
  APPLE_LOGIN_CLIENT: m.appleLoginClient || "",
  IDENTITY_ORIGIN: m.identityOrigin ? origin(m.identityOrigin) : "",
  IDENTITY_CLIENT: m.identityClient,
  STRIPE_PRICE: m.stripePrice,
  SUPPORT_EMAIL: m.supportEmail || "",
});
base.vars.STRIPE_AUTOMATIC_TAX = m.automaticTax === true ? "true" : "false";
Object.assign(base.d1_databases[0], {
  database_id: m.controlDatabaseId,
  migrations_dir: resolve(root, "hosted/migrations"),
});
if (!m.slots?.length) throw Error("Configure at least one beta workspace.");
const configs = [];

function register(name, url, config) {
  if (url === "https://finance.phooey.foo")
    throw Error("Use a new commercial hostname for this deployment.");
  if (origins.has(url)) throw Error("Workspace origins must be distinct.");
  origins.add(url);
  config.name = "phooey-hosted-" + name;
  if (new URL(url).hostname.endsWith(".workers.dev")) {
    if (!new URL(url).hostname.startsWith(config.name + "."))
      throw Error("The workers.dev address must match the Worker name.");
    config.workers_dev = true;
  } else
    config.routes = [{ pattern: new URL(url).hostname, custom_domain: true }];
  configs.push([name, config]);
}
register("portal", m.portalOrigin, structuredClone(base));
if (m.melodyClient) {
  if (!m.appOrigin) throw Error("Configure the Finance app domain for Melody.");
  const gateway = configs[0][1];
  gateway.vars.MELODY_CLIENT = m.melodyClient;
  gateway.services = [{ binding: "MELODY", service: "phooey-finance-melody" }];
}
if (m.appOrigin) {
  const app = origin(m.appOrigin);
  if (origins.has(app)) throw Error("Use separate marketing and app domains.");
  origins.add(app);
  if (m.attachAppDomain !== false)
    (configs[0][1].routes ??= []).push({ pattern: new URL(app).hostname, custom_domain: true });
}
for (const host of [m.invoicerOrigin,m.invoicerMarketingOrigin].filter(Boolean)) {
  if (origins.has(origin(host))) throw Error("Use distinct Finance and Invoicer domains.");
  origins.add(origin(host));
  (configs[0][1].routes ??= []).push({pattern:new URL(origin(host)).hostname,custom_domain:true});
}
const registry = [];
for (const slot of m.slots) {
  if (
    !/^[a-z][a-z0-9-]{0,23}$/.test(slot.id) ||
    slot.id === "portal" ||
    seen.has(slot.id)
  )
    throw Error("Invalid or duplicated workspace ID.");
  seen.add(slot.id);
  checkId(slot.databaseId);
  const config = structuredClone(base),
    prefix = "phooey-hosted-" + slot.id;
  config.vars.WORKSPACE_ID = slot.id;
  if (m.appOrigin) {
    config.vars.CANONICAL_APP = "true";
    (configs[0][1].services ??= []).push({
      binding: "WORKSPACE_SERVICE_" + slot.id.replaceAll("-", "_"),
      service: prefix,
    });
  }
  config.d1_databases.push({
    binding: "DB",
    database_name: prefix + "-ledger",
    database_id: slot.databaseId,
    migrations_dir: resolve(root, "migrations"),
  });
  config.triggers.crons.push("47 6,18 * * *");
  config.r2_buckets = [{ binding: "FILES", bucket_name: prefix + "-files" }];
  config.queues = {
    producers: [{ binding: "JOBS", queue: prefix + "-jobs" }],
    consumers: [{ queue: prefix + "-jobs", max_batch_size: 1, max_retries: 3 }],
  };
  if (slot.invoiceDatabaseId) {
    checkId(slot.invoiceDatabaseId);
    const invoiceName = prefix + "-invoicer";
    config.services = [{ binding: "INVOICER", service: invoiceName }];
    if (!(configs[0][1].services || []).some(s => s.binding === "INVOICER_ASSETS")) (configs[0][1].services ??= []).push({binding:"INVOICER_ASSETS",service:invoiceName});
    configs.push([slot.id + "-invoicer", {
      name: invoiceName, main: resolve(root, "invoicer/src/worker/index.ts"),
      compatibility_date: base.compatibility_date, compatibility_flags: base.compatibility_flags,
      workers_dev: false, preview_urls: false,
      vars: { BUNDLE_PREFIX: m.invoicerOrigin ? `/w/${slot.id}` : "/invoicer", KEY_NAMESPACE: slot.id, PUBLIC_ORIGIN: m.invoicerOrigin || "" },
      assets: { ...base.assets, directory: resolve(root, "invoicer/dist-hosted") },
      d1_databases: [{ binding: "DB", database_name: invoiceName, database_id: slot.invoiceDatabaseId, migrations_dir: resolve(root, "invoicer/migrations") }]
    }]);
  }
  register(slot.id, origin(slot.origin), config);
  registry.push(
    "INSERT INTO workspaces(id,origin) VALUES('" +
      slot.id +
      "','" +
      slot.origin.replaceAll("'", "''") +
      "') ON CONFLICT(id) DO NOTHING;",
  );
}
for (const [name, config] of configs)
  await writeFile(
    resolve(out, name + ".json"),
    JSON.stringify(config, null, 2) + "\n",
    { mode: 0o600 },
  );
await writeFile(resolve(out, "register.sql"), registry.join("\n") + "\n", {
  mode: 0o600,
});
console.log(
  "Created private portal and workspace configurations. Follow the migration and launch steps in docs/hosted-launch.md.",
);
