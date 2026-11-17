import type { UrlInspectionResult } from './google/client.js';
import type { Logger } from './logger.js';
import type { StateStore } from './state.js';

/** Inspections kept per URL; older ones are dropped. */
export const MAX_HISTORY_PER_URL = 5;
/** URLs tracked per property; the least recently inspected ones are dropped. */
export const MAX_TRACKED_URLS = 1_000;

/** The fields of an inspection that index_diff compares. */
export interface PageIndexState {
  verdict?: string | null;
  coverageState?: string | null;
  indexingState?: string | null;
  robotsTxtState?: string | null;
  pageFetchState?: string | null;
  lastCrawlTime?: string | null;
  googleCanonical?: string | null;
  userCanonical?: string | null;
}

export interface HistoryEntry extends PageIndexState {
  at: string;
}

export function pickState(i: PageIndexState = {}): PageIndexState {
  return {
    verdict: i.verdict,
    coverageState: i.coverageState,
    indexingState: i.indexingState,
    robotsTxtState: i.robotsTxtState,
    pageFetchState: i.pageFetchState,
    lastCrawlTime: i.lastCrawlTime,
    googleCanonical: i.googleCanonical,
    userCanonical: i.userCanonical,
  };
}

// Site URLs contain "/", which must not reach a file name (Node's store keeps one file per key).
const enc = encodeURIComponent;
const urlsKey = (site: string) => `inspected:${enc(site)}`;
const entriesKey = (site: string, url: string) => `inspection:${enc(site)}:${enc(url)}`;

/**
 * The server's own record of fresh URL inspections, kept like the quota counters: an internal side
 * effect of inspecting, not something a tool writes. One key per URL keeps values small (Durable
 * Object storage caps value size); a per-site list of URLs lets index_diff find them.
 */
export class InspectionHistory {
  // Writes run one at a time, so concurrent inspections can't lose each other's read-modify-write.
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly store: StateStore,
    private readonly logger: Logger,
  ) {}

  /** Saves one fresh inspection. Never throws: losing history must not fail the inspection. */
  record(site: string, url: string, result: UrlInspectionResult, now = Date.now()): Promise<void> {
    const entry: HistoryEntry = { at: new Date(now).toISOString(), ...pickState(result.indexStatusResult) };
    this.queue = this.queue
      .then(async () => {
        const entries = [...(await this.entries(site, url)), entry].slice(-MAX_HISTORY_PER_URL);
        await this.store.put(entriesKey(site, url), entries);
        const urls = [...(await this.urls(site)).filter((u) => u !== url), url];
        const dropped = urls.splice(0, Math.max(0, urls.length - MAX_TRACKED_URLS));
        await this.store.put(urlsKey(site), urls);
        await Promise.all(dropped.map((u) => this.store.delete(entriesKey(site, u))));
      })
      .catch((err) => this.logger.warn('failed to save inspection history', { site, error: (err as Error).message }));
    return this.queue;
  }

  /** URLs with history, least recently inspected first. */
  async urls(site: string): Promise<string[]> {
    return (await this.store.get<string[]>(urlsKey(site))) ?? [];
  }

  /** Inspections of one URL, oldest first. */
  async entries(site: string, url: string): Promise<HistoryEntry[]> {
    return (await this.store.get<HistoryEntry[]>(entriesKey(site, url))) ?? [];
  }
}
