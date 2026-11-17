# gitupcms-gscmcp

A read-only [MCP](https://modelcontextprotocol.io) server for the **Google Search Console API**. It speaks Streamable HTTP (stateless, POST only), so AI agents and MCP clients anywhere can read Search Console data: performance, indexing status, sitemaps and properties, plus SEO helpers built on top of them.

- **Read-only by design.** It requests only the `https://www.googleapis.com/auth/webmasters.readonly` OAuth scope. Even if a client token or the server itself is compromised, Google rejects any write to Search Console.
- **Two runtimes, one core.** Runs on Node.js (Docker or bare) and on Cloudflare Workers (one Durable Object). On Node it can also run as a local stdio server that Claude Desktop, Claude Code or Cursor start themselves.
- **Per-client tokens.** Issue, list, rotate and revoke bearer tokens with an expiry and an optional per-token property allowlist.
- **Stays inside Google's quotas.** Caching, local rate limiting at 80% of Google's published limits, retries with backoff, and per-property pauses after quota errors.

```bash
git clone https://github.com/gitupcms/gsc-mcp.git && cd gsc-mcp && npm install
```

Based on [MichalBrylKaminski/gsc-mcp](https://github.com/MichalBrylKaminski/gsc-mcp) (MIT), ported from Express to [Hono](https://hono.dev), with ideas and prompt workflows adapted from [AminForou/mcp-gsc](https://github.com/AminForou/mcp-gsc).

## Contents

- [Tools](#tools)
- [Prompts](#prompts)
- [Google auth: OAuth (recommended for personal use) or service account](#google-auth-oauth-recommended-for-personal-use-or-service-account)
- [Deploy: Docker / Node.js](#deploy-docker--nodejs)
- [Deploy: Cloudflare Workers](#deploy-cloudflare-workers)
- [Token management](#token-management)
- [Connect a client](#connect-a-client)
- [Claude Code / Cursor / OpenCode plugin](#claude-code--cursor--opencode-plugin)
- [Configuration reference](#configuration-reference)
- [Quota model](#quota-model)
- [Index watch: compare before and after a deploy](#index-watch-compare-before-and-after-a-deploy)
- [Limitations](#limitations)
- [Development](#development)

## Tools

| Tool | Google calls | What it returns |
|---|---|---|
| `list_sites` | sites.list | Properties the service account (and your token) may read, with permission level |
| `get_site` | sites.get | One property |
| `list_sitemaps` | sitemaps.list | Submitted sitemaps (or one index's children): status, errors, warnings, URL counts |
| `get_sitemap` | sitemaps.get | One sitemap |
| `search_analytics_query` | searchanalytics.query | Clicks, impressions, CTR, position with dimensions, filters (incl. regex), search types (`web`, `image`, `video`, `news`, `discover`, `googleNews`), aggregation and data state. Dates as `startDate`/`endDate` or `days` (last N days of available data). `sortBy` (`clicks`, `impressions`, `ctr`, `position`) and `sortDirection` sort the returned rows; Google still picks which rows to return by clicks. `fetchAll` pages automatically (5,000 rows unless `maxRows` asks for more) |
| `compare_periods` | searchanalytics.query | Totals for two date ranges with the change, and optionally rows matched by query/page/country/device, sorted by movers, gains or losses. Baseline defaults to the same number of days just before the current period. `days` can replace `currentStart`/`currentEnd` |
| `get_page_queries` | searchanalytics.query | The queries that bring traffic to one page (exact page filter). `pageUrl` must be inside the property; last 28 days and top 50 queries by default, `days` or dates, `rowLimit`, `sortBy` |
| `get_site_overview` | composite | Permission level, sitemap health, totals for the last N days vs. the N days before |
| `find_ctr_opportunities` | 2x searchanalytics.query (+ optional inspections) | Pages whose impressions grew while CTR fell, grouped by page and ranked by estimated lost clicks. `inspectTop` (max 25) also inspects the top pages |
| `find_cannibalization` | searchanalytics.query | Queries where two or more pages each get a real share of impressions |
| `inspect_url` | urlInspection.index.inspect | Google's indexed view of one URL |
| `batch_inspect_urls` | urlInspection.index.inspect | Up to 25 URLs with a compact summary each; stops after 90 s and marks the rest as skipped |
| `inspect_top_pages` | searchanalytics.query + inspections | Inspects the top pages by impressions over the last 28 days, up to `maxInspections` (default and max 25) |
| `index_diff` | none | Per URL, compares the latest recorded inspection with the one before it, or with the last one at/before `since`. Returns only changed pages |
| `find_deindexed_pages` | searchanalytics.query (+ inspections) | Pages with impressions in the last 28 days whose verdict is not PASS. Reads recorded inspections (no cost) or, with `live: true` or no history, inspects up to `maxInspections` pages |
| `get_quota_status` | local | Inspections used and left today per property, per-minute usage, pauses, reset time |
| `get_capabilities` | sites.list (cached) | Tool list, readable properties, inspections left today and cooldowns per property, scope |

Every tool is annotated read-only and none writes on request. The server keeps internal bookkeeping (quota counters, pauses, and the last 5 inspection results per URL for up to 1,000 URLs per property), the same way it keeps its cache. Left out on purpose: Google's write methods (`sites.add/delete`, `sitemaps.submit/delete`).

## Prompts

Each takes one argument, `siteUrl`.

| Prompt | Workflow |
|---|---|
| `seo-weekly-report` | Overview, period comparison with alerts, top queries |
| `indexing-audit` | Quota check, `find_deindexed_pages`, `index_diff`, prioritized action table |
| `content-opportunities` | `find_ctr_opportunities` plus page-2 queries scored by impressions |
| `cannibalization-check` | `find_cannibalization` and a keep/canonical/redirect/merge plan |

## Google auth: OAuth (recommended for personal use) or service account

The server signs in to Google in exactly one of two ways; setting both stops startup with an error:

- **OAuth (your own Google account).** No user to add in Search Console: the server sees every property your account can see. Best for personal use.
- **Service account.** A robot account you add to each property like a colleague. Best for teams and servers you do not want tied to a person.

Either way only the `webmasters.readonly` scope is used. With OAuth the server also checks the scope Google reports for the token and refuses one that grants more (e.g. `.../auth/webmasters`).

### OAuth setup

In the [Google Cloud console](https://console.cloud.google.com/):

1. Create or pick a project and enable the **Google Search Console API** (APIs & Services → Library).
2. OAuth consent screen (Google Auth Platform): user type **External**, fill in the app name and your email. Add the scope `https://www.googleapis.com/auth/webmasters.readonly`. While the app is in **Testing**, add your own Google account under Test users.
3. **Testing mode limit:** refresh tokens of apps in Testing expire after **7 days**, and the server then fails with `AUTH_ERROR` (`invalid_grant`). For lasting use, set the publishing status to **In production**. As far as we know `webmasters.readonly` counts as a *sensitive* scope (not restricted). We have not verified this; check the scope list on your consent screen. For a sensitive scope, an unverified app in production still works for your own account: Google shows an "unverified app" warning that you click through, and the app is capped at 100 users. No verification is needed for personal use.
4. Credentials → Create credentials → OAuth client ID → Application type **Desktop app**. Download the JSON or copy the client id and secret.

Then, on any machine with a browser:

```bash
npm ci
npm run oauth:login -- --client-secrets ~/Downloads/client_secret_XXX.json
# or: GOOGLE_OAUTH_CLIENT_ID=... GOOGLE_OAUTH_CLIENT_SECRET=... npm run oauth:login
```

It opens (or prints) a Google sign-in URL, listens on `127.0.0.1` on a random port for the redirect (PKCE and `state` checked, 5 minute timeout), asks only for `webmasters.readonly`, checks the granted scope and prints the refresh token. It writes no files. Put the three values in the server's environment:

```bash
# .env (Docker / Node)
GOOGLE_OAUTH_CLIENT_ID=123-abc.apps.googleusercontent.com
GOOGLE_OAUTH_CLIENT_SECRET=GOCSPX-...
GOOGLE_OAUTH_REFRESH_TOKEN=1//0g...
GSC_ALLOWED_SITES=https://www.example.com/,sc-domain:example.org

# Workers
npx wrangler secret put GOOGLE_OAUTH_CLIENT_ID
npx wrangler secret put GOOGLE_OAUTH_CLIENT_SECRET
npx wrangler secret put GOOGLE_OAUTH_REFRESH_TOKEN
```

OAuth sees every property of the account, so set `GSC_ALLOWED_SITES` to the properties clients may read; the server logs a warning when it is empty. If the token is revoked or expires, tools return `AUTH_ERROR`: run `npm run oauth:login` again and replace `GOOGLE_OAUTH_REFRESH_TOKEN`. Revoke access any time at https://myaccount.google.com/permissions.

### Service account setup

The server signs in to Google as a **service account**. You add its email to Search Console like a colleague.

In the Google Cloud console:

1. Create or pick a project.
2. Enable the **Google Search Console API** (APIs & Services → Library).
3. Create a service account (IAM & Admin → Service Accounts). It needs no Cloud roles.
4. Open it → Keys → Add key → Create new key → JSON. Keep the downloaded file private.

Or with `gcloud` (replace `my-project`):

```bash
gcloud services enable searchconsole.googleapis.com --project=my-project
gcloud iam service-accounts create gsc-mcp --display-name="gsc-mcp" --project=my-project
gcloud iam service-accounts keys create gsc-sa.json \
  --iam-account=gsc-mcp@my-project.iam.gserviceaccount.com
```

In [Search Console](https://search.google.com/search-console), for each property: Settings → Users and permissions → Add user → the key's `client_email` → **Restricted**. Restricted is enough for every tool, including URL inspection.

Property names follow Google: domain properties are `sc-domain:example.com`, URL-prefix properties are `https://www.example.com/` (trailing slash required). `list_sites` shows the exact values.

## Deploy: Docker / Node.js

Requires Node.js 24+ or Docker with Compose v2. Put the server behind a TLS reverse proxy for remote clients; do not buffer responses and allow at least 120 s per request (batch inspections take up to 90 s).

### Docker Compose

```bash
cp .env.example .env
sed -i "s/^ADMIN_TOKEN=.*/ADMIN_TOKEN=$(openssl rand -hex 32)/" .env
mkdir -p secrets && cp /path/to/your-key.json secrets/gsc-sa.json
sudo chown 1000:1000 secrets/gsc-sa.json && chmod 400 secrets/gsc-sa.json
docker compose up -d --build
curl http://127.0.0.1:3000/healthz        # {"status":"ok"}
```

The Compose file publishes the port on `127.0.0.1` only (`HOST_PORT`, default 3000), mounts the key as a secret at `/run/secrets/gsc-sa.json`, keeps state (quota counters, pauses, tokens, inspection history) in the `gsc-data` volume, and runs read-only with all capabilities dropped.

### Node.js directly

The server does not read `.env` itself; set the variables in your shell or service manager.

```bash
npm ci && npm run build
export ADMIN_TOKEN="$(openssl rand -hex 32)"
export GOOGLE_APPLICATION_CREDENTIALS="$PWD/secrets/gsc-sa.json"   # or GOOGLE_SERVICE_ACCOUNT_JSON='<key JSON>'
export DATA_DIR="$PWD/data"                                        # must be writable
export HOST=127.0.0.1
npm start                                                          # node dist/node/index.js
```

State is stored as one JSON file per key in `DATA_DIR`.

### Local stdio (Claude Desktop / Claude Code / Cursor)

For one person on one machine, the client can start the server as a subprocess and talk to it over stdin/stdout. Start it with `--stdio` (or `MCP_TRANSPORT=stdio`). There is no HTTP server, no bearer token and no `/admin/tokens`: the trust boundary is your operating system user, so `ADMIN_TOKEN`/`MCP_AUTH_TOKEN` are not needed. `GSC_ALLOWED_SITES` still applies. Logs go to stderr, stdout carries only JSON-RPC. Quota state lives in `DATA_DIR`, which defaults to `~/.gitupcms-gscmcp` under stdio; only one process may use a `DATA_DIR` at a time, so give each concurrent client its own.

```bash
npm ci && npm run build
claude mcp add gsc --scope user \
  -e GOOGLE_APPLICATION_CREDENTIALS=/path/to/gsc-sa.json \
  -- node /path/to/gsc-mcp/dist/node/index.js --stdio
```

Claude Desktop (`claude_desktop_config.json`), Cursor (`~/.cursor/mcp.json`) or a Claude Code `.mcp.json` take the same shape:

```json
{
  "mcpServers": {
    "gsc": {
      "command": "node",
      "args": ["/path/to/gsc-mcp/dist/node/index.js", "--stdio"],
      "env": { "GOOGLE_APPLICATION_CREDENTIALS": "/path/to/gsc-sa.json" }
    }
  }
}
```

OAuth works the same way: pass the three `GOOGLE_OAUTH_*` variables in `env` instead of the key path. `npm run start:stdio` starts the built server in stdio mode, and the package declares a `gitupcms-gscmcp` binary (`npm link` puts it on your `PATH`).

## Deploy: Cloudflare Workers

Configuration is in `wrangler.jsonc`: one Durable Object class `GscHub` (binding `GSC_HUB`) holds the rate limiter, cache, pauses, tokens and inspection history. Key files are not available on Workers, so the key goes in a secret as JSON (or use the three `GOOGLE_OAUTH_*` secrets instead, see [OAuth setup](#oauth-setup)).

```bash
npm ci
npx wrangler secret put GOOGLE_SERVICE_ACCOUNT_JSON   # paste the whole key JSON (service account)
npx wrangler secret put ADMIN_TOKEN                   # openssl rand -hex 32
# optional, legacy: npx wrangler secret put MCP_AUTH_TOKEN
npm run cf:check                                      # dry-run build
npm run cf:deploy                                     # wrangler deploy
curl https://<your-worker>.workers.dev/healthz
```

Other settings (`ALLOWED_HOSTS`, `GSC_ALLOWED_SITES`, `TOKEN_TTL_DAYS`, `MCP_PATH`, ...) go in `"vars"` in `wrangler.jsonc`. `HOST`, `PORT`, `DATA_DIR` and `GOOGLE_APPLICATION_CREDENTIALS` do not apply on Workers. `npm run cf:dev` runs it locally.

## Token management

Clients authenticate with `Authorization: Bearer <token>`. Tokens are issued by the server when `ADMIN_TOKEN` is set; without it the `/admin/tokens` routes return 404.

- Format: `gsc_<16 hex id>_<secret>`. Only the SHA-256 of the secret is stored; the full token is shown once.
- **TTL:** `ttlDays` (1-365), default `TOKEN_TTL_DAYS` (90). Expired tokens are rejected.
- **allowedSites:** optional per-token property list, applied on top of `GSC_ALLOWED_SITES`.
- **Rotation:** issues a new secret and a fresh expiry. With `graceMinutes` (max 10080 = 7 days) the old secret keeps working that long; default 0 invalidates it immediately.
- **Expiry warning:** MCP responses carry `X-Token-Expires-At` (ISO time) when the token expires within 7 days.
- **Legacy `MCP_AUTH_TOKEN`:** a single shared token (min. 32 chars), still accepted alongside issued tokens; the server logs a deprecation warning. At least one of `ADMIN_TOKEN` / `MCP_AUTH_TOKEN` must be set.

### HTTP API

All routes need `Authorization: Bearer $ADMIN_TOKEN`.

| Method and path | Body | Result |
|---|---|---|
| `POST /admin/tokens` | `{ "name", "ttlDays"?, "allowedSites"? }` | 201, the new token (with `token`) |
| `GET /admin/tokens` | | `{ "tokens": [...] }` (no secrets) |
| `POST /admin/tokens/:id/rotate` | `{ "ttlDays"?, "graceMinutes"? }` | The token with its new `token`; 404 if unknown or revoked |
| `DELETE /admin/tokens/:id` | | The revoked token; 404 if unknown |

```bash
curl -s -X POST https://gsc-mcp.example.com/admin/tokens \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"claude-laptop","ttlDays":30,"allowedSites":["sc-domain:example.com"]}'
```

### CLI

`scripts/token.ts` calls the same API on a running server and reads `ADMIN_TOKEN` from the environment:

```bash
export ADMIN_TOKEN=...
npm run token -- create --url https://gsc-mcp.example.com --name claude-laptop [--ttl-days 90] [--sites https://a.com/,sc-domain:b.com]
npm run token -- list   --url https://gsc-mcp.example.com
npm run token -- rotate --url https://gsc-mcp.example.com --id <id> [--ttl-days 90] [--grace-minutes 60]
npm run token -- revoke --url https://gsc-mcp.example.com --id <id>
```

## Connect a client

- **Endpoint:** `https://gsc-mcp.example.com/mcp` (or your `MCP_PATH`). Streamable HTTP, stateless, POST only.
- **Header:** `Authorization: Bearer <token>`.

Claude Code:

```bash
export GSC_MCP_TOKEN='gsc_...'
claude mcp add --transport http --scope user gsc https://gsc-mcp.example.com/mcp \
  --header "Authorization: Bearer $GSC_MCP_TOKEN"
claude mcp list
```

The shell expands the token, so it is saved in plain text in `~/.claude.json`. To share with a team, commit a `.mcp.json` using `"headers": { "Authorization": "Bearer ${GSC_MCP_TOKEN}" }` instead.

## Claude Code / Cursor / OpenCode plugin

The repository is also a plugin for Claude Code (`.claude-plugin/plugin.json`) and Cursor (`.cursor-plugin/plugin.json`). It bundles the four workflows as skills (`skills/*/SKILL.md`, the same steps as the prompts) and connects to your remote HTTP server through two environment variables:

```bash
export GSC_MCP_URL='https://gsc-mcp.example.com/mcp'
export GSC_MCP_TOKEN='gsc_...'
```

- Claude Code reads `.mcp.json`, which uses Claude Code's `${VAR}` expansion in `url` and `headers`.
- Cursor reads `mcp.json`, which uses Cursor's `${env:VAR}` syntax. This was written from Cursor's documentation and not tested against every Cursor version; if your Cursor does not expand it, put the URL and header in `~/.cursor/mcp.json` directly.

- OpenCode reads `opencode.json` (`{env:VAR}` substitution) and loads the skills from `.opencode/skills` (a symlink to `skills/`). OpenCode resolves `{env:VAR}` in the process that loads the config: if you run the background service (`opencode serve --service`), start it with these variables set, or use `opencode --standalone`. For a local server, use a `"type": "local"` entry with `"command": ["node", "/path/to/dist/node/index.js", "--stdio"]` and the Google variables in `"environment"`.

Install it with your client's plugin command pointed at this repository (or a local clone). To run the server locally instead, replace the server entry with the stdio example from [Local stdio](#local-stdio-claude-desktop--claude-code--cursor).

Quick check with curl (HTTP server):

```bash
curl -s https://gsc-mcp.example.com/mcp \
  -H "Authorization: Bearer $GSC_MCP_TOKEN" \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_sites","arguments":{}}}'
```

## Configuration reference

| Variable | Default | Description |
|---|---|---|
| `MCP_TRANSPORT` | `http` | `http` or `stdio` (Node only; the `--stdio` flag does the same) |
| `ADMIN_TOKEN` | (off) | Enables `/admin/tokens`. Min. 32 chars |
| `MCP_AUTH_TOKEN` | (off) | Legacy shared bearer token. Min. 32 chars. One of these two is required over HTTP, neither under stdio |
| `TOKEN_TTL_DAYS` | `90` | Default lifetime of issued tokens (1-365) |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | | The key JSON itself. Required on Workers; takes precedence on Node |
| `GOOGLE_APPLICATION_CREDENTIALS` | | Path to the key file (Node only) |
| `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` / `GOOGLE_OAUTH_REFRESH_TOKEN` | | OAuth sign-in (all three; token from `npm run oauth:login`). Set either these or a service account key, not both |
| `DATA_DIR` | `./data` (`/data` in Docker, `~/.gitupcms-gscmcp` under stdio) | Writable state directory (Node only) |
| `HOST` / `PORT` | `0.0.0.0` / `3000` | Listen address (Node only) |
| `HOST_PORT` | `3000` | Docker Compose: port published on `127.0.0.1` |
| `MCP_PATH` | `/mcp` | MCP endpoint path. No trailing slash; not `/healthz` or under `/admin` |
| `ALLOWED_HOSTS` | (off) | Comma-separated hostnames accepted in the `Host` header (DNS-rebinding protection); applies to the MCP and admin routes |
| `GSC_ALLOWED_SITES` | (all) | Comma-separated properties any client may read. Recommended with OAuth |
| `QUOTA_SAFETY_FACTOR` | `0.8` | Share of Google's published limits to use (>0, ≤1) |
| `MAX_QUEUE_WAIT_MS` | `15000` | Max wait for a rate-limit or concurrency slot before `LOCAL_RATE_LIMIT` |
| `MAX_CONCURRENCY` | `4` | Parallel Google API calls (1-32) |
| `GSC_MAX_ROWS_PER_CALL` | `25000` | Max rows per Search Analytics call (≤50,000) |
| `CACHE_ENABLED` | `true` | `false` turns off the response cache |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |

Invalid values stop startup with a list of problems (on Workers, requests return 500 "Server misconfigured" and the log says why).

## Quota model

Google's published limits ([source](https://developers.google.com/webmaster-tools/limits)), enforced locally at `QUOTA_SAFETY_FACTOR` (default 0.8, a 20% safety margin):

| API | Google limit | Enforced at 0.8 |
|---|---|---|
| Search Analytics | 1,200 QPM per site and per user | 960/min |
| URL Inspection | 600 QPM and **2,000 QPD** per property | 480/min, **1,600/day** |
| Sites, sitemaps | 20 QPS and 200 QPM per user | 16/s, 160/min |

- **URL inspection is the scarce resource:** about 2,000 per property per day. Tools that inspect on their own take `maxInspections` (default and max 25; `find_ctr_opportunities` uses `inspectTop`) and report `quotaUsed` and what is left. Cached inspections (1 h) are free. Check `get_quota_status` before large audits.
- **Waiting:** a full window or concurrency cap makes a call wait up to `MAX_QUEUE_WAIT_MS`, then fail with `LOCAL_RATE_LIMIT` and `retryAfterSeconds`.
- **Daily counters** reset at midnight Pacific Time and are persisted (`quota-state`), so restarts don't reset them.
- **Quota errors pause, not retry.** Google returns the same error for every quota, so a quota error on Search Analytics or URL Inspection pauses that property: 15 min, then 1 h, then until midnight Pacific if errors continue without a success in between. Quota errors on 3 properties within 10 min pause Search Analytics for every property for 5 min. Pauses are persisted (`pause-state`).
- **Shared budget:** Google counts per property and per Google account, so other tools using the same properties draw from the same quota.
- **Cache lifetimes:** final analytics 6 h, fresh analytics 5 min, sites and sitemaps 15 min, inspections 1 h. `bypassCache: true` forces a fresh fetch.

## Index watch: compare before and after a deploy

Catch pages falling out of the index before traffic drops. Every non-cached inspection is recorded automatically, so there is nothing to save by hand:

1. Before a deploy, inspect the pages you care about: `inspect_top_pages { "siteUrl": "sc-domain:example.com" }` (or `batch_inspect_urls`).
2. A few days after the deploy, inspect them again (same call; use `bypassCache: true` on `batch_inspect_urls` if the cache is still warm).
3. Compare against the deploy time: `index_diff { "siteUrl": "sc-domain:example.com", "since": "2026-11-17T14:00:00Z" }`. For each URL it compares the latest record with the last one at or before `since` and returns only changed pages, `verdictLost` first. Other change flags: `verdictRecovered`, `verdictChanged`, `coverageStateChanged`, `canonicalMismatch`, `crawlStale`. `since` also accepts `YYYY-MM-DD`; without it each URL's two latest records are compared.

`find_deindexed_pages` reads the recorded results at no inspection cost.

## Limitations

- **Workers: one global Durable Object.** All requests go through a single `GscHub` instance (`idFromName('global')`) so quota state is consistent. That serializes the server in one location; it is fine for a handful of agents, not for high traffic. `/healthz` is answered by the Worker without touching the Durable Object.
- **Top pages are capped at 1,000.** "Top pages by impressions" (`inspect_top_pages`, `find_deindexed_pages`) comes from one Search Analytics request with `rowLimit` 1,000. Google sorts by clicks, so on large sites pages with many impressions but few clicks can be missed. Inspect those with `batch_inspect_urls`.
- **Snapshots cover at most 25 URLs per call** (the inspection cap); larger sets need several calls and more quota.
- **Data lag:** final data lags 2-3 days; dates are Pacific Time. Use `dataState: "all"` for fresher, incomplete data.
- **Stateless transport only:** GET/DELETE on the MCP path return 405; clients needing the old HTTP+SSE transport are not supported. Local clients can use stdio instead.
- **Sorting is per response:** `sortBy` reorders the rows Google returned. Google always picks rows by clicks, so sorting by position or CTR does not find rows beyond `rowLimit`.

## Development

```bash
npm install
npm test             # vitest, no Google access needed
npm run typecheck    # core (no Node types), Node and Worker builds
npm run build        # dist/ for Node
npm run cf:check     # Worker dry-run build
npm run dev          # tsx watch src/node/index.ts (set the env vars first)
```

Layout:

```
src/
  app.ts              Hono app: bearer auth, Host check, MCP endpoint, /healthz, /admin/tokens
  core/               runtime-agnostic (Web APIs only): config, tools, Google client, limits, tokens, state
  node/               Node adapter: @hono/node-server or stdio, FileStateStore
  worker/             Workers adapter: GscHub Durable Object, DoStateStore
scripts/token.ts      token admin CLI
scripts/oauth-login.ts  OAuth refresh-token helper (npm run oauth:login)
test/                 vitest tests with an in-memory fake of the Google API
skills/               Claude Code / Cursor skills (the prompt workflows)
.claude-plugin/ .cursor-plugin/ .mcp.json mcp.json  plugin manifests and the remote server entry
```

## License

[MIT](LICENSE)

## Privacy

This is a self-hosted server: it runs on your own machine, server or Cloudflare account, and nobody else operates it. Search Console data goes only from Google to your server and from there to the MCP clients you give a token to. The server stores quota counters, token hashes and recent URL inspection summaries in its own storage (`DATA_DIR` or the Durable Object). It sends no telemetry and uses no third-party services besides Google's APIs.
