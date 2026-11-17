import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { MAX_HISTORY_PER_URL } from './inspectionHistory.js';
import { registerPrompts } from './prompts.js';
import { registerCapabilityTools } from './tools/capabilities.js';
import type { ToolDeps } from './tools/common.js';
import { registerComparePeriodsTools } from './tools/comparePeriods.js';
import { registerIndexWatchTools } from './tools/indexWatch.js';
import { registerOpportunityTools } from './tools/opportunities.js';
import { registerOverviewTools } from './tools/overview.js';
import { registerQuotaTools } from './tools/quota.js';
import { registerSearchAnalyticsTools } from './tools/searchAnalytics.js';
import { registerSitemapTools } from './tools/sitemaps.js';
import { registerSiteTools } from './tools/sites.js';
import { MAX_BATCH_URLS, registerUrlInspectionTools } from './tools/urlInspection.js';

export const SERVER_NAME = 'gitupcms-gscmcp';
export const SERVER_VERSION = '0.1.0';

const INSTRUCTIONS = `Read-only access to Google Search Console (Search Console data is never changed).
Start with list_sites to get valid siteUrl values, get_capabilities for tools, sites and quota left, or get_site_overview for a quick summary of one property.
search_analytics_query returns performance data (clicks, impressions, CTR, position); "type" picks the search type (web, image for Google Images, video, news, discover, googleNews; discover and googleNews have no query data). Keep date ranges short and dimensions few where you can; query+page grouping over long ranges is expensive.
compare_periods compares two date ranges, as totals or matched per query/page/country/device, with the change for each row.
find_ctr_opportunities lists pages whose impressions grew while CTR fell, as a prioritized to-do list; find_cannibalization finds queries where several pages compete.
inspect_url / batch_inspect_urls show how Google indexed specific URLs; inspect_top_pages inspects the pages with the most impressions. find_deindexed_pages lists pages with impressions that are not indexed.
Every fresh inspection is kept on this server (last ${MAX_HISTORY_PER_URL} per URL), so index_diff can show what changed since the previous inspection or since a time you pass as since (e.g. your last deploy). No tool writes anything, here or in Search Console.
URL inspection quota is scarce: about 2,000 per property per day, and this server stops at a safety share of that (80% by default). Each call inspects at most ${MAX_BATCH_URLS} URLs: batch_inspect_urls takes up to ${MAX_BATCH_URLS} inspectionUrls, inspect_top_pages and find_deindexed_pages take maxInspections (default and max ${MAX_BATCH_URLS}), find_ctr_opportunities takes inspectTop (default 0, max ${MAX_BATCH_URLS}). Every inspecting tool reports quotaUsed; check get_quota_status before large audits.
Prompts seo-weekly-report, indexing-audit, content-opportunities and cannibalization-check give step-by-step workflows.
Dates are Pacific Time. Final data usually lags 2-3 days; use dataState "all" for fresher, incomplete data.
Errors come back as JSON with a code; LOCAL_RATE_LIMIT, LOAD_QUOTA_COOLDOWN and DAILY_QUOTA_EXHAUSTED include when to retry.`;

export function buildServer(baseDeps: ToolDeps): McpServer {
  // Every tool goes through the service, so scoping it applies the token's site limits everywhere.
  const deps = { ...baseDeps, service: baseDeps.service.scoped(baseDeps.auth?.allowedSites) };
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { instructions: INSTRUCTIONS });
  registerSiteTools(server, deps);
  registerSitemapTools(server, deps);
  registerSearchAnalyticsTools(server, deps);
  registerUrlInspectionTools(server, deps);
  registerOverviewTools(server, deps);
  registerComparePeriodsTools(server, deps);
  registerQuotaTools(server, deps);
  registerOpportunityTools(server, deps);
  registerIndexWatchTools(server, deps);
  registerCapabilityTools(server, deps);
  registerPrompts(server);
  return server;
}
