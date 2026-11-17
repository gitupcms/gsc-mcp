import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { singleTokenVerifier } from './auth.js';
import { MAX_TTL_DAYS, type TokenStore } from './tokens.js';

export interface AdminOptions {
  /** ADMIN_TOKEN; the admin routes exist only when it is set. */
  adminToken: string;
  tokens: TokenStore;
  defaultTtlDays: number;
  now?: () => number;
}

/** Failed admin logins allowed per window before the admin routes lock for everyone. */
export const ADMIN_MAX_FAILURES = 10;
export const ADMIN_FAILURE_WINDOW_MS = 15 * 60_000;

const ttlDays = z.number().int().min(1).max(MAX_TTL_DAYS).optional();
const CreateBody = z.object({
  name: z.string().trim().min(1).max(100),
  ttlDays,
  allowedSites: z.array(z.string().trim().min(1)).min(1).max(1000).optional(),
});
const RotateBody = z.object({ ttlDays, graceMinutes: z.number().int().min(0).max(7 * 24 * 60).optional() });

async function parse<T>(c: Context, schema: z.ZodType<T>): Promise<T | Response> {
  let body: unknown = {};
  const text = await c.req.text();
  if (text.trim()) {
    try {
      body = JSON.parse(text);
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ') }, 400);
  return parsed.data;
}

/** /admin/tokens routes, guarded by the ADMIN_TOKEN bearer. */
export function adminRoutes({ adminToken, tokens, defaultTtlDays, now = Date.now }: AdminOptions): Hono {
  const verify = singleTokenVerifier(adminToken);
  const app = new Hono();
  // Global, not per IP: client IPs behind proxies are spoofable, and the admin API is rarely used.
  let failures: number[] = [];

  app.use('*', async (c, next) => {
    const t = now();
    failures = failures.filter((f) => t - f < ADMIN_FAILURE_WINDOW_MS);
    if (failures.length >= ADMIN_MAX_FAILURES) {
      const retryAfter = Math.ceil((failures[0]! + ADMIN_FAILURE_WINDOW_MS - t) / 1000);
      c.header('Retry-After', String(retryAfter));
      return c.json({ error: 'Too many failed admin logins; try again later.', retryAfterSeconds: retryAfter }, 429);
    }
    const match = /^Bearer\s+(.+)$/i.exec(c.req.header('authorization') ?? '');
    if (!match || !(await verify(match[1]!.trim()))) {
      failures.push(t);
      c.header('WWW-Authenticate', 'Bearer');
      return c.json({ error: 'Unauthorized' }, 401);
    }
    await next();
  });

  app.post('/', async (c) => {
    const body = await parse(c, CreateBody);
    if (body instanceof Response) return body;
    return c.json(await tokens.create(body.name, body.ttlDays ?? defaultTtlDays, body.allowedSites), 201);
  });

  app.get('/', async (c) => c.json({ tokens: await tokens.list() }));

  app.post('/:id/rotate', async (c) => {
    const body = await parse(c, RotateBody);
    if (body instanceof Response) return body;
    const issued = await tokens.rotate(c.req.param('id'), body.ttlDays ?? defaultTtlDays, body.graceMinutes);
    return issued ? c.json(issued) : c.json({ error: 'Token not found or revoked' }, 404);
  });

  app.delete('/:id', async (c) => {
    const revoked = await tokens.revoke(c.req.param('id'));
    return revoked ? c.json(revoked) : c.json({ error: 'Token not found' }, 404);
  });

  return app;
}
