#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createApp } from '../app.js';
import { loadConfig, oauthAuth, startupWarnings } from '../core/config.js';
import { createGscApi, parseServiceAccountKey, type GoogleAuth, type ServiceAccountKey } from '../core/google/client.js';
import { GscService } from '../core/google/service.js';
import { createLogger } from '../core/logger.js';
import { buildServer, SERVER_NAME, SERVER_VERSION } from '../core/server.js';
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
  const env = { ...process.env };
  if (process.argv.includes('--stdio')) env.MCP_TRANSPORT = 'stdio';
  // A client spawns stdio servers from an arbitrary cwd, so ./data would scatter quota state.
  if (env.MCP_TRANSPORT === 'stdio' && !env.DATA_DIR) env.DATA_DIR = join(homedir(), '.gitupcms-gscmcp');
  const config = loadConfig(env);
  const stdio = config.MCP_TRANSPORT === 'stdio';
  // stdout carries JSON-RPC under stdio, so logs go to stderr.
  const logger = createLogger(config.LOG_LEVEL, stdio ? 'stderr' : 'stdout');
  const auth: GoogleAuth = oauthAuth(config) ?? {
    kind: 'service_account',
    key: readKey(config.GOOGLE_SERVICE_ACCOUNT_JSON, config.GOOGLE_APPLICATION_CREDENTIALS),
  };
  ensureWritableDir(config.DATA_DIR);
  const releaseLock = acquireDirLock(config.DATA_DIR);
  const serviceAccountEmail = auth.kind === 'service_account' ? auth.key.client_email : undefined;
  const stateStore = new FileStateStore(config.DATA_DIR);
  for (const w of startupWarnings(config)) logger.warn(w);

  const service = new GscService(createGscApi(auth), {
    serviceAccountEmail,
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

  if (stdio) {
    // Local subprocess: the OS user is the trust boundary, so no bearer auth; GSC_ALLOWED_SITES still applies.
    const server = buildServer({ service, logger, maxRowsPerCall: config.GSC_MAX_ROWS_PER_CALL });
    await server.connect(new StdioServerTransport());
    logger.info(`${SERVER_NAME} running on stdio`, {
      version: SERVER_VERSION,
      auth: auth.kind,
      serviceAccount: serviceAccountEmail,
      allowedSites: config.GSC_ALLOWED_SITES?.length ?? 'all',
      dataDir: config.DATA_DIR,
    });
    let stopping = false;
    const stop = (reason: string) => {
      if (stopping) return;
      stopping = true;
      logger.info('shutting down', { reason });
      void server.close().finally(() =>
        service.flush().finally(() => {
          releaseLock();
          process.exit(0);
        }),
      );
      setTimeout(() => process.exit(1), 10_000).unref();
    };
    process.stdin.on('end', () => stop('stdin closed'));
    process.stdin.on('close', () => stop('stdin closed'));
    process.on('SIGTERM', () => stop('SIGTERM'));
    process.on('SIGINT', () => stop('SIGINT'));
    return;
  }

  const tokens = new TokenStore(stateStore, logger);
  const app = createApp({
    verifyToken: combinedVerifier(tokens, config.MCP_AUTH_TOKEN),
    allowedHosts: config.ALLOWED_HOSTS,
    mcpPath: config.MCP_PATH,
    deps: { service, logger, maxRowsPerCall: config.GSC_MAX_ROWS_PER_CALL },
    logger,
    admin: config.ADMIN_TOKEN ? { adminToken: config.ADMIN_TOKEN, tokens, defaultTtlDays: config.TOKEN_TTL_DAYS } : undefined,
    oauth: { store: stateStore, publicUrl: config.PUBLIC_URL, extraRedirectUris: config.OAUTH_REDIRECT_URIS },
  });

  const httpServer = serve({ fetch: app.fetch, port: config.PORT, hostname: config.HOST }, () => {
    logger.info(`${SERVER_NAME} listening`, {
      version: SERVER_VERSION,
      host: config.HOST,
      port: config.PORT,
      auth: auth.kind,
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
