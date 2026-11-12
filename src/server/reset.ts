import { z } from "zod";
import type { AppEnv } from "./auth";
import { assert, id } from "./util";

export async function resetData(
  env: AppEnv,
  input: unknown,
  sessionHash: string,
) {
  const { scope, confirmation } = z
    .object({
      scope: z.enum(["transactions", "everything"]),
      confirmation: z.string(),
    })
    .parse(input);
  assert(
    confirmation ===
      (scope === "everything" ? "RESET EVERYTHING" : "DELETE TRANSACTIONS"),
    400,
    "Type the confirmation exactly",
  );
  const guard = id();
  const cleanupId = id();
  const cutoff = Date.now();
  const active = await env.DB.prepare(
    "SELECT id FROM jobs WHERE status='running' LIMIT 1",
  ).first();
  assert(
    !active,
    409,
    "Wait for the current import or sync to finish, then try again",
  );
  const statements = [
    env.DB.prepare(
      "INSERT INTO write_guards VALUES(?,NOT EXISTS(SELECT 1 FROM jobs WHERE status='running'))",
    ).bind(guard),
    env.DB.prepare("DELETE FROM jobs"),
    env.DB.prepare("UPDATE tax_payments SET transaction_id=NULL"),
    env.DB.prepare("DELETE FROM transactions"),
    env.DB.prepare("DELETE FROM imports"),
    env.DB.prepare("DELETE FROM idempotency"),
    env.DB.prepare("DELETE FROM audit"),
  ];
  if (scope === "everything") {
    for (const table of [
      "rules",
      "balance_snapshots",
      "accounts",
      "categories",
      "tax_payments",
      "settings",
      "connections",
      "oauth_codes",
      "oauth_clients",
      "access_tokens",
    ])
      statements.push(env.DB.prepare(`DELETE FROM ${table}`));
    statements.push(
      env.DB.prepare("DELETE FROM sessions WHERE token_hash<>?").bind(
        sessionHash,
      ),
    );
  } else {
    statements.push(
      env.DB.prepare("UPDATE accounts SET archived=1 WHERE source='simplefin'"),
    );
    statements.push(
      env.DB.prepare(
        "UPDATE connections SET selected_accounts='[]',selection_ready=0,status='selecting',generation=?,last_success=NULL,resume_from=NULL,last_error=NULL",
      ).bind(id()),
    );
  }
  statements.push(
    env.DB.prepare(
      "INSERT INTO jobs(id,kind,payload,progress) VALUES(?,'cleanup',?,'Deleting stored import and export files')",
    ).bind(cleanupId, JSON.stringify({ cutoff })),
    env.DB.prepare("DELETE FROM write_guards WHERE id=?").bind(guard),
  );
  await env.DB.batch(statements);
  // Cron also recovers queued work if the queue is temporarily unavailable.
  try {
    await env.JOBS.send({ jobId: cleanupId });
  } catch {
    /* durable job retained */
  }
  return { ok: true, jobId: cleanupId };
}
export async function cleanupFiles(
  env: AppEnv,
  jobId: string,
  payload: { cutoff: number; cursor?: string },
) {
  const objects = await env.FILES.list({ limit: 500, cursor: payload.cursor });
  const keys = objects.objects
    .filter((object) => object.uploaded.getTime() <= payload.cutoff)
    .map((object) => object.key);
  if (keys.length) await env.FILES.delete(keys);
  const result = await env.DB.prepare(
    "UPDATE jobs SET status=?,payload=?,progress=?,lease_until=0,error=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='running'",
  )
    .bind(
      objects.truncated ? "queued" : "complete",
      JSON.stringify({
        cutoff: payload.cutoff,
        ...(objects.truncated ? { cursor: objects.cursor } : {}),
      }),
      objects.truncated ? "Deleting stored files" : "Stored files deleted",
      jobId,
    )
    .run();
  if (objects.truncated && result.meta.changes) await env.JOBS.send({ jobId });
}
