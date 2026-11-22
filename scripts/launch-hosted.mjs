// Production rollout for the provisioned commercial workspace pool.
import { randomBytes, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const dir = join(root, ".private/launch");
const market = "https://getfinance.phooey.foo";
const app = "https://finance.phooey.foo";
const inputs = join(dir, "providers.json");
const resources = join(dir, "resources.json");
const cfg = (name) => join(dir, name + ".json");
const secrets = [
  "STRIPE_SECRET",
  "STRIPE_WEBHOOK_SECRET",
];

function run(cmd, args, capture = false) {
  const r = spawnSync(cmd, args, {
    cwd: root,
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
  });
  if (r.error) throw r.error;
  if (r.status !== 0)
    throw Error(args[0] + " failed. Resolve the error above and rerun.");
  return r.stdout;
}
const wrangler = (args, capture) =>
  run(join(root, "node_modules/.bin/wrangler"), args, capture);
const read = async (file) => JSON.parse(await readFile(file, "utf8"));
async function writePrivate(file, value, exclusive = false) {
  const dest = exclusive ? file : file + "." + randomUUID();
  try {
    await writeFile(dest, JSON.stringify(value, null, 2) + "\n", {
      flag: "wx",
      mode: 0o600,
    });
  } catch (e) {
    if (exclusive && e.code === "EEXIST") return;
    throw e;
  }
  if (!exclusive) await rename(dest, file);
}
function configure() {
  run(process.execPath, ["scripts/configure-hosted.mjs", resources, dir]);
}
async function verifyRedirect(origin, expected) {
  const res = await fetch(origin, {
    redirect: "manual",
    signal: AbortSignal.timeout(15000),
  });
  if (
    ![301, 302, 303, 307, 308].includes(res.status) ||
    new URL(res.headers.get("location") || origin, origin).href !== expected
  )
    throw Error("Unexpected signed-out redirect at " + origin);
}
async function main() {
  const mode = process.argv[2] || "prepare";
  if (!["prepare", "site", "deploy", "cutover"].includes(mode))
    throw Error("Use prepare, site, deploy, or cutover.");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  let m;
  try {
    m = await read(resources);
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
    const old = await read(join(root, ".private/hosted-resources.json"));
    await writePrivate(
      resources,
      { ...old, portalOrigin: market, appOrigin: app, attachAppDomain: false },
      true,
    );
    m = await read(resources);
  }
  if (m.portalOrigin !== market || m.appOrigin !== app)
    throw Error("Unexpected public domains in the launch manifest.");
  m.invoicerOrigin = "https://invoicer.phooey.foo";
  m.invoicerMarketingOrigin = "https://getinvoicer.phooey.foo";
  await writePrivate(resources,m);
  // Validate IDs and origins before using slot identifiers in local filenames or provisioning D1.
  configure();
  const providerDefaults = {
    googleLoginClient: m.googleLoginClient || "",
    appleLoginClient: m.appleLoginClient || "",
    APPLE_LOGIN_SECRET: "",
    RESEND_API_KEY: "",
    RESEND_SENDER_ADDRESS: "",
    stripePrice: m.stripePrice || "",
  };
  for (const name of secrets) providerDefaults[name] = "";
  await writePrivate(inputs, providerDefaults, true);
  const saved = await read(inputs);
  if (Object.keys(providerDefaults).some(key => !(key in saved)))
    await writePrivate(inputs, { ...providerDefaults, ...saved });
  const factorKeyFile = cfg("factor-encryption");
  if (!m.factorEncryptionConfigured)
    await writePrivate(factorKeyFile, { ENCRYPTION_KEY: randomBytes(32).toString("base64") }, true);
  const { ENCRYPTION_KEY } = await read(factorKeyFile);
  if (typeof ENCRYPTION_KEY !== "string" || Buffer.from(ENCRYPTION_KEY, "base64").length !== 32)
    throw Error("Restore the Finance factor encryption key from your private backup.");
  for (const slot of m.slots) {
    const keyFile = cfg(slot.id + "-invoice-secret");
    await writePrivate(
      keyFile,
      { ADMIN_KEY: randomBytes(32).toString("hex") },
      true,
    );
    const key = (await read(keyFile)).ADMIN_KEY;
    if (typeof key !== "string" || key.length < 32)
      throw Error("Invalid invoice service key for " + slot.id);
    await writePrivate(cfg(slot.id + "-workspace-secret"), {
      INVOICER_KEY: key,
    });
  }
  if (mode === "prepare") {
    console.log(
      "Domain configs and service keys are ready. Fill in .private/launch/providers.json.",
    );
    return;
  }
  const databases = () =>
    JSON.parse(
      wrangler(["d1", "list", "--json", "--config", cfg("portal")], true),
    );
  let dbs = databases();
  const bound = (name, id) => dbs.some((d) => d.name === name && d.uuid === id);
  if (!bound("phooey-hosted-control", m.controlDatabaseId))
    throw Error(
      "The signed-in account does not contain the configured control database.",
    );
  const migrate = (name, binding) =>
    wrangler([
      "d1",
      "migrations",
      "apply",
      binding,
      "--remote",
      "--config",
      cfg(name),
    ]);
  if (mode === "site") {
    if (
      m.melodyClient ||
      m.attachAppDomain ||
      m.stripePrice ||
      m.appleLoginClient ||
      m.googleLoginClient
    )
      throw Error(
        "This portal has a paid release configured. Use deploy to update it.",
      );
    const existing = JSON.parse(
      wrangler(
        ["secret", "list", "--format", "json", "--config", cfg("portal")],
        true,
      ),
    );
    if (existing.some((s) => secrets.includes(s.name)))
      throw Error(
        "The existing portal has payment or login secrets. Use deploy with its provider configuration.",
      );
    run("npm", ["run", "build"]);
    migrate("portal", "CONTROL");
    wrangler(["deploy", "--config", cfg("portal")]);
    await verifyRedirect(market + "/cloud/signup", app + "/cloud/signup");
    console.log("Marketing pages are live on getfinance.phooey.foo.");
    return;
  }
  const p = await read(inputs);
  const missing = Object.keys(providerDefaults).filter(
    (k) => typeof p[k] !== "string" || !p[k].trim(),
  );
  if (missing.length)
    throw Error(
      "Fill in .private/launch/providers.json: " + missing.join(", "),
    );
  const portalSecrets = Object.fromEntries(secrets.map((k) => [k, p[k]]));
  await writePrivate(cfg("portal-secrets"), { ...portalSecrets, ENCRYPTION_KEY });
  if (mode === "cutover" && m.melodyClient !== "phooey-finance")
    throw Error("Deploy the Melody-backed bundle before moving the app domain.");
  Object.assign(m, {
    melodyClient: "phooey-finance",
    factorEncryptionConfigured: true,
    googleLoginClient: "",
    appleLoginClient: "",
    stripePrice: p.stripePrice,
  });
  if (mode === "cutover") {
    await verifyRedirect(market + "/cloud/start", app + "/cloud/start");
    const liveSecrets = JSON.parse(wrangler(
      ["secret", "list", "--format", "json", "--config", cfg("portal")], true,
    ));
    if (!secrets.every(name => liveSecrets.some(secret => secret.name === name)))
      throw Error("Deploy the paid bundle before moving the app domain.");
  }
  const price = await fetch(
    "https://api.stripe.com/v1/prices/" + encodeURIComponent(p.stripePrice),
    {
      headers: { Authorization: "Bearer " + p.STRIPE_SECRET },
      signal: AbortSignal.timeout(15000),
      redirect: "error",
    },
  );
  if (!price.ok) throw Error("Stripe could not verify the configured price.");
  const item = await price.json();
  if (
    !item.active ||
    !item.livemode ||
    item.currency !== "usd" ||
    item.unit_amount !== 2900 ||
    item.recurring?.interval !== "year" ||
    item.recurring.interval_count !== 1
  )
    throw Error("The live bundle requires an active USD 29.00 annual price.");
  for (const slot of m.slots) {
    const prefix = "phooey-hosted-" + slot.id;
    if (!bound(prefix + "-ledger", slot.databaseId))
      throw Error("Ledger database mismatch for " + slot.id);
    const name = prefix + "-invoicer";
    if (
      !dbs.some((d) => d.name === name) &&
      !slot.invoiceDatabaseId &&
      mode === "deploy"
    ) {
      wrangler([
        "d1",
        "create",
        name,
        "--config",
        cfg("portal"),
        "--no-update-config",
      ]);
      dbs = databases();
    }
    const actual = dbs.find((d) => d.name === name)?.uuid;
    if (
      !actual ||
      (slot.invoiceDatabaseId && slot.invoiceDatabaseId !== actual)
    )
      throw Error("Invoice database mismatch for " + slot.id);
    slot.invoiceDatabaseId = actual;
    const liveSecrets = JSON.parse(
      wrangler(
        ["secret", "list", "--format", "json", "--config", cfg(slot.id)],
        true,
      ),
    );
    if (!liveSecrets.some((s) => s.name === "ENCRYPTION_KEY"))
      throw Error(
        "Restore the existing ENCRYPTION_KEY for " +
          slot.id +
          " before deploying.",
      );
  }
  if (mode === "deploy") run(process.execPath, ["scripts/deploy-melody.mjs", "deploy"]);
  await writePrivate(resources, m);
  configure();
  run("npm", ["--prefix", "invoicer", "run", "build:hosted"]);
  run("npm", ["run", "build"]);
  if (mode === "deploy") {
    migrate("portal", "CONTROL");
    for (const slot of m.slots) {
      const invoice = slot.id + "-invoicer";
      migrate(slot.id, "DB");
      migrate(invoice, "DB");
      wrangler([
        "deploy",
        "--config",
        cfg(invoice),
        "--secrets-file",
        cfg(slot.id + "-invoice-secret"),
      ]);
      wrangler([
        "deploy",
        "--config",
        cfg(slot.id),
        "--secrets-file",
        cfg(slot.id + "-workspace-secret"),
      ]);
    }
    wrangler([
      "d1",
      "execute",
      "CONTROL",
      "--remote",
      "--config",
      cfg("portal"),
      "--file",
      join(dir, "register.sql"),
    ]);
    run(process.execPath, ["scripts/backfill-mcp-routes.mjs", resources, dir]);
  }
  if (mode === "cutover") {
    const portal = await read(cfg("portal"));
    if (!portal.routes.some((r) => r.pattern === new URL(app).hostname))
      portal.routes.push({
        pattern: new URL(app).hostname,
        custom_domain: true,
      });
    await writePrivate(cfg("portal"), portal);
  }
  wrangler([
    "deploy",
    "--config",
    cfg("portal"),
    "--secrets-file",
    cfg("portal-secrets"),
  ]);
  if (mode === "cutover") {
    m.attachAppDomain = true;
    await writePrivate(resources, m);
  }
  const landing = await fetch(market + "/", {
    signal: AbortSignal.timeout(15000),
  });
  const landingHtml = await landing.text();
  if (!landing.ok || !landingHtml.includes(app + "/cloud/signup") || !landingHtml.includes("14-day free trial"))
    throw Error("Check the free trial signup link on the marketing homepage.");
  await verifyRedirect(market + "/cloud/start", app + "/cloud/start");
  if (m.attachAppDomain) {
    await verifyRedirect(app + "/", market + "/");
    const signup = await fetch(app + "/cloud/signup", {
      redirect: "manual", signal: AbortSignal.timeout(15000),
    });
    const signupUrl = new URL(signup.headers.get("location") || app, app);
    if (signupUrl.origin + signupUrl.pathname !== app + "/oauth2/v1/authorize" ||
        signupUrl.searchParams.get("step") !== "sign_up")
      throw Error("Check the Finance account creation link.");
    const signIn = await fetch(app + "/cloud/start", {
      redirect: "manual", signal: AbortSignal.timeout(15000),
    });
    const authorize = new URL(signIn.headers.get("location") || app, app);
    if (authorize.origin + authorize.pathname !== app + "/oauth2/v1/authorize" ||
        authorize.searchParams.get("redirect_uri") !== app + "/cloud/callback")
      throw Error("Check the Finance Melody authorization URL.");
    const view = await fetch(authorize, { redirect: "manual", signal: AbortSignal.timeout(15000) });
    const target = new URL(view.headers.get("location") || app, authorize);
    if (target.origin + target.pathname !== app + "/identity/v1/view/authorize")
      throw Error("Check the Finance Melody sign-in page.");
    const form = await fetch(target, { redirect: "error", signal: AbortSignal.timeout(15000) });
    const html = await form.text();
    if (!form.ok || ![p.googleLoginClient, p.appleLoginClient].every(id => html.includes(id)))
      throw Error("Check Google and Apple on the Finance Melody sign-in page.");
  }
  console.log(
    m.attachAppDomain
      ? "Both public domains responded as expected."
      : "Public portal deployed. finance.phooey.foo is ready for the separate cutover.",
  );
}
main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
