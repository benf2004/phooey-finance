import { beforeAll, afterAll, it, expect } from "vitest";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { readFile, readdir } from "node:fs/promises";
import { hash } from "bcryptjs";
import { randomBytes } from "node:crypto";
import type { AppEnv } from "../src/server/auth";
import {
  cleanupAttachments,
  uploadAttachment,
  validateAttachment,
} from "../src/server/attachments";
import { twoPagePDF, tinyPNG } from "./attachment-fixtures";
import { MAX_ATTACHMENT_BYTES } from "../src/shared/attachments";

let mf: Miniflare, env: AppEnv, cookie: string, account: string;
const pdf = twoPagePDF();
async function request(
  path: string,
  method = "GET",
  body?: string | Uint8Array,
  headers: Record<string, string> = {},
) {
  return mf.dispatchFetch("http://127.0.0.1/api" + path, {
    method,
    headers: { Cookie: cookie ?? "", Origin: "http://127.0.0.1", ...headers },
    ...(body ? { body } : {}),
  });
}
async function json(path: string, method: string, data: unknown) {
  return request(path, method, JSON.stringify(data), {
    "Content-Type": "application/json",
  });
}
async function transaction() {
  const response = await json("/transactions", "POST", {
    account_id: account,
    posted: "2026-01-01",
    amount: -1200,
    description: "Synthetic receipt",
    type: "expense",
  });
  expect(response.status).toBe(200);
  return (await response.json()) as { id: string; revision: number };
}
function headers(
  name = "invoice.pdf",
  key = crypto.randomUUID(),
  type = "application/pdf",
) {
  return {
    "Content-Type": type,
    "Idempotency-Key": key,
    "X-File-Name": encodeURIComponent(name),
  };
}
async function attach(
  id: string,
  body: Uint8Array = pdf,
  metadata = headers(),
) {
  const result = await request(
    `/transactions/${id}/attachments`,
    "POST",
    body,
    metadata,
  );
  expect(result.status, await result.clone().text()).toBe(200);
  return (await result.json()) as {
    id: string;
    filename: string;
    size: number;
    original_size: number;
  };
}
beforeAll(async () => {
  mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      scriptPath: "dist/phooey_finance/index.js",
      compatibilityDate: "2026-11-12",
      compatibilityFlags: ["nodejs_compat"],
      d1Databases: { DB: "attachments-test" },
      r2Buckets: ["FILES"],
      queueProducers: { JOBS: "jobs" },
      bindings: {
        ADMIN_USERNAME: "admin",
        ADMIN_PASSWORD_HASH: await hash("synthetic-test-password", 4),
        ENCRYPTION_KEY: randomBytes(32).toString("base64"),
      },
    }),
  );
  env = await mf.getBindings<AppEnv>();
  for (const file of (await readdir("migrations")).sort())
    await env.DB.exec(
      (await readFile("migrations/" + file, "utf8")).replaceAll("\n", " "),
    );
  const login = await json("/login", "POST", {
    username: "admin",
    password: "synthetic-test-password",
  });
  cookie = login.headers.get("Set-Cookie")!.split(";")[0];
  account = (
    (await (
      await json("/accounts", "POST", { name: "Synthetic attachment account" })
    ).json()) as { id: string }
  ).id;
});
afterAll(async () => {
  await mf?.dispose();
});

it("round-trips all PDF pages unchanged, safe filenames, headers, listing and deletion", async () => {
  const tx = await transaction();
  const attachment = await attach(tx.id, pdf, headers('../bad"\r\nname.html'));
  expect(attachment.filename).toBe("bad___name.pdf");
  expect(attachment.size).toBe(pdf.length);
  const base = `/transactions/${tx.id}/attachments`;
  const listing = (await (await request(base)).json()) as { id: string }[];
  expect(listing).toHaveLength(1);
  const download = await request(base + "/" + attachment.id);
  expect(download.headers.get("Content-Type")).toBe("application/pdf");
  expect(download.headers.get("X-Content-Type-Options")).toBe("nosniff");
  expect(download.headers.get("Content-Security-Policy")).toContain("sandbox");
  expect(download.headers.get("Cache-Control")).toContain("no-store");
  expect(download.headers.get("Content-Disposition")).toContain("inline;");
  expect(new Uint8Array(await download.arrayBuffer())).toEqual(pdf);
  expect(
    (await request(base + "/" + attachment.id + "?download=1")).headers.get(
      "Content-Disposition",
    ),
  ).toContain("attachment;");
  expect((await request(base + "/" + attachment.id, "DELETE")).status).toBe(
    200,
  );
  expect((await request(base + "/" + attachment.id)).status).toBe(404);
  expect(await (await request(base)).json()).toEqual([]);
});

it("enforces session, origin, existing transaction and attachment-to-transaction ownership", async () => {
  const tx = await transaction(),
    other = await transaction();
  const attachment = await attach(tx.id);
  const base = `/transactions/${tx.id}/attachments`;
  for (const [path, method] of [
    [base, "GET"],
    [base, "POST"],
    [base + "/" + attachment.id, "GET"],
    [base + "/" + attachment.id, "DELETE"],
  ]) {
    expect(
      (
        await request(path, method, method === "POST" ? pdf : undefined, {
          ...headers(),
          Cookie: "",
        })
      ).status,
    ).toBe(401);
  }
  expect(
    (
      await request(base, "POST", pdf, {
        ...headers(),
        Origin: "https://evil.example",
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await request(base + "/" + attachment.id, "DELETE", undefined, {
        Origin: "https://evil.example",
      })
    ).status,
  ).toBe(403);
  for (const method of ["GET", "DELETE"])
    expect(
      (
        await request(
          `/transactions/${other.id}/attachments/${attachment.id}`,
          method,
        )
      ).status,
    ).toBe(404);
  expect(
    (await request("/transactions/missing/attachments", "POST", pdf, headers()))
      .status,
  ).toBe(404);
  const token = (await (
    await json("/tokens", "POST", {
      name: "Synthetic reader",
      scopes: ["finance:read"],
      days: 1,
    })
  ).json()) as { token: string };
  expect(
    (
      await request(base, "GET", undefined, {
        Cookie: "",
        Authorization: `Bearer ${token.token}`,
      })
    ).status,
  ).toBe(401);
});

it("rejects empty, mismatched, unsupported, truncated and oversized bodies before storing", async () => {
  const tx = await transaction();
  const base = `/transactions/${tx.id}/attachments`;
  for (const [body, type, status] of [
    [pdf, "text/html", 415],
    [new TextEncoder().encode("<html>fake</html>"), "application/pdf", 415],
    [pdf.slice(0, -10), "application/pdf", 415],
    [tinyPNG, "image/jpeg", 415],
    [new Uint8Array(), "image/png", 400],
  ] as const) {
    expect(
      (
        await request(
          base,
          "POST",
          body,
          headers("file", crypto.randomUUID(), type),
        )
      ).status,
    ).toBe(status);
  }
  // Test early rejection directly: Miniflare's HTTP bridge can close its socket
  // while undici is still sending a 20 MiB body, producing a transport EPIPE.
  await expect(
    uploadAttachment(
      env,
      tx.id,
      new Request("http://test", {
        method: "POST",
        headers: {
          ...headers(),
          "Content-Length": String(MAX_ATTACHMENT_BYTES + 1),
        },
        body: new Uint8Array(MAX_ATTACHMENT_BYTES + 1),
      }),
    ),
  ).rejects.toMatchObject({ status: 413 });
  // Exercise bounded streaming without a Content-Length hint, too.
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new Uint8Array(MAX_ATTACHMENT_BYTES));
      c.enqueue(new Uint8Array(1));
      c.close();
    },
  });
  await expect(
    uploadAttachment(
      env,
      tx.id,
      new Request("http://test", {
        method: "POST",
        headers: headers(),
        body: stream,
        duplex: "half",
      } as RequestInit),
    ),
  ).rejects.toThrow("20 MB");
  expect(await (await request(base)).json()).toEqual([]);
  expect(
    (
      await env.DB.prepare(
        "SELECT COUNT(*) n FROM transaction_attachments WHERE transaction_id=?",
      )
        .bind(tx.id)
        .first<{ n: number }>()
    )?.n,
  ).toBe(0);
  expect(() => validateAttachment(tinyPNG, "image/png")).not.toThrow();
});

it("retries a lost successful response without duplicating the file, and enforces count limit", async () => {
  const tx = await transaction();
  const metadata = headers();
  const attachment = await attach(tx.id, pdf, metadata);
  expect((await attach(tx.id, pdf, metadata)).id).toBe(attachment.id);
  expect(
    (
      await request(`/transactions/${tx.id}/attachments`, "POST", tinyPNG, {
        ...metadata,
        "Content-Type": "image/png",
      })
    ).status,
  ).toBe(409);
  for (let i = 1; i < 20; i++)
    await attach(
      tx.id,
      tinyPNG,
      headers(`receipt-${i}.png`, crypto.randomUUID(), "image/png"),
    );
  expect(
    (
      await request(
        `/transactions/${tx.id}/attachments`,
        "POST",
        pdf,
        headers(),
      )
    ).status,
  ).toBe(409);
  expect(
    (await (
      await request(`/transactions/${tx.id}/attachments`)
    ).json()) as unknown[],
  ).toHaveLength(20);
});

it("removes references on soft deletion and physical deletion and recovers stale uploads", async () => {
  const tx = await transaction();
  const attachment = await attach(tx.id);
  const stored = await env.DB.prepare(
    "SELECT object_key FROM transaction_attachments WHERE id=?",
  )
    .bind(attachment.id)
    .first<{ object_key: string }>();
  expect(
    (await json(`/transactions/${tx.id}`, "DELETE", { revision: tx.revision }))
      .status,
  ).toBe(200);
  expect(
    (await request(`/transactions/${tx.id}/attachments/${attachment.id}`))
      .status,
  ).toBe(404);
  expect(
    (
      await request(
        `/transactions/${tx.id}/attachments`,
        "POST",
        pdf,
        headers(),
      )
    ).status,
  ).toBe(404);
  expect(
    await env.DB.prepare("SELECT id FROM transaction_attachments WHERE id=?")
      .bind(attachment.id)
      .first(),
  ).toBeNull();
  expect(
    await env.DB.prepare(
      "SELECT object_key FROM attachment_cleanup WHERE object_key=?",
    )
      .bind(stored!.object_key)
      .first(),
  ).toBeTruthy();
  const physical = await transaction();
  const second = await attach(physical.id);
  await env.DB.prepare("DELETE FROM transactions WHERE id=?")
    .bind(physical.id)
    .run();
  expect(
    await env.DB.prepare("SELECT id FROM transaction_attachments WHERE id=?")
      .bind(second.id)
      .first(),
  ).toBeNull();
  const stale = await transaction();
  const third = await attach(stale.id);
  await env.DB.prepare(
    "UPDATE transaction_attachments SET state='uploading',created_at=unixepoch()-7200 WHERE id=?",
  )
    .bind(third.id)
    .run();
  await cleanupAttachments(env);
  expect(
    await env.DB.prepare("SELECT id FROM transaction_attachments WHERE id=?")
      .bind(third.id)
      .first(),
  ).toBeNull();
  await env.DB.prepare(
    "UPDATE attachment_cleanup SET queued_at=unixepoch()-7200",
  ).run();
  await cleanupAttachments(env);
  expect(await env.FILES.get(stored!.object_key)).toBeNull();
  expect(
    (
      await env.DB.prepare("SELECT COUNT(*) n FROM attachment_cleanup").first<{
        n: number;
      }>()
    )?.n,
  ).toBe(0);
});

it("retains durable cleanup when a put or delete fails, including deletion during upload", async () => {
  const tx = await transaction();
  const files = env.FILES;
  env.FILES = new Proxy(files, {
    get(target, property) {
      if (property === "put")
        return async (...args: Parameters<R2Bucket["put"]>) => {
          await target.put(...args);
          throw new Error("Synthetic storage failure");
        };
      if (property === "delete")
        return async () => {
          throw new Error("Synthetic cleanup failure");
        };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  try {
    await expect(
      uploadAttachment(
        env,
        tx.id,
        new Request("http://test", {
          method: "POST",
          headers: headers(),
          body: pdf,
        }),
      ),
    ).rejects.toThrow("Synthetic storage failure");
  } finally {
    env.FILES = files;
  }
  expect(
    await (await request(`/transactions/${tx.id}/attachments`)).json(),
  ).toEqual([]);
  expect(
    (
      await env.DB.prepare("SELECT COUNT(*) n FROM attachment_cleanup").first<{
        n: number;
      }>()
    )?.n,
  ).toBeGreaterThan(0);
  env.FILES = new Proxy(files, {
    get(target, property) {
      if (property === "put")
        return async (...args: Parameters<R2Bucket["put"]>) => {
          await env.DB.prepare("UPDATE transactions SET deleted=1 WHERE id=?")
            .bind(tx.id)
            .run();
          return target.put(...args);
        };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  try {
    await expect(
      uploadAttachment(
        env,
        tx.id,
        new Request("http://test", {
          method: "POST",
          headers: headers(),
          body: pdf,
        }),
      ),
    ).rejects.toThrow("transaction was deleted");
  } finally {
    env.FILES = files;
  }
  await env.DB.prepare(
    "UPDATE attachment_cleanup SET queued_at=unixepoch()-7200",
  ).run();
  await cleanupAttachments(env);
});

it("persists compression presets without overwriting other preferences", async () => {
  expect(
    await (await request("/settings/attachment-compression")).json(),
  ).toEqual({ preset: "balanced" });
  await json("/settings/profile", "POST", { displayName: "Synthetic name" });
  expect(
    (
      await json("/settings/attachment-compression", "POST", {
        preset: "smaller",
      })
    ).status,
  ).toBe(200);
  expect(
    await (await request("/settings/attachment-compression")).json(),
  ).toEqual({ preset: "smaller" });
  expect(
    ((await (await request("/session")).json()) as { displayName: string })
      .displayName,
  ).toBe("Synthetic name");
  expect(
    (await json("/settings/attachment-compression", "POST", { preset: "fake" }))
      .status,
  ).toBe(400);
});

it("returns ready image/PDF counts with transaction rows and details, excluding pending or removed files", async () => {
  const tx = await transaction();
  const count = async () => {
    const list = (await (await request(`/transactions?limit=100`)).json()) as {
      items: { id: string; attachment_count: number }[];
    };
    const detail = (await (await request(`/transactions/${tx.id}`)).json()) as {
      attachment_count: number;
    };
    const result = list.items.find((row) => row.id === tx.id)!.attachment_count;
    expect(detail.attachment_count).toBe(result);
    return result;
  };
  expect(await count()).toBe(0);
  const image = await attach(
    tx.id,
    tinyPNG,
    headers("receipt.png", crypto.randomUUID(), "image/png"),
  );
  const invoice = await attach(tx.id);
  expect(await count()).toBe(2);
  await env.DB.prepare(
    "UPDATE transaction_attachments SET state='uploading' WHERE id=?",
  )
    .bind(invoice.id)
    .run();
  expect(await count()).toBe(1);
  expect(
    (await request(`/transactions/${tx.id}/attachments/${image.id}`, "DELETE"))
      .status,
  ).toBe(200);
  expect(await count()).toBe(0);
  await env.DB.prepare(
    "UPDATE transaction_attachments SET state='ready' WHERE id=?",
  )
    .bind(invoice.id)
    .run();
  expect(await count()).toBe(1);
  await env.DB.prepare("UPDATE accounts SET archived=1 WHERE id=?")
    .bind(account)
    .run();
  try {
    expect((await request(`/transactions/${tx.id}/attachments`)).status).toBe(
      404,
    );
    expect(
      (await request(`/transactions/${tx.id}/attachments/${invoice.id}`))
        .status,
    ).toBe(404);
    expect(
      (
        await request(
          `/transactions/${tx.id}/attachments`,
          "POST",
          pdf,
          headers(),
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await request(
          `/transactions/${tx.id}/attachments/${invoice.id}`,
          "DELETE",
        )
      ).status,
    ).toBe(404);
  } finally {
    await env.DB.prepare("UPDATE accounts SET archived=0 WHERE id=?")
      .bind(account)
      .run();
  }
  await json(`/transactions/${tx.id}`, "DELETE", { revision: tx.revision });
  const list = (await (await request(`/transactions?limit=100`)).json()) as {
    items: { id: string }[];
  };
  expect(list.items.some((row) => row.id === tx.id)).toBe(false);
});
