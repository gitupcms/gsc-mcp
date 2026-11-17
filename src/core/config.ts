import { z } from 'zod';
import type { GoogleAuth } from './google/client.js';

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
  // Google sign-in, exactly one of: a service account (key file path, Node only, or the key JSON itself)
  // or a user's OAuth client + refresh token from `npm run oauth:login` (all three together).
  GOOGLE_APPLICATION_CREDENTIALS: z.string().min(1).optional(),
  GOOGLE_SERVICE_ACCOUNT_JSON: z.string().min(1).optional(),
  GOOGLE_OAUTH_CLIENT_ID: z.string().min(1).optional(),
  GOOGLE_OAUTH_CLIENT_SECRET: z.string().min(1).optional(),
  GOOGLE_OAUTH_REFRESH_TOKEN: z.string().min(1).optional(),
  // stdio: one local client spawns the server as a subprocess; no HTTP server, no bearer tokens.
  MCP_TRANSPORT: z.enum(['http', 'stdio']).default('http'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  // Path of the MCP endpoint, e.g. /gsc-mcp when a reverse proxy publishes it under that path.
  MCP_PATH: z
    .string()
    .regex(/^(\/[A-Za-z0-9._~-]+)+$/, 'MCP_PATH must look like /mcp or /gsc-mcp (no trailing slash)')
    .refine((p) => p !== '/healthz', 'MCP_PATH cannot be /healthz')
    .refine((p) => p !== '/admin' && !p.startsWith('/admin/'), 'MCP_PATH cannot be under /admin')
    .refine((p) => !/^\/(oauth|\.well-known)(\/|$)/.test(p), 'MCP_PATH cannot be under /oauth or /.well-known')
    .default('/mcp'),
  ALLOWED_HOSTS: csv.transform((hosts, ctx) =>
    hosts?.map((h) => {
      const name = hostnameOnly(h);
      if (name === undefined) ctx.addIssue({ code: 'custom', message: `"${h}" is not a hostname; use e.g. gsc-mcp.example.com (no https:// or path)` });
      return name ?? '';
    }),
  ),
  // Public origin for OAuth metadata behind a reverse proxy, e.g. https://gsc.example.com (no path). Default: the request's origin.
  PUBLIC_URL: z
    .string()
    .url()
    .refine((u) => /^https?:$/.test(new URL(u).protocol) && new URL(u).pathname === '/' && !new URL(u).search && !new URL(u).hash, 'PUBLIC_URL must be an origin like https://gsc.example.com (no path)')
    .transform((u) => new URL(u).origin)
    .optional(),
  // Extra exact redirect URIs the OAuth server accepts besides the claude.ai/claude.com callbacks and loopback.
  OAUTH_REDIRECT_URIS: csv.transform((uris, ctx) =>
    uris?.map((u) => {
      if (!URL.canParse(u)) ctx.addIssue({ code: 'custom', message: `"${u}" is not a URL` });
      return u;
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
}).superRefine((c, ctx) => {
  const serviceAccount = Boolean(c.GOOGLE_APPLICATION_CREDENTIALS || c.GOOGLE_SERVICE_ACCOUNT_JSON);
  const oauthVars = [c.GOOGLE_OAUTH_CLIENT_ID, c.GOOGLE_OAUTH_CLIENT_SECRET, c.GOOGLE_OAUTH_REFRESH_TOKEN].filter(Boolean).length;
  const issue = (message: string, key: string) => ctx.addIssue({ code: 'custom', message, path: [key] });
  if (oauthVars > 0 && oauthVars < 3) {
    issue('Set all three of GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET and GOOGLE_OAUTH_REFRESH_TOKEN (npm run oauth:login)', 'GOOGLE_OAUTH_REFRESH_TOKEN');
  } else if (serviceAccount && oauthVars) {
    issue('Both a service account and GOOGLE_OAUTH_* are set; set only one Google sign-in method', 'GOOGLE_OAUTH_REFRESH_TOKEN');
  } else if (!serviceAccount && !oauthVars) {
    issue(
      'Set GOOGLE_OAUTH_CLIENT_ID/SECRET/REFRESH_TOKEN (OAuth), or GOOGLE_SERVICE_ACCOUNT_JSON (the key JSON) or GOOGLE_APPLICATION_CREDENTIALS (path to the key file)',
      'GOOGLE_SERVICE_ACCOUNT_JSON',
    );
  }
}).refine((c) => c.MCP_TRANSPORT === 'stdio' || c.MCP_AUTH_TOKEN || c.ADMIN_TOKEN, {
  message: 'Set ADMIN_TOKEN (to issue tokens via /admin/tokens) and/or MCP_AUTH_TOKEN (legacy shared token)',
  path: ['ADMIN_TOKEN'],
});

export type Config = z.infer<typeof ConfigSchema>;

/** The OAuth sign-in when GOOGLE_OAUTH_* is set (the schema guarantees all three or none). */
export function oauthAuth(c: Config): Extract<GoogleAuth, { kind: 'oauth' }> | undefined {
  if (!c.GOOGLE_OAUTH_REFRESH_TOKEN) return undefined;
  return { kind: 'oauth', clientId: c.GOOGLE_OAUTH_CLIENT_ID!, clientSecret: c.GOOGLE_OAUTH_CLIENT_SECRET!, refreshToken: c.GOOGLE_OAUTH_REFRESH_TOKEN };
}

/** Configuration warnings to log at startup. */
export function startupWarnings(c: Config): string[] {
  const warnings: string[] = [];
  if (c.MCP_AUTH_TOKEN) warnings.push('MCP_AUTH_TOKEN is deprecated; issue per-client tokens via /admin/tokens (ADMIN_TOKEN)');
  if (c.GOOGLE_OAUTH_REFRESH_TOKEN && !c.GSC_ALLOWED_SITES?.length) {
    warnings.push('OAuth sees every property of the account; set GSC_ALLOWED_SITES to limit what clients can read');
  }
  return warnings;
}

export function loadConfig(env: Record<string, string | undefined>): Config {
  const parsed = ConfigSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  return parsed.data;
}
