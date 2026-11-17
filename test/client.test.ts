import { describe, expect, it } from 'vitest';
import { classifyGoogleError, toToolError } from '../src/core/errors.js';
import { createGscApi, GoogleApiError, GSC_READONLY_SCOPE, parseServiceAccountKey } from '../src/core/google/client.js';

const b64urlDecode = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

async function testKey() {
  const pair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  );
  const der = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
  const b64 = btoa(String.fromCharCode(...der)).replace(/(.{64})/g, '$1\n');
  const pem = `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----\n`;
  const key = parseServiceAccountKey(JSON.stringify({ type: 'service_account', client_email: 'bot@p.iam.gserviceaccount.com', private_key: pem }));
  return { key, publicKey: pair.publicKey };
}

/** A fake fetch that answers the token endpoint and records every call. */
function fakeFetch(api: (url: string, init: RequestInit) => Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    if (url === 'https://oauth2.googleapis.com/token') return json({ access_token: `tok${calls.length}`, expires_in: 3600 });
    return api(url, init);
  }) as typeof fetch;
  return { fn, calls };
}

describe('Google client', () => {
  it('signs an RS256 JWT with only the read-only scope and caches the access token', async () => {
    const { key, publicKey } = await testKey();
    let now = Date.parse('2026-11-08T12:00:00Z');
    const { fn, calls } = fakeFetch(() => json({ siteEntry: [{ siteUrl: 'sc-domain:a.com', permissionLevel: 'siteOwner' }] }));
    const api = createGscApi({ kind: 'service_account', key }, { fetch: fn, now: () => now });

    expect(await api.listSites()).toEqual([{ siteUrl: 'sc-domain:a.com', permissionLevel: 'siteOwner' }]);
    const tokenCall = calls[0]!;
    const form = new URLSearchParams(String(tokenCall.init.body));
    expect(form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
    const [h, p, s] = form.get('assertion')!.split('.') as [string, string, string];
    expect(JSON.parse(new TextDecoder().decode(b64urlDecode(h)))).toEqual({ alg: 'RS256', typ: 'JWT' });
    const claims = JSON.parse(new TextDecoder().decode(b64urlDecode(p)));
    expect(claims).toMatchObject({ iss: key.client_email, scope: GSC_READONLY_SCOPE, aud: 'https://oauth2.googleapis.com/token', iat: now / 1000, exp: now / 1000 + 3600 });
    expect(await crypto.subtle.verify('RSASSA-PKCS1-v1_5', publicKey, b64urlDecode(s), new TextEncoder().encode(`${h}.${p}`))).toBe(true);
    expect(calls[1]!.url).toBe('https://searchconsole.googleapis.com/webmasters/v3/sites');
    expect((calls[1]!.init.headers as Record<string, string>).authorization).toBe('Bearer tok1');

    // Reused until 5 minutes before expiry, then refreshed.
    await api.listSites();
    expect(calls.filter((c) => c.url.includes('oauth2')).length).toBe(1);
    now += 56 * 60_000;
    await api.listSites();
    expect(calls.filter((c) => c.url.includes('oauth2')).length).toBe(2);
  });

  it('builds the Search Console endpoints', async () => {
    const { key } = await testKey();
    const { fn, calls } = fakeFetch((url) => (url.includes('urlInspection') ? json({ inspectionResult: { inspectionResultLink: 'x' } }) : json({})));
    const api = createGscApi({ kind: 'service_account', key }, { fetch: fn });
    await api.getSite('https://www.a.com/');
    await api.listSitemaps('sc-domain:a.com', 'https://a.com/index.xml');
    await api.getSitemap('sc-domain:a.com', 'https://a.com/s.xml');
    await api.querySearchAnalytics('sc-domain:a.com', { startDate: '2026-10-01', endDate: '2026-10-02' });
    expect(await api.inspectUrl({ siteUrl: 'sc-domain:a.com', inspectionUrl: 'https://a.com/' })).toEqual({ inspectionResultLink: 'x' });
    const api_ = calls.filter((c) => !c.url.includes('oauth2'));
    expect(api_.map((c) => `${c.init.method} ${c.url}`)).toEqual([
      'GET https://searchconsole.googleapis.com/webmasters/v3/sites/https%3A%2F%2Fwww.a.com%2F',
      'GET https://searchconsole.googleapis.com/webmasters/v3/sites/sc-domain%3Aa.com/sitemaps?sitemapIndex=https%3A%2F%2Fa.com%2Findex.xml',
      'GET https://searchconsole.googleapis.com/webmasters/v3/sites/sc-domain%3Aa.com/sitemaps/https%3A%2F%2Fa.com%2Fs.xml',
      'POST https://searchconsole.googleapis.com/webmasters/v3/sites/sc-domain%3Aa.com/searchAnalytics/query',
      'POST https://searchconsole.googleapis.com/v1/urlInspection/index:inspect',
    ]);
    expect(JSON.parse(String(api_[3]!.init.body))).toEqual({ startDate: '2026-10-01', endDate: '2026-10-02' });
  });

  it('throws gaxios-shaped errors that classifyGoogleError understands', async () => {
    const { key } = await testKey();
    const { fn } = fakeFetch(() =>
      json({ error: { code: 403, message: 'Quota exceeded', errors: [{ reason: 'rateLimitExceeded' }] } }, 403, { 'retry-after': '7' }),
    );
    const err = await createGscApi({ kind: 'service_account', key }, { fetch: fn }).listSites().catch((e) => e);
    expect(classifyGoogleError(err)).toMatchObject({ kind: 'rateLimit', status: 403, reason: 'rateLimitExceeded', retryAfterMs: 7000 });

    const { fn: notFound } = fakeFetch(() => json({ error: { code: 404, message: 'gone', errors: [{ reason: 'notFound' }] } }, 404));
    const nf = await createGscApi({ kind: 'service_account', key }, { fetch: notFound }).getSite('sc-domain:a.com').catch((e) => e);
    expect(toToolError(nf).code).toBe('NOT_FOUND');
  });

  it('maps token endpoint failures to AUTH_ERROR', async () => {
    const { key } = await testKey();
    const fn = (async () => json({ error: 'invalid_grant', error_description: 'Invalid JWT Signature.' }, 400)) as typeof fetch;
    const err = await createGscApi({ kind: 'service_account', key }, { fetch: fn }).listSites().catch((e) => e);
    expect(classifyGoogleError(err)).toMatchObject({ kind: 'auth', reason: 'invalid_grant' });
    expect(toToolError(err).code).toBe('AUTH_ERROR');
  });

  it('copies network error codes from fetch failures', async () => {
    const { key } = await testKey();
    const fn = (async () => {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
    }) as typeof fetch;
    expect(classifyGoogleError(await createGscApi({ kind: 'service_account', key }, { fetch: fn }).listSites().catch((e) => e)).kind).toBe('network');
  });

  it('treats a bare fetch TypeError (Workers) as a network error', async () => {
    const { key } = await testKey();
    const fn = (async () => {
      throw new TypeError('Network connection lost.');
    }) as typeof fetch;
    expect(classifyGoogleError(await createGscApi({ kind: 'service_account', key }, { fetch: fn }).listSites().catch((e) => e)).kind).toBe('network');
  });

  it('rejects keys that are not service accounts', () => {
    expect(() => parseServiceAccountKey('{"type":"authorized_user"}')).toThrow(/not a service account key/);
    expect(() => parseServiceAccountKey('nope')).toThrow(/Cannot parse/);
  });
});

describe('Google client with OAuth', () => {
  const oauth = { kind: 'oauth', clientId: 'cid.apps.googleusercontent.com', clientSecret: 'csecret', refreshToken: '1//rt' } as const;
  const tokenFetch = (token: (n: number) => Response) => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fn = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input);
      calls.push({ url, init });
      if (url === 'https://oauth2.googleapis.com/token') return token(calls.filter((c) => c.url === url).length);
      return json({ siteEntry: [] });
    }) as typeof fetch;
    return { fn, calls };
  };

  it('uses the refresh_token grant and caches the access token', async () => {
    let now = Date.parse('2026-11-08T12:00:00Z');
    const { fn, calls } = tokenFetch((n) => json({ access_token: `at${n}`, expires_in: 3599, scope: GSC_READONLY_SCOPE, token_type: 'Bearer' }));
    const api = createGscApi(oauth, { fetch: fn, now: () => now });
    await Promise.all([api.listSites(), api.listSites()]);
    const form = Object.fromEntries(new URLSearchParams(String(calls[0]!.init.body)));
    expect(form).toEqual({ grant_type: 'refresh_token', client_id: oauth.clientId, client_secret: oauth.clientSecret, refresh_token: oauth.refreshToken });
    expect(calls[0]!.init.method).toBe('POST');
    expect((calls.at(-1)!.init.headers as Record<string, string>).authorization).toBe('Bearer at1');
    expect(calls.filter((c) => c.url.includes('oauth2')).length).toBe(1);
    now += 56 * 60_000;
    await api.listSites();
    expect(calls.filter((c) => c.url.includes('oauth2')).length).toBe(2);
    expect((calls.at(-1)!.init.headers as Record<string, string>).authorization).toBe('Bearer at2');
  });

  it('maps invalid_grant to AUTH_ERROR that says to run oauth:login', async () => {
    const { fn } = tokenFetch(() => json({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }, 400));
    const err = await createGscApi(oauth, { fetch: fn }).listSites().catch((e) => e);
    const tool = toToolError(err, { authMethod: 'oauth' });
    expect(tool.code).toBe('AUTH_ERROR');
    expect(tool.message).toContain('npm run oauth:login');
  });

  it('refuses a token with a Search Console scope wider than read-only', async () => {
    const { fn, calls } = tokenFetch(() => json({ access_token: 'at', expires_in: 3600, scope: `openid https://www.googleapis.com/auth/webmasters` }));
    const err = await createGscApi(oauth, { fetch: fn }).listSites().catch((e) => e);
    expect(classifyGoogleError(err)).toMatchObject({ kind: 'auth', reason: 'scope_too_broad' });
    const tool = toToolError(err, { authMethod: 'oauth' });
    expect(tool.code).toBe('AUTH_ERROR');
    expect(tool.message).toContain('https://www.googleapis.com/auth/webmasters');
    // No Search Console call was made with the wide token.
    expect(calls.every((c) => c.url.includes('oauth2'))).toBe(true);
  });

  it('points OAuth permission errors at the signed-in account', () => {
    const err = new GoogleApiError(403, new Headers(), { error: { code: 403, message: 'no access', errors: [{ reason: 'forbidden' }] } });
    const tool = toToolError(err, { siteUrl: 'sc-domain:a.com', authMethod: 'oauth' });
    expect(tool.code).toBe('PERMISSION_DENIED');
    expect(tool.message).toContain('the Google account that ran oauth:login has no access');
  });
});
