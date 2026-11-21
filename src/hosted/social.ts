import { createRemoteJWKSet, jwtVerify } from "jose";
import { z } from "zod";
import { rateLimit } from "../server/auth";
import { assert, randomToken } from "../server/util";
import {
  challenge,
  consume,
  cookie,
  readCookie,
  redirect,
  portal,
  completeSignIn,
  type HostedEnv,
} from "./control";

const providers = {
  apple: {
    authorize: "https://appleid.apple.com/auth/authorize",
    token: "https://appleid.apple.com/auth/token",
    keys: createRemoteJWKSet(new URL("https://appleid.apple.com/auth/keys")),
    issuer: "https://appleid.apple.com",
  },
  google: {
    authorize: "https://accounts.google.com/o/oauth2/v2/auth",
    token: "https://oauth2.googleapis.com/token",
    keys: createRemoteJWKSet(
      new URL("https://www.googleapis.com/oauth2/v3/certs"),
    ),
    issuer: "https://accounts.google.com",
  },
};
type Provider = keyof typeof providers;
function credentials(env: HostedEnv, provider: Provider) {
  return provider === "apple"
    ? ([env.APPLE_LOGIN_CLIENT, env.APPLE_LOGIN_SECRET] as const)
    : ([env.GOOGLE_LOGIN_CLIENT, env.GOOGLE_LOGIN_SECRET] as const);
}
export function socialProviders(env: HostedEnv) {
  return (["google", "apple"] as const).filter((p) =>
    credentials(env, p).every(Boolean),
  );
}
function callback(env: HostedEnv, provider: Provider) {
  return portal(env) + "/cloud/social/" + provider + "/callback";
}
export async function startSocial(
  env: HostedEnv,
  req: Request,
  provider: Provider,
) {
  const [client, secret] = credentials(env, provider);
  assert(client && secret, 503, "This sign-in provider is unavailable.");
  await rateLimit(
    env.CONTROL,
    "social:" + (req.headers.get("CF-Connecting-IP") || "local"),
    40,
    900,
  );
  const nonce = randomToken();
  const state = await challenge(env, "social:" + provider, { nonce });
  const url = new URL(providers[provider].authorize);
  url.search = new URLSearchParams({
    client_id: client,
    response_type: "code",
    scope: provider === "apple" ? "email" : "openid email",
    redirect_uri: callback(env, provider),
    state,
    nonce,
  }).toString();
  let stateCookie = cookie("social_" + provider, state, 600);
  if (provider === "apple") {
    url.searchParams.set("response_mode", "form_post");
    stateCookie = stateCookie.replace("SameSite=Lax", "SameSite=None");
  }
  return redirect(url.href, stateCookie);
}
export async function finishSocial(
  env: HostedEnv,
  req: Request,
  provider: Provider,
) {
  const [client, secret] = credentials(env, provider);
  assert(client && secret, 503, "This sign-in provider is unavailable.");
  const params =
    provider === "apple" ? await req.formData() : new URL(req.url).searchParams;
  const state = params.get("state");
  assert(
    typeof state === "string" &&
      state.length === 43 &&
      readCookie(req, "social_" + provider) === state,
    400,
    "Restart sign-in in this browser.",
  );
  const { nonce } = await consume(env, "social:" + provider, state);
  const code = params.get("code");
  assert(
    typeof code === "string" && code.length > 0,
    400,
    "Sign-in was cancelled.",
  );
  const config = providers[provider];
  const exchange = await fetch(config.token, {
    method: "POST",
    redirect: "error",
    body: new URLSearchParams({
      client_id: client,
      client_secret: secret,
      code,
      grant_type: "authorization_code",
      redirect_uri: callback(env, provider),
    }),
  });
  assert(exchange.ok, 401, "Sign-in expired. Please try again.");
  const { id_token } = z
    .object({ id_token: z.string() })
    .parse(await exchange.json());
  const verified = await jwtVerify(id_token, config.keys, {
    algorithms: ["RS256"],
    audience: client,
    issuer: config.issuer,
    requiredClaims: ["exp", "sub", "iat", "nonce"],
  }).catch(() => null);
  assert(
    verified && verified.payload.nonce === nonce,
    401,
    "Could not verify sign-in.",
  );
  const p = verified.payload;
  assert(
    typeof p.sub === "string" &&
      p.sub &&
      (p.email_verified === true || p.email_verified === "true"),
    403,
    "A verified email is required.",
  );
  const result = await completeSignIn(
    env,
    config.issuer + "|" + p.sub,
    z.email().parse(p.email),
  );
  result.headers.append("Set-Cookie", cookie("social_" + provider, "", 0));
  return result;
}
