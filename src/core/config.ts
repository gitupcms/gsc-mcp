import { z } from 'zod';

const csv = z
  .string()
  .optional()
  .transform((v) =>
    v
      ? v
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined,
  );

/**
 * The SDK checks `new URL(`http://${Host}`).hostname` against ALLOWED_HOSTS, so
 * normalize entries the same way: lowercase, punycode, no port, IPv6 in brackets.
 * Returns undefined for entries that aren't a host (a URL, a path).
 */
export function hostnameOnly(host: string): string | undefined {
  const h = host.trim();
  if (!h || h.includes('://') || /[/?#@\s]/.test(h)) return undefined;
  // More than one colon without brackets is a bare IPv6 address, not host:port.
  const bracketed = !h.startsWith('[') && (h.match(/:/g)?.length ?? 0) > 1 ? `[${h}]` : h;
  try {
    return new URL(`http://${bracketed}`).hostname || undefined;
  } catch {
    return undefined;
  }
}

const bool = z
  .enum(['true', 'false', '1', '0'])
  .optional()
  .transform((v) => (v === undefined ? undefined : v === 'true' || v === '1'));

const ConfigSchema = z.object({
  // Legacy single shared token; still accepted alongside tokens issued via /admin/tokens.
  MCP_AUTH_TOKEN: z.string().min(32, 'MCP_AUTH_TOKEN must be at least 32 characters (try `openssl rand -hex 32`)').optional(),
  // Enables the /admin/tokens API; unset = admin routes are 404.
  ADMIN_TOKEN: z.string().min(32, 'ADMIN_TOKEN must be at least 32 characters (try `openssl rand -hex 32`)').optional(),
  TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(90),
  // Key file path (Node adapter only) or the key JSON itself (any runtime); one is required.
  GOOGLE_APPLICATION_CREDENTIALS: z.string().min(1).optional(),
  GOOGLE_SERVICE_ACCOUNT_JSON: z.string().min(1).optional(),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  // Path of the MCP endpoint, e.g. /gsc-mcp when a reverse proxy publishes it under that path.
  MCP_PATH: z
    .string()
    .regex(/^(\/[A-Za-z0-9._~-]+)+$/, 'MCP_PATH must look like /mcp or /gsc-mcp (no trailing slash)')
    .refine((p) => p !== '/healthz', 'MCP_PATH cannot be /healthz')
    .refine((p) => p !== '/admin' && !p.startsWith('/admin/'), 'MCP_PATH cannot be under /admin')
    .default('/mcp'),
  ALLOWED_HOSTS: csv.transform((hosts, ctx) =>
    hosts?.map((h) => {
      const name = hostnameOnly(h);
      if (name === undefined) ctx.addIssue({ code: 'custom', message: `"${h}" is not a hostname; use e.g. gsc-mcp.example.com (no https:// or path)` });
      return name ?? '';
    }),
  ),
  GSC_ALLOWED_SITES: csv,
  QUOTA_SAFETY_FACTOR: z.coerce.number().gt(0).max(1).default(0.8),
  MAX_QUEUE_WAIT_MS: z.coerce.number().int().min(0).default(15_000),
  MAX_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(4),
  // Results are sent twice (text + structuredContent), so keep responses to a few MB.
  GSC_MAX_ROWS_PER_CALL: z.coerce.number().int().min(1).max(50_000).default(25_000),
  CACHE_ENABLED: bool.transform((v) => v ?? true),
  DATA_DIR: z.string().default('./data'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
}).refine((c) => c.GOOGLE_APPLICATION_CREDENTIALS || c.GOOGLE_SERVICE_ACCOUNT_JSON, {
  message: 'Set GOOGLE_SERVICE_ACCOUNT_JSON (the key JSON) or GOOGLE_APPLICATION_CREDENTIALS (path to the key file)',
  path: ['GOOGLE_SERVICE_ACCOUNT_JSON'],
}).refine((c) => c.MCP_AUTH_TOKEN || c.ADMIN_TOKEN, {
  message: 'Set ADMIN_TOKEN (to issue tokens via /admin/tokens) and/or MCP_AUTH_TOKEN (legacy shared token)',
  path: ['ADMIN_TOKEN'],
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(env: Record<string, string | undefined>): Config {
  const parsed = ConfigSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  return parsed.data;
}
