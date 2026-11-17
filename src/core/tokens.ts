import { sha256, singleTokenVerifier, timingSafeEqual, type AuthContext, type VerifyToken } from './auth.js';
import type { Logger } from './logger.js';
import type { StateStore } from './state.js';

const KEY = 'tokens';
const DAY_MS = 86_400_000;
const LAST_USED_EVERY_MS = 5 * 60_000;
export const MAX_TTL_DAYS = 365;
/** Responses carry X-Token-Expires-At when the token expires within this window. */
export const EXPIRY_WARNING_MS = 7 * DAY_MS;

/** A stored token. The plain secret is never stored, only its SHA-256. */
export interface StoredToken {
  id: string;
  name: string;
  hash: string;
  createdAt: string;
  expiresAt: string;
  allowedSites?: string[];
  lastUsedAt?: string;
  revokedAt?: string;
  /** Previous secret after a rotation, valid until `prevValidUntil`. */
  prevHash?: string;
  prevValidUntil?: string;
}

export type TokenInfo = Omit<StoredToken, 'hash' | 'prevHash'>;

/** A freshly issued token; `token` is shown only once. */
export interface IssuedToken extends TokenInfo {
  token: string;
}

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const fromHex = (s: string) => new Uint8Array((s.match(/../g) ?? []).map((h) => parseInt(h, 16)));
const random = (n: number) => crypto.getRandomValues(new Uint8Array(n));
const base64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const info = ({ hash: _h, prevHash: _p, ...rest }: StoredToken): TokenInfo => rest;

/** Multi-token registry kept in one StateStore entry ("tokens"), cached in memory. */
export class TokenStore {
  private tokens?: Promise<Record<string, StoredToken>>;
  private writes: Promise<void> = Promise.resolve();

  constructor(
    private readonly store: StateStore,
    private readonly logger?: Logger,
    private readonly now: () => number = Date.now,
  ) {}

  private load(): Promise<Record<string, StoredToken>> {
    return (this.tokens ??= this.store.get<Record<string, StoredToken>>(KEY).then(
      (t) => t ?? {},
      (err) => {
        this.tokens = undefined; // retry on the next call
        throw err;
      },
    ));
  }

  /** Serialized whole-map writes, so concurrent saves can't interleave. */
  private save(tokens: Record<string, StoredToken>): Promise<void> {
    const write = this.writes.then(() => this.store.put(KEY, tokens));
    this.writes = write.catch(() => {});
    return write;
  }

  private async issue(t: Omit<StoredToken, 'hash'>, tokens: Record<string, StoredToken>): Promise<IssuedToken> {
    const secret = base64url(random(32));
    tokens[t.id] = { ...t, hash: hex(await sha256(secret)) };
    await this.save(tokens);
    return { ...info(tokens[t.id]!), token: `gsc_${t.id}_${secret}` };
  }

  async create(name: string, ttlDays: number, allowedSites?: string[]): Promise<IssuedToken> {
    const tokens = await this.load();
    const now = this.now();
    const t = {
      id: hex(random(8)),
      name,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + Math.min(ttlDays, MAX_TTL_DAYS) * DAY_MS).toISOString(),
      ...(allowedSites ? { allowedSites } : {}),
    };
    return this.issue(t, tokens);
  }

  async list(): Promise<TokenInfo[]> {
    return Object.values(await this.load()).map(info);
  }

  /**
   * New secret and a fresh expiry. The old secret stays valid for `graceMinutes` (0 = invalid now).
   * Returns undefined for unknown or revoked tokens.
   */
  async rotate(id: string, ttlDays: number, graceMinutes = 0): Promise<IssuedToken | undefined> {
    const tokens = await this.load();
    const old = tokens[id];
    if (!old || old.revokedAt) return undefined;
    const now = this.now();
    const { hash, prevHash: _p, prevValidUntil: _v, ...rest } = old;
    const grace = graceMinutes > 0 ? { prevHash: hash, prevValidUntil: new Date(now + graceMinutes * 60_000).toISOString() } : {};
    return this.issue({ ...rest, ...grace, expiresAt: new Date(now + Math.min(ttlDays, MAX_TTL_DAYS) * DAY_MS).toISOString() }, tokens);
  }

  /** Returns undefined for unknown tokens; revoking twice keeps the first time. */
  async revoke(id: string): Promise<TokenInfo | undefined> {
    const tokens = await this.load();
    const t = tokens[id];
    if (!t) return undefined;
    t.revokedAt ??= new Date(this.now()).toISOString();
    await this.save(tokens);
    return info(t);
  }

  readonly verify: VerifyToken = async (token) => {
    const m = /^gsc_([0-9a-f]{16})_([A-Za-z0-9_-]{43})$/.exec(token);
    if (!m) return null;
    const tokens = await this.load();
    const t = tokens[m[1]!];
    const now = this.now();
    if (!t || t.revokedAt || now >= Date.parse(t.expiresAt)) return null;
    const h = await sha256(m[2]!);
    const ok =
      timingSafeEqual(h, fromHex(t.hash)) ||
      (!!t.prevHash && !!t.prevValidUntil && now < Date.parse(t.prevValidUntil) && timingSafeEqual(h, fromHex(t.prevHash)));
    if (!ok) return null;
    if (!t.lastUsedAt || now - Date.parse(t.lastUsedAt) >= LAST_USED_EVERY_MS) {
      t.lastUsedAt = new Date(now).toISOString();
      this.save(tokens).catch((err: Error) => this.logger?.warn('failed to save token lastUsedAt', { id: t.id, error: err.message }));
    }
    const ctx: AuthContext = { tokenId: t.id, expiresAt: t.expiresAt };
    if (t.allowedSites) ctx.allowedSites = t.allowedSites;
    return ctx;
  };
}

/** Store tokens, plus MCP_AUTH_TOKEN as a "legacy" token when set. */
export function combinedVerifier(tokens: TokenStore, legacyToken?: string): VerifyToken {
  const legacy = legacyToken ? singleTokenVerifier(legacyToken) : undefined;
  return async (token) => (await tokens.verify(token)) ?? (legacy && (await legacy(token)) ? { tokenId: 'legacy' } : null);
}
