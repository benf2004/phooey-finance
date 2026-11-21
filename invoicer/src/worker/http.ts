import { AppError } from '../shared/model';
export async function readBody(request: Request, limit = 1048576): Promise<Uint8Array> {
  if (Number(request.headers.get('content-length') || 0) > limit) throw new AppError(413, 'body_too_large', `Request limit is ${limit} bytes`);
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = []; let length = 0;
  while (true) {
    const next = await reader.read(); if (next.done) break;
    length += next.value.length;
    if (length > limit) { await reader.cancel(); throw new AppError(413, 'body_too_large', `Request limit is ${limit} bytes`); }
    chunks.push(next.value);
  }
  const result = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return result;
}
export async function jsonBody(request: Request): Promise<unknown> {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw new AppError(415, 'content_type', 'Use application/json');
  try { return JSON.parse(new TextDecoder().decode(await readBody(request))); }
  catch (e) { if (e instanceof AppError) throw e; throw new AppError(400, 'invalid_json', 'Invalid JSON body'); }
}
export async function sha(value: string | Uint8Array) {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  const digest = await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes).buffer);
  return Array.from(new Uint8Array(digest), x => x.toString(16).padStart(2, '0')).join('');
}
export function token() { const bytes = crypto.getRandomValues(new Uint8Array(32)); return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join(''); }
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
export function sameOrigin(request: Request) {
  if (request.headers.get('origin') !== new URL(request.url).origin) throw new AppError(403, 'origin', 'This request must originate from this application');
}
