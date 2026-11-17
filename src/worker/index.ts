import { DurableObject } from 'cloudflare:workers';
import { createApp } from '../app.js';
import { loadConfig, oauthAuth, startupWarnings } from '../core/config.js';
import { createGscApi, parseServiceAccountKey, type GoogleAuth } from '../core/google/client.js';
import { GscService } from '../core/google/service.js';
import { createLogger } from '../core/logger.js';
import type { StateStore } from '../core/state.js';
import { combinedVerifier, TokenStore } from '../core/tokens.js';

interface Env {
  GSC_HUB: DurableObjectNamespace<GscHub>;
}

type Handler = (req: Request) => Response | Promise<Response>;

/** StateStore backed by the Durable Object's storage. */
class DoStateStore implements StateStore {
  constructor(private readonly storage: DurableObjectStorage) {}
  get<T>(key: string): Promise<T | undefined> {
    return this.storage.get<T>(key);
  }
  put(key: string, value: unknown): Promise<void> {
    return this.storage.put(key, value);
  }
  async delete(key: string): Promise<void> {
    await this.storage.delete(key);
  }
}

/**
 * The single, global instance: rate limiter, cache, pauses and tokens live here,
 * so every request sees the same state.
 */
export class GscHub extends DurableObject<Env> {
  private handler?: Promise<Handler>;

  private async build(): Promise<Handler> {
    // Plain string vars and secrets only; bindings are objects.
    const vars = Object.fromEntries(Object.entries(this.env).filter(([, v]) => typeof v === 'string')) as Record<string, string>;
    const config = loadConfig(vars);
    const logger = createLogger(config.LOG_LEVEL);
    let auth: GoogleAuth | undefined = oauthAuth(config);
    if (!auth) {
      if (!config.GOOGLE_SERVICE_ACCOUNT_JSON) throw new Error('Set the GOOGLE_SERVICE_ACCOUNT_JSON secret (key files are not available on Workers) or the GOOGLE_OAUTH_* secrets');
      auth = { kind: 'service_account', key: parseServiceAccountKey(config.GOOGLE_SERVICE_ACCOUNT_JSON, 'GOOGLE_SERVICE_ACCOUNT_JSON') };
    }
    const stateStore = new DoStateStore(this.ctx.storage);
    const service = new GscService(createGscApi(auth), {
      serviceAccountEmail: auth.kind === 'service_account' ? auth.key.client_email : undefined,
      authMethod: auth.kind,
      allowedSites: config.GSC_ALLOWED_SITES,
      safetyFactor: config.QUOTA_SAFETY_FACTOR,
      maxQueueWaitMs: config.MAX_QUEUE_WAIT_MS,
      maxConcurrency: config.MAX_CONCURRENCY,
      cacheEnabled: config.CACHE_ENABLED,
      stateStore,
      logger,
    });
    await service.init();
    const tokens = new TokenStore(stateStore, logger);
    for (const w of startupWarnings(config)) logger.warn(w);
    logger.info('started', { auth: auth.kind, allowedSites: config.GSC_ALLOWED_SITES?.length ?? 'all' });
    const app = createApp({
      verifyToken: combinedVerifier(tokens, config.MCP_AUTH_TOKEN),
      allowedHosts: config.ALLOWED_HOSTS,
      mcpPath: config.MCP_PATH,
      deps: { service, logger, maxRowsPerCall: config.GSC_MAX_ROWS_PER_CALL },
      logger,
      admin: config.ADMIN_TOKEN ? { adminToken: config.ADMIN_TOKEN, tokens, defaultTtlDays: config.TOKEN_TTL_DAYS } : undefined,
      oauth: { store: stateStore, publicUrl: config.PUBLIC_URL, extraRedirectUris: config.OAUTH_REDIRECT_URIS },
    });
    return (req) => app.fetch(req);
  }

  override async fetch(request: Request): Promise<Response> {
    // Lazy, once; requests wait until saved state is loaded. A failure is retried on the next request.
    this.handler ??= this.ctx.blockConcurrencyWhile(() => this.build()).catch((err: Error) => {
      this.handler = undefined;
      console.error(JSON.stringify({ time: new Date().toISOString(), level: 'error', msg: 'startup failed', error: err.message }));
      throw err;
    });
    let handler: Handler;
    try {
      handler = await this.handler;
    } catch {
      return Response.json({ jsonrpc: '2.0', error: { code: -32603, message: 'Server misconfigured' }, id: null }, { status: 500 });
    }
    return handler(request);
  }
}

export default {
  async fetch(request, env): Promise<Response> {
    if (new URL(request.url).pathname === '/healthz') return Response.json({ status: 'ok' });
    return env.GSC_HUB.get(env.GSC_HUB.idFromName('global')).fetch(request);
  },
} satisfies ExportedHandler<Env>;
