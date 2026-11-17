import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

/** Guided workflows, adapted from mcp-gsc's skills to this server's tools. */
const PROMPTS: { name: string; title: string; description: string; text: (site: string) => string }[] = [
  {
    name: 'seo-weekly-report',
    title: 'Weekly SEO report',
    description: 'Performance snapshot, period-over-period change and alerts for one property.',
    text: (site) => `Write a weekly SEO report for ${site}.
1. get_site_overview (days 28): totals and change against the previous 28 days.
2. compare_periods with dimensions ["query"], sortBy "clicksLost", limit 20 (current = last 28 days of final data). Flag queries that lost more than 20% of their clicks.
3. search_analytics_query with dimensions ["query"], rowLimit 10: top queries by clicks.
Report as markdown: summary table, alerts with a one-line recommendation each, top 10 queries.`,
  },
  {
    name: 'indexing-audit',
    title: 'Indexing audit',
    description: 'Index status of the most visible pages, as a prioritized action list.',
    text: (site) => `Audit indexing for ${site}. URL inspections are scarce (~2,000 per property per day), so check get_quota_status first.
1. find_deindexed_pages (uses recorded inspections, or inspects the top pages) for pages with impressions that are not indexed. inspect_top_pages refreshes the top pages.
2. index_diff for what changed since each page's previous inspection (or since=<deploy time, ISO>).
3. For other doubts, batch_inspect_urls on a few URLs only.
Group findings: Critical (not indexed but has impressions), High (Google canonical differs from the declared one), Medium (robots.txt or fetch blocks), Low (soft exclusions). End with a table: URL | verdict | issue | action.`,
  },
  {
    name: 'content-opportunities',
    title: 'Content opportunities',
    description: 'Quick wins: page-2 rankings and pages whose CTR fell while impressions grew.',
    text: (site) => `Find content quick wins for ${site}.
1. find_ctr_opportunities (defaults): pages whose impressions grew but CTR fell, already prioritized.
2. search_analytics_query with dimensions ["query","page"], rowLimit 1000 for the last 28 days; keep rows with position 11-20, impressions > 100 and ctr < 0.03. Score = impressions x (0.05 - ctr).
Present a table (query | page | position | impressions | CTR | score), top 20, then concrete title/meta, internal-link or merge suggestions.`,
  },
  {
    name: 'cannibalization-check',
    title: 'Cannibalization check',
    description: 'Queries where several pages of the site compete.',
    text: (site) => `Check ${site} for keyword cannibalization.
1. find_cannibalization (defaults; raise minPageSharePct to cut noise).
2. For each case pick the page to keep (better position or CTR) and say whether to use a canonical, a redirect or a content merge.
Present a markdown table (query | pages with share/position | severity by impressions at stake) followed by a prioritized action list.`,
  },
];

export function registerPrompts(server: McpServer): void {
  for (const p of PROMPTS) {
    server.registerPrompt(
      p.name,
      { title: p.title, description: p.description, argsSchema: { siteUrl: z.string().min(1).describe('Search Console property, as list_sites returns it.') } },
      ({ siteUrl }) => ({ messages: [{ role: 'user', content: { type: 'text', text: p.text(siteUrl) } }] }),
    );
  }
}
