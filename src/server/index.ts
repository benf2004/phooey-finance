import { deleteAccount } from "./accounts";
import { resetData, cleanupFiles } from "./reset";
import { Hono } from "hono";
import { z } from "zod";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import {
  type AppEnv,
  type Principal,
  authenticate,
  login,
  cookieToken,
  sessionCookie,
  checkOrigin,
  requireScope,
  issueToken,
  rateLimit,
} from "./auth";
import {
  AppError,
  assert,
  hash,
  id,
  now,
  readJSON,
  readText,
  errorMessage,
} from "./util";
import { Ledger } from "./ledger";
import { dateSchema, scopeSchema, filterSchema } from "../shared/models";
import { taxState, saveTax, addPayment } from "./taxes";
import {
  connectSimplefin,
  requestSync,
  syncWindow,
  claimJob,
  simplefinState,
  discoverSimplefinAccounts,
  selectSimplefinAccounts,
} from "./sync";
import {
  previewImport,
  queueImport,
  importChunk,
  exportCSV,
  exportChunk,
  exportDownload,
  backup,
  restore,
} from "./files";
import {
  oauthMetadata,
  registerClient,
  validateAuthorization,
  authorize,
  exchangeCode,
} from "./oauth";
import { handleMcp } from "./mcp";
const app = new Hono<{
  Bindings: AppEnv;
  Variables: { principal: Principal; ledger: Ledger };
}>();
app.use("*", async (c, next) => {
  await next();
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Referrer-Policy", "no-referrer");
  c.header("Cache-Control", "no-store");
});
app.onError((e, c) => {
  const status =
    e instanceof AppError
      ? e.status
      : e instanceof z.ZodError
        ? 400
        : String(e).includes("CHECK constraint")
          ? 409
          : String(e).includes("UNIQUE constraint")
            ? 409
            : 500;
  return c.json(
    {
      error:
        status === 409 && !(e instanceof AppError)
          ? "This record changed or already exists. Refresh and try again."
          : errorMessage(e),
    },
    status as ContentfulStatusCode,
  );
});
app.get("/api/health", (c) => c.json({ ok: true, version: "0.1.0" }));
app.post("/api/login", async (c) => {
  checkOrigin(c.req.raw);
  const body = z
    .object({ username: z.string().max(200), password: z.string().max(500) })
    .parse(await readJSON(c.req.raw, 2000));
  const token = await login(
    c.env,
    body.username,
    body.password,
    c.req.header("CF-Connecting-IP") ?? "local",
  );
  c.header("Set-Cookie", sessionCookie(token, c.req.raw));
  return c.json({ ok: true });
});
app.use("/api/*", async (c, next) => {
  const p = await authenticate(
    c.env,
    c.req.raw,
    !c.req.path.startsWith("/api/files/"),
  );
  assert(p, 401, "Please sign in");
  if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method))
    checkOrigin(c.req.raw);
  c.set("principal", p);
  c.set("ledger", new Ledger(c.env.DB, p.actor));
  await next();
});
app.get("/api/session", async (c) =>
  c.json({
    username: c.env.ADMIN_USERNAME,
    sourceUrl: c.env.SOURCE_URL,
    demo: !!(await c.env.DB.prepare(
      "SELECT value FROM settings WHERE key='demo'",
    ).first()),
  }),
);
app.post("/api/logout", async (c) => {
  await c.env.DB.prepare("DELETE FROM sessions WHERE token_hash=?")
    .bind(await hash(cookieToken(c.req.raw) ?? ""))
    .run();
  c.header("Set-Cookie", sessionCookie("", c.req.raw, 0));
  return c.json({ ok: true });
});
app.post("/api/settings/reset", async (c) =>
  c.json(
    await resetData(
      c.env,
      await readJSON(c.req.raw),
      await hash(cookieToken(c.req.raw) ?? ""),
    ),
  ),
);
app.get("/api/accounts", async (c) => c.json(await c.get("ledger").accounts()));
app.post("/api/accounts", async (c) =>
  c.json(
    await c
      .get("ledger")
      .saveAccount(
        await readJSON(c.req.raw),
        undefined,
        c.req.header("Idempotency-Key"),
      ),
  ),
);
app.delete("/api/accounts/:id", async (c) =>
  c.json(
    await deleteAccount(c.env, c.req.param("id"), await readJSON(c.req.raw)),
  ),
);
app.put("/api/accounts/:id", async (c) =>
  c.json(
    await c
      .get("ledger")
      .saveAccount(
        await readJSON(c.req.raw),
        c.req.param("id"),
        c.req.header("Idempotency-Key"),
      ),
  ),
);
app.get("/api/accounts/:id/history", async (c) =>
  c.json(
    (
      await c.env.DB.prepare(
        "SELECT balance,captured_at FROM balance_snapshots WHERE account_id=? AND account_id IN (SELECT id FROM accounts WHERE archived=0) ORDER BY captured_at DESC LIMIT 365",
      )
        .bind(c.req.param("id"))
        .all()
    ).results,
  ),
);
app.get("/api/categories", async (c) =>
  c.json(await c.get("ledger").categories()),
);
app.post("/api/categories", async (c) =>
  c.json(
    await c
      .get("ledger")
      .saveCategory(
        await readJSON(c.req.raw),
        undefined,
        c.req.header("Idempotency-Key"),
      ),
  ),
);
app.put("/api/categories/:id", async (c) =>
  c.json(
    await c
      .get("ledger")
      .saveCategory(
        await readJSON(c.req.raw),
        c.req.param("id"),
        c.req.header("Idempotency-Key"),
      ),
  ),
);
app.get("/api/transactions", async (c) =>
  c.json(await c.get("ledger").transactions(c.req.query())),
);
app.post("/api/transactions", async (c) =>
  c.json(
    await c.get("ledger").saveTransaction(await readJSON(c.req.raw), {
      requestKey: c.req.header("Idempotency-Key"),
    }),
  ),
);
app.get("/api/transactions/:id", async (c) =>
  c.json(await c.get("ledger").transaction(c.req.param("id"))),
);
app.put("/api/transactions/:id", async (c) => {
  const data = z
    .object({ transaction: z.unknown(), revision: z.number().int() })
    .parse(await readJSON(c.req.raw));
  return c.json(
    await c.get("ledger").saveTransaction(data.transaction, {
      id: c.req.param("id"),
      revision: data.revision,
      requestKey: c.req.header("Idempotency-Key"),
    }),
  );
});
app.delete("/api/transactions/:id", async (c) => {
  const data = z
    .object({ revision: z.number().int() })
    .parse(await readJSON(c.req.raw));
  return c.json(
    await c.get("ledger").deleteTransaction(c.req.param("id"), data.revision),
  );
});
app.post("/api/bulk-category", async (c) => {
  const data = z
    .object({
      items: z
        .array(z.object({ id: z.string(), revision: z.number().int() }))
        .max(100),
      category_id: z.string().nullable(),
    })
    .parse(await readJSON(c.req.raw));
  return c.json(
    await c.get("ledger").bulkCategory(data.items, data.category_id),
  );
});
app.post("/api/transfers", async (c) => {
  const data = z
    .object({ first: z.string(), second: z.string() })
    .parse(await readJSON(c.req.raw));
  return c.json(await c.get("ledger").linkTransfer(data.first, data.second));
});
app.delete("/api/transfers/:id", async (c) =>
  c.json(await c.get("ledger").unlinkTransfer(c.req.param("id"))),
);
app.get("/api/rules", async (c) => c.json(await c.get("ledger").rules()));
app.post("/api/rules", async (c) =>
  c.json(
    await c
      .get("ledger")
      .saveRule(
        await readJSON(c.req.raw),
        undefined,
        c.req.header("Idempotency-Key"),
      ),
  ),
);
app.put("/api/rules/:id", async (c) =>
  c.json(
    await c
      .get("ledger")
      .saveRule(
        await readJSON(c.req.raw),
        c.req.param("id"),
        c.req.header("Idempotency-Key"),
      ),
  ),
);
app.post("/api/rules/preview", async (c) =>
  c.json(await c.get("ledger").previewRule(await readJSON(c.req.raw))),
);
app.post("/api/rules/:id/apply", async (c) => {
  const data = z
    .object({
      items: z
        .array(z.object({ id: z.string(), revision: z.number().int() }))
        .max(500),
    })
    .parse(await readJSON(c.req.raw));
  return c.json(await c.get("ledger").applyRule(c.req.param("id"), data.items));
});
app.get("/api/report", async (c) => {
  const q = z.object({ from: dateSchema, to: dateSchema }).parse(c.req.query());
  assert(q.from <= q.to, 400, "Start must precede end");
  return c.json(await c.get("ledger").report(q.from, q.to));
});
const year = (s: string) =>
  z.coerce.number().int().min(2000).max(2100).parse(s);
app.get("/api/taxes/:year", async (c) =>
  c.json(await taxState(c.get("ledger"), year(c.req.param("year")))),
);
app.put("/api/taxes/:year", async (c) => {
  const data = z
    .object({
      profile: z.object({ year: z.number() }).passthrough(),
      revision: z.number().int(),
    })
    .parse(await readJSON(c.req.raw));
  assert(
    data.profile.year === year(c.req.param("year")),
    400,
    "Year does not match profile",
  );
  return c.json(await saveTax(c.get("ledger"), data.profile, data.revision));
});
app.post("/api/tax-payments", async (c) =>
  c.json(
    await addPayment(
      c.get("ledger"),
      await readJSON(c.req.raw),
      c.req.header("Idempotency-Key"),
    ),
  ),
);
app.delete("/api/tax-payments/:id", async (c) => {
  const before = await c.env.DB.prepare("SELECT * FROM tax_payments WHERE id=?")
    .bind(c.req.param("id"))
    .first();
  assert(before, 404, "Payment not found");
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM tax_payments WHERE id=?").bind(
      c.req.param("id"),
    ),
    c
      .get("ledger")
      .auditStatement("tax.payment.delete", c.req.param("id"), before, null),
  ]);
  return c.json({ ok: true });
});
app.get("/api/sync", async (c) =>
  c.json({
    connection: await simplefinState(c.env),
    jobs: (
      await c.env.DB.prepare(
        "SELECT id,kind,status,progress,error,created_at,updated_at FROM jobs ORDER BY created_at DESC LIMIT 20",
      ).all()
    ).results,
  }),
);
app.post("/api/sync/connect", async (c) => {
  const body = z
    .object({ token: z.string().min(1).max(10000) })
    .parse(await readJSON(c.req.raw));
  return c.json(await connectSimplefin(c.env, body.token));
});
app.post("/api/sync/discover", async (c) =>
  c.json(await discoverSimplefinAccounts(c.env)),
);
app.post("/api/sync/accounts", async (c) =>
  c.json(await selectSimplefinAccounts(c.env, await readJSON(c.req.raw))),
);
app.post("/api/sync", async (c) => {
  const body = z
    .object({ start: dateSchema.optional() })
    .parse(await readJSON(c.req.raw));
  return c.json(await requestSync(c.env, body.start));
});
app.delete("/api/sync", async (c) => {
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM connections WHERE id='simplefin'"),
    c.env.DB.prepare(
      "UPDATE jobs SET status='cancelled' WHERE kind='sync' AND status IN ('queued','running')",
    ),
  ]);
  return c.json({ ok: true });
});
app.post("/api/jobs/:id/retry", async (c) => {
  const key = c.req.param("id");
  const job = await c.env.DB.prepare(
    "SELECT kind,status,payload FROM jobs WHERE id=?",
  )
    .bind(key)
    .first<{ kind: string; status: string; payload: string }>();
  assert(
    job && job.status === "failed",
    409,
    "Only failed jobs can be retried",
  );
  const payload = JSON.parse(job.payload);
  if (job.kind === "sync") {
    const connection = await c.env.DB.prepare(
      "SELECT generation FROM connections WHERE id='simplefin'",
    ).first<{ generation: string }>();
    assert(
      connection?.generation === payload.generation,
      409,
      "Connection changed; start a new sync",
    );
  }
  if (job.kind === "import")
    assert(
      await c.env.FILES.head("imports/" + payload.importId),
      409,
      "Import file is unavailable; import it again",
    );
  await c.env.DB.prepare(
    "UPDATE jobs SET status='queued',error=NULL,lease_until=0,updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='failed'",
  )
    .bind(key)
    .run();
  await c.env.JOBS.send({ jobId: key });
  return c.json({ jobId: key });
});
app.post("/api/import/preview", async (c) =>
  c.json(await previewImport(c.get("ledger"), await readJSON(c.req.raw))),
);
app.post("/api/import", async (c) => {
  const body = z
    .object({
      data: z.unknown(),
      skipRows: z.array(z.number().int()).max(5000),
    })
    .parse(await readJSON(c.req.raw));
  return c.json(await queueImport(c.env, body.data, body.skipRows));
});
app.get("/api/export", async (c) => {
  const csv = await exportCSV(
    c.get("ledger"),
    filterSchema.parse(c.req.query()),
  );
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="phooey-transactions.csv"',
      "Cache-Control": "no-store",
    },
  });
});
app.get(
  "/api/backup",
  async (c) =>
    new Response(JSON.stringify(await backup(c.get("ledger"))), {
      headers: {
        "Content-Type": "application/json",
        "Content-Disposition": 'attachment; filename="phooey-backup.json"',
        "Cache-Control": "no-store",
      },
    }),
);
app.post("/api/restore", async (c) =>
  c.json(await restore(c.get("ledger"), await readJSON(c.req.raw, 10_000_000))),
);
app.get("/api/files/:id", async (c) => {
  requireScope(c.get("principal"), "finance:read");
  assert(/^[\w-]+$/.test(c.req.param("id")), 400, "Invalid file ID");
  return new Response(await exportDownload(c.env, c.req.param("id")), {
    headers: {
      "Content-Type": "text/csv",
      "Content-Disposition": 'attachment; filename="phooey-transactions.csv"',
      "Cache-Control": "no-store",
    },
  });
});
app.get("/api/tokens", async (c) =>
  c.json(
    (
      await c.env.DB.prepare(
        "SELECT id,name,scopes,expires_at,created_at,last_used_at,client_id FROM access_tokens ORDER BY created_at DESC",
      ).all()
    ).results,
  ),
);
app.post("/api/tokens", async (c) => {
  const data = z
    .object({
      name: z.string().min(1).max(100),
      scopes: scopeSchema,
      days: z.number().int().min(1).max(365),
    })
    .parse(await readJSON(c.req.raw));
  return c.json(await issueToken(c.env, data.name, data.scopes, data.days));
});
app.delete("/api/tokens/:id", async (c) => {
  await c.env.DB.prepare("DELETE FROM access_tokens WHERE id=?")
    .bind(c.req.param("id"))
    .run();
  return c.json({ ok: true });
});
app.get("/api/preferences/:key", async (c) => {
  assert(
    ["saved-filters", "preferences"].includes(c.req.param("key")),
    404,
    "Unknown preference",
  );
  const row = await c.env.DB.prepare("SELECT value FROM settings WHERE key=?")
    .bind(c.req.param("key"))
    .first<{ value: string }>();
  return c.json(row ? JSON.parse(row.value) : null);
});
app.put("/api/preferences/:key", async (c) => {
  assert(
    ["saved-filters", "preferences"].includes(c.req.param("key")),
    404,
    "Unknown preference",
  );
  const data = await readJSON(c.req.raw, 20000);
  await c.env.DB.prepare(
    "INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,revision=settings.revision+1",
  )
    .bind(c.req.param("key"), JSON.stringify(data))
    .run();
  return c.json({ ok: true });
});
app.get("/.well-known/oauth-authorization-server", (c) =>
  c.json(oauthMetadata(new URL(c.req.url).origin)),
);
app.get("/.well-known/oauth-protected-resource/mcp", (c) => {
  const origin = new URL(c.req.url).origin;
  return c.json({
    resource: origin + "/mcp",
    authorization_servers: [origin],
    scopes_supported: [
      "finance:read",
      "transactions:write",
      "rules:write",
      "tax:write",
      "sync:write",
    ],
  });
});
app.post("/oauth/register", async (c) =>
  c.json(
    await registerClient(
      c.env,
      await readJSON(c.req.raw, 10000),
      c.req.header("CF-Connecting-IP") ?? "local",
    ),
    201,
  ),
);
app.get("/oauth/authorize", async (c) => {
  await validateAuthorization(
    c.env,
    new URL(c.req.url).searchParams,
    new URL(c.req.url).origin,
  );
  return c.env.ASSETS.fetch(new Request(new URL("/", c.req.url)));
});
app.get("/api/oauth/request", async (c) => {
  const data = await validateAuthorization(
    c.env,
    new URL(c.req.url).searchParams,
    new URL(c.req.url).origin,
  );
  return c.json({
    name: data.client.name,
    scopes: data.scopes,
    redirect: data.redirect,
  });
});
app.post("/api/oauth/authorize", async (c) => {
  const data = z
    .object({ query: z.string().max(10000), approved: z.boolean() })
    .parse(await readJSON(c.req.raw));
  return c.json(
    await authorize(
      c.env,
      new URLSearchParams(data.query),
      new URL(c.req.url).origin,
      data.approved,
    ),
  );
});
app.post("/oauth/token", async (c) => {
  await rateLimit(
    c.env.DB,
    "oauth-token:" + (c.req.header("CF-Connecting-IP") ?? "local"),
    30,
    60,
  );
  assert(
    Number(c.req.header("content-length") ?? 0) < 10000,
    413,
    "Request too large",
  );
  return c.json(
    await exchangeCode(
      c.env,
      new URLSearchParams(await readText(c.req.raw)),
      new URL(c.req.url).origin,
    ),
  );
});
app.post("/oauth/revoke", async (c) => {
  const body = new URLSearchParams(await readText(c.req.raw));
  await c.env.DB.prepare("DELETE FROM access_tokens WHERE token_hash=?")
    .bind(await hash(body.get("token") ?? ""))
    .run();
  return c.json({});
});
app.all("/api/*", (c) => c.json({ error: "Endpoint not found" }, 404));
app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));
export default {
  async fetch(request, env, ctx) {
    if (new URL(request.url).pathname === "/mcp") {
      try {
        const p = await authenticate(env, request);
        const origin = new URL(request.url).origin;
        if (!p || p.kind !== "token")
          return new Response(
            JSON.stringify({ error: "MCP authentication required" }),
            {
              status: 401,
              headers: {
                "Content-Type": "application/json",
                "WWW-Authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
              },
            },
          );
        if (request.headers.has("Origin")) checkOrigin(request);
        return handleMcp(request, env, ctx, p);
      } catch (e) {
        return Response.json(
          { error: errorMessage(e) },
          { status: e instanceof AppError ? e.status : 500 },
        );
      }
    }
    return app.fetch(request, env, ctx);
  },
  async scheduled(_event: ScheduledController, env: AppEnv) {
    const connected = await env.DB.prepare(
      "SELECT id FROM connections WHERE selection_ready=1 AND json_array_length(selected_accounts)>0 LIMIT 1",
    ).first();
    const recovery = (
      await env.DB.prepare(
        "SELECT id FROM jobs WHERE status IN ('queued','running') AND lease_until<? LIMIT 100",
      )
        .bind(now())
        .all<{ id: string }>()
    ).results;
    for (const job of recovery) await env.JOBS.send({ jobId: job.id });
    if (connected) await requestSync(env);
    await env.DB.batch([
      env.DB.prepare("DELETE FROM sessions WHERE expires_at<?").bind(now()),
      env.DB.prepare("DELETE FROM oauth_codes WHERE expires_at<?").bind(now()),
      env.DB.prepare("DELETE FROM rate_limits WHERE expires_at<?").bind(now()),
    ]);
  },
  async queue(batch: MessageBatch<{ jobId: string }>, env: AppEnv) {
    for (const message of batch.messages) {
      const job = await claimJob(env, message.body.jobId);
      if (!job) {
        const pending = await env.DB.prepare(
          "SELECT status,lease_until FROM jobs WHERE id=?",
        )
          .bind(message.body.jobId)
          .first<{ status: string; lease_until: number }>();
        if (pending && ["queued", "running"].includes(pending.status))
          message.retry({
            delaySeconds: Math.max(10, pending.lease_until - now() + 1),
          });
        else message.ack();
        continue;
      }
      try {
        const payload = JSON.parse(job.payload);
        if (job.kind === "sync") await syncWindow(env, job.id, payload);
        else if (job.kind === "import") await importChunk(env, job.id, payload);
        else if (job.kind === "cleanup")
          await cleanupFiles(env, job.id, payload);
        else if (job.kind === "export") await exportChunk(env, job.id, payload);
        message.ack();
      } catch (e) {
        const current = await env.DB.prepare(
          "SELECT status FROM jobs WHERE id=?",
        )
          .bind(job.id)
          .first<{ status: string }>();
        if (!current || ["complete", "cancelled"].includes(current.status)) {
          message.ack();
          continue;
        }
        const terminal =
          message.attempts >= 4 ||
          (e instanceof AppError && e.status < 500 && e.status !== 429);
        await env.DB.prepare(
          "UPDATE jobs SET status=?,error=?,lease_until=0,updated_at=CURRENT_TIMESTAMP WHERE id=?",
        )
          .bind(terminal ? "failed" : "queued", errorMessage(e), job.id)
          .run();
        if (terminal) message.ack();
        else
          message.retry({
            delaySeconds: e instanceof AppError && e.status === 429 ? 3600 : 60,
          });
      }
    }
  },
} satisfies ExportedHandler<AppEnv, { jobId: string }>;
