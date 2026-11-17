# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A read-only MCP server for Google Search Console. Streamable HTTP (stateless, POST only) on Hono, or stdio on Node (`--stdio` / `MCP_TRANSPORT=stdio`), per-client bearer tokens, and Google sign-in via a service account or a user's OAuth refresh token (exactly one), both limited to the `webmasters.readonly` scope. It runs on Node.js (Docker or bare) and on Cloudflare Workers from the same core. The main job of the codebase is staying inside Google's quotas; see the Quota model section of README.md.

## Commands

```bash
npm test                                  # vitest run (no Google access needed)
npx vitest run test/service.test.ts       # one file
npx vitest run -t "load quota"            # tests whose name matches
npm run typecheck                         # three passes: core (no Node types), Node + tests + scripts, Worker
npm run build                             # tsc -p tsconfig.build.json -> dist/ (Node)
npm run cf:check                          # wrangler deploy --dry-run --outdir .wrangler/dry
npm run dev                               # tsx watch src/node/index.ts; needs ADMIN_TOKEN or MCP_AUTH_TOKEN (>=32 chars), a key, DATA_DIR
npm run start:stdio                       # node dist/node/index.js --stdio; no tokens needed, DATA_DIR defaults to ~/.gitupcms-gscmcp
npm run token -- list --url <base>        # token admin CLI (scripts/token.ts), reads ADMIN_TOKEN
npm run oauth:login                       # loopback+PKCE login (scripts/oauth-login.ts), prints a read-only refresh token
```

There is no linter. TypeScript is strict with `noUncheckedIndexedAccess` and ESM (`NodeNext`), so relative imports use `.js` extensions.

## Architecture

- **`src/core/**` and `src/app.ts` are runtime-agnostic.** Web APIs only (fetch, `crypto.subtle`, AbortSignal, TextEncoder). No `node:*`, `fs`, `process`, `googleapis` or `google-auth-library`. `tsconfig.core.json` type-checks them with `types: []` to enforce this; `grep -rn "node:" src/core src/app.ts` must stay empty.
- **Adapters** build the config, `GscService`, `TokenStore` and `createApp()` and supply a `StateStore`:
  - `src/node/index.ts`: `@hono/node-server`, `FileStateStore` (one JSON file per key in `DATA_DIR`, atomic writes), key from `GOOGLE_SERVICE_ACCOUNT_JSON` or the `GOOGLE_APPLICATION_CREDENTIALS` file, or OAuth. With `--stdio`/`MCP_TRANSPORT=stdio` it connects one `buildServer()` to the SDK's `StdioServerTransport` instead: no HTTP, no bearer auth or admin routes (the OS user is the trust boundary), `GSC_ALLOWED_SITES` still applies, the `DATA_DIR` lock is still taken, and the logger writes to stderr (`createLogger(level, 'stderr')`) because stdout is JSON-RPC only. Never write to stdout in code that runs under stdio.
  - `src/worker/index.ts`: one global Durable Object `GscHub` (`idFromName('global')`) with `DoStateStore`; key only from the `GOOGLE_SERVICE_ACCOUNT_JSON` secret, or OAuth secrets. `/healthz` is answered before the DO.
- **Google auth** (`core/google/client.ts`): `createGscApi(auth)` takes `GoogleAuth` = `{ kind: 'service_account', key } | { kind: 'oauth', clientId, clientSecret, refreshToken }`; both share the token cache, 5-min early refresh and single-flight refresh. The config schema requires exactly one method (`oauthAuth(config)` builds the OAuth one). An OAuth token whose `scope` includes a Search Console scope wider than read-only is refused (`scope_too_broad` → `AUTH_ERROR`). `GscServiceOptions.authMethod` changes PERMISSION_DENIED/AUTH_ERROR advice and shows in `get_capabilities`. `startupWarnings(config)` warns on OAuth without `GSC_ALLOWED_SITES`.
- **`StateStore`** (`core/state.ts`): `get/put/delete` key-value. `StoredState` coalesces writes and logs (never throws) on failure; in-memory state stays authoritative. Keys: `quota-state`, `pause-state`, `tokens`, `inspected:<site>`, `inspection:<site>:<url>` (`encodeURIComponent`-ed, since Node maps keys to file names; keys over 200 chars are hashed).
- **HTTP** (`app.ts`): a new `McpServer` + transport per POST; GET/DELETE return 405. Bearer auth via a pluggable `VerifyToken`; `combinedVerifier` accepts issued tokens and the legacy `MCP_AUTH_TOKEN`. `/admin/tokens` exists only with `ADMIN_TOKEN`. `ALLOWED_HOSTS` guards the MCP, admin and OAuth routes. `X-Token-Expires-At` is set when a token expires within 7 days.
- **OAuth** (`core/oauth.ts`): mounted only with `ADMIN_TOKEN` (`AppOptions.oauth` + `admin`). Metadata under `/.well-known/*`, stateless DCR, consent page checked by the shared `AdminGuard` (same lockout as `/admin`), PKCE S256. Codes (`oauth-code:<sha256>`, 60 s) and refresh tokens (`oauth-refresh:<sha256>` → token id) live in the `StateStore`; refresh rotates the `gsc_` token via `TokenStore.rotate` (5 min grace), so a revoked token gives `invalid_grant`. Origin = `PUBLIC_URL` or the request URL.
- **Tokens** (`core/tokens.ts`): all in one `tokens` entry; only SHA-256 hashes stored; rotation keeps the previous hash until `prevValidUntil`.
- **Site scoping:** `buildServer()` replaces `service` with `service.scoped(auth.allowedSites)`, so a token's sites apply to every tool on top of `GSC_ALLOWED_SITES` (enforced in `GscService.site()`).

Every Google call goes through `GscService.call()` (`core/google/service.ts`); tools never call the client directly. Pipeline, outermost first: cache (LRU+TTL, in-flight dedupe) → pause check (`checkBreaker`) → `withRetry` (backoff, honours Retry-After; quota errors on `searchAnalytics`/`urlInspection` are not retried) → `Semaphore` → `RateLimiter.acquire` (sliding windows + PT-midnight daily counters) → the request. Quota state is recorded while the semaphore slot is held.

Quota model notes (read before changing anything here):
- Google's numbers live only in `GOOGLE_LIMITS` (`core/limits/quotas.ts`), scaled by `QUOTA_SAFETY_FACTOR` (default 0.8). URL inspection: 2,000/property/day → 1,600 locally.
- Google returns one error for every quota, so `classifyGoogleError` can't tell load quota from rate limit. For `searchAnalytics` and `urlInspection`, any quota error pauses that property: `QUOTA_PAUSE_STEPS_MS` (15 min, 1 h), then until PT midnight. Steps go up only with no success since the last pause; reset on a new PT day.
- First-step pauses on 3 properties within 10 min pause Search Analytics for all properties for 5 min.
- Inspection-spending tools take `maxInspections` (default and max `MAX_BATCH_URLS` = 25) via `inspectCapped()` and report `quotaUsed`. `batch_inspect_urls` stops at `BATCH_DEADLINE_MS` (90 s).
- `pagesWithImpressions()` (`tools/indexWatch.ts`) uses one `rowLimit: 1000` query sorted by clicks; a known shortcut.
- `sortBy`/`sortDirection` on `search_analytics_query`/`get_page_queries` sort the returned rows after the cache (`sortRows`), so they never change the cache key; Google always selects rows by clicks.
- `days` (relative range) is resolved by `resolveDates()` in `tools/searchAnalytics.ts`: end = PT today − 3 days (− 1 for non-final dataState), start = end − days + 1; giving both `days` and dates is `INVALID_ARGUMENT`.

Other rules:
- `normalizeSiteUrl` validates user input before any quota is spent; values from Google go through `normalizeKnownSiteUrl` (never throws).
- Errors reach clients as `GscToolError` (`code`, message, `retryAfterSeconds`/`resetAt`). Wrap tool handlers with `handle()` (`tools/common.ts`), which passes the abort `signal`.
- Every tool is annotated read-only (`READ_ONLY`), and `test/http.test.ts` enforces it. Inspection history (`src/core/inspectionHistory.ts`) is recorded as a side effect of `GscService.inspectUrl` (non-cached results only), like quota state. Never add a tool that writes on request.

## Tests

`test/helpers.ts`: `fakeApi()` (in-memory `GscApi`), `makeService()` (safetyFactor 1, `maxQueueWaitMs` 0, millisecond retries), `googleError(status, reason, message, headers)`. `MemoryStateStore` (`core/state.ts`) stands in for persistence. Time-dependent tests use `vi.useFakeTimers({ toFake: ['Date'] })` and `vi.setSystemTime`.
`test/stdio.test.ts` spawns `src/node/index.ts --stdio` through tsx with a throwaway RSA service account key (no Google request) and fails on any non-JSON-RPC output on stdout.

## Plugin

`.claude-plugin/plugin.json`, `.cursor-plugin/plugin.json`, `.mcp.json` (Claude Code, `${VAR}`) and `mcp.json` (Cursor, `${env:VAR}`) point clients at a remote HTTP deployment through `GSC_MCP_URL`/`GSC_MCP_TOKEN`. `skills/*/SKILL.md` mirror `core/prompts.ts`; keep the two in step when a workflow changes.

## Deployment

- Docker/Node: `docker compose up -d --build` with `.env` (from `.env.example`) and the key in `./secrets/gsc-sa.json`; state in the `gsc-data` volume.
- Workers: `wrangler secret put GOOGLE_SERVICE_ACCOUNT_JSON` (or the three `GOOGLE_OAUTH_*`) and `ADMIN_TOKEN`, other settings in `"vars"` of `wrangler.jsonc`, then `npm run cf:check` and `npm run cf:deploy`.
- Keys, `.env`, tokens and OAuth refresh tokens never go into the repository.
