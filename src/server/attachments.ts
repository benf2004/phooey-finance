import type { AppEnv } from "./auth";
import { AppError, assert } from "./util";
import {
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS,
  MAX_PHOTO_BYTES,
  type Attachment,
} from "../shared/attachments";

type StoredAttachment = Attachment & {
  object_key: string;
  digest: string;
  state: string;
};
const publicFields =
  "id,transaction_id,filename,content_type,size,original_size,created_at";

export async function requireTransaction(env: AppEnv, transactionId: string) {
  // This deployment is a single-owner ledger. Routes require its admin session.
  assert(
    await env.DB.prepare(
      "SELECT id FROM transactions WHERE id=? AND deleted=0 AND account_id IN (SELECT id FROM accounts WHERE archived=0)",
    )
      .bind(transactionId)
      .first(),
    404,
    "Transaction not found",
  );
}
export async function listAttachments(env: AppEnv, transactionId: string) {
  await requireTransaction(env, transactionId);
  return (
    await env.DB.prepare(
      `SELECT ${publicFields} FROM transaction_attachments WHERE transaction_id=? AND state='ready' ORDER BY created_at,id`,
    )
      .bind(transactionId)
      .all<Attachment>()
  ).results;
}

export function safeFilename(value: string, contentType: string) {
  const extension = {
    "application/pdf": "pdf",
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
  }[contentType];
  const leaf = value.split(/[\\/]/).pop() ?? "attachment";
  const name = leaf
    .replace(
      /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069<>:"|?*]/g,
      "_",
    )
    .replace(/\.[^.]*$/, "")
    .trim()
    .replace(/^\.+/, "")
    .slice(0, 140);
  return `${name || "attachment"}.${extension}`;
}

export function validateAttachment(bytes: Uint8Array, type: string) {
  const start = new TextDecoder("latin1").decode(bytes.subarray(0, 16));
  const end = new TextDecoder("latin1").decode(
    bytes.subarray(Math.max(0, bytes.length - 1024)),
  );
  const valid =
    type === "application/pdf"
      ? /^%PDF-(1\.[0-7]|2\.0)[\r\n\s]/.test(start) && /%%EOF\s*$/.test(end)
      : type === "image/jpeg"
        ? bytes.length > 4 &&
          bytes[0] === 255 &&
          bytes[1] === 216 &&
          bytes[2] === 255 &&
          bytes[bytes.length - 2] === 255 &&
          bytes[bytes.length - 1] === 217
        : type === "image/png"
          ? bytes.length >= 45 &&
            [137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => bytes[i] === v) &&
            start.slice(12, 16) === "IHDR" &&
            [73, 69, 78, 68, 174, 66, 96, 130].every(
              (v, i) => bytes[bytes.length - 8 + i] === v,
            )
          : type === "image/webp"
            ? bytes.length >= 20 &&
              start.startsWith("RIFF") &&
              start.slice(8, 12) === "WEBP" &&
              ["VP8 ", "VP8L", "VP8X"].includes(start.slice(12, 16)) &&
              new DataView(
                bytes.buffer,
                bytes.byteOffset,
                bytes.byteLength,
              ).getUint32(4, true) ===
                bytes.length - 8
            : false;
  assert(
    valid,
    415,
    "File contents do not match a supported JPEG, PNG, WebP or PDF. Export the file again and retry.",
  );
}

async function readBounded(request: Request) {
  const declared = Number(request.headers.get("Content-Length"));
  assert(
    !declared || declared <= MAX_ATTACHMENT_BYTES,
    413,
    "Each stored attachment must be 20 MB or smaller.",
  );
  assert(request.body, 400, "Choose a file to upload.");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_ATTACHMENT_BYTES) {
        await reader.cancel();
        throw new AppError(
          413,
          "Each stored attachment must be 20 MB or smaller.",
        );
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  assert(size > 0, 400, "The file is empty.");
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

export async function uploadAttachment(
  env: AppEnv,
  transactionId: string,
  request: Request,
) {
  await requireTransaction(env, transactionId);
  const uploadId = request.headers.get("Idempotency-Key") ?? "";
  assert(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      uploadId,
    ),
    400,
    "A valid upload identifier is required.",
  );
  const contentType =
    request.headers.get("Content-Type")?.split(";")[0].toLowerCase() ?? "";
  assert(
    ["application/pdf", "image/jpeg", "image/png", "image/webp"].includes(
      contentType,
    ),
    415,
    "Upload JPEG, PNG, WebP or PDF files.",
  );
  let name: string;
  try {
    name = decodeURIComponent(
      request.headers.get("X-File-Name") ?? "attachment",
    );
  } catch {
    throw new AppError(400, "Invalid file name.");
  }
  assert(name.length <= 1000, 400, "The file name is too long.");
  const filename = safeFilename(name, contentType);
  const bytes = await readBounded(request);
  validateAttachment(bytes, contentType);
  const originalSize = Number(
    request.headers.get("X-Original-Size") ?? bytes.length,
  );
  assert(
    Number.isSafeInteger(originalSize) &&
      originalSize >= bytes.length &&
      originalSize <= MAX_PHOTO_BYTES,
    400,
    "Invalid original file size.",
  );
  const digest = Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
  const existing = await env.DB.prepare(
    "SELECT * FROM transaction_attachments WHERE id=?",
  )
    .bind(uploadId)
    .first<StoredAttachment>();
  if (existing) {
    assert(
      existing.transaction_id === transactionId &&
        existing.digest === digest &&
        existing.filename === filename,
      409,
      "This upload identifier was already used for another file.",
    );
    assert(
      existing.state === "ready",
      409,
      "This upload is still processing. Refresh the attachment list before retrying.",
    );
    return (await listAttachments(env, transactionId)).find(
      (a) => a.id === uploadId,
    );
  }
  // Reserve the reference BEFORE writing R2, so interrupted uploads are recoverable.
  const key = `attachments/${transactionId}/${crypto.randomUUID()}`;
  const inserted = await env.DB.prepare(
    `INSERT INTO transaction_attachments(id,transaction_id,object_key,filename,content_type,size,original_size,digest,state)
    SELECT ?,?,?,?,?,?,?,?,'uploading' WHERE EXISTS(SELECT 1 FROM transactions WHERE id=? AND deleted=0 AND account_id IN (SELECT id FROM accounts WHERE archived=0))
    AND (SELECT COUNT(*) FROM transaction_attachments WHERE transaction_id=?)<?`,
  )
    .bind(
      uploadId,
      transactionId,
      key,
      filename,
      contentType,
      bytes.length,
      originalSize,
      digest,
      transactionId,
      transactionId,
      MAX_ATTACHMENTS,
    )
    .run();
  if (!inserted.meta.changes) {
    await requireTransaction(env, transactionId);
    throw new AppError(
      409,
      `A transaction can have up to ${MAX_ATTACHMENTS} attachments. Remove a file before adding another.`,
    );
  }
  try {
    await env.FILES.put(key, bytes, { httpMetadata: { contentType } });
    const finalized = await env.DB.prepare(
      "UPDATE transaction_attachments SET state='ready' WHERE id=? AND state='uploading' AND created_at>unixepoch()-3600 AND EXISTS(SELECT 1 FROM transactions WHERE id=? AND deleted=0 AND account_id IN (SELECT id FROM accounts WHERE archived=0))",
    )
      .bind(uploadId, transactionId)
      .run();
    assert(
      finalized.meta.changes,
      409,
      "The transaction was deleted or the upload expired. The file was not attached.",
    );
  } catch (error) {
    await env.DB.prepare("DELETE FROM transaction_attachments WHERE id=?")
      .bind(uploadId)
      .run();
    try {
      await env.FILES.delete(key);
    } catch {
      /* durable cleanup trigger retries */
    }
    throw error;
  }
  return (await listAttachments(env, transactionId)).find(
    (a) => a.id === uploadId,
  );
}

async function getAttachment(
  env: AppEnv,
  transactionId: string,
  attachmentId: string,
) {
  await requireTransaction(env, transactionId);
  const attachment = await env.DB.prepare(
    "SELECT * FROM transaction_attachments WHERE id=? AND transaction_id=? AND state='ready'",
  )
    .bind(attachmentId, transactionId)
    .first<StoredAttachment>();
  assert(attachment, 404, "Attachment not found");
  return attachment;
}
export async function downloadAttachment(
  env: AppEnv,
  transactionId: string,
  attachmentId: string,
  download: boolean,
) {
  const attachment = await getAttachment(env, transactionId, attachmentId);
  const object = await env.FILES.get(attachment.object_key);
  assert(
    object,
    404,
    "This attachment is unavailable. Remove it and upload the file again.",
  );
  const ascii = attachment.filename.replace(/[^\x20-\x7e]/g, "_");
  return new Response(object.body, {
    headers: {
      "Content-Type": attachment.content_type,
      "Content-Length": String(object.size),
      "Content-Disposition": `${download ? "attachment" : "inline"}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(attachment.filename).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16)}`)}`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy":
        "sandbox; default-src 'none'; frame-ancestors 'self'",
      "Cross-Origin-Resource-Policy": "same-origin",
      "X-Frame-Options": "SAMEORIGIN",
    },
  });
}
export async function removeAttachment(
  env: AppEnv,
  transactionId: string,
  attachmentId: string,
) {
  const attachment = await getAttachment(env, transactionId, attachmentId);
  await env.DB.prepare(
    "DELETE FROM transaction_attachments WHERE id=? AND transaction_id=?",
  )
    .bind(attachmentId, transactionId)
    .run();
  try {
    await env.FILES.delete(attachment.object_key);
  } catch {
    /* durable cleanup trigger retries */
  }
  return { removed: true };
}

export async function cleanupAttachments(env: AppEnv) {
  // Bounded batches; retain tombstones for an hour so a concurrent R2 write cannot
  // resurrect an object after transaction/account deletion or a data reset.
  await env.DB.prepare(
    "DELETE FROM transaction_attachments WHERE id IN (SELECT id FROM transaction_attachments WHERE state='uploading' AND created_at<=unixepoch()-3600 LIMIT 100)",
  ).run();
  const rows = (
    await env.DB.prepare(
      "SELECT object_key FROM attachment_cleanup WHERE queued_at<=unixepoch()-3600 LIMIT 100",
    ).all<{ object_key: string }>()
  ).results;
  if (!rows.length) return;
  await env.FILES.delete(rows.map((r) => r.object_key));
  await env.DB.batch(
    rows.map((r) =>
      env.DB.prepare("DELETE FROM attachment_cleanup WHERE object_key=?").bind(
        r.object_key,
      ),
    ),
  );
}
