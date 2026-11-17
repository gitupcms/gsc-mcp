import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApiDataRow, SearchAnalyticsQueryRequest, UrlInspectionResult } from '../src/core/google/client.js';
import { MemoryStateStore } from '../src/core/state.js';
import { addDays, ptDay } from '../src/core/time.js';
import { silentLogger } from '../src/core/logger.js';
import { InspectionHistory, MAX_HISTORY_PER_URL, MAX_TRACKED_URLS } from '../src/core/inspectionHistory.js';
import { diffEntries, runFindDeindexed, runIndexDiff, runInspectTopPages } from '../src/core/tools/indexWatch.js';
import { runBatchInspection } from '../src/core/tools/urlInspection.js';
import { runFindCannibalization, runFindCtrOpportunities } from '../src/core/tools/opportunities.js';
import { FINAL_DATA_LAG_DAYS } from '../src/core/tools/overview.js';
import { fakeApi, makeService } from './helpers.js';

const site = 'sc-domain:a.com';
const u = (path: string) => `https://a.com/${path}`;
const row = (keys: string[], impressions: number, clicks: number, position = 5): ApiDataRow => ({ keys, impressions, clicks, ctr: clicks / impressions, position });

afterEach(() => {
  vi.useRealTimers();
});

describe('find_ctr_opportunities', () => {
  const current = [
    row([u('a'), 'q1'], 2000, 100), // impressions +100 %, CTR 10 % -> 5 %: in
    row([u('a'), 'q2'], 1050, 90), // impressions only +5 %: out
    row([u('b'), 'q3'], 300, 27), // CTR drop only 10 %: out by default
    row([u('c'), 'q4'], 50, 1), // below minImpressions: out
    row([u('c'), 'q5'], 1000, 50), // +100 %, 10 % -> 5 %: in
  ];
  const previous = [row([u('a'), 'q1'], 1000, 100), row([u('a'), 'q2'], 1000, 100), row([u('b'), 'q3'], 200, 20), row([u('c'), 'q4'], 20, 10), row([u('c'), 'q5'], 500, 50)];
  const currentStart = () => addDays(ptDay(Date.now()), -FINAL_DATA_LAG_DAYS - 27);

  function service() {
    const query = vi.fn(async (_s: string, body: SearchAnalyticsQueryRequest) => ({ rows: body.startDate === currentStart() ? current : previous }));
    const inspect = vi.fn(async () => ({ indexStatusResult: { verdict: 'PASS', coverageState: 'Submitted and indexed' } }));
    return { query, inspect, service: makeService(fakeApi({ querySearchAnalytics: query, inspectUrl: inspect })) };
  }

  it('keeps rows whose impressions grew and CTR fell past the thresholds, grouped by page', async () => {
    const { query, inspect, service: s } = service();
    const res = await runFindCtrOpportunities(s, { siteUrl: site }, 25_000);
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[0]![1].dimensions).toEqual(['page', 'query']);
    expect(res.pages.map((p) => [p.priority, p.page, p.estimatedLostClicks, p.queryCount])).toEqual([
      [1, u('a'), 100, 1],
      [2, u('c'), 50, 1],
    ]);
    expect(res.pages[0]!.queries[0]).toMatchObject({ query: 'q1', impressionGrowthPct: 100, ctr: 0.05, previousCtr: 0.1, ctrDropPct: 50 });
    expect(res.quotaUsed).toBe(0);
    expect(inspect).not.toHaveBeenCalled();

    const looser = await runFindCtrOpportunities(s, { siteUrl: site, minCtrDropPct: 5, minImpressions: 10 }, 25_000);
    expect(looser.pages.map((p) => p.page)).toEqual([u('a'), u('c'), u('b')]);
  });

  it('inspects only the top inspectTop pages and reports the quota used', async () => {
    const { inspect, service: s } = service();
    const res = await runFindCtrOpportunities(s, { siteUrl: site, inspectTop: 1 }, 25_000);
    expect(inspect).toHaveBeenCalledTimes(1);
    expect(res.pages[0]).toMatchObject({ index: { verdict: 'PASS' } });
    expect(res.pages[1]).not.toHaveProperty('index');
    expect(res).toMatchObject({ quotaUsed: 1, urlInspectionQuota: { used: 1 } });
  });

  it('rejects query data for discover before calling Google', async () => {
    const { query, service: s } = service();
    await expect(runFindCtrOpportunities(s, { siteUrl: site, type: 'discover' }, 25_000)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(query).not.toHaveBeenCalled();
  });
});

describe('find_cannibalization', () => {
  it('reports queries where several pages each get a real share', async () => {
    const rows = [
      row(['shoes', u('a')], 600, 30, 3),
      row(['shoes', u('b')], 300, 6, 8),
      row(['shoes', u('c')], 10, 0, 40), // ~1 % share: not competing
      row(['hats', u('a')], 500, 20),
      row(['tiny', u('a')], 3, 0),
      row(['tiny', u('b')], 3, 0),
    ];
    const s = makeService(fakeApi({ querySearchAnalytics: async () => ({ rows }) }));
    const res = await runFindCannibalization(s, { siteUrl: site }, 25_000);
    expect(res.matchingQueries).toBe(1);
    expect(res.cases[0]).toMatchObject({ query: 'shoes', impressions: 910, pageCount: 2, positionSpread: 5 });
    expect(res.cases[0]!.pages.map((p) => [p.page, p.impressionSharePct, p.clickSharePct])).toEqual([
      [u('a'), 65.9, 83.3],
      [u('b'), 33, 16.7],
    ]);
  });
});

describe('index watch', () => {
  const T0 = Date.parse('2026-11-01T12:00:00Z');
  const state: Record<string, UrlInspectionResult['indexStatusResult']> = {};
  const passing = (path: string) => ({
    verdict: 'PASS',
    coverageState: 'Submitted and indexed',
    lastCrawlTime: '2026-10-31T00:00:00Z',
    googleCanonical: u(path),
    userCanonical: u(path),
  });

  /** A fresh service per step, so the hour-long inspection cache doesn't hide the change. */
  function at(ms: number, store: MemoryStateStore, pages: string[] = ['a', 'b']) {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(ms);
    const inspect = vi.fn(async (body: { inspectionUrl: string }) => ({ indexStatusResult: state[body.inspectionUrl] }));
    const query = vi.fn(async () => ({ rows: pages.map((p, i) => row([u(p)], 100 - i, 5)) }));
    return { inspect, service: makeService(fakeApi({ inspectUrl: inspect, querySearchAnalytics: query }), { stateStore: store }) };
  }

  it('records fresh inspections and diffs them per URL, also since a given time', async () => {
    const store = new MemoryStateStore();
    state[u('a')] = passing('a');
    state[u('b')] = passing('b');
    const first = await runBatchInspection(at(T0, store).service, { siteUrl: site, inspectionUrls: [u('a'), u('b')] });
    expect(first.quotaUsed).toBe(2);

    state[u('a')] = { ...passing('a'), verdict: 'NEUTRAL', coverageState: 'Crawled - currently not indexed' };
    state[u('b')] = { ...passing('b'), googleCanonical: u('other') };
    expect(await runInspectTopPages(at(T0 + 86_400_000, store).service, { siteUrl: site })).toMatchObject({
      inspected: 2,
      quotaUsed: 2,
      notPassing: [{ url: u('a'), verdict: 'NEUTRAL' }],
    });
    await runInspectTopPages(at(T0 + 2 * 86_400_000, store).service, { siteUrl: site });

    const svc = at(T0 + 2 * 86_400_000, store).service;
    expect(await runIndexDiff(svc, { siteUrl: site })).toMatchObject({ trackedUrls: 2, compared: 2, changes: [] });
    const sinceDeploy = await runIndexDiff(svc, { siteUrl: site, since: new Date(T0 + 3_600_000).toISOString() });
    expect(sinceDeploy.changes.map((c) => [c.url, c.changes, c.before.at])).toEqual([
      [u('a'), ['verdictLost', 'coverageStateChanged'], new Date(T0).toISOString()],
      [u('b'), ['canonicalMismatch'], new Date(T0).toISOString()],
    ]);
    expect((await runIndexDiff(svc, { siteUrl: site, since: '2026-11-01' })).compared).toBe(2);
    expect(await runIndexDiff(svc, { siteUrl: site, since: '2026-10-01' })).toMatchObject({ compared: 0, noBaseline: 2 });
    expect(await runIndexDiff(svc, { siteUrl: site, since: '2026-12-01' })).toMatchObject({ compared: 0, notInspectedSince: 2 });
    await expect(runIndexDiff(svc, { siteUrl: site, since: 'deploy:v2' })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });

    const deindexed = await runFindDeindexed(svc, { siteUrl: site });
    expect(deindexed).toMatchObject({ source: 'history', checked: 2, quotaUsed: 0 });
    expect(deindexed.deindexed.map((d) => d.page)).toEqual([u('a')]);
  });

  it('does not record cached results', async () => {
    const store = new MemoryStateStore();
    state[u('a')] = passing('a');
    const { service: s } = at(T0, store);
    await s.inspectUrl(site, u('a'));
    expect((await s.inspectUrl(site, u('a'))).cached).toBe(true);
    expect(await s.history!.entries(site, u('a'))).toHaveLength(1);
    await s.inspectUrl(site, u('a'), undefined, true);
    expect(await s.history!.entries(site, u('a'))).toHaveLength(2);
  });

  it(`keeps the last ${MAX_HISTORY_PER_URL} inspections per URL`, async () => {
    const store = new MemoryStateStore();
    state[u('a')] = passing('a');
    for (let i = 0; i < MAX_HISTORY_PER_URL + 2; i++) await at(T0 + i * 1000, store).service.inspectUrl(site, u('a'));
    const entries = await at(T0, store).service.history!.entries(site, u('a'));
    expect(entries.map((e) => e.at)).toEqual(Array.from({ length: MAX_HISTORY_PER_URL }, (_, i) => new Date(T0 + (i + 2) * 1000).toISOString()));
    expect([...store.data.keys()].every((k) => !k.includes('/'))).toBe(true);
  });

  it(`tracks at most ${MAX_TRACKED_URLS} URLs per site, dropping the least recently inspected`, async () => {
    const store = new MemoryStateStore();
    const h = new InspectionHistory(store, silentLogger);
    for (let i = 0; i <= MAX_TRACKED_URLS; i++) await h.record(site, u(`p${i}`), { indexStatusResult: { verdict: 'PASS' } });
    const urls = await h.urls(site);
    expect(urls).toHaveLength(MAX_TRACKED_URLS);
    expect(urls[0]).toBe(u('p1'));
    expect(await h.entries(site, u('p0'))).toEqual([]);
  });

  it('flags crawls that went stale', () => {
    const before = { at: '2026-11-01T00:00:00Z', verdict: 'PASS', lastCrawlTime: '2026-10-25T00:00:00Z' };
    const after = { ...before, at: '2026-11-20T00:00:00Z' };
    expect(diffEntries(before, after, 30)).toEqual([]);
    expect(diffEntries(before, after, 14)).toEqual(['crawlStale']);
  });

  it('caps the inspections each tool spends', async () => {
    const pages = Array.from({ length: 40 }, (_, i) => `p${i}`);
    for (const p of pages) state[u(p)] = { ...passing(p), verdict: 'FAIL' };
    const store = new MemoryStateStore();

    let step = at(T0, store, pages);
    const top = await runInspectTopPages(step.service, { siteUrl: site, maxInspections: 5 });
    expect(step.inspect).toHaveBeenCalledTimes(5);
    expect(top).toMatchObject({ quotaUsed: 5, inspected: 5, urlInspectionQuota: { used: 5 } });

    step = at(T0, store, pages);
    expect(await runInspectTopPages(step.service, { siteUrl: site, maxInspections: 99 })).toMatchObject({ quotaUsed: 25 });
    expect(step.inspect).toHaveBeenCalledTimes(25);

    step = at(T0, store, pages);
    const live = await runFindDeindexed(step.service, { siteUrl: site, live: true, maxInspections: 3 });
    expect(step.inspect).toHaveBeenCalledTimes(3);
    expect(live).toMatchObject({ source: 'live', checked: 3, quotaUsed: 3 });
    expect(live.deindexed).toHaveLength(3);
  });

  it('inspects without a state store and only index_diff needs one', async () => {
    const s = makeService(fakeApi());
    expect((await runBatchInspection(s, { siteUrl: site, inspectionUrls: [u('a')] })).inspected).toBe(1);
    await expect(runIndexDiff(s, { siteUrl: site })).rejects.toMatchObject({ code: 'INTERNAL' });
  });
});
