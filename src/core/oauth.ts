import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { AdminGuard } from './admin.js';
import { sha256 } from './auth.js';
import type { Logger } from './logger.js';
import type { StateStore } from './state.js';
import type { TokenStore } from './tokens.js';

/**
 * Minimal OAuth 2.1 authorization server for claude.ai custom connectors: DCR, PKCE S256,
 * public clients only. It issues the usual gsc_ tokens; consent needs ADMIN_TOKEN.
 */
export interface OAuthOptions {
  store: StateStore;
  /** Public origin (PUBLIC_URL), e.g. https://gsc.example.com; default = the request's origin. */
  publicUrl?: string;
  /** Extra exact redirect URIs allowed besides the Claude callbacks and loopback (OAUTH_REDIRECT_URIS). */
  extraRedirectUris?: string[];
}

interface RouteOptions extends OAuthOptions {
  guard: AdminGuard;
  tokens: TokenStore;
  defaultTtlDays: number;
  mcpPath: string;
  logger: Logger;
  now?: () => number;
}

interface CodeRecord {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  expiresAt: number;
}

interface RefreshRecord {
  tokenId: string;
  clientId: string;
  expiresAt: number;
}

const CODE_TTL_MS = 60_000;
const REFRESH_GRACE_MINUTES = 5;
const CLAUDE_CALLBACKS = ['https://claude.ai/api/mcp/auth_callback', 'https://claude.com/api/mcp/auth_callback'];
const CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const base64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const randomSecret = () => base64url(crypto.getRandomValues(new Uint8Array(32)));
const hashKey = async (prefix: string, secret: string) => `${prefix}:${hex(await sha256(secret))}`;
const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
const str = (v: unknown) => (typeof v === 'string' ? v : '');

/** The server's public origin: PUBLIC_URL, else the request URL's origin. */
export const publicOrigin = (requestUrl: string, publicUrl?: string) => publicUrl ?? new URL(requestUrl).origin;

/** Claude callbacks, loopback http on any port/path, and configured exact URIs. */
export function redirectAllowed(uri: string, extra: string[] = []): boolean {
  if (CLAUDE_CALLBACKS.includes(uri) || extra.includes(uri)) return true;
  try {
    const u = new URL(uri);
    return u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1') && !u.username && !u.password && !u.hash;
  } catch {
    return false;
  }
}

export function oauthRoutes({ store, publicUrl, extraRedirectUris = [], guard, tokens, defaultTtlDays, mcpPath, logger, now = Date.now }: RouteOptions): Hono {
  const app = new Hono();
  const origin = (c: Context) => publicOrigin(c.req.url, publicUrl);

  const resourceMetadata = (c: Context) =>
    c.json({ resource: `${origin(c)}${mcpPath}`, authorization_servers: [origin(c)], bearer_methods_supported: ['header'] });
  app.get('/.well-known/oauth-protected-resource', resourceMetadata);
  app.get(`/.well-known/oauth-protected-resource${mcpPath}`, resourceMetadata);

  app.get('/.well-known/oauth-authorization-server', (c) => {
    const o = origin(c);
    return c.json({
      issuer: o,
      authorization_endpoint: `${o}/oauth/authorize`,
      token_endpoint: `${o}/oauth/token`,
      registration_endpoint: `${o}/oauth/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
    });
  });

  app.use('/oauth/*', bodyLimit({ maxSize: 64 * 1024, onError: (c) => c.json({ error: 'invalid_request', error_description: 'Request body too large' }, 413) }));

  // Stateless DCR: nothing is stored; redirect URIs are checked against the allowlist again at /authorize.
  app.post('/oauth/register', async (c) => {
    let body: { redirect_uris?: unknown; client_name?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid_client_metadata', error_description: 'Body must be JSON' }, 400);
    }
    const uris = body.redirect_uris;
    if (!Array.isArray(uris) || !uris.length || !uris.every((u) => typeof u === 'string' && redirectAllowed(u, extraRedirectUris))) {
      return c.json({ error: 'invalid_redirect_uri', error_description: 'redirect_uris must be Claude callbacks, loopback http URLs or OAUTH_REDIRECT_URIS' }, 400);
    }
    return c.json(
      {
        client_id: hex(crypto.getRandomValues(new Uint8Array(16))),
        client_id_issued_at: Math.floor(now() / 1000),
        redirect_uris: uris,
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        ...(typeof body.client_name === 'string' ? { client_name: body.client_name } : {}),
      },
      201,
    );
  });

  type AuthorizeParams = { client_id: string; redirect_uri: string; code_challenge: string; state: string };
  const validate = (p: Record<string, string>): AuthorizeParams | string => {
    if (!redirectAllowed(p.redirect_uri ?? '', extraRedirectUris)) return 'redirect_uri is not allowed';
    if (p.response_type !== 'code') return 'response_type must be code';
    if (!p.client_id || p.client_id.length > 255) return 'client_id is required';
    if (p.code_challenge_method !== 'S256' || !CHALLENGE.test(p.code_challenge ?? '')) return 'PKCE with code_challenge_method=S256 is required';
    return { client_id: p.client_id, redirect_uri: p.redirect_uri!, code_challenge: p.code_challenge!, state: p.state ?? '' };
  };

  const page = (c: Context, status: 200 | 400 | 401 | 429, body: string, redirectUri?: string) => {
    // form-action also covers the redirect after the POST, so the client's callback origin must be allowed.
    const formAction = redirectUri ? `'self' ${new URL(redirectUri).origin}` : `'self'`;
    c.header('Content-Security-Policy', `default-src 'none'; style-src 'unsafe-inline'; form-action ${formAction}`);
    c.header('X-Frame-Options', 'DENY');
    c.header('Cache-Control', 'no-store');
    c.header('Referrer-Policy', 'no-referrer');
    return c.html(
      `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Authorize GSC MCP</title>` +
        `<style>body{font-family:system-ui,sans-serif;max-width:28rem;margin:3rem auto;padding:0 1rem}input,button{font:inherit;padding:.5rem;width:100%;box-sizing:border-box;margin:.5rem 0}.err{color:#b00}</style></head><body>${body}</body></html>`,
      status,
    );
  };

  const consent = (c: Context, p: AuthorizeParams, status: 200 | 401 = 200, error = '') =>
    page(
      c,
      status,
      `<h1>Authorize access</h1><p>A client wants read-only access to Google Search Console through this server.</p>` +
        `<p>Redirect: <code>${esc(p.redirect_uri)}</code></p>${error ? `<p class="err">${esc(error)}</p>` : ''}` +
        `<form method="post" action="/oauth/authorize">` +
        `<input type="hidden" name="response_type" value="code"><input type="hidden" name="code_challenge_method" value="S256">` +
        (['client_id', 'redirect_uri', 'code_challenge', 'state'] as const).map((k) => `<input type="hidden" name="${k}" value="${esc(p[k])}">`).join('') +
        `<label>ADMIN_TOKEN<input type="password" name="admin_token" autocomplete="current-password" required autofocus></label>` +
        `<button type="submit">Allow</button></form>`,
      p.redirect_uri,
    );

  app.get('/oauth/authorize', (c) => {
    const p = validate(c.req.query());
    return typeof p === 'string' ? page(c, 400, `<h1>Invalid request</h1><p class="err">${esc(p)}</p>`) : consent(c, p);
  });

  app.post('/oauth/authorize', async (c) => {
    const form = await c.req.parseBody();
    const p = validate(Object.fromEntries(Object.entries(form).map(([k, v]) => [k, str(v)])));
    if (typeof p === 'string') return page(c, 400, `<h1>Invalid request</h1><p class="err">${esc(p)}</p>`);
    const retryAfter = guard.lockedFor();
    if (retryAfter) {
      c.header('Retry-After', String(retryAfter));
      return page(c, 429, `<h1>Too many failed logins</h1><p class="err">Try again in ${retryAfter} seconds.</p>`);
    }
    if (!(await guard.check(str(form.admin_token)))) return consent(c, p, 401, 'Wrong ADMIN_TOKEN.');

    const code = randomSecret();
    const record: CodeRecord = { clientId: p.client_id, redirectUri: p.redirect_uri, codeChallenge: p.code_challenge, expiresAt: now() + CODE_TTL_MS };
    // shortcut: codes never exchanged stay in the store (one small entry each, admin-gated), add a sweep if that matters.
    await store.put(await hashKey('oauth-code', code), record);
    const target = new URL(p.redirect_uri);
    target.searchParams.set('code', code);
    if (p.state) target.searchParams.set('state', p.state);
    return c.redirect(target.href, 302);
  });

  app.post('/oauth/token', async (c) => {
    c.header('Cache-Control', 'no-store');
    c.header('Pragma', 'no-cache');
    const fail = (error: string, description: string) => c.json({ error, error_description: description }, 400);
    const form = await c.req.parseBody();
    const grant = str(form.grant_type);
    const clientId = str(form.client_id);

    const respond = async (issued: { id: string; token: string; expiresAt: string }, clientId: string) => {
      const expiresAt = Date.parse(issued.expiresAt);
      const refresh = randomSecret();
      const record: RefreshRecord = { tokenId: issued.id, clientId, expiresAt };
      await store.put(await hashKey('oauth-refresh', refresh), record);
      return c.json({ access_token: issued.token, token_type: 'Bearer', expires_in: Math.max(0, Math.floor((expiresAt - now()) / 1000)), refresh_token: refresh });
    };

    if (grant === 'authorization_code') {
      const code = str(form.code);
      if (!code) return fail('invalid_request', 'code is required');
      const key = await hashKey('oauth-code', code);
      // shortcut: get-then-delete is not atomic, so two exchanges racing within one await can both pass; codes live 60 s.
      const rec = await store.get<CodeRecord>(key);
      if (rec) await store.delete(key);
      if (!rec || now() >= rec.expiresAt) return fail('invalid_grant', 'Unknown, used or expired code');
      if (rec.clientId !== clientId || rec.redirectUri !== str(form.redirect_uri)) return fail('invalid_grant', 'client_id or redirect_uri does not match');
      const verifier = str(form.code_verifier);
      if (!VERIFIER.test(verifier) || base64url(await sha256(verifier)) !== rec.codeChallenge) return fail('invalid_grant', 'PKCE verification failed');
      const issued = await tokens.create(`oauth:claude ${clientId.slice(0, 8)}`, defaultTtlDays);
      logger.info('oauth token issued', { tokenId: issued.id });
      return respond(issued, clientId);
    }

    if (grant === 'refresh_token') {
      const refresh = str(form.refresh_token);
      if (!refresh) return fail('invalid_request', 'refresh_token is required');
      const key = await hashKey('oauth-refresh', refresh);
      const rec = await store.get<RefreshRecord>(key);
      if (rec) await store.delete(key);
      if (!rec || now() >= rec.expiresAt || (clientId && clientId !== rec.clientId)) return fail('invalid_grant', 'Unknown, used or expired refresh token');
      // rotate() returns undefined for revoked or deleted tokens, so revoking via the admin API ends OAuth access too.
      const issued = await tokens.rotate(rec.tokenId, defaultTtlDays, REFRESH_GRACE_MINUTES);
      if (!issued) return fail('invalid_grant', 'Token was revoked');
      logger.info('oauth token refreshed', { tokenId: issued.id });
      return respond(issued, rec.clientId);
    }

    return fail('unsupported_grant_type', 'grant_type must be authorization_code or refresh_token');
  });

  return app;
}
