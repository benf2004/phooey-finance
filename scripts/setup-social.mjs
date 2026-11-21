import { randomUUID } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { importPKCS8, SignJWT } from "jose";

const file = ".private/launch/providers.json";
const [provider, keyPath, team, kid, service] = process.argv.slice(2);
async function setup() {
  const config = JSON.parse(await readFile(file, "utf8"));
  if (provider === "google" && keyPath) {
    const { web } = JSON.parse(await readFile(keyPath, "utf8"));
    if (
      !web?.client_id ||
      !web.javascript_origins?.includes("https://finance.phooey.foo")
    )
      throw Error(
        "Download the Web application client JSON after adding https://finance.phooey.foo as an authorized JavaScript origin.",
      );
    config.googleLoginClient = web.client_id;

  } else if (
    provider === "apple" &&
    keyPath &&
    /^[A-Z0-9]{10}$/.test(team ?? "") &&
    /^[A-Z0-9]{10}$/.test(kid ?? "") &&
    service
  ) {
    const key = await importPKCS8(await readFile(keyPath, "utf8"), "ES256");
    const expiry = Math.floor(Date.now() / 1000) + 180 * 86400;
    config.appleLoginClient = service;
    config.APPLE_LOGIN_SECRET = await new SignJWT({})
      .setProtectedHeader({ alg: "ES256", kid })
      .setIssuer(team)
      .setSubject(service)
      .setAudience("https://appleid.apple.com")
      .setIssuedAt()
      .setExpirationTime(expiry)
      .sign(key);
    console.log(
      "Apple credential expires on " +
        new Date(expiry * 1000).toISOString().slice(0, 10) +
        ". Regenerate and deploy before this date.",
    );
  } else {
    throw Error(
      "Usage: node scripts/setup-social.mjs google CLIENT.json | apple KEY.p8 TEAM_ID KEY_ID SERVICES_ID",
    );
  }
  const temporary = file + "." + randomUUID();
  await writeFile(temporary, JSON.stringify(config, null, 2) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
  await rename(temporary, file);
  console.log("Saved " + provider + " settings in " + file);
}
setup().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
