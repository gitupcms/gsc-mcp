/** Read-only scope: Google rejects any write even if the server tried one. */
export const GSC_READONLY_SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API_ROOT = 'https://searchconsole.googleapis.com';
const REQUEST_TIMEOUT_MS = 60_000;
/** Refresh the access token this long before it expires. */
const TOKEN_REFRESH_MARGIN_MS = 5 * 60_000;

// Hand-written subset of the Search Console API types (only fields this server reads or sends).
export interface WmxSite {
  siteUrl?: string | null;
  permissionLevel?: string | null;
}

export interface WmxSitemapContent {
  type?: string | null;
  submitted?: string | null;
  indexed?: string | null;
}

export interface WmxSitemap {
  path?: string | null;
  type?: string | null;
  lastSubmitted?: string | null;
  lastDownloaded?: string | null;
  isPending?: boolean | null;
  isSitemapsIndex?: boolean | null;
  warnings?: string | null;
  errors?: string | null;
  contents?: WmxSitemapContent[];
}

export interface ApiDimensionFilter {
  dimension?: string | null;
  operator?: string | null;
  expression?: string | null;
}

export interface ApiDimensionFilterGroup {
  groupType?: string | null;
  filters?: ApiDimensionFilter[];
}

export interface SearchAnalyticsQueryRequest {
  startDate?: string | null;
  endDate?: string | null;
  dimensions?: string[] | null;
  type?: string | null;
  searchType?: string | null;
  dimensionFilterGroups?: ApiDimensionFilterGroup[];
  aggregationType?: string | null;
  dataState?: string | null;
  rowLimit?: number | null;
  startRow?: number | null;
}

export interface ApiDataRow {
  keys?: string[] | null;
  clicks?: number | null;
  impressions?: number | null;
  ctr?: number | null;
  position?: number | null;
}

export interface SearchAnalyticsQueryResponse {
  rows?: ApiDataRow[];
  responseAggregationType?: string | null;
  metadata?: { first_incomplete_date?: string | null; first_incomplete_hour?: string | null } | null;
}

export interface InspectUrlIndexRequest {
  inspectionUrl?: string | null;
  siteUrl?: string | null;
  languageCode?: string | null;
}

export interface IndexStatusInspectionResult {
  verdict?: string | null;
  coverageState?: string | null;
  indexingState?: string | null;
  robotsTxtState?: string | null;
  pageFetchState?: string | null;
  lastCrawlTime?: string | null;
  crawledAs?: string | null;
  googleCanonical?: string | null;
  userCanonical?: string | null;
  sitemap?: string[] | null;
  referringUrls?: string[] | null;
}

export interface UrlInspectionResult {
  inspectionResultLink?: string | null;
  indexStatusResult?: IndexStatusInspectionResult;
  mobileUsabilityResult?: Record<string, unknown>;
  richResultsResult?: { verdict?: string | null; detectedItems?: { richResultType?: string | null }[] };
  ampResult?: { verdict?: string | null; ampUrl?: string | null };
}

/** Per-request options; `signal` aborts the HTTP request to Google. */
export interface RequestOptions {
  signal?: AbortSignal;
}

/** The read-only slice of the Search Console API that this server uses. */
export interface GscApi {
  listSites(opts?: RequestOptions): Promise<WmxSite[]>;
  getSite(siteUrl: string, opts?: RequestOptions): Promise<WmxSite>;
  listSitemaps(siteUrl: string, sitemapIndex?: string, opts?: RequestOptions): Promise<WmxSitemap[]>;
  getSitemap(siteUrl: string, feedpath: string, opts?: RequestOptions): Promise<WmxSitemap>;
  querySearchAnalytics(siteUrl: string, body: SearchAnalyticsQueryRequest, opts?: RequestOptions): Promise<SearchAnalyticsQueryResponse>;
  inspectUrl(body: InspectUrlIndexRequest, opts?: RequestOptions): Promise<UrlInspectionResult>;
}

export interface ServiceAccountKey {
  client_email: string;
  private_key: string;
}

/** How the server signs in to Google: a service account, or a user's OAuth refresh token (`npm run oauth:login`). */
export type GoogleAuth =
  | { kind: 'service_account'; key: ServiceAccountKey }
  | { kind: 'oauth'; clientId: string; clientSecret: string; refreshToken: string };
export type AuthMethod = GoogleAuth['kind'];

/** Search Console scopes in a space-separated `scope` string that are wider than read-only (e.g. .../auth/webmasters). */
export function widerGscScopes(scope: string): string[] {
  return scope.split(/\s+/).filter((s) => s.startsWith('https://www.googleapis.com/auth/webmasters') && s !== GSC_READONLY_SCOPE);
}

/** Parses and checks a service-account key JSON, failing early on a bad key. */
export function parseServiceAccountKey(json: string, source = 'service account key'): ServiceAccountKey {
  let key: { type?: string; client_email?: string; private_key?: string };
  try {
    key = JSON.parse(json);
  } catch (err) {
    throw new Error(`Cannot parse ${source}: ${(err as Error).message}`);
  }
  if (key?.type !== 'service_account' || !key.client_email || !key.private_key) {
    throw new Error(`${source} is not a service account key (expected "type": "service_account")`);
  }
  return { client_email: key.client_email, private_key: key.private_key };
}

/**
 * An HTTP error shaped like a gaxios error (status, response.headers,
 * response.data), so classifyGoogleError reads it the same way.
 */
export class GoogleApiError extends Error {
  readonly response: { status: number; headers: Headers; data: unknown };
  constructor(
    readonly status: number,
    headers: Headers,
    data: unknown,
  ) {
    const err = (data as { error?: unknown; error_description?: string } | undefined)?.error;
    const message =
      typeof err === 'string'
        ? ((data as { error_description?: string }).error_description ?? err)
        : ((err as { message?: string } | undefined)?.message ?? `Request failed with status code ${status}`);
    super(message);
    this.name = 'GoogleApiError';
    this.response = { status, headers, data };
  }
}

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64urlJson = (v: unknown) => b64url(new TextEncoder().encode(JSON.stringify(v)));

function importPrivateKey(pem: string): Promise<CryptoKey> {
  const body = pem.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, '').replace(/\s+/g, '');
  const der = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
}

/** Builds the RS256-signed JWT assertion for the OAuth jwt-bearer grant. */
export async function signJwt(key: ServiceAccountKey, cryptoKey: CryptoKey, nowMs: number): Promise<string> {
  const iat = Math.floor(nowMs / 1000);
  const unsigned = `${b64urlJson({ alg: 'RS256', typ: 'JWT' })}.${b64urlJson({
    iss: key.client_email,
    scope: GSC_READONLY_SCOPE,
    aud: TOKEN_URL,
    iat,
    exp: iat + 3600,
  })}`;
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', cryptoKey, new TextEncoder().encode(unsigned));
  return `${unsigned}.${b64url(new Uint8Array(sig))}`;
}

/** Network failures carry the system code (ECONNRESET...) on `cause` with Node's fetch; copy it up as gaxios did.
 * Workers' fetch throws a bare TypeError with no code, so treat that as a reset to keep it retryable. */
function networkError(err: unknown): unknown {
  if (!(err instanceof Error) || (err as { code?: unknown }).code) return err;
  const code = (err as { cause?: { code?: unknown } }).cause?.code;
  if (typeof code === 'string') Object.assign(err, { code });
  else if (err.name === 'TypeError') Object.assign(err, { code: 'ECONNRESET' });
  return err;
}

async function readJson(res: Response): Promise<unknown> {
  const text = await res.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { error: { message: text.slice(0, 500) } };
  }
}

export interface GscApiOptions {
  /** Injectable for tests; defaults to the global fetch. */
  fetch?: typeof fetch;
  now?: () => number;
}

export function createGscApi(auth: GoogleAuth, { fetch: fetchFn = (...a) => fetch(...a), now = Date.now }: GscApiOptions = {}): GscApi {
  let cryptoKey: Promise<CryptoKey> | undefined;
  let token: { value: string; expiresAt: number } | undefined;
  let refreshing: Promise<string> | undefined;

  async function send(url: string, init: RequestInit, signal?: AbortSignal): Promise<unknown> {
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetchFn(url, { ...init, signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    } catch (err) {
      throw networkError(err);
    }
    const data = await readJson(res);
    if (!res.ok) throw new GoogleApiError(res.status, res.headers, data);
    return data;
  }

  async function grantBody(issuedAt: number): Promise<URLSearchParams> {
    if (auth.kind === 'oauth') {
      return new URLSearchParams({ grant_type: 'refresh_token', client_id: auth.clientId, client_secret: auth.clientSecret, refresh_token: auth.refreshToken });
    }
    cryptoKey ??= importPrivateKey(auth.key.private_key);
    const assertion = await signJwt(auth.key, await cryptoKey, issuedAt);
    return new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion });
  }

  async function fetchToken(): Promise<string> {
    const issuedAt = now();
    const data = (await send(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: (await grantBody(issuedAt)).toString(),
    })) as { access_token?: string; expires_in?: number; scope?: string };
    if (!data.access_token) throw new GoogleApiError(401, new Headers(), { error: 'invalid_token_response', error_description: 'No access_token in token response' });
    // A user token keeps the scopes it was granted; refuse one that could write to Search Console.
    const wider = auth.kind === 'oauth' && data.scope ? widerGscScopes(data.scope) : [];
    if (wider.length) {
      throw new GoogleApiError(401, new Headers(), {
        error: 'scope_too_broad',
        error_description: `The refresh token grants ${wider.join(' ')}; this server only accepts ${GSC_READONLY_SCOPE}. Run npm run oauth:login again.`,
      });
    }
    token = { value: data.access_token, expiresAt: issuedAt + (data.expires_in ?? 3600) * 1000 };
    return token.value;
  }

  async function accessToken(): Promise<string> {
    if (token && now() < token.expiresAt - TOKEN_REFRESH_MARGIN_MS) return token.value;
    // One refresh shared by concurrent callers.
    refreshing ??= fetchToken().finally(() => {
      refreshing = undefined;
    });
    return refreshing;
  }

  async function call<T>(method: 'GET' | 'POST', path: string, opts: RequestOptions = {}, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { authorization: `Bearer ${await accessToken()}`, accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    return (await send(`${API_ROOT}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }, opts.signal)) as T;
  }

  const site = (siteUrl: string) => `/webmasters/v3/sites/${encodeURIComponent(siteUrl)}`;
  return {
    async listSites(opts) {
      return (await call<{ siteEntry?: WmxSite[] }>('GET', '/webmasters/v3/sites', opts)).siteEntry ?? [];
    },
    async getSite(siteUrl, opts) {
      return call<WmxSite>('GET', site(siteUrl), opts);
    },
    async listSitemaps(siteUrl, sitemapIndex, opts) {
      const q = sitemapIndex ? `?${new URLSearchParams({ sitemapIndex })}` : '';
      return (await call<{ sitemap?: WmxSitemap[] }>('GET', `${site(siteUrl)}/sitemaps${q}`, opts)).sitemap ?? [];
    },
    async getSitemap(siteUrl, feedpath, opts) {
      return call<WmxSitemap>('GET', `${site(siteUrl)}/sitemaps/${encodeURIComponent(feedpath)}`, opts);
    },
    async querySearchAnalytics(siteUrl, requestBody, opts) {
      return call<SearchAnalyticsQueryResponse>('POST', `${site(siteUrl)}/searchAnalytics/query`, opts, requestBody);
    },
    async inspectUrl(requestBody, opts) {
      return (await call<{ inspectionResult?: UrlInspectionResult }>('POST', '/v1/urlInspection/index:inspect', opts, requestBody)).inspectionResult ?? {};
    },
  };
}
