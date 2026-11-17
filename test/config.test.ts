import { describe, expect, it } from 'vitest';
import { hostnameOnly, loadConfig, oauthAuth, startupWarnings } from '../src/core/config.js';

const base = { MCP_AUTH_TOKEN: 'x'.repeat(32), GOOGLE_APPLICATION_CREDENTIALS: 'key.json' };

describe('MCP_PATH', () => {
  it('defaults to /mcp and accepts a custom path', () => {
    expect(loadConfig(base).MCP_PATH).toBe('/mcp');
    expect(loadConfig({ ...base, MCP_PATH: '/gsc-mcp' }).MCP_PATH).toBe('/gsc-mcp');
  });

  it('rejects malformed paths', () => {
    for (const bad of ['gsc-mcp', '/gsc-mcp/', '/', '/healthz', 'https://x/y']) {
      expect(() => loadConfig({ ...base, MCP_PATH: bad }), bad).toThrow(/MCP_PATH/);
    }
  });
});

describe('service account key', () => {
  it('accepts the key JSON instead of a file path, and requires one of them', () => {
    expect(loadConfig({ MCP_AUTH_TOKEN: base.MCP_AUTH_TOKEN, GOOGLE_SERVICE_ACCOUNT_JSON: '{}' }).GOOGLE_SERVICE_ACCOUNT_JSON).toBe('{}');
    expect(() => loadConfig({ MCP_AUTH_TOKEN: base.MCP_AUTH_TOKEN })).toThrow(/GOOGLE_SERVICE_ACCOUNT_JSON/);
  });
});

describe('Google OAuth', () => {
  const oauth = { ADMIN_TOKEN: 'a'.repeat(32), GOOGLE_OAUTH_CLIENT_ID: 'cid', GOOGLE_OAUTH_CLIENT_SECRET: 'cs', GOOGLE_OAUTH_REFRESH_TOKEN: 'rt' };

  it('accepts the three OAuth variables instead of a service account', () => {
    expect(oauthAuth(loadConfig(oauth))).toEqual({ kind: 'oauth', clientId: 'cid', clientSecret: 'cs', refreshToken: 'rt' });
    expect(oauthAuth(loadConfig(base))).toBeUndefined();
  });

  it('needs exactly one sign-in method', () => {
    expect(() => loadConfig({ ...oauth, GOOGLE_SERVICE_ACCOUNT_JSON: '{}' })).toThrow(/only one Google sign-in method/);
    expect(() => loadConfig({ ...oauth, GOOGLE_APPLICATION_CREDENTIALS: 'key.json' })).toThrow(/only one Google sign-in method/);
    expect(() => loadConfig({ ...oauth, GOOGLE_OAUTH_CLIENT_SECRET: undefined })).toThrow(/all three/);
    expect(() => loadConfig({ MCP_AUTH_TOKEN: base.MCP_AUTH_TOKEN })).toThrow(/GOOGLE_OAUTH_CLIENT_ID/);
  });

  it('warns when OAuth runs without GSC_ALLOWED_SITES', () => {
    expect(startupWarnings(loadConfig(oauth))).toEqual([expect.stringMatching(/OAuth sees every property.*GSC_ALLOWED_SITES/)]);
    expect(startupWarnings(loadConfig({ ...oauth, GSC_ALLOWED_SITES: 'sc-domain:a.com' }))).toEqual([]);
    expect(startupWarnings(loadConfig(base)).some((w) => w.includes('OAuth'))).toBe(false);
  });
});

describe('ALLOWED_HOSTS', () => {
  it('normalizes entries the way the SDK parses Host headers', () => {
    expect(hostnameOnly('LOCALHOST:443')).toBe('localhost');
    expect(hostnameOnly('bücher.de')).toBe('xn--bcher-kva.de');
    expect(hostnameOnly('::1')).toBe('[::1]');
    expect(hostnameOnly('[::1]:3000')).toBe('[::1]');
    expect(hostnameOnly('127.0.0.1')).toBe('127.0.0.1');
  });

  it('rejects URLs and paths with a clear message', () => {
    expect(hostnameOnly('https://gsc.example.com')).toBeUndefined();
    expect(hostnameOnly('gsc.example.com/mcp')).toBeUndefined();
    expect(() => loadConfig({ ...base, ALLOWED_HOSTS: 'ok.example.com, https://gsc.example.com' })).toThrow(/not a hostname/);
    expect(loadConfig({ ...base, ALLOWED_HOSTS: 'Gsc.Example.com:443' }).ALLOWED_HOSTS).toEqual(['gsc.example.com']);
  });
});

describe('auth settings', () => {
  it('needs ADMIN_TOKEN or MCP_AUTH_TOKEN and keeps admin out of MCP_PATH', () => {
    const key = { GOOGLE_APPLICATION_CREDENTIALS: 'key.json' };
    expect(() => loadConfig(key)).toThrow(/ADMIN_TOKEN/);
    expect(loadConfig({ ...key, ADMIN_TOKEN: 'a'.repeat(32) }).TOKEN_TTL_DAYS).toBe(90);
    expect(() => loadConfig({ ...key, ADMIN_TOKEN: 'short' })).toThrow(/ADMIN_TOKEN/);
    expect(() => loadConfig({ ...base, TOKEN_TTL_DAYS: '366' })).toThrow(/TOKEN_TTL_DAYS/);
    expect(() => loadConfig({ ...base, MCP_PATH: '/admin/tokens' })).toThrow(/MCP_PATH/);
  });
});
