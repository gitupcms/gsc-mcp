import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { GscToolError } from '../errors.js';
import type { GscService } from '../google/service.js';
import { MAX_HISTORY_PER_URL, pickState, type HistoryEntry, type InspectionHistory, type PageIndexState } from '../inspectionHistory.js';
import { addDays, ptDay } from '../time.js';
import { handle, READ_ONLY, siteUrlSchema, type ToolDeps } from './common.js';
import { HISTORY_NOTE, inspectCapped, MAX_BATCH_URLS, maxInspectionsSchema } from './urlInspection.js';

export const DEFAULT_STALE_CRAWL_DAYS = 30;
const DAY_MS = 86_400_000;

function history(service: GscService): InspectionHistory {
  if (!service.history) throw new GscToolError('INTERNAL', 'This server has no state storage, so inspection history is unavailable.');
  return service.history;
}

/** Pages with impressions in the last `days` days, most impressions first. */
export async function pagesWithImpressions(service: GscService, siteUrl: string, days: number, signal?: AbortSignal) {
  const today = ptDay(Date.now());
  // shortcut: Google sorts rows by clicks, so this ranks only the top 1,000 pages by clicks; raise rowLimit if big sites miss pages.
  const { value } = await service.querySearchAnalytics(
    siteUrl,
    { startDate: addDays(today, -days), endDate: today, dimensions: ['page'], rowLimit: 1_000 },
    undefined,
    { signal },
  );
  return (value.rows ?? [])
    .filter((r) => r.keys?.[0] && (r.impressions ?? 0) > 0)
    .map((r) => ({ page: r.keys![0]!, clicks: r.clicks ?? 0, impressions: r.impressions ?? 0 }))
    .sort((a, b) => b.impressions - a.impressions);
}

const quotaOf = (service: GscService, site: string) => service.quotaStatus([site]).sites[0]?.urlInspectionToday;

export async function runInspectTopPages(service: GscService, args: { siteUrl: string; maxInspections?: number }, signal?: AbortSignal) {
  const siteUrl = service.site(args.siteUrl);
  const pages = await pagesWithImpressions(service, siteUrl, 28, signal);
  const batch = await inspectCapped(service, siteUrl, pages.map((p) => p.page), args.maxInspections ?? MAX_BATCH_URLS, signal);
  return {
    siteUrl,
    pagesWithImpressions: pages.length,
    inspected: batch.inspected,
    notPassing: batch.results
      .filter((r) => !r.error && !r.skipped && r.verdict !== 'PASS')
      .map((r) => ({ url: r.inspectionUrl, verdict: r.verdict, coverageState: r.coverageState })),
    failed: batch.failed,
    skipped: batch.skipped,
    ...(batch.stoppedReason ? { stoppedReason: batch.stoppedReason } : {}),
    quotaUsed: batch.quotaUsed,
    urlInspectionQuota: batch.quota,
  };
}

const mismatch = (s: PageIndexState) => !!s.googleCanonical && !!s.userCanonical && s.googleCanonical !== s.userCanonical;
const crawlStale = (s: PageIndexState, atMs: number, staleMs: number) => {
  const t = s.lastCrawlTime ? Date.parse(s.lastCrawlTime) : NaN;
  return Number.isFinite(t) && atMs - t > staleMs;
};

/** How one URL's index state got worse or changed between two inspections; [] if unchanged. */
export function diffEntries(before: HistoryEntry, after: HistoryEntry, staleCrawlDays = DEFAULT_STALE_CRAWL_DAYS): string[] {
  const staleMs = staleCrawlDays * DAY_MS;
  const c: string[] = [];
  if (before.verdict !== after.verdict) c.push(before.verdict === 'PASS' ? 'verdictLost' : after.verdict === 'PASS' ? 'verdictRecovered' : 'verdictChanged');
  if (before.coverageState !== after.coverageState) c.push('coverageStateChanged');
  if (mismatch(after) && !mismatch(before)) c.push('canonicalMismatch');
  if (crawlStale(after, Date.parse(after.at), staleMs) && !crawlStale(before, Date.parse(before.at), staleMs)) c.push('crawlStale');
  return c;
}

/** The instant `since` stands for: a date (end of that day, UTC) or an ISO timestamp. */
function resolveSince(since: string): number {
  const t = /^\d{4}-\d{2}-\d{2}$/.test(since) ? Date.parse(`${since}T00:00:00Z`) + DAY_MS - 1 : Date.parse(since);
  if (!Number.isFinite(t)) throw new GscToolError('INVALID_ARGUMENT', 'since must be a YYYY-MM-DD date or an ISO timestamp.');
  return t;
}

export async function runIndexDiff(service: GscService, args: { siteUrl: string; since?: string; staleCrawlDays?: number }) {
  const siteUrl = service.site(args.siteUrl);
  const hist = history(service);
  const cutoff = args.since === undefined ? undefined : resolveSince(args.since);
  const urls = await hist.urls(siteUrl);
  if (!urls.length) throw new GscToolError('NOT_FOUND', `No inspections of ${siteUrl} recorded yet. Run inspect_top_pages or batch_inspect_urls first.`);
  const changes: { url: string; changes: string[]; before: HistoryEntry; after: HistoryEntry }[] = [];
  let compared = 0;
  let noBaseline = 0;
  let notInspectedSince = 0;
  for (const [url, entries] of await Promise.all(urls.map(async (u) => [u, await hist.entries(siteUrl, u)] as const))) {
    const after = entries.at(-1);
    if (!after) continue;
    if (cutoff !== undefined && Date.parse(after.at) <= cutoff) {
      notInspectedSince++;
      continue;
    }
    const before = cutoff === undefined ? entries.at(-2) : entries.slice(0, -1).findLast((e) => Date.parse(e.at) <= cutoff);
    if (!before) {
      noBaseline++;
      continue;
    }
    compared++;
    const c = diffEntries(before, after, args.staleCrawlDays);
    if (c.length) changes.push({ url, changes: c, before, after });
  }
  // Lost pages first: they are the ones about to lose traffic.
  changes.sort((x, y) => Number(y.changes.includes('verdictLost')) - Number(x.changes.includes('verdictLost')));
  return {
    siteUrl,
    ...(cutoff !== undefined ? { since: new Date(cutoff).toISOString() } : {}),
    trackedUrls: urls.length,
    compared,
    changes,
    // URLs left out: no earlier inspection to compare with, or (with since) none after it.
    noBaseline,
    ...(cutoff !== undefined ? { notInspectedSince } : {}),
  };
}

export async function runFindDeindexed(
  service: GscService,
  args: { siteUrl: string; live?: boolean; maxInspections?: number },
  signal?: AbortSignal,
) {
  const siteUrl = service.site(args.siteUrl);
  const pages = await pagesWithImpressions(service, siteUrl, 28, signal);
  const common = { siteUrl, pagesWithImpressions: pages.length };
  if (!args.live && service.history) {
    const hist = service.history;
    const tracked = new Set(await hist.urls(siteUrl));
    const known = (
      await Promise.all(pages.filter((p) => tracked.has(p.page)).map(async (p) => ({ ...p, last: (await hist.entries(siteUrl, p.page)).at(-1) })))
    ).filter((p) => p.last);
    if (known.length) {
      return {
        ...common,
        source: 'history',
        checked: known.length,
        deindexed: known.flatMap(({ last, ...p }) => (last!.verdict !== 'PASS' ? [{ ...p, ...last!, inspectedAt: last!.at }] : [])),
        quotaUsed: 0,
        urlInspectionQuota: quotaOf(service, siteUrl),
      };
    }
  }
  const batch = await inspectCapped(service, siteUrl, pages.map((p) => p.page), args.maxInspections ?? MAX_BATCH_URLS, signal);
  const byUrl = new Map(pages.map((p) => [p.page, p]));
  const deindexed = batch.results.flatMap((r) =>
    !r.error && !r.skipped && r.verdict !== 'PASS' ? [{ ...byUrl.get(r.inspectionUrl as string)!, ...pickState(r as PageIndexState) }] : [],
  );
  return {
    ...common,
    source: 'live',
    checked: batch.inspected,
    deindexed,
    failed: batch.failed,
    skipped: batch.skipped,
    ...(batch.stoppedReason ? { stoppedReason: batch.stoppedReason } : {}),
    quotaUsed: batch.quotaUsed,
    urlInspectionQuota: batch.quota,
  };
}

export function registerIndexWatchTools(server: McpServer, { service, logger }: ToolDeps): void {
  server.registerTool(
    'inspect_top_pages',
    {
      title: 'Inspect the top pages',
      description:
        'Inspects the pages with the most impressions in the last 28 days, up to maxInspections, and lists those whose index verdict is not ' +
        `PASS. Cached inspections are free; see quotaUsed. ${HISTORY_NOTE} Run it before and after a change, then index_diff.`,
      inputSchema: { siteUrl: siteUrlSchema, maxInspections: maxInspectionsSchema },
      annotations: READ_ONLY,
    },
    handle(logger, (args: { siteUrl: string; maxInspections?: number }, { signal }) => runInspectTopPages(service, args, signal)),
  );

  server.registerTool(
    'index_diff',
    {
      title: 'Index changes between inspections',
      description:
        `Compares each URL's latest inspection with the one before it, or with the last one at or before \`since\` (the server keeps the last ` +
        `${MAX_HISTORY_PER_URL} fresh inspections per URL from every inspecting tool), and returns only pages that changed: verdictLost (was ` +
        'PASS), verdictRecovered/verdictChanged, coverageStateChanged, canonicalMismatch (Google newly picked a different canonical than the ' +
        'page declares) and crawlStale (last crawl newly older than staleCrawlDays). For "since the last deploy", pass the deploy time as since. ' +
        'No Google calls.',
      inputSchema: {
        siteUrl: siteUrlSchema,
        since: z.string().min(1).optional().describe('A YYYY-MM-DD date (end of that day, UTC) or an ISO timestamp, e.g. a deploy time. Default: the previous inspection.'),
        staleCrawlDays: z.number().int().min(1).max(365).optional().describe(`Crawl age that counts as stale (default ${DEFAULT_STALE_CRAWL_DAYS}).`),
      },
      annotations: { ...READ_ONLY, openWorldHint: false },
    },
    handle(logger, async (args: { siteUrl: string; since?: string; staleCrawlDays?: number }) => runIndexDiff(service, args)),
  );

  server.registerTool(
    'find_deindexed_pages',
    {
      title: 'Find pages dropped from the index',
      description:
        "Lists pages that had impressions in the last 28 days but whose index verdict is not PASS. Uses each page's latest recorded " +
        'inspection when there are any (no quota), otherwise or with live=true inspects the top pages by impressions, up to maxInspections; ' +
        `see quotaUsed. ${HISTORY_NOTE}`,
      inputSchema: {
        siteUrl: siteUrlSchema,
        live: z.boolean().optional().describe('Inspect now instead of reading recorded inspections.'),
        maxInspections: maxInspectionsSchema,
      },
      annotations: READ_ONLY,
    },
    handle(logger, (args: { siteUrl: string; live?: boolean; maxInspections?: number }, { signal }) => runFindDeindexed(service, args, signal)),
  );
}
