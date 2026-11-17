import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { AdminGuard, adminRoutes, type AdminOptions } from './core/admin.js';
import type { AuthContext, VerifyToken } from './core/auth.js';
import type { Logger } from './core/logger.js';
import { oauthRoutes, publicOrigin, type OAuthOptions } from './core/oauth.js';
import { buildServer } from './core/server.js';
import { EXPIRY_WARNING_MS } from './core/tokens.js';
import type { ToolDeps } from './core/tools/common.js';

export interface AppOptions {
  verifyToken: VerifyToken;
  allowedHosts?: string[];
  /** Where the MCP endpoint is served, e.g. "/mcp" (default) or "/gsc-mcp". */
  mcpPath?: string;
  /** Shared deps; `auth` is filled in per request. */
  deps: Omit<ToolDeps, 'auth'>;
  logger: Logger;
  /** Token admin API at /admin/tokens; omitted = 404. */
  admin?: AdminOptions;
  /** OAuth for claude.ai connectors (/oauth/*, /.well-known/*); mounted only together with `admin`. */
  oauth?: OAuthOptions;
}

type Env = { Variables: { auth: AuthContext } };

const MAX_BODY_BYTES = 1024 * 1024;

const rpcError = (c: Context, status: 400 | 401 | 403 | 405 | 413 | 500, code: number, message: string) =>
  c.json({ jsonrpc: '2.0', error: { code, message }, id: null }, status);

/** DNS-rebinding protection, same check as the SDK's Express hostHeaderValidation. */
function hostHeaderValidation(allowedHostnames: string[]): MiddlewareHandler {
  return async (c, next) => {
    const hostHeader = c.req.header('host');
    if (!hostHeader) return rpcError(c, 403, -32000, 'Missing Host header');
    let hostname: string;
    try {
      hostname = new URL(`http://${hostHeader}`).hostname;
    } catch {
      return rpcError(c, 403, -32000, `Invalid Host header: ${hostHeader}`);
    }
    if (!allowedHostnames.includes(hostname)) return rpcError(c, 403, -32000, `Invalid Host: ${hostname}`);
    await next();
  };
}

/** Bearer token check through the pluggable verifier. */
function bearerAuth(verifyToken: VerifyToken, challenge: (c: Context) => string): MiddlewareHandler<Env> {
  return async (c, next) => {
    const match = /^Bearer\s+(.+)$/i.exec(c.req.header('authorization') ?? '');
    const auth = match ? await verifyToken(match[1]!.trim()) : null;
    if (!auth) {
      c.header('WWW-Authenticate', challenge(c));
      return rpcError(c, 401, -32001, 'Unauthorized');
    }
    c.set('auth', auth);
    await next();
    if (auth.expiresAt && Date.parse(auth.expiresAt) - Date.now() <= EXPIRY_WARNING_MS) c.header('X-Token-Expires-At', auth.expiresAt);
  };
}

export function createApp({ verifyToken, allowedHosts, mcpPath = '/mcp', deps, logger, admin, oauth }: AppOptions): Hono<Env> {
  const app = new Hono<Env>();
  const withOAuth = admin && oauth;

  app.get('/healthz', (c) => c.json({ status: 'ok' }));

  if (allowedHosts?.length) app.use(mcpPath, hostHeaderValidation(allowedHosts));
  app.use(
    mcpPath,
    bearerAuth(verifyToken, (c) =>
      withOAuth ? `Bearer resource_metadata="${publicOrigin(c.req.url, oauth.publicUrl)}/.well-known/oauth-protected-resource"` : 'Bearer',
    ),
  );

  if (admin) {
    // One lockout for the admin API and the OAuth consent page.
    const guard = new AdminGuard(admin.adminToken, admin.now);
    if (allowedHosts?.length) app.use('/admin/*', hostHeaderValidation(allowedHosts));
    app.route('/admin/tokens', adminRoutes(admin, guard));
    if (oauth) {
      if (allowedHosts?.length) {
        app.use('/oauth/*', hostHeaderValidation(allowedHosts));
        app.use('/.well-known/*', hostHeaderValidation(allowedHosts));
      }
      app.route('/', oauthRoutes({ ...oauth, guard, tokens: admin.tokens, defaultTtlDays: admin.defaultTtlDays, mcpPath, logger, now: admin.now }));
    }
  }

  // Stateless Streamable HTTP: a fresh server and transport per request.
  app.post(mcpPath, bodyLimit({ maxSize: MAX_BODY_BYTES, onError: (c) => rpcError(c, 413, -32600, 'Request body too large') }), async (c) => {
    let parsedBody: unknown;
    // Non-JSON bodies go to the transport unparsed, which answers 415.
    if ((c.req.header('content-type') ?? '').toLowerCase().includes('application/json')) {
      const text = await c.req.text();
      try {
        parsedBody = JSON.parse(text);
      } catch {
        return rpcError(c, 400, -32700, 'Parse error');
      }
    }
    const server = buildServer({ ...deps, auth: c.get('auth') });
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    const close = () => {
      void transport.close();
      void server.close();
    };
    // A client disconnect aborts the request signal; closing the transport cancels in-flight tool calls.
    c.req.raw.signal?.addEventListener('abort', close, { once: true });
    try {
      await server.connect(transport);
      return await transport.handleRequest(c.req.raw, { parsedBody });
    } catch (err) {
      logger.error('mcp request failed', { error: (err as Error).message });
      return rpcError(c, 500, -32603, 'Internal server error');
    } finally {
      // JSON responses are complete once handleRequest returns.
      c.req.raw.signal?.removeEventListener('abort', close);
      close();
    }
  });

  const methodNotAllowed = (c: Context) => {
    c.header('Allow', 'POST');
    return rpcError(c, 405, -32000, 'Method not allowed. This server is stateless; use POST.');
  };
  app.get(mcpPath, methodNotAllowed);
  app.delete(mcpPath, methodNotAllowed);

  app.notFound((c) => c.json({ error: 'Not found' }, 404));
  app.onError((err, c) => {
    logger.error('http error', { error: err.message });
    return rpcError(c, 500, -32603, 'Internal server error');
  });
  return app;
}
