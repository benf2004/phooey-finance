import { z } from "zod";
import { assert } from "../server/util";
import {
  hasAccess,
  challenge,
  consume,
  cookie,
  readCookie,
  redirect,
  workspace,
  type Customer,
  type HostedEnv,
} from "./control";
import { rateLimit } from "../server/auth";

const proof = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
async function digest(value: string) {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
export async function beginMobile(env: HostedEnv, req: Request) {
  const query = new URL(req.url).searchParams;
  await rateLimit(
    env.CONTROL,
    "ios:" + (req.headers.get("CF-Connecting-IP") || "local"),
    40,
    900,
  );
  const pending = await challenge(
    env,
    "mobile-browser",
    {
      proof: proof.parse(query.get("challenge")),
      state: proof.parse(query.get("state")),
    },
    600,
  );
  return redirect("/cloud/account", cookie("mobile", pending, 600));
}
export async function authorizeMobile(
  env: HostedEnv,
  req: Request,
  c: Customer,
) {
  const slot = await workspace(env, c.id);
  assert(slot && hasAccess(c), 403, "An active workspace is required.");
  const pending = await consume(
    env,
    "mobile-browser",
    readCookie(req, "mobile"),
  );
  const code = await challenge(
    env,
    "mobile-token:" + pending.proof,
    { customer: c.id, origin: slot.origin },
    90,
  );
  return redirect(
    "phooeyfinance://signin?" +
      new URLSearchParams({ code, state: pending.state }),
    cookie("mobile", "", 0),
  );
}
export async function exchangeMobile(env: HostedEnv, req: Request) {
  const { code, verifier } = z
    .object({ code: proof, verifier: proof })
    .parse(await req.json());
  const data = await consume(
    env,
    "mobile-token:" + (await digest(verifier)),
    code,
  );
  const ticket = await challenge(
    env,
    "mobile-workspace:" + data.origin,
    { customer: data.customer },
    60,
  );
  return Response.json(
    { origin: data.origin, ticket },
    { headers: { "Cache-Control": "no-store" } },
  );
}
