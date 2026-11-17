import type { Logger } from './logger.js';

/** Persistent key-value storage (a file on Node, Durable Object storage on Workers). */
export interface StateStore {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
}

/** In-memory StateStore, for tests and single-process use without persistence. */
export class MemoryStateStore implements StateStore {
  readonly data = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | undefined> {
    return structuredClone(this.data.get(key)) as T | undefined;
  }
  async put(key: string, value: unknown): Promise<void> {
    this.data.set(key, structuredClone(value));
  }
  async delete(key: string): Promise<void> {
    this.data.delete(key);
  }
}

/**
 * One state entry with coalesced writes. Failures are logged, never thrown:
 * in-memory state stays authoritative.
 */
export class StoredState<T> {
  private writing: Promise<void> | undefined;
  private dirty = false;
  private latest: (() => T) | undefined;

  constructor(
    private readonly store: StateStore | undefined,
    readonly key: string,
    private readonly label: string,
    private readonly logger?: Logger,
  ) {}

  async read(): Promise<T | undefined> {
    if (!this.store) return undefined;
    try {
      return await this.store.get<T>(this.key);
    } catch (err) {
      this.logger?.warn(`${this.label} unreadable, starting fresh`, { key: this.key, error: (err as Error).message });
      return undefined;
    }
  }

  /** Schedules a save of `data()`, evaluated when the write happens. */
  save(data: () => T): void {
    const store = this.store;
    if (!store) return;
    this.latest = data;
    this.dirty = true;
    if (this.writing) return;
    this.writing = (async () => {
      while (this.dirty) {
        this.dirty = false;
        try {
          await store.put(this.key, this.latest!());
        } catch (err) {
          this.logger?.error(`failed to save ${this.label}`, { key: this.key, error: (err as Error).message });
        }
      }
    })().finally(() => {
      this.writing = undefined;
    });
  }

  /** Waits for pending writes to finish. */
  async flush(): Promise<void> {
    while (this.writing) await this.writing;
  }
}
