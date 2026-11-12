import { z } from "zod";
export class AppError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export function assert(
  condition: unknown,
  status: number,
  message: string,
): asserts condition {
  if (!condition) throw new AppError(status, message);
}
export const id = () => crypto.randomUUID();
export const now = () => Math.floor(Date.now() / 1000);
export async function hash(value: string) {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
    ),
  )
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}
export function randomToken() {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...b))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}
export async function readJSON(
  request: Request,
  limit = 2_000_000,
): Promise<unknown> {
  assert(
    Number(request.headers.get("content-length") || 0) <= limit,
    413,
    "Request is too large",
  );
  const reader = request.body?.getReader();
  if (!reader) return {};
  let size = 0;
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) {
      await reader.cancel();
      throw new AppError(413, "Request is too large");
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    all.set(c, offset);
    offset += c.length;
  }
  try {
    return JSON.parse(new TextDecoder().decode(all));
  } catch {
    throw new AppError(400, "Invalid JSON");
  }
}
export function errorMessage(e: unknown) {
  if (e instanceof AppError) return e.message;
  if (e instanceof z.ZodError)
    return e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
  return "Something went wrong. Please try again.";
}
export async function audit(
  db: D1Database,
  actor: string,
  action: string,
  entity: string,
  before: unknown,
  after: unknown,
) {
  await db
    .prepare(
      "INSERT INTO audit(id,actor,action,entity_id,before_json,after_json) VALUES(?,?,?,?,?,?)",
    )
    .bind(
      id(),
      actor,
      action,
      entity,
      before == null ? null : JSON.stringify(before),
      after == null ? null : JSON.stringify(after),
    )
    .run();
}

export async function readText(request: Request, limit = 10000) {
  const reader = request.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) {
      await reader.cancel();
      throw new AppError(413, "Request is too large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }
  return new TextDecoder().decode(bytes);
}
