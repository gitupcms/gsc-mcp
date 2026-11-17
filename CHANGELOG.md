# Changelog

## Unreleased

### Added

- **stdio transport (Node).** `node dist/node/index.js --stdio` or `MCP_TRANSPORT=stdio` (also `npm run start:stdio` and the `gitupcms-gscmcp` bin). No HTTP server, bearer auth or admin routes; `ADMIN_TOKEN`/`MCP_AUTH_TOKEN` are not required. `GSC_ALLOWED_SITES` and the `DATA_DIR` lock still apply; `DATA_DIR` defaults to `~/.gitupcms-gscmcp`. Logs go to stderr.
- **Claude Code / Cursor plugin.** `.claude-plugin/plugin.json`, `.cursor-plugin/plugin.json`, `.mcp.json` and `mcp.json` (remote HTTP server via `GSC_MCP_URL`/`GSC_MCP_TOKEN`), and four skills mirroring the prompts: `seo-weekly-report`, `indexing-audit`, `content-opportunities`, `cannibalization-check`.
- **`get_page_queries` tool.** Queries that bring traffic to one page (exact page filter); `pageUrl` must belong to the property. Defaults: last 28 days, 50 rows.
- **Sorting.** `sortBy` (`clicks`, `impressions`, `ctr`, `position`) and `sortDirection` on `search_analytics_query` and `get_page_queries`. Only the returned rows are sorted (Google picks them by clicks); the cache key is unchanged.
- **Relative dates.** `days` (1-480) on `search_analytics_query`, `compare_periods` and `get_page_queries`: the range ends 4 days before today in Pacific Time (1 day with `dataState` `"all"`). Combining `days` with explicit dates is `INVALID_ARGUMENT`; responses show the dates used.

### Changed

- `createLogger(level, target)` takes an optional `"stderr"` target.
- `startDate`/`endDate` on `search_analytics_query` and `currentStart`/`currentEnd` on `compare_periods` are optional in the schema; one of dates or `days` is required.
