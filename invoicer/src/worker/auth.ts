import { timingSafeEqual } from 'node:crypto';
import { createMiddleware } from 'hono/factory';
import { getCookie } from 'hono/cookie';
import { AppError } from '../shared/model';
import { sha, sameOrigin } from './http';
export type Env = CloudflareBindings & { ADMIN_KEY?: string; BUNDLE_PREFIX?: string };
export type AppEnv = { Bindings: Env; Variables: { csrf: string; sessionHash: string } };
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
  if (auth) {
    if (!auth.startsWith('Bearer ') || !(await keyMatches(auth.slice(7), key))) throw new AppError(401, 'unauthorized', 'Invalid admin key');
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
    c.set('csrf', session.csrf_token); c.set('sessionHash', hash);
  }
  await next();
});
