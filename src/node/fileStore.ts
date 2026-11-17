import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { StateStore } from '../core/state.js';

/**
 * Fails fast if `dir` can't hold the quota state. Without it the per-site
 * daily URL inspection counter would silently reset on every restart.
 */
export function ensureWritableDir(dir: string): void {
  const probe = join(dir, `.write-test-${process.pid}`);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(probe, 'ok');
    renameSync(probe, `${probe}.renamed`);
    unlinkSync(`${probe}.renamed`);
  } catch (err) {
    throw new Error(
      `DATA_DIR "${dir}" is not writable (${(err as NodeJS.ErrnoException).code ?? (err as Error).message}). ` +
        'Daily quota counters must persist across restarts; mount a writable volume there (the container runs as uid 1000).',
    );
  }
}

export const LOCK_STALE_MS = 90_000;

/**
 * Takes DATA_DIR for this process: two processes on one directory would overwrite
 * each other's quota counters and inspection history. A heartbeat keeps the lock
 * fresh; one older than LOCK_STALE_MS (a crashed process) is taken over.
 * Returns the release function.
 */
export function acquireDirLock(dir: string, now = Date.now): () => void {
  const file = join(dir, '.lock');
  const me = JSON.stringify({ pid: process.pid, host: hostname() });
  try {
    writeFileSync(file, me, { flag: 'wx' });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    let owner = '';
    try {
      owner = readFileSync(file, 'utf8');
    } catch {}
    const age = now() - statSync(file).mtimeMs;
    // Same pid and host means a restart of this same process slot (pid 1 in a container).
    if (age < LOCK_STALE_MS && owner !== me) {
      throw new Error(`DATA_DIR "${dir}" is in use by another process (${owner || 'unknown'}). Run one process per DATA_DIR, or wait ${Math.ceil((LOCK_STALE_MS - age) / 1000)} s if it just crashed.`);
    }
    writeFileSync(file, me);
  }
  const beat = setInterval(() => {
    try {
      const t = new Date(now());
      utimesSync(file, t, t);
    } catch {}
  }, LOCK_STALE_MS / 3);
  beat.unref();
  return () => {
    clearInterval(beat);
    rmSync(file, { force: true });
  };
}

/** One JSON file per key under `dir` ("quota-state" -> quota-state.json), written atomically. */
export class FileStateStore implements StateStore {
  constructor(readonly dir: string) {}

  private file(key: string): string {
    // Long keys (inspection history embeds the page URL) would exceed the 255-byte file name limit.
    const name = key.length > 200 ? `h-${createHash('sha256').update(key).digest('hex')}` : key;
    return join(this.dir, `${name}.json`);
  }

  async get<T>(key: string): Promise<T | undefined> {
    let text: string;
    try {
      text = await readFile(this.file(key), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw err;
    }
    return JSON.parse(text) as T;
  }

  async put(key: string, value: unknown): Promise<void> {
    const file = this.file(key);
    const tmp = `${file}.tmp`;
    const json = JSON.stringify(value);
    await mkdir(this.dir, { recursive: true });
    // flush: fsync before rename, so a crash can't leave an empty state file.
    await writeFile(tmp, json, { flush: true });
    await rename(tmp, file);
  }

  async delete(key: string): Promise<void> {
    await rm(this.file(key), { force: true });
  }
}
