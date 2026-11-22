import { afterAll, beforeAll, expect, it } from "vitest";
import {
  Miniflare,
  convertV4MiniflareOptions,
  type V4WorkerOptions,
} from "miniflare";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { tinyPNG } from "./attachment-fixtures";
import { sampleTiller, tillerGroups } from "../src/shared/tiller";

const portal = "https://finance.example.test",
  first = "https://a.books.example.test",
  second = "https://b.books.example.test";
const timestamp = () => Math.floor(Date.now() / 1000);
const digest = (token: string) =>
  createHash("sha256").update(token).digest("hex");
type DB = Awaited<ReturnType<Miniflare["getD1Database"]>>;
const yearsEnd = timestamp() + 31536000;
const sheetIds = [0, 120]; // Customer-owned sheet occupying the first extension ID.
const markedSheetIds = new Set<number>();
let subscribed = true,

  identityVerified = true,
  paymentCalls = 0;
let control: DB,
  ledger: DB,
  portalWorker: Miniflare,
  a: Miniflare,
  b: Miniflare;
const instances: Miniflare[] = [];
function config(slot?: string): V4WorkerOptions {
  return {
    name: slot ?? "portal",
    routes: [(slot === "a" ? first : slot === "b" ? second : portal) + "/*"],
    modules: true,
    scriptPath: "dist/hosted/worker.js",
    compatibilityFlags: ["nodejs_compat"],
    compatibilityDate: "2026-11-17",
    d1Databases: { DB: "ledger-" + slot, CONTROL: "shared" },
    r2Buckets: { FILES: "files-" + slot },
    queueProducers: { JOBS: "jobs-" + slot },
    bindings: {
      PORTAL_ORIGIN: portal,
      IDENTITY_ORIGIN: "https://identity.test",
      IDENTITY_CLIENT: "client",
      IDENTITY_SECRET: "secret",
      GOOGLE_CLIENT: "client",
      GOOGLE_SECRET: "secret",
      STRIPE_PRICE: "price_29",
      STRIPE_SECRET: "test",
      STRIPE_WEBHOOK_SECRET: "whsec_test",
      ENCRYPTION_KEY: randomBytes(32).toString("base64"),
      ...(slot ? { WORKSPACE_ID: slot } : {}),
    },
    outboundService: async (req) => {
      const u = new URL(req.url),
        p = u.pathname;
      if (u.host === "identity.test")
        return Response.json(
          p === "/userinfo"
            ? {
                sub: "person-a",
                email: "a@example.test",
                email_verified: identityVerified,
              }
            : { access_token: "fake" },
        );
      if (u.host === "api.stripe.com") {
        if (p.includes("/prices/"))
          return Response.json({
            active: true,
            currency: "usd",
            unit_amount: 2900,
            recurring: { interval: "year", interval_count: 1 },
          });
        if (p === "/v1/customers") return Response.json({ id: "cus_a" });
        if (p.includes("/checkout/sessions")) {
          if (req.method === "POST") paymentCalls++;
          return Response.json({
            id: "cs_a",
            url: "https://checkout.stripe.test/session",
            status: "open",
            metadata: { offer: "finance-14-days" },
          });
        }
        if (p.includes("/subscriptions/"))
          return Response.json({
            id: "sub_a",
            customer: "cus_a",
            status: subscribed ? "active" : "canceled",
            ended_at: subscribed ? null : timestamp() - 1,
            current_period_end: yearsEnd,
            items: { data: [{ price: { id: "price_29" } }] },
          });
      }
      throw Error("Unexpected external request " + u.host + p);
    },
  };
}
async function schema(db: DB, dir: string) {
  for (const f of (await readdir(dir)).sort())
    await db.exec(
      (await readFile(dir + "/" + f, "utf8"))
        .replace(/^--.*$/gm, "")
        .replaceAll("\n", " "),
    );
}
async function call(
  mf: Miniflare,
  origin: string,
  path: string,
  options: {
    cookie?: string;
    data?: unknown;
    headers?: Record<string, string>;
    method?: string;
  } = {},
) {
  return mf.dispatchFetch(origin + path, {
    method: options.method ?? (options.data ? "POST" : "GET"),
    headers: {
      Origin: origin,
      ...(options.cookie ? { Cookie: options.cookie } : {}),
      ...options.headers,
    },
    body: options.data ? JSON.stringify(options.data) : undefined,
    redirect: "manual",
  });
}
async function body(r: Awaited<ReturnType<typeof call>>) {
  const data = (await r.json()) as any;
  expect(r.status, JSON.stringify(data)).toBe(200);
  return data;
}
async function seed(mf: Miniflare) {
  const db = await mf.getD1Database("CONTROL");
  await schema(db, "hosted/migrations");
  await db.exec(
    "INSERT INTO customers(id,email,subject,paid_until) VALUES('a','a@example.test','https://identity.test|person-a'," +
      yearsEnd +
      "),('b','b@example.test','person-b'," +
      yearsEnd +
      ");",
  );
  for (const [id, origin] of [
    ["a", first],
    ["b", second],
  ]) {
    await db
      .prepare("INSERT INTO workspaces VALUES(?,?,?)")
      .bind(id, origin, id)
      .run();
    await db
      .prepare("INSERT INTO sessions VALUES(?,?,?,?)")
      .bind(digest("session-" + id), id, origin + "#dashboard", yearsEnd)
      .run();
  }
  await db
    .prepare("INSERT INTO sessions VALUES(?,?,?,?)")
    .bind(digest("portal-session"), "a", portal, yearsEnd)
    .run();
  return db;
}
beforeAll(async () => {
  portalWorker =
    a =
    b =
      new Miniflare(
        convertV4MiniflareOptions({
          workers: [config(), config("a"), config("b")],
        }),
      );
  instances.push(a);
  control = await seed(portalWorker);
  for (const name of ["a", "b"]) {
    const db = await a.getD1Database("DB", name);
    await schema(db, "migrations");

  }
  ledger = await a.getD1Database("DB", "a");
});
afterAll(async () => {
  await Promise.all(instances.map((i) => i.dispose()));
});
const cookieA = "__Host-phooey_dashboard=session-a",
  cookieB = "__Host-phooey_dashboard=session-b";
it("binds identity state to the browser, rejects unverified email, and issues an audience-bound revocable session", async () => {
  async function start() {
    const res = await call(portalWorker, portal, "/cloud/start");
    return {
      state: new URL(res.headers.get("location")!).searchParams.get("state"),
      cookie: res.headers.get("set-cookie")!.split(";")[0],
    };
  }
  let startResult = await start();
  const path = "/cloud/callback?code=fixture&state=";
  expect(
    (await call(portalWorker, portal, path + startResult.state)).status,
  ).toBe(400);
  identityVerified = false;
  expect(
    (
      await call(portalWorker, portal, path + startResult.state, {
        cookie: startResult.cookie,
      })
    ).status,
  ).toBe(403);
  identityVerified = true;
  startResult = await start();
  const ok = await call(portalWorker, portal, path + startResult.state, {
    cookie: startResult.cookie,
  });
  expect(ok.status).toBe(303);
  expect(ok.headers.get("set-cookie")).toContain("HttpOnly");
  expect(
    (
      await call(portalWorker, portal, path + startResult.state, {
        cookie: startResult.cookie,
      })
    ).status,
  ).toBe(400);
});
it("hands off a portal purchase only to its own workspace and requested product session", async () => {
  const entry = await call(a, first, "/cloud/enter?view=dashboard");
  const target = new URL(entry.headers.get("location")!);
  const ticket = await call(
    portalWorker,
    portal,
    target.pathname + target.search,
    { cookie: "__Host-phooey_session=portal-session" },
  );
  const url = new URL(ticket.headers.get("location")!);
  const ok = await call(a, first, url.pathname + url.search, {
    cookie: entry.headers.get("set-cookie")!.split(";")[0],
  });
  expect(ok.headers.get("location")).toBe("/");
  expect(ok.headers.get("set-cookie")).toContain("__Host-phooey_dashboard=");
  const unauthorized = await call(
    portalWorker,
    portal,
    target.pathname + target.search.replace("slot=a", "slot=b"),
    { cookie: "__Host-phooey_session=portal-session" },
  );
  expect(unauthorized.status).toBe(403);
  expect((await call(a, first, url.pathname + url.search)).status).toBe(400);
});
it("keeps tenant API, attachment, export, and workbook grants private", async () => {
  for (const path of [
    "/api/session",
    "/api/accounts",
    "/api/backup",
    "/api/transactions/other/attachments",
    "/api/files/other",
  ]) {
    expect((await call(b, second, path, { cookie: cookieA })).status).toBe(401);
  }
  expect(
    (
      await call(a, "https://unknown.example.test", "/api/session", {
        cookie: cookieB,
      })
    ).status,
  ).toBe(404);
  expect(
    (
      await call(a, first, "/api/settings/password", {
        cookie: cookieA,
        data: {},
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await call(a, first, "/api/accounts", {
        cookie: cookieA,
        data: { name: "bad" },
        headers: { Origin: "https://unrelated.test" },
      })
    ).status,
  ).toBe(403);
  const session = await body(
    await call(a, first, "/api/session", { cookie: cookieA }),
  );
  expect(session.username).toBe("a@example.test");
  expect(
    await body(await call(b, second, "/api/accounts", { cookie: cookieB })),
  ).toEqual([]);
});
it("recovers a synthetic ledger, splits, and a receipt into a fresh isolated workspace", async () => {
  const account = await body(await call(a, first, "/api/accounts", {cookie: cookieA, data:{name:"Checking"}}));
  const tx = await body(await call(a, first, "/api/transactions", {cookie: cookieA, data:{account_id:account.id, posted:"2026-05-08",description:"Sample",amount:10000,type:"income",splits:[{amount:2500, category_id:null,type:"income"},{amount:7500,category_id:null,type:"income"}]}}));
  const endpoint = "/api/transactions/" + tx!.id + "/attachments";
  const upload = await a.dispatchFetch(first + endpoint, {
    method: "POST",
    headers: {
      Cookie: cookieA,
      Origin: first,
      "Content-Type": "image/png",
      "X-File-Name": "sample.png",
      "Idempotency-Key": crypto.randomUUID(),
    },
    body: tinyPNG,
  });
  const attachment = await body(upload);
  const snapshot = await body(
    await call(a, first, "/api/backup", { cookie: cookieA }),
  );
  expect(snapshot.tables.hosted_workbook).toBeUndefined();
  expect(
    (await call(b, second, endpoint + "/" + attachment.id, { cookie: cookieB }))
      .status,
  ).toBe(404);
  await body(
    await call(b, second, "/api/restore", { cookie: cookieB, data: snapshot }),
  );
  // Operator recovery additionally copies attachment metadata and the exact private object.
  const row = (await ledger
    .prepare("SELECT * FROM transaction_attachments WHERE id=?")
    .bind(attachment.id)
    .first()) as Record<string, string | number>;
  const keys = Object.keys(row),
    restored = await b.getD1Database("DB", "b");
  await restored
    .prepare(
      "INSERT INTO transaction_attachments(" +
        keys.join(",") +
        ") VALUES(" +
        keys.map(() => "?").join(",") +
        ")",
    )
    .bind(...Object.values(row))
    .run();
  const oldBucket = (await a.getR2Bucket("FILES", "a")) as unknown as R2Bucket,
    fresh = (await b.getR2Bucket("FILES", "b")) as unknown as R2Bucket;
  const object = await oldBucket.get(String(row.object_key));
  await fresh.put(String(row.object_key), await object!.arrayBuffer(), {
    httpMetadata: object!.httpMetadata,
  });
  const download = await call(b, second, endpoint + "/" + attachment.id, {
    cookie: cookieB,
  });
  expect(download.status).toBe(200);
  expect(new Uint8Array(await download.arrayBuffer())).toEqual(tinyPNG);
  const original = await body(
      await call(a, first, "/api/taxes/2026", { cookie: cookieA }),
    ),
    copy = await body(
      await call(b, second, "/api/taxes/2026", { cookie: cookieB }),
    );
  expect(copy.estimate).toEqual(original.estimate);
  expect(
    (
      await body(
        await call(b, second, "/api/transactions/" + tx!.id, {
          cookie: cookieB,
        }),
      )
    ).splits,
  ).toHaveLength(2);
});
it("reuses checkout, verifies webhook signatures and reconciles current subscription on redelivery", async () => {
  await control.prepare("UPDATE customers SET paid_until=0 WHERE id='a'").run();
  const cookie = "__Host-phooey_session=portal-session";
  for (let i = 0; i < 2; i++) {
    const checkout = await call(portalWorker, portal, "/cloud/checkout", {
      cookie,
      data: {},
    });
    expect(checkout.headers.get("location")).toBe(
      "https://checkout.stripe.test/session",
    );
  }
  expect(paymentCalls).toBe(1);
  const event = {
      type: "customer.subscription.updated",
      data: { object: { id: "sub_a" } },
    },
    t = timestamp();
  const signature = createHmac("sha256", "whsec_test")
    .update(t + "." + JSON.stringify(event))
    .digest("hex");
  const post = (sign: string) =>
    call(portalWorker, portal, "/cloud/webhook", {
      data: event,
      headers: { "Stripe-Signature": "t=" + t + ",v1=" + sign },
    });
  expect((await post("bad")).status).toBe(400);
  await body(await post(signature));
  await body(await post(signature));
  expect(
    (
      await control
        .prepare("SELECT paid_until FROM customers WHERE id='a'")
        .first()
    )?.paid_until,
  ).toBe(yearsEnd);
  subscribed = false;
  await body(await post(signature));
  expect(
    Number(
      (
        await control
          .prepare("SELECT paid_until FROM customers WHERE id='a'")
          .first()
      )?.paid_until,
    ),
  ).toBeLessThanOrEqual(timestamp());
});
it("keeps CSV/JSON exports available temporarily after expiry and blocks ledger changes", async () => {
  const db = await a.getD1Database("CONTROL");
  await db
    .prepare("UPDATE customers SET paid_until=? WHERE id='a'")
    .bind(timestamp() - 1)
    .run();
  expect(
    (await call(a, first, "/api/export", { cookie: cookieA })).status,
  ).toBe(200);
  expect(
    (
      await call(a, first, "/api/accounts", {
        cookie: cookieA,
        data: { name: "No" },
      })
    ).status,
  ).toBe(402);
  await db
    .prepare("UPDATE customers SET paid_until=? WHERE id='a'")
    .bind(timestamp() - 31 * 86400)
    .run();
  expect(
    (await call(a, first, "/api/backup", { cookie: cookieA })).status,
  ).toBe(402);
});
it("preserves account identities, negative amounts and original row numbers in Tiller previews", () => {
  const groups = tillerGroups(sampleTiller);
  expect(groups.map((g) => g.account)).toEqual([
    "Checking · 1234",
    "Business card · 5678",
  ]);
  expect(groups[1].rows[0]).toMatchObject({
    row: 3,
    amount: -5900,
    posted: "2026-11-03",
    category: "Software",
  });
});
