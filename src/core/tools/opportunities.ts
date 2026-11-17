import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { GscService } from '../google/service.js';
import { addDays, ptDay } from '../time.js';
import { bypassCacheSchema, handle, READ_ONLY, siteUrlSchema, type ToolDeps } from './common.js';
import { mergePeriods } from './comparePeriods.js';
import { FINAL_DATA_LAG_DAYS } from './overview.js';
import { DEFAULT_FETCH_ALL_ROWS, runSearchAnalytics, searchAnalyticsInput, type SearchAnalyticsInput } from './searchAnalytics.js';
import { HISTORY_NOTE, inspectCapped, MAX_BATCH_URLS } from './urlInspection.js';

const daysSchema = z.number().int().min(1).max(180).optional().describe('Length of each period in days (default 28).');
const limitSchema = z.number().int().min(1).max(100).optional().describe('Items to return (default 20).');
const rowsSchema = z
  .number()
  .int()
  .min(1)
  .optional()
  .describe(`page+query rows fetched per period, by clicks (default ${DEFAULT_FETCH_ALL_ROWS.toLocaleString('en-US')}, capped by the server limit).`);

/** The last `days` days of final data, and the `days` before them. */
function periods(days: number) {
  const end = addDays(ptDay(Date.now()), -FINAL_DATA_LAG_DAYS);
  const start = addDays(end, -(days - 1));
  return { current: { startDate: start, endDate: end }, previous: { startDate: addDays(start, -days), endDate: addDays(start, -1) } };
}

const r1 = (n: number) => Number(n.toFixed(1));
const r4 = (n: number) => Number(n.toFixed(4));

export interface CtrOpportunityArgs {
  siteUrl: string;
  days?: number;
  type?: SearchAnalyticsInput['type'];
  minImpressions?: number;
  minImpressionGrowthPct?: number;
  minCtrDropPct?: number;
  rowsPerPeriod?: number;
  limit?: number;
  inspectTop?: number;
  bypassCache?: boolean;
}

export async function runFindCtrOpportunities(service: GscService, a: CtrOpportunityArgs, maxRowsPerCall: number, signal?: AbortSignal) {
  const siteUrl = service.site(a.siteUrl);
  const days = a.days ?? 28;
  const minImpressions = a.minImpressions ?? 100;
  const minGrowth = a.minImpressionGrowthPct ?? 10;
  const minDrop = a.minCtrDropPct ?? 20;
  const { current, previous } = periods(days);
  const query = (p: { startDate: string; endDate: string }) =>
    runSearchAnalytics(
      service,
      { siteUrl, ...p, dimensions: ['page', 'query'], type: a.type, fetchAll: true, maxRows: a.rowsPerPeriod ?? DEFAULT_FETCH_ALL_ROWS, bypassCache: a.bypassCache },
      maxRowsPerCall,
      signal,
    );
  const [cur, prev] = await Promise.all([query(current), query(previous)]);
  const merged = mergePeriods(2, { rows: cur.rows, complete: !cur.truncated }, { rows: prev.rows, complete: !prev.truncated });

  const byPage = new Map<string, { page: string; estimatedLostClicks: number; impressions: number; queries: Record<string, unknown>[] }>();
  for (const m of merged) {
    if (m.status !== 'both') continue;
    const ci = m.cur.impressions ?? 0;
    const pi = m.prev.impressions ?? 0;
    if (ci < minImpressions || ci <= pi || !pi) continue;
    // From clicks/impressions, not the rounded ctr column.
    const cc = (m.cur.clicks ?? 0) / ci;
    const pc = (m.prev.clicks ?? 0) / pi;
    if (!pc || cc >= pc) continue;
    const growth = ((ci - pi) / pi) * 100;
    const drop = ((pc - cc) / pc) * 100;
    if (growth < minGrowth || drop < minDrop) continue;
    const lost = ci * (pc - cc); // clicks the page would have had at the old CTR
    const [page, q] = m.keys as [string, string];
    const entry = byPage.get(page) ?? { page, estimatedLostClicks: 0, impressions: 0, queries: [] };
    entry.estimatedLostClicks += lost;
    entry.impressions += ci;
    entry.queries.push({
      query: q,
      impressions: ci,
      previousImpressions: pi,
      impressionGrowthPct: r1(growth),
      ctr: r4(cc),
      previousCtr: r4(pc),
      ctrDropPct: r1(drop),
      position: m.cur.position,
      previousPosition: m.prev.position,
      estimatedLostClicks: r1(lost),
    });
    byPage.set(page, entry);
  }
  const todo = [...byPage.values()]
    .sort((x, y) => y.estimatedLostClicks - x.estimatedLostClicks)
    .slice(0, a.limit ?? 20)
    .map((p, i) => ({
      priority: i + 1,
      ...p,
      estimatedLostClicks: r1(p.estimatedLostClicks),
      queries: p.queries.sort((x, y) => (y.estimatedLostClicks as number) - (x.estimatedLostClicks as number)).slice(0, 10),
      queryCount: p.queries.length,
    }));

  let inspection: Record<string, unknown> = {};
  if (a.inspectTop && todo.length) {
    const batch = await inspectCapped(service, siteUrl, todo.map((p) => p.page), a.inspectTop, signal);
    const byUrl = new Map(batch.results.map((r) => [r.inspectionUrl as string, r]));
    for (const p of todo) {
      const r = byUrl.get(p.page);
      if (r) Object.assign(p, { index: r.error || r.skipped ? { error: r.error, skipped: r.skipped } : pick(r) });
    }
    inspection = { quotaUsed: batch.quotaUsed, urlInspectionQuota: batch.quota, ...(batch.stoppedReason ? { stoppedReason: batch.stoppedReason } : {}) };
  }

  return {
    siteUrl,
    type: a.type ?? 'web',
    current,
    previous,
    thresholds: { minImpressions, minImpressionGrowthPct: minGrowth, minCtrDropPct: minDrop },
    pages: todo,
    matchingPages: byPage.size,
    allRowsFetched: !cur.truncated && !prev.truncated,
    quotaUsed: 0,
    ...inspection,
    note: 'estimatedLostClicks = current impressions x (previous CTR - current CTR): clicks the page would have had at its old CTR. Work top down.',
  };
}

function pick(r: Record<string, unknown>) {
  return { verdict: r.verdict, coverageState: r.coverageState, googleCanonical: r.googleCanonical, userCanonical: r.userCanonical, lastCrawlTime: r.lastCrawlTime };
}

export interface CannibalizationArgs {
  siteUrl: string;
  days?: number;
  type?: CtrOpportunityArgs['type'];
  minQueryImpressions?: number;
  minPageSharePct?: number;
  rows?: number;
  limit?: number;
  bypassCache?: boolean;
}

export async function runFindCannibalization(service: GscService, a: CannibalizationArgs, maxRowsPerCall: number, signal?: AbortSignal) {
  const siteUrl = service.site(a.siteUrl);
  const { current } = periods(a.days ?? 28);
  const minQuery = a.minQueryImpressions ?? 10;
  const minShare = a.minPageSharePct ?? 10;
  const res = await runSearchAnalytics(
    service,
    { siteUrl, ...current, dimensions: ['query', 'page'], type: a.type, fetchAll: true, maxRows: a.rows ?? DEFAULT_FETCH_ALL_ROWS, bypassCache: a.bypassCache },
    maxRowsPerCall,
    signal,
  );
  const byQuery = new Map<string, { page: string; clicks: number; impressions: number; ctr: number | null; position: number | null }[]>();
  for (const row of res.rows) {
    const [q, page, clicks, impressions, ctr, position] = row as [string, string, number, number, number | null, number | null];
    const list = byQuery.get(q) ?? [];
    list.push({ page, clicks, impressions, ctr, position });
    byQuery.set(q, list);
  }
  const cases = [];
  for (const [query, pages] of byQuery) {
    const impressions = pages.reduce((n, p) => n + p.impressions, 0);
    const clicks = pages.reduce((n, p) => n + p.clicks, 0);
    if (impressions < minQuery) continue;
    const competing = pages
      .filter((p) => (p.impressions / impressions) * 100 >= minShare)
      .sort((x, y) => y.impressions - x.impressions)
      .map((p) => ({ ...p, impressionSharePct: r1((p.impressions / impressions) * 100), clickSharePct: clicks ? r1((p.clicks / clicks) * 100) : null }));
    if (competing.length < 2) continue;
    const positions = competing.map((p) => p.position).filter((p): p is number => p != null);
    cases.push({
      query,
      impressions,
      clicks,
      pageCount: competing.length,
      positionSpread: positions.length ? r1(Math.max(...positions) - Math.min(...positions)) : null,
      pages: competing,
    });
  }
  cases.sort((x, y) => y.impressions - x.impressions);
  return {
    siteUrl,
    type: a.type ?? 'web',
    period: current,
    thresholds: { minQueryImpressions: minQuery, minPageSharePct: minShare },
    cases: cases.slice(0, a.limit ?? 20),
    matchingQueries: cases.length,
    rowsFetched: res.rowCount,
    allRowsFetched: !res.truncated,
    quotaUsed: 0,
  };
}

export function registerOpportunityTools(server: McpServer, { service, logger, maxRowsPerCall }: ToolDeps): void {
  server.registerTool(
    'find_ctr_opportunities',
    {
      title: 'Find CTR opportunities',
      description:
        'A prioritized to-do list of pages whose impressions grew while CTR fell: compares the last N days of final data with the N days ' +
        'before, per page+query, keeps rows passing the thresholds and groups them by page, ranked by estimated lost clicks. Usually means ' +
        'the title/snippet no longer wins the click (or a SERP feature took it). Two page+query queries per call. inspectTop>0 also ' +
        `inspects that many top pages (max ${MAX_BATCH_URLS}; see quotaUsed). ` +
        HISTORY_NOTE,
      inputSchema: {
        siteUrl: siteUrlSchema,
        days: daysSchema,
        type: searchAnalyticsInput.type,
        minImpressions: z.number().int().min(0).optional().describe('Minimum current-period impressions per page+query (default 100).'),
        minImpressionGrowthPct: z.number().min(0).optional().describe('Minimum impressions growth in percent (default 10).'),
        minCtrDropPct: z.number().min(0).max(100).optional().describe('Minimum relative CTR drop in percent (default 20).'),
        rowsPerPeriod: rowsSchema,
        limit: limitSchema,
        inspectTop: z.number().int().min(0).max(MAX_BATCH_URLS).optional().describe(`Inspect the top N pages of the list (default 0, max ${MAX_BATCH_URLS}).`),
        bypassCache: bypassCacheSchema,
      },
      annotations: READ_ONLY,
    },
    handle(logger, (args: CtrOpportunityArgs, { signal }) => runFindCtrOpportunities(service, args, maxRowsPerCall, signal)),
  );

  server.registerTool(
    'find_cannibalization',
    {
      title: 'Find keyword cannibalization',
      description:
        'Queries where two or more pages of the property each get a real share of the impressions over the last N days of final data, ' +
        "with each page's impression and click share, CTR and position, largest queries first. Consolidate to the page with the better " +
        'position/CTR (canonical, redirect or merge). One query+page request per call; anonymized queries are not included.',
      inputSchema: {
        siteUrl: siteUrlSchema,
        days: daysSchema,
        type: searchAnalyticsInput.type,
        minQueryImpressions: z.number().int().min(0).optional().describe('Ignore queries with fewer impressions in total (default 10).'),
        minPageSharePct: z.number().min(0).max(50).optional().describe("A page competes when it has at least this share of the query's impressions (default 10)."),
        rows: rowsSchema,
        limit: limitSchema,
        bypassCache: bypassCacheSchema,
      },
      annotations: READ_ONLY,
    },
    handle(logger, (args: CannibalizationArgs, { signal }) => runFindCannibalization(service, args, maxRowsPerCall, signal)),
  );
}
