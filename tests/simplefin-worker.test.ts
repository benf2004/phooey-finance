import { beforeEach, afterEach, it, expect } from "vitest";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { readFile, readdir } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { hash } from "bcryptjs";

let mf: Miniflare, cookie: string;
let db: Awaited<ReturnType<Miniflare["getD1Database"]>>;
let redirectAt: "claim" | "accounts" | undefined;
const requests: {
  host: string;
  path: string;
  method: string;
  auth: string | null;
}[] = [];
const accessURL = "https://test:password@bridge.simplefin.org/simplefin";
const setupToken = btoa("https://bridge.simplefin.org/simplefin/claim/test");
beforeEach(async () => {
  redirectAt = undefined;
  requests.length = 0;
  mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      scriptPath: "dist/phooey_finance/index.js",
      compatibilityDate: "2026-11-12",
      compatibilityFlags: ["nodejs_compat"],
      d1Databases: { DB: "simplefin-worker" },
      r2Buckets: ["FILES"],
      queueProducers: { JOBS: "jobs" },
      bindings: {
        ADMIN_USERNAME: "admin",
        ADMIN_PASSWORD_HASH: await hash("test-password", 4),
        ENCRYPTION_KEY: randomBytes(32).toString("base64"),
      },
      outboundService: async (request) => {
        const url = new URL(request.url);
        requests.push({
          host: url.hostname,
          path: url.pathname,
          method: request.method,
          auth: request.headers.get("Authorization"),
        });
        const stage = url.pathname.includes("/claim/") ? "claim" : "accounts";
        if (redirectAt === stage)
          return new Response(null, {
            status: 302,
            headers: { Location: "https://unexpected.example/redirect" },
          });
        if (stage === "claim") return new Response(accessURL);
        return Response.json({
          accounts: [
            {
              id: "bank",
              name: "Checking",
              currency: "USD",
              balance: "100.00",
              "balance-date": 1794000000,
              transactions: [
                {
                  id: "tx",
                  posted: 1793000000,
                  amount: "-10.00",
                  description: "Test transaction",
                },
              ],
            },
          ],
        });
      },
    }),
  );
  db = await mf.getD1Database("DB");
  for (const file of (await readdir("migrations")).sort())
    await db.exec(
      (await readFile("migrations/" + file, "utf8")).replaceAll("\n", " "),
    );
  const login = await mf.dispatchFetch("http://localhost/api/login", {
    method: "POST",
    headers: { Origin: "http://localhost", "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "test-password" }),
  });
  expect(login.status).toBe(200);
  cookie = login.headers.get("Set-Cookie")!.split(";")[0];
});
afterEach(async () => {
  await mf?.dispose();
});
async function connect() {
  return mf.dispatchFetch("http://localhost/api/sync/connect", {
    method: "POST",
    headers: {
      Origin: "http://localhost",
      Cookie: cookie,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ token: setupToken }),
  });
}
async function consume(jobId: string) {
  const worker = await mf.getWorker();
  if (!("queue" in worker) || typeof worker.queue !== "function")
    throw new Error("Worker queue handler unavailable");
  await worker.queue("jobs", [
    {
      id: crypto.randomUUID(),
      timestamp: new Date(),
      attempts: 1,
      body: { jobId },
    },
  ]);
  return db
    .prepare("SELECT status,error FROM jobs WHERE id=?")
    .bind(jobId)
    .first<{ status: string; error: string | null }>();
}
it("claims a token and imports transactions inside the Workers runtime", async () => {
  const response = await connect();
  expect(response.status).toBe(200);
  const { jobId } = (await response.json()) as { jobId: string };
  let job;
  for (let i = 0; i < 5; i++) {
    job = await consume(jobId);
    if (job?.status === "complete") break;
    expect(job?.error).toBeNull();
  }
  expect(job?.status).toBe("complete");
  expect(
    await db.prepare("SELECT amount,category_id FROM transactions").first(),
  ).toEqual({ amount: -1000, category_id: null });
  expect(
    (
      await db
        .prepare("SELECT secret FROM connections")
        .first<{ secret: string }>()
    )?.secret,
  ).not.toContain(accessURL);
  expect(requests).toEqual([
    {
      host: "bridge.simplefin.org",
      path: "/simplefin/claim/test",
      method: "POST",
      auth: null,
    },
    {
      host: "bridge.simplefin.org",
      path: "/simplefin/accounts",
      method: "GET",
      auth: "Basic " + btoa("test:password"),
    },
  ]);
});
it("rejects claim redirects without following them", async () => {
  redirectAt = "claim";
  const response = await connect();
  expect(response.status).toBe(400);
  expect(
    await db.prepare("SELECT COUNT(*) AS count FROM connections").first(),
  ).toEqual({ count: 0 });
  expect(requests).toHaveLength(1);
});
it("rejects account redirects without forwarding bank credentials", async () => {
  const response = await connect();
  expect(response.status).toBe(200);
  const { jobId } = (await response.json()) as { jobId: string };
  redirectAt = "accounts";
  const job = await consume(jobId);
  expect(job?.status).toBe("queued");
  expect(job?.error).toBe("SimpleFIN is temporarily unavailable");
  expect(requests).toHaveLength(2);
  expect(requests.every((r) => r.host === "bridge.simplefin.org")).toBe(true);
});
