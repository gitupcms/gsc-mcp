import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { ADMIN_MAX_FAILURES } from '../src/core/admin.js';
import { loadConfig } from '../src/core/config.js';
import { silentLogger } from '../src/core/logger.js';
import { redirectAllowed } from '../src/core/oauth.js';
import { MemoryStateStore } from '../src/core/state.js';
import { combinedVerifier, TokenStore } from '../src/core/tokens.js';
import { fakeApi, makeService } from './helpers.js';

const ADMIN = 'admin-token-0123456789abcdef0123456789abcdef';
const base = 'https://gsc.example.com';
const CALLBACK = 'https://claude.ai/api/mcp/auth_callback';

const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const VERIFIER = 'v'.repeat(50);
const challengeOf = async (v: string) => b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(v))));

function setup(opts: { admin?: boolean; oauth?: boolean; publicUrl?: string } = {}) {
  const clock = { now: Date.parse('2026-01-01T00:00:00Z') };
  const store = new MemoryStateStore();
  const tokens = new TokenStore(store, silentLogger, () => clock.now);
  const app = createApp({
    verifyToken: combinedVerifier(tokens),
    deps: { service: makeService(fakeApi()), logger: silentLogger, maxRowsPerCall: 25_000 },
    logger: silentLogger,
    admin: opts.admin === false ? undefined : { adminToken: ADMIN, tokens, defaultTtlDays: 90, now: () => clock.now },
    oauth: opts.oauth === false ? undefined : { store, publicUrl: opts.publicUrl },
  });
  const form = (path: string, fields: Record<string, string>) =>
    app.request(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields).toString() });

  async function register(redirect = CALLBACK) {
    const res = await app.request(`${base}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: [redirect] }) });
    return { res, body: (await res.json()) as { client_id: string; error?: string } };
  }

  async function authorize(clientId: string, adminToken = ADMIN, redirect = CALLBACK) {
    return form('/oauth/authorize', {
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirect,
      code_challenge: await challengeOf(VERIFIER),
      code_challenge_method: 'S256',
      state: 'xyz',
      admin_token: adminToken,
    });
  }

  async function getCode(clientId: string) {
    const res = await authorize(clientId);
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get('location')!);
    expect(loc.origin + loc.pathname).toBe(CALLBACK);
    expect(loc.searchParams.get('state')).toBe('xyz');
    return loc.searchParams.get('code')!;
  }

  const exchange = (clientId: string, code: string, verifier = VERIFIER) =>
    form('/oauth/token', { grant_type: 'authorization_code', client_id: clientId, code, redirect_uri: CALLBACK, code_verifier: verifier });
  const refresh = (clientId: string, token: string) => form('/oauth/token', { grant_type: 'refresh_token', client_id: clientId, refresh_token: token });

  return { clock, store, tokens, app, register, authorize, getCode, exchange, refresh };
}

async function listSites(app: ReturnType<typeof setup>['app'], token: string) {
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
      fetch: async (url, init) => app.request(url instanceof URL ? url.href : url, init),
    }),
  );
  const res = await client.callTool({ name: 'list_sites', arguments: {} });
  await client.close();
  return res;
}

type TokenResponse = { access_token: string; refresh_token: string; token_type: string; expires_in: number; error?: string };

describe('OAuth', () => {
  it('runs the full flow: register, consent, exchange, MCP call, refresh rotation', async () => {
    const s = setup();
    const { res: reg, body } = await s.register();
    expect(reg.status).toBe(201);
    expect(body).toMatchObject({ token_endpoint_auth_method: 'none', redirect_uris: [CALLBACK] });

    const params = new URLSearchParams({
      response_type: 'code',
      client_id: body.client_id,
      redirect_uri: CALLBACK,
      code_challenge: await challengeOf(VERIFIER),
      code_challenge_method: 'S256',
      state: '<script>',
    });
    const page = await s.app.request(`${base}/oauth/authorize?${params}`);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(page.headers.get('x-frame-options')).toBe('DENY');
    const html = await page.text();
    expect(html).toContain('type="password"');
    expect(html).not.toContain('<script>');

    const code = await s.getCode(body.client_id);
    expect([...s.store.data.keys()].some((k) => k.startsWith('oauth-code:') && !k.includes(code))).toBe(true);
    const tokRes = await s.exchange(body.client_id, code);
    expect(tokRes.status).toBe(200);
    expect(tokRes.headers.get('cache-control')).toBe('no-store');
    const tok = (await tokRes.json()) as TokenResponse;
    expect(tok).toMatchObject({ token_type: 'Bearer', expires_in: 90 * 86_400 });
    expect(tok.access_token).toMatch(/^gsc_/);
    expect((await s.tokens.list())[0]!.name).toBe(`oauth:claude ${body.client_id.slice(0, 8)}`);

    expect((await listSites(s.app, tok.access_token)).isError).toBeFalsy();

    const r1 = await s.refresh(body.client_id, tok.refresh_token);
    expect(r1.status).toBe(200);
    const tok2 = (await r1.json()) as TokenResponse;
    expect(tok2.access_token).not.toBe(tok.access_token);
    expect(tok2.refresh_token).not.toBe(tok.refresh_token);
    expect((await listSites(s.app, tok2.access_token)).isError).toBeFalsy();

    const reused = await s.refresh(body.client_id, tok.refresh_token);
    expect(reused.status).toBe(400);
    expect(await reused.json()).toMatchObject({ error: 'invalid_grant' });
  });

  it('rejects a bad PKCE verifier and a reused code', async () => {
    const s = setup();
    const { body } = await s.register();
    const bad = await s.exchange(body.client_id, await s.getCode(body.client_id), 'w'.repeat(50));
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: 'invalid_grant' });

    const code = await s.getCode(body.client_id);
    expect((await s.exchange(body.client_id, code)).status).toBe(200);
    const again = await s.exchange(body.client_id, code);
    expect(again.status).toBe(400);
    expect(await again.json()).toMatchObject({ error: 'invalid_grant' });
  });

  it('rejects expired codes', async () => {
    const s = setup();
    const { body } = await s.register();
    const code = await s.getCode(body.client_id);
    s.clock.now += 61_000;
    expect(await (await s.exchange(body.client_id, code)).json()).toMatchObject({ error: 'invalid_grant' });
  });

  it('allows only Claude callbacks, loopback and configured redirect URIs', async () => {
    const s = setup();
    const { res, body } = await s.register('https://evil.example.com/cb');
    expect(res.status).toBe(400);
    expect(body.error).toBe('invalid_redirect_uri');
    expect((await s.register('http://localhost:33418/callback')).res.status).toBe(201);
    expect((await s.authorize('c1', ADMIN, 'https://evil.example.com/cb')).status).toBe(400);

    expect(redirectAllowed('https://claude.com/api/mcp/auth_callback')).toBe(true);
    expect(redirectAllowed('http://127.0.0.1:5000/x')).toBe(true);
    expect(redirectAllowed('https://localhost/x')).toBe(false);
    expect(redirectAllowed('http://localhost.evil.com/x')).toBe(false);
    expect(redirectAllowed('https://claude.ai/api/mcp/auth_callback/x')).toBe(false);
    expect(redirectAllowed('https://my.example.com/cb', ['https://my.example.com/cb'])).toBe(true);
  });

  it('re-renders on a wrong admin token and shares the admin lockout', async () => {
    const s = setup();
    const wrong = await s.authorize('c1', 'nope');
    expect(wrong.status).toBe(401);
    expect(await wrong.text()).toContain('Wrong ADMIN_TOKEN');
    for (let i = 1; i < ADMIN_MAX_FAILURES; i++) await s.authorize('c1', 'nope');
    const locked = await s.authorize('c1');
    expect(locked.status).toBe(429);
    expect(locked.headers.get('retry-after')).toBeTruthy();
    // The same lockout covers the admin API.
    expect((await s.app.request(`${base}/admin/tokens`, { headers: { authorization: `Bearer ${ADMIN}` } })).status).toBe(429);
  });

  it('serves metadata whose resource equals the MCP URL', async () => {
    const s = setup();
    for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
      expect(await (await s.app.request(`${base}${path}`)).json()).toMatchObject({ resource: `${base}/mcp`, authorization_servers: [base] });
    }
    expect(await (await s.app.request(`${base}/.well-known/oauth-authorization-server`)).json()).toMatchObject({
      issuer: base,
      token_endpoint: `${base}/oauth/token`,
      registration_endpoint: `${base}/oauth/register`,
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
    });
    const proxied = setup({ publicUrl: 'https://public.example.com' });
    expect(await (await proxied.app.request('http://127.0.0.1/.well-known/oauth-protected-resource')).json()).toMatchObject({
      resource: 'https://public.example.com/mcp',
    });
  });

  it('points 401 responses at the resource metadata', async () => {
    const s = setup();
    const res = await s.app.request(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe(`Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"`);
  });

  it('has no OAuth routes without ADMIN_TOKEN', async () => {
    const s = setup({ admin: false });
    expect((await s.app.request(`${base}/.well-known/oauth-protected-resource`)).status).toBe(404);
    expect((await s.app.request(`${base}/.well-known/oauth-authorization-server`)).status).toBe(404);
    expect((await s.register()).res.status).toBe(404);
    const res = await s.app.request(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(res.headers.get('www-authenticate')).toBe('Bearer');
  });

  it('ends OAuth access when the token is revoked', async () => {
    const s = setup();
    const { body } = await s.register();
    const tok = (await (await s.exchange(body.client_id, await s.getCode(body.client_id))).json()) as TokenResponse;
    await s.tokens.revoke((await s.tokens.list())[0]!.id);
    const res = await s.refresh(body.client_id, tok.refresh_token);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid_grant' });
  });

  it('rejects unsupported grant types', async () => {
    const s = setup();
    const res = await s.app.request(`${base}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'grant_type=password' });
    expect(await res.json()).toMatchObject({ error: 'unsupported_grant_type' });
  });

  it('validates PUBLIC_URL and OAUTH_REDIRECT_URIS', () => {
    const env = { ADMIN_TOKEN: ADMIN, GOOGLE_SERVICE_ACCOUNT_JSON: '{}' };
    expect(loadConfig({ ...env, PUBLIC_URL: 'https://gsc.example.com/' }).PUBLIC_URL).toBe('https://gsc.example.com');
    expect(() => loadConfig({ ...env, PUBLIC_URL: 'https://gsc.example.com/mcp' })).toThrow(/PUBLIC_URL/);
    expect(() => loadConfig({ ...env, OAUTH_REDIRECT_URIS: 'not a url' })).toThrow(/not a URL/);
    expect(() => loadConfig({ ...env, MCP_PATH: '/oauth' })).toThrow(/MCP_PATH/);
  });
});
