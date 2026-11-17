import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { ADMIN_FAILURE_WINDOW_MS, ADMIN_MAX_FAILURES } from '../src/core/admin.js';
import { silentLogger } from '../src/core/logger.js';
import { MemoryStateStore } from '../src/core/state.js';
import { combinedVerifier, TokenStore, type IssuedToken } from '../src/core/tokens.js';
import { fakeApi, makeService } from './helpers.js';

const ADMIN = 'admin-token-0123456789abcdef0123456789abcdef';
const LEGACY = 'legacy-token-0123456789abcdef0123456789abcdef';
const DAY = 86_400_000;
const base = 'http://127.0.0.1';

function setup(opts: { admin?: boolean; allowedSites?: string[]; now?: number } = {}) {
  const clock = { now: opts.now ?? Date.parse('2026-01-01T00:00:00Z') };
  const store = new MemoryStateStore();
  const tokens = new TokenStore(store, silentLogger, () => clock.now);
  const app = createApp({
    verifyToken: combinedVerifier(tokens, LEGACY),
    deps: { service: makeService(fakeApi(), { allowedSites: opts.allowedSites }), logger: silentLogger, maxRowsPerCall: 25_000 },
    logger: silentLogger,
    admin: opts.admin === false ? undefined : { adminToken: ADMIN, tokens, defaultTtlDays: 90, now: () => clock.now },
  });
  const admin = (method: string, path: string, body?: unknown, token = ADMIN) =>
    app.request(`${base}/admin/tokens${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  return { clock, store, tokens, app, admin };
}

describe('TokenStore', () => {
  it('creates a token that verifies, without storing the secret', async () => {
    const { tokens, store } = setup();
    const t = await tokens.create('ci', 30, ['sc-domain:example.org']);
    expect(t.token).toMatch(/^gsc_[0-9a-f]{16}_[A-Za-z0-9_-]{43}$/);
    expect(t.expiresAt).toBe('2026-01-31T00:00:00.000Z');
    expect(await tokens.verify(t.token)).toEqual({ tokenId: t.id, allowedSites: ['sc-domain:example.org'], expiresAt: t.expiresAt });
    const secret = t.token.split('_').slice(2).join('_');
    expect(JSON.stringify([...store.data.values()])).not.toContain(secret);
    expect(await tokens.verify(t.token.slice(0, -1) + (t.token.endsWith('A') ? 'B' : 'A'))).toBeNull();
    expect(await tokens.verify(`gsc_0000000000000000_${secret}`)).toBeNull();
  });

  it('rejects expired and revoked tokens', async () => {
    const { tokens, clock } = setup();
    const a = await tokens.create('a', 1);
    const b = await tokens.create('b', 10);
    clock.now += DAY;
    expect(await tokens.verify(a.token)).toBeNull();
    expect(await tokens.verify(b.token)).not.toBeNull();
    await tokens.revoke(b.id);
    expect(await tokens.verify(b.token)).toBeNull();
    expect(await tokens.rotate(b.id, 10)).toBeUndefined();
  });

  it('caps the TTL at 365 days', async () => {
    const { tokens } = setup();
    expect((await tokens.create('x', 9999)).expiresAt).toBe('2027-01-01T00:00:00.000Z');
  });

  it('rotates immediately by default, or keeps the old secret for a grace period', async () => {
    const { tokens, clock } = setup();
    const t = await tokens.create('x', 30);
    const r1 = (await tokens.rotate(t.id, 30))!;
    expect(await tokens.verify(t.token)).toBeNull();
    expect(await tokens.verify(r1.token)).not.toBeNull();
    const r2 = (await tokens.rotate(t.id, 30, 10))!;
    expect(await tokens.verify(r1.token)).not.toBeNull();
    expect(await tokens.verify(r2.token)).not.toBeNull();
    clock.now += 10 * 60_000;
    expect(await tokens.verify(r1.token)).toBeNull();
    expect(await tokens.verify(r2.token)).not.toBeNull();
  });

  it('writes lastUsedAt at most every 5 minutes', async () => {
    const { tokens, store, clock } = setup();
    const t = await tokens.create('x', 30);
    const lastUsed = () => (store.data.get('tokens') as Record<string, { lastUsedAt?: string }>)[t.id]!.lastUsedAt;
    await tokens.verify(t.token);
    await new Promise((r) => setTimeout(r, 0));
    const first = lastUsed();
    expect(first).toBe('2026-01-01T00:00:00.000Z');
    clock.now += 60_000;
    await tokens.verify(t.token);
    await new Promise((r) => setTimeout(r, 0));
    expect(lastUsed()).toBe(first);
    clock.now += 5 * 60_000;
    await tokens.verify(t.token);
    await new Promise((r) => setTimeout(r, 0));
    expect(lastUsed()).toBe('2026-01-01T00:06:00.000Z');
  });

  it('still accepts the legacy MCP_AUTH_TOKEN', async () => {
    const { tokens } = setup();
    const verify = combinedVerifier(tokens, LEGACY);
    expect(await verify(LEGACY)).toEqual({ tokenId: 'legacy' });
    expect(await verify('nope')).toBeNull();
  });
});

describe('admin API', () => {
  it('is 404 when ADMIN_TOKEN is not set', async () => {
    const { admin } = setup({ admin: false });
    expect((await admin('GET', '')).status).toBe(404);
    expect((await admin('POST', '', { name: 'x' })).status).toBe(404);
  });

  it('requires the admin bearer', async () => {
    const { admin } = setup();
    expect((await admin('GET', '', undefined, LEGACY)).status).toBe(401);
    expect((await admin('GET', '', undefined, 'x')).status).toBe(401);
  });

  it('creates, lists, rotates and revokes', async () => {
    const { admin, app } = setup();
    const created = await admin('POST', '', { name: 'claude', ttlDays: 30 });
    expect(created.status).toBe(201);
    const t = (await created.json()) as IssuedToken;
    expect(t).toMatchObject({ name: 'claude', expiresAt: '2026-01-31T00:00:00.000Z' });

    const list = (await (await admin('GET', '')).json()) as { tokens: Record<string, unknown>[] };
    expect(list.tokens).toHaveLength(1);
    expect(list.tokens[0]).not.toHaveProperty('hash');
    expect(list.tokens[0]).not.toHaveProperty('token');

    const rotated = await admin('POST', `/${t.id}/rotate`, { graceMinutes: 5 });
    expect(rotated.status).toBe(200);
    const r = (await rotated.json()) as IssuedToken;
    expect(r.token).not.toBe(t.token);

    const del = await admin('DELETE', `/${t.id}`);
    expect(del.status).toBe(200);
    expect(await del.json()).toHaveProperty('revokedAt');
    const mcp = await app.request(`${base}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${r.token}` } });
    expect(mcp.status).toBe(401);

    expect((await admin('DELETE', '/ffffffffffffffff')).status).toBe(404);
    expect((await admin('POST', '/ffffffffffffffff/rotate', {})).status).toBe(404);
  });

  it('locks after too many failed logins, then recovers', async () => {
    const { admin, clock } = setup();
    for (let i = 0; i < ADMIN_MAX_FAILURES; i++) expect((await admin('GET', '', undefined, 'wrong')).status).toBe(401);
    const locked = await admin('GET', '');
    expect(locked.status).toBe(429);
    expect(Number(locked.headers.get('retry-after'))).toBe(ADMIN_FAILURE_WINDOW_MS / 1000);
    clock.now += ADMIN_FAILURE_WINDOW_MS;
    expect((await admin('GET', '')).status).toBe(200);
  });

  it('validates input', async () => {
    const { admin } = setup();
    expect((await admin('POST', '', {})).status).toBe(400);
    expect((await admin('POST', '', { name: 'x', ttlDays: 366 })).status).toBe(400);
    expect((await admin('POST', '', { name: 'x', allowedSites: [] })).status).toBe(400);
  });
});

describe('issued tokens over MCP', () => {
  async function connect(app: ReturnType<typeof setup>['app'], token: string) {
    let expiresHeader: string | null = null;
    const client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
        fetch: async (url, init) => {
          const res = await app.request(url instanceof URL ? url.href : url, init);
          expiresHeader = res.headers.get('x-token-expires-at');
          return res;
        },
      }),
    );
    return { client, expiresHeader: () => expiresHeader };
  }

  it('intersects token allowedSites with GSC_ALLOWED_SITES', async () => {
    const { app, tokens } = setup({ allowedSites: ['https://www.example.com/', 'sc-domain:example.org'] });
    const t = await tokens.create('x', 30, ['sc-domain:example.org', 'https://other.example/']);
    const { client } = await connect(app, t.token);
    const list = await client.callTool({ name: 'list_sites', arguments: {} });
    expect(list.structuredContent).toMatchObject({ count: 1, sites: [{ siteUrl: 'sc-domain:example.org' }] });
    for (const siteUrl of ['https://www.example.com/', 'https://other.example/']) {
      const denied = await client.callTool({ name: 'get_site', arguments: { siteUrl } });
      expect(JSON.parse((denied.content as { text: string }[])[0]!.text)).toMatchObject({ error: { code: 'SITE_NOT_ALLOWED' } });
    }
    await client.close();
  });

  it('sends X-Token-Expires-At only within 7 days of expiry', async () => {
    // The header check uses the real clock.
    const { app, tokens } = setup({ now: Date.now() });
    const far = await connect(app, (await tokens.create('far', 30)).token);
    await far.client.listTools();
    expect(far.expiresHeader()).toBeNull();
    const soon = await tokens.create('soon', 7);
    const near = await connect(app, soon.token);
    await near.client.listTools();
    expect(near.expiresHeader()).toBe(soon.expiresAt);
    await far.client.close();
    await near.client.close();
  });
});
