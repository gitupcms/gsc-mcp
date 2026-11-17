import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { describe, expect, it } from 'vitest';
import { createApp, type AppOptions } from '../src/app.js';
import { singleTokenVerifier } from '../src/core/auth.js';
import { loadConfig } from '../src/core/config.js';
import { silentLogger } from '../src/core/logger.js';
import { fakeApi, makeService } from './helpers.js';

const TOKEN = 'test-token-0123456789abcdef0123456789abcdef';

function makeApp(opts: Partial<AppOptions> = {}) {
  return createApp({
    verifyToken: singleTokenVerifier(TOKEN),
    deps: { service: makeService(fakeApi()), logger: silentLogger, maxRowsPerCall: 25_000 },
    logger: silentLogger,
    ...opts,
  });
}

const app = makeApp();
const base = 'http://127.0.0.1';

async function connect(token: string, target = app) {
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
      fetch: async (url, init) => target.request(url instanceof URL ? url.href : url, init),
    }),
  );
  return client;
}

describe('HTTP transport', () => {
  it('serves /healthz without auth', async () => {
    const res = await app.request(`${base}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  it('rejects missing and wrong tokens', async () => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
    const missing = await app.request(`${base}/mcp`, { method: 'POST', headers, body });
    expect(missing.status).toBe(401);
    expect(missing.headers.get('www-authenticate')).toBe('Bearer');
    expect((await app.request(`${base}/mcp`, { method: 'POST', headers: { ...headers, authorization: 'Bearer nope' }, body })).status).toBe(401);
  });

  it('lists exactly the read-only tools', async () => {
    const client = await connect(TOKEN);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'batch_inspect_urls',
      'compare_periods',
      'find_cannibalization',
      'find_ctr_opportunities',
      'find_deindexed_pages',
      'get_capabilities',
      'get_page_queries',
      'get_quota_status',
      'get_site',
      'get_site_overview',
      'get_sitemap',
      'index_diff',
      'inspect_top_pages',
      'inspect_url',
      'list_sitemaps',
      'list_sites',
      'search_analytics_query',
    ]);
    expect(tools.every((t) => t.annotations?.readOnlyHint === true)).toBe(true);
    expect(tools.every((t) => t.annotations?.destructiveHint === false)).toBe(true);
    const caps = await client.callTool({ name: 'get_capabilities', arguments: {} });
    expect((caps.structuredContent as { tools: unknown[] }).tools).toHaveLength(tools.length);
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name).sort()).toEqual(['cannibalization-check', 'content-opportunities', 'indexing-audit', 'seo-weekly-report']);
    await client.close();
  });

  it('calls a tool end to end', async () => {
    const client = await connect(TOKEN);
    const res = await client.callTool({ name: 'list_sites', arguments: {} });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toMatchObject({ count: 2, sites: [{ siteUrl: 'https://www.example.com/' }, { siteUrl: 'sc-domain:example.org' }] });
    const bad = await client.callTool({ name: 'get_site', arguments: { siteUrl: 'not a site' } });
    expect(bad.isError).toBe(true);
    expect(JSON.parse((bad.content as { text: string }[])[0]!.text)).toMatchObject({ error: { code: 'INVALID_ARGUMENT' } });
    await client.close();
  });

  it("limits tools to the token's allowed sites", async () => {
    const scoped = makeApp({ verifyToken: async (t) => (t === TOKEN ? { tokenId: 't1', allowedSites: ['sc-domain:example.org'] } : null) });
    const client = await connect(TOKEN, scoped);
    const list = await client.callTool({ name: 'list_sites', arguments: {} });
    expect(list.structuredContent).toMatchObject({ count: 1, sites: [{ siteUrl: 'sc-domain:example.org' }] });
    const denied = await client.callTool({ name: 'get_site', arguments: { siteUrl: 'https://www.example.com/' } });
    expect(JSON.parse((denied.content as { text: string }[])[0]!.text)).toMatchObject({ error: { code: 'SITE_NOT_ALLOWED' } });
    await client.close();
  });
});

describe('HTTP edge cases', () => {
  const auth = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });

  it('answers GET and DELETE with 405', async () => {
    const get = await app.request(`${base}/mcp`, { headers: auth });
    expect(get.status).toBe(405);
    expect(get.headers.get('allow')).toBe('POST');
    expect((await app.request(`${base}/mcp`, { method: 'DELETE', headers: auth })).status).toBe(405);
  });

  it('returns JSON 404 for unknown paths', async () => {
    const res = await app.request(`${base}/nope`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
  });

  it('returns JSON-RPC errors for bad JSON and oversized bodies', async () => {
    const bad = await app.request(`${base}/mcp`, { method: 'POST', headers: auth, body: '{not json' });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ jsonrpc: '2.0', error: { code: -32700 } });
    const big = await app.request(`${base}/mcp`, { method: 'POST', headers: auth, body: JSON.stringify({ x: 'a'.repeat(2 * 1024 * 1024) }) });
    expect(big.status).toBe(413);
    expect(await big.json()).toMatchObject({ error: { code: -32600 } });
  });

  it('serves the MCP endpoint at a custom path', async () => {
    const custom = makeApp({ mcpPath: '/gsc-mcp' });
    expect((await custom.request(`${base}/gsc-mcp`, { method: 'POST', headers: auth, body })).status).toBe(200);
    expect((await custom.request(`${base}/mcp`, { method: 'POST', headers: auth, body })).status).toBe(404);
    expect((await custom.request(`${base}/healthz`)).status).toBe(200);
  });

  it('rejects unknown Host headers when ALLOWED_HOSTS is set', async () => {
    const guarded = makeApp({
      allowedHosts: loadConfig({ MCP_AUTH_TOKEN: TOKEN, GOOGLE_APPLICATION_CREDENTIALS: 'x', ALLOWED_HOSTS: 'LOCALHOST:443, 127.0.0.1' }).ALLOWED_HOSTS,
    });
    const post = (host: string) => guarded.request(`${base}/mcp`, { method: 'POST', headers: { ...auth, host }, body });
    expect((await post('127.0.0.1:3000')).status).toBe(200);
    expect((await post('localhost:3000')).status).toBe(200); // "LOCALHOST:443" was normalised to "localhost"
    expect((await post('evil.example')).status).toBe(403);
  });
});
