import { z } from "zod";
import { type AppEnv } from "./auth";
import { Ledger } from "./ledger";
import { mapCSV, encodeCSV } from "../shared/csv";
import { id, hash, assert } from "./util";
import {
  transactionSchema,
  accountSchema,
  categorySchema,
  ruleSchema,
  paymentSchema,
} from "../shared/models";
import { taxSchema } from "../shared/tax";
export const importSchema = z.object({
  name: z.string().min(1).max(200),
  account_id: z.string().min(1),
  text: z.string().max(1_500_000),
  mapping: z.object({
    date: z.number().int().min(0).max(100),
    description: z.number().int().min(0).max(100),
    amount: z.number().int().min(0).max(100),
    dateFormat: z.enum(["iso", "mdy", "dmy"]),
    invert: z.boolean(),
  }),
});
export async function previewImport(ledger: Ledger, input: unknown) {
  const data = importSchema.parse(input);
  assert(
    (await ledger.accounts()).some((a) => a.id === data.account_id),
    400,
    "Choose an account",
  );
  const rows = mapCSV(data.text, data.mapping);
  assert(rows.length > 0, 400, "CSV contains no transactions");
  const duplicates = (
    await ledger.db
      .prepare(
        `SELECT json_extract(j.value,'$.row') row_number,MIN(t.id) id FROM json_each(?) j JOIN transactions t ON t.account_id=? AND t.posted=json_extract(j.value,'$.posted') AND t.amount=json_extract(j.value,'$.amount') AND t.description=json_extract(j.value,'$.description') AND t.deleted=0 GROUP BY json_extract(j.value,'$.row')`,
      )
      .bind(JSON.stringify(rows.filter((r) => !r.error)), data.account_id)
      .all<{ row_number: number; id: string }>()
  ).results;
  const matches = new Map(duplicates.map((d) => [d.row_number, d.id]));
  const result = rows.map((row) => {
    const parsed = transactionSchema.safeParse({
      account_id: data.account_id,
      posted: row.posted,
      amount: row.amount,
      description: row.description,
      type: row.amount >= 0 ? "income" : "expense",
    });
    return {
      ...row,
      error:
        row.error ||
        (parsed.success
          ? null
          : parsed.error.issues.map((i) => i.message).join("; ")),
      duplicate: matches.get(row.row) ?? null,
    };
  });
  return { rows: result };
}
export async function queueImport(
  env: AppEnv,
  input: unknown,
  skipRows: number[],
) {
  const data = importSchema.parse(input);
  const fingerprint = await hash(
    JSON.stringify({
      account: data.account_id,
      text: data.text,
      mapping: data.mapping,
      skip: [...skipRows].sort((a, b) => a - b),
    }),
  );
  const existing = await env.DB.prepare(
    "SELECT id FROM imports WHERE fingerprint=?",
  )
    .bind(fingerprint)
    .first<{ id: string }>();
  if (existing) {
    const job = await env.DB.prepare(
      "SELECT id,status FROM jobs WHERE kind='import' AND json_extract(payload,'$.importId')=?",
    )
      .bind(existing.id)
      .first<{ id: string; status: string }>();
    if (job?.status === "failed") {
      assert(
        await env.FILES.head("imports/" + existing.id),
        409,
        "Import staging is missing; restore from a complete backup or start a corrected import",
      );
      await env.DB.prepare(
        "UPDATE jobs SET status='queued',error=NULL,lease_until=0 WHERE id=?",
      )
        .bind(job.id)
        .run();
      await env.JOBS.send({ jobId: job.id });
      return { jobId: job.id, resumed: true };
    }
    if (job && ["queued", "running"].includes(job.status))
      await env.JOBS.send({ jobId: job.id });
    return { jobId: job?.id, alreadyImported: true };
  }
  const preview = await previewImport(new Ledger(env.DB), data);
  const rows = preview.rows.filter((r) => !skipRows.includes(r.row));
  assert(
    rows.every((r) => !r.error),
    400,
    "Resolve or skip invalid rows",
  );
  const importId = id(),
    jobId = id();
  await env.FILES.put(
    "imports/" + importId,
    JSON.stringify({ account_id: data.account_id, rows }),
  );
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO imports(id,name,fingerprint,row_count) VALUES(?,?,?,?)",
    ).bind(importId, data.name, fingerprint, rows.length),
    env.DB.prepare(
      "INSERT INTO jobs(id,kind,payload) VALUES(?,'import',?)",
    ).bind(jobId, JSON.stringify({ importId, cursor: 0 })),
  ]);
  await env.JOBS.send({ jobId });
  return { jobId };
}
export async function importChunk(
  env: AppEnv,
  jobId: string,
  payload: { importId: string; cursor: number },
) {
  const object = await env.FILES.get("imports/" + payload.importId);
  assert(object, 404, "Import file not found");
  const file = await object.json<{
    account_id: string;
    rows: {
      row: number;
      posted: string;
      description: string;
      amount: number;
    }[];
  }>();
  const ledger = new Ledger(env.DB, "import");
  const end = Math.min(payload.cursor + 50, file.rows.length);
  for (const row of file.rows.slice(payload.cursor, end)) {
    await ledger.saveTransaction(
      {
        account_id: file.account_id,
        posted: row.posted,
        amount: row.amount,
        description: row.description,
        type: row.amount >= 0 ? "income" : "expense",
        reviewed: false,
      },
      {
        requestKey: payload.importId + ":" + row.row,
        source: "csv",
        importId: payload.importId,
        auto: true,
      },
    );
  }
  const done = end >= file.rows.length;
  await env.DB.prepare(
    "UPDATE jobs SET payload=?,status=?,progress=?,lease_until=0,updated_at=CURRENT_TIMESTAMP WHERE id=?",
  )
    .bind(
      JSON.stringify({ ...payload, cursor: end }),
      done ? "complete" : "queued",
      `${end} of ${file.rows.length} imported`,
      jobId,
    )
    .run();
  if (done) {
    try {
      await env.FILES.delete("imports/" + payload.importId);
    } catch {
      /* Staging cleanup is independent of a completed import. */
    }
  } else await env.JOBS.send({ jobId });
}
const exportHeader = [
  "Date",
  "Description",
  "Merchant",
  "Amount",
  "Currency",
  "Account",
  "Category",
  "Type",
  "Notes",
  "Pending",
  "Reviewed",
  "Transaction ID",
  "Splits",
];
type ExportPayload = {
  filter: unknown;
  upper: number;
  cursor: number;
  part: number;
  rows: number;
};
async function exportBounds(ledger: Ledger, filter: unknown) {
  const { sql, args } = ledger.where(filter);
  const bounds = await ledger.db
    .prepare(
      `SELECT COUNT(*) count,COALESCE(MAX(t.rowid),0) upper FROM transactions t WHERE ${sql}`,
    )
    .bind(...args)
    .first<{ count: number; upper: number }>();
  assert(
    bounds && bounds.count <= 100000,
    413,
    "Export a smaller date range (up to 100,000 transactions)",
  );
  return bounds;
}
async function exportBatch(ledger: Ledger, payload: ExportPayload) {
  const { sql, args } = ledger.where(payload.filter);
  const rows = (
    await ledger.db
      .prepare(
        `SELECT t.rowid cursor,t.posted,t.description,t.merchant,t.amount,a.currency,a.name account_name,c.name category_name,t.type,t.notes,t.pending,t.reviewed,t.id,(SELECT json_group_array(json_object('amount',s.amount,'category_id',s.category_id,'type',s.type,'notes',s.notes)) FROM splits s WHERE s.transaction_id=t.id) splits FROM transactions t JOIN accounts a ON a.id=t.account_id LEFT JOIN categories c ON c.id=t.category_id WHERE ${sql} AND t.rowid>? AND t.rowid<=? ORDER BY t.rowid LIMIT 500`,
      )
      .bind(...args, payload.cursor, payload.upper)
      .all<Record<string, string | number | null>>()
  ).results;
  const csvRows = rows.map((t) => [
    t.posted,
    t.description,
    t.merchant,
    Number(t.amount) / 100,
    t.currency,
    t.account_name,
    t.category_name,
    t.type,
    t.notes,
    t.pending,
    t.reviewed,
    t.id,
    t.splits,
  ]);
  return {
    csv: encodeCSV(
      payload.part === 0 ? [exportHeader, ...csvRows] : csvRows,
      payload.part === 0,
    ),
    cursor: rows.length ? Number(rows[rows.length - 1].cursor) : payload.cursor,
    count: rows.length,
  };
}
export async function exportCSV(ledger: Ledger, filter: unknown) {
  const bounds = await exportBounds(ledger, filter);
  let payload: ExportPayload = {
    filter,
    upper: bounds.upper,
    cursor: 0,
    part: 0,
    rows: 0,
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await exportBatch(ledger, payload);
        if (chunk.csv)
          controller.enqueue(new TextEncoder().encode(chunk.csv + "\r\n"));
        payload = { ...payload, cursor: chunk.cursor, part: payload.part + 1 };
        if (chunk.count < 500 || chunk.cursor >= payload.upper)
          controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
  });
}
export async function queueExport(env: AppEnv, filter: unknown) {
  const bounds = await exportBounds(new Ledger(env.DB), filter);
  const jobId = id();
  const payload: ExportPayload = {
    filter,
    upper: bounds.upper,
    cursor: 0,
    part: 0,
    rows: 0,
  };
  await env.DB.prepare("INSERT INTO jobs(id,kind,payload) VALUES(?,'export',?)")
    .bind(jobId, JSON.stringify(payload))
    .run();
  await env.JOBS.send({ jobId });
  return {
    jobId,
    download_path: "/api/files/" + jobId,
    authentication: "Use a finance:read token or admin session",
    expires: "24 hours after creation; poll get_job until complete",
  };
}
export async function exportChunk(
  env: AppEnv,
  jobId: string,
  payload: ExportPayload,
) {
  const chunk = await exportBatch(new Ledger(env.DB), payload);
  await env.FILES.put(`exports/${jobId}/${payload.part}`, chunk.csv + "\r\n");
  const next = {
    ...payload,
    cursor: chunk.cursor,
    part: payload.part + 1,
    rows: payload.rows + chunk.count,
  };
  const done = chunk.count < 500 || chunk.cursor >= payload.upper;
  await env.DB.prepare(
    "UPDATE jobs SET payload=?,status=?,progress=?,lease_until=0,updated_at=CURRENT_TIMESTAMP WHERE id=?",
  )
    .bind(
      JSON.stringify(next),
      done ? "complete" : "queued",
      `${next.rows} transactions exported`,
      jobId,
    )
    .run();
  if (!done) await env.JOBS.send({ jobId });
}
export async function exportDownload(env: AppEnv, key: string) {
  const job = await env.DB.prepare(
    "SELECT status,payload,created_at FROM jobs WHERE id=? AND kind='export'",
  )
    .bind(key)
    .first<{ status: string; payload: string; created_at: string }>();
  assert(job, 404, "Export not found");
  assert(
    Date.now() - Date.parse(job.created_at + "Z") < 86400000,
    410,
    "Export expired; create another export",
  );
  assert(
    job.status === "complete",
    409,
    "Export is not complete; check job progress",
  );
  const { part: total } = JSON.parse(job.payload) as ExportPayload;
  let part = 0;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        while (true) {
          if (!reader) {
            if (part >= total) {
              controller.close();
              return;
            }
            const object = await env.FILES.get(`exports/${key}/${part++}`);
            assert(object, 410, "Export expired; create another export");
            reader = object.body.getReader();
          }
          const chunk = await reader.read();
          if (chunk.done) {
            reader.releaseLock();
            reader = undefined;
            continue;
          }
          controller.enqueue(chunk.value);
          return;
        }
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel() {
      await reader?.cancel();
    },
  });
}
const tables = [
  "accounts",
  "categories",
  "rules",
  "imports",
  "transactions",
  "splits",
  "balance_snapshots",
  "settings",
  "tax_payments",
  "audit",
] as const;
type BackupTable = (typeof tables)[number];
const backupSchema = z.object({
  format: z.literal("phooey-finance"),
  version: z.literal(1),
  created_at: z.string(),
  tables: z.record(
    z.string(),
    z.array(z.record(z.string(), z.union([z.string(), z.number(), z.null()]))),
  ),
});
export async function backup(ledger: Ledger) {
  const data: Partial<Record<BackupTable, unknown[]>> = {};
  const results = await ledger.db.batch([
    ...tables.map((table) =>
      ledger.db.prepare(
        `SELECT * FROM ${table}${table === "settings" ? " WHERE key LIKE 'tax:%' OR key='saved-filters' OR key='preferences'" : ""}`,
      ),
    ),
    ledger.db.prepare(
      "SELECT id FROM jobs WHERE kind='import' AND status NOT IN ('complete','cancelled') LIMIT 1",
    ),
  ]);
  assert(
    results[tables.length].results.length === 0,
    409,
    "Finish or resume pending imports before creating a portable backup",
  );
  tables.forEach((table, i) => {
    data[table] = results[i].results;
  });
  return {
    format: "phooey-finance",
    version: 1,
    created_at: new Date().toISOString(),
    tables: data,
  };
}
export async function restore(ledger: Ledger, input: unknown) {
  const data = backupSchema.parse(input);
  assert(
    tables.every((t) => Array.isArray(data.tables[t])),
    400,
    "Backup is missing required tables",
  );
  const count = await ledger.db
    .prepare("SELECT COUNT(*) count FROM transactions")
    .first<{ count: number }>();
  assert(
    count?.count === 0,
    409,
    "Restore requires an empty ledger. Use a fresh deployment to restore a backup.",
  );
  for (const a of data.tables.accounts) accountSchema.parse(a);
  for (const c of data.tables.categories) categorySchema.parse(c);
  for (const r of data.tables.rules)
    ruleSchema.parse({ ...r, enabled: !!r.enabled });
  for (const t of data.tables.transactions)
    transactionSchema.parse({
      ...t,
      pending: !!t.pending,
      reviewed: !!t.reviewed,
      splits: data.tables.splits.filter((s) => s.transaction_id === t.id),
    });
  for (const p of data.tables.tax_payments) paymentSchema.parse(p);
  for (const s of data.tables.settings) {
    assert(
      typeof s.key === "string" &&
        (s.key.startsWith("tax:") ||
          ["saved-filters", "preferences"].includes(s.key)),
      400,
      "Invalid setting in backup",
    );
    if (s.key.startsWith("tax:")) taxSchema.parse(JSON.parse(String(s.value)));
  }
  const restoreGuard = id();
  const statements: D1PreparedStatement[] = [
    ledger.db
      .prepare(
        "INSERT INTO write_guards VALUES(?,(SELECT COUNT(*)=0 FROM transactions) AND (SELECT COUNT(*)=0 FROM connections) AND (SELECT COUNT(*)=0 FROM jobs WHERE status IN ('queued','running')))",
      )
      .bind(restoreGuard),
  ];
  for (const table of [...tables].reverse())
    statements.push(ledger.db.prepare(`DELETE FROM ${table}`));
  for (const table of tables) {
    const cols = (
      await ledger.db
        .prepare(`PRAGMA table_info(${table})`)
        .all<{ name: string }>()
    ).results.map((c) => c.name);
    for (const row of data.tables[table]) {
      assert(
        Object.keys(row).every((k) => cols.includes(k)),
        400,
        `Unknown column in ${table}`,
      );
    }
    for (let offset = 0; offset < data.tables[table].length; offset += 100) {
      const chunk = data.tables[table].slice(offset, offset + 100);
      const keys = cols.filter((k) => chunk.some((row) => k in row));
      assert(
        chunk.every((row) => keys.every((k) => k in row)),
        400,
        `Inconsistent columns in ${table}`,
      );
      statements.push(
        ledger.db
          .prepare(
            `INSERT INTO ${table} (${keys.map((k) => '"' + k + '"').join(",")}) SELECT ${keys.map((k) => `json_extract(value,'$.${k}')`).join(",")} FROM json_each(?)`,
          )
          .bind(JSON.stringify(chunk)),
      );
    }
  }

  statements.push(
    ledger.auditStatement("backup.restore", "backup", null, {
      created_at: data.created_at,
    }),
  );
  assert(
    statements.length < 900,
    413,
    "Use SQL restore for backups above 85,000 records",
  );
  statements.push(
    ledger.db.prepare("DELETE FROM write_guards WHERE id=?").bind(restoreGuard),
  );
  await ledger.db.batch(statements);
  return { restored: true };
}
