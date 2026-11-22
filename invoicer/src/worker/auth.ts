import { timingSafeEqual } from 'node:crypto';
import { createMiddleware } from 'hono/factory';
import { getCookie } from 'hono/cookie';
import { AppError } from '../shared/model';
import { sha, sameOrigin } from './http';
export type Env = CloudflareBindings & { ADMIN_KEY?: string; BUNDLE_PREFIX?: string; KEY_NAMESPACE?: string; PUBLIC_ORIGIN?: string };
export type AppEnv = { Bindings: Env; Variables: { csrf: string; sessionHash: string; businessId: string; keyScope: string; admin: boolean } };
export function requireKey(env: Env) {
  if (!env.ADMIN_KEY || env.ADMIN_KEY.length < 32) throw new AppError(503, 'not_configured', 'Set the ADMIN_KEY Worker secret to a random key of at least 32 characters.');
  return env.ADMIN_KEY;
}
export async function keyMatches(provided: string, key: string) {
  const [a, b] = await Promise.all([crypto.subtle.digest('SHA-256', new TextEncoder().encode(provided)), crypto.subtle.digest('SHA-256', new TextEncoder().encode(key))]);
  return timingSafeEqual(new Uint8Array(a), new Uint8Array(b));
}
export const authenticate = createMiddleware<AppEnv>(async (c, next) => {
  const key = requireKey(c.env);
  const auth = c.req.header('Authorization');
  c.set('admin', false); c.set('keyScope', 'write');
  let businessId = c.req.header('X-Business-Id') || (c.req.path.startsWith('/api/v1/assets/') ? c.req.query('business') : '') || 'default';
  if (auth) {
    if (!auth.startsWith('Bearer ')) throw new AppError(401, 'unauthorized', 'Invalid API key');
    if (await keyMatches(auth.slice(7), key)) c.set('admin', true);
    else {
      const record = await c.env.DB.prepare('SELECT business_id, scope FROM api_keys WHERE token_hash = ? AND revoked_at IS NULL').bind(await sha(auth.slice(7))).first<{business_id:string;scope:string}>();
      if (!record) throw new AppError(401, 'unauthorized', 'Invalid or revoked API key');
      if (c.req.header('X-Business-Id') && businessId !== record.business_id) throw new AppError(403, 'business_scope', 'This key belongs to another business');
      businessId = record.business_id; c.set('keyScope', record.scope);
      if (record.scope === 'read' && !['GET','HEAD','OPTIONS'].includes(c.req.method) && c.req.path !== '/mcp') throw new AppError(403, 'read_only', 'This key is read-only');
    }
    c.set('csrf', ''); c.set('sessionHash', '');
  } else {
    const raw = getCookie(c, 'invoicer_session');
    if (!raw || !/^[0-9a-f]{64}$/.test(raw)) throw new AppError(401, 'unauthorized', 'Sign in to continue');
    const hash = await sha(raw);
    const session = await c.env.DB.prepare('SELECT csrf_token, key_fingerprint, expires_at FROM sessions WHERE token_hash = ?').bind(hash).first<{ csrf_token: string; key_fingerprint: string; expires_at: number }>();
    if (!session || session.expires_at <= Date.now() || session.key_fingerprint !== await sha(key)) throw new AppError(401, 'unauthorized', 'Your session has expired');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) {
      sameOrigin(c.req.raw);
      if (!await keyMatches(c.req.header('X-CSRF-Token') || '', session.csrf_token)) throw new AppError(403, 'csrf', 'Invalid CSRF token');
    }
    c.set('admin', true);
    c.set('csrf', session.csrf_token); c.set('sessionHash', hash);
  }
  c.set('businessId', businessId);
  await next();
});
