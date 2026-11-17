import { readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { serve } from '@hono/node-server';
import { createApp } from '../app.js';
import { loadConfig } from '../core/config.js';
import { createGscApi, parseServiceAccountKey, type ServiceAccountKey } from '../core/google/client.js';
import { GscService } from '../core/google/service.js';
import { createLogger } from '../core/logger.js';
import { SERVER_NAME, SERVER_VERSION } from '../core/server.js';
import { combinedVerifier, TokenStore } from '../core/tokens.js';
import { acquireDirLock, ensureWritableDir, FileStateStore } from './fileStore.js';

function readKey(json: string | undefined, file: string | undefined): ServiceAccountKey {
  if (json) return parseServiceAccountKey(json, 'GOOGLE_SERVICE_ACCOUNT_JSON');
  let text: string;
  try {
    text = readFileSync(file!, 'utf8');
  } catch (err) {
    throw new Error(`Cannot read service account key at ${file}: ${(err as Error).message}`);
  }
  return parseServiceAccountKey(text, file);
}

async function main() {
  const config = loadConfig(process.env);
  const logger = createLogger(config.LOG_LEVEL);
  const key = readKey(config.GOOGLE_SERVICE_ACCOUNT_JSON, config.GOOGLE_APPLICATION_CREDENTIALS);
  ensureWritableDir(config.DATA_DIR);
  const releaseLock = acquireDirLock(config.DATA_DIR);
  const serviceAccountEmail = key.client_email;
  const stateStore = new FileStateStore(config.DATA_DIR);
  const tokens = new TokenStore(stateStore, logger);
  if (config.MCP_AUTH_TOKEN) logger.warn('MCP_AUTH_TOKEN is deprecated; issue per-client tokens via /admin/tokens (ADMIN_TOKEN)');

  const service = new GscService(createGscApi(key), {
    serviceAccountEmail,
    allowedSites: config.GSC_ALLOWED_SITES,
    safetyFactor: config.QUOTA_SAFETY_FACTOR,
    maxQueueWaitMs: config.MAX_QUEUE_WAIT_MS,
    maxConcurrency: config.MAX_CONCURRENCY,
    cacheEnabled: config.CACHE_ENABLED,
    stateStore,
    logger,
  });
  await service.init();

  const app = createApp({
    verifyToken: combinedVerifier(tokens, config.MCP_AUTH_TOKEN),
    allowedHosts: config.ALLOWED_HOSTS,
    mcpPath: config.MCP_PATH,
    deps: { service, logger, maxRowsPerCall: config.GSC_MAX_ROWS_PER_CALL },
    logger,
    admin: config.ADMIN_TOKEN ? { adminToken: config.ADMIN_TOKEN, tokens, defaultTtlDays: config.TOKEN_TTL_DAYS } : undefined,
  });

  const httpServer = serve({ fetch: app.fetch, port: config.PORT, hostname: config.HOST }, () => {
    logger.info(`${SERVER_NAME} listening`, {
      version: SERVER_VERSION,
      host: config.HOST,
      port: config.PORT,
      serviceAccount: serviceAccountEmail,
      allowedSites: config.GSC_ALLOWED_SITES?.length ?? 'all',
      safetyFactor: config.QUOTA_SAFETY_FACTOR,
    });
  }) as Server;
  httpServer.on('error', (err) => {
    logger.error('cannot listen', { host: config.HOST, port: config.PORT, error: err.message });
    process.exit(1);
  });

  // Outlive reverse-proxy idle connections (Caddy keeps them 2 min, nginx 60 s
  // by default), so the proxy never reuses a socket Node is closing.
  httpServer.keepAliveTimeout = 125_000;
  httpServer.headersTimeout = 130_000;

  const shutdown = (signal: string) => {
    logger.info('shutting down', { signal });
    httpServer.close(() => {
      void service.flush().finally(() => {
        releaseLock();
        process.exit(0);
      });
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err: Error) => {
  process.stderr.write(`${err.message}\n`);
  process.exit(1);
});
