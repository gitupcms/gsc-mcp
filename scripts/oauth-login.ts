// Gets a Google OAuth refresh token limited to webmasters.readonly, for GOOGLE_OAUTH_REFRESH_TOKEN.
// Uses a "Desktop app" OAuth client: loopback redirect to 127.0.0.1, PKCE (S256) and a state check.
//   npm run oauth:login                                   # GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET from the environment
//   npm run oauth:login -- --client-secrets client.json   # or the JSON downloaded from the Cloud console
// Writes no files: the refresh token is printed to stdout only.
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { GSC_READONLY_SCOPE, widerGscScopes } from '../src/core/google/client.js';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const TIMEOUT_MS = 5 * 60_000;

/** PKCE verifier and its S256 challenge. */
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

/** The consent URL: read-only scope, offline access (refresh token) and a fresh consent so Google returns one. */
export function buildAuthUrl(p: { clientId: string; redirectUri: string; state: string; challenge: string }): string {
  return `${AUTH_URL}?${new URLSearchParams({
    client_id: p.clientId,
    redirect_uri: p.redirectUri,
    response_type: 'code',
    scope: GSC_READONLY_SCOPE,
    access_type: 'offline',
    prompt: 'consent',
    state: p.state,
    code_challenge: p.challenge,
    code_challenge_method: 'S256',
  })}`;
}

function fail(msg: string): never {
  process.stderr.write(`${msg}\n`);
  process.exit(1);
}

function clientCredentials(secretsFile: string | undefined): { clientId: string; clientSecret: string } {
  if (secretsFile) {
    let j: { installed?: { client_id?: string; client_secret?: string }; web?: { client_id?: string; client_secret?: string } };
    try {
      j = JSON.parse(readFileSync(secretsFile, 'utf8'));
    } catch (err) {
      fail(`Cannot read ${secretsFile}: ${(err as Error).message}`);
    }
    const c = j.installed ?? j.web;
    if (!c?.client_id || !c.client_secret) fail(`${secretsFile} has no installed.client_id/client_secret (download it from a "Desktop app" OAuth client)`);
    return { clientId: c.client_id, clientSecret: c.client_secret };
  }
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) fail('Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET, or pass --client-secrets <client_secret_*.json>');
  return { clientId, clientSecret };
}

function openBrowser(url: string): void {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? undefined : 'xdg-open';
  if (!cmd) return;
  const child = spawn(cmd, [url], { stdio: 'ignore', detached: true });
  child.on('error', () => {}); // no browser opener: the URL is printed anyway
  child.unref();
}

/** Listens on 127.0.0.1 (random port) for the redirect; `code` resolves with the authorization code. */
function startLoopback(state: string): Promise<{ redirectUri: string; code: Promise<string>; close: () => void }> {
  return new Promise((resolveStart, rejectStart) => {
    let resolveCode!: (code: string) => void;
    let rejectCode!: (err: Error) => void;
    const codePromise = new Promise<string>((res, rej) => {
      resolveCode = res;
      rejectCode = rej;
    });
    const server = createServer((req, res) => {
      const u = new URL(req.url ?? '/', 'http://127.0.0.1');
      const code = u.searchParams.get('code');
      const error = u.searchParams.get('error');
      if (!code && !error) {
        res.writeHead(404).end();
        return;
      }
      const ok = Boolean(code) && u.searchParams.get('state') === state;
      res.writeHead(ok ? 200 : 400, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(ok ? 'Signed in. You can close this tab and return to the terminal.' : 'Sign-in failed. See the terminal.');
      if (error) rejectCode(new Error(`Google returned error: ${error}`));
      else if (!ok) rejectCode(new Error('State mismatch in the redirect; start again'));
      else resolveCode(code!);
    });
    server.on('error', rejectStart);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      const redirectUri = `http://127.0.0.1:${port}/`;
      const timer = setTimeout(() => rejectCode(new Error('Timed out after 5 minutes waiting for the browser sign-in')), TIMEOUT_MS);
      const close = () => {
        clearTimeout(timer);
        server.close();
        server.closeAllConnections();
      };
      resolveStart({ redirectUri, code: codePromise, close });
    });
  });
}

async function main() {
  const { values } = parseArgs({ options: { 'client-secrets': { type: 'string' } } });
  const { clientId, clientSecret } = clientCredentials(values['client-secrets']);
  const state = randomBytes(16).toString('base64url');
  const { verifier, challenge } = pkcePair();
  const loopback = await startLoopback(state);
  const url = buildAuthUrl({ clientId, redirectUri: loopback.redirectUri, state, challenge });
  process.stderr.write(`Open this URL in a browser and sign in with the Google account that can read your Search Console properties:\n\n${url}\n\n`);
  openBrowser(url);

  let code: string;
  try {
    code = await loopback.code;
  } finally {
    loopback.close();
  }

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: loopback.redirectUri,
      code_verifier: verifier,
    }).toString(),
  });
  const data = (await res.json().catch(() => ({}))) as { refresh_token?: string; scope?: string; error?: string; error_description?: string };
  if (!res.ok) fail(`Token exchange failed (${res.status}): ${data.error_description ?? data.error ?? 'unknown error'}`);
  const scopes = (data.scope ?? '').split(/\s+/);
  const wider = widerGscScopes(data.scope ?? '');
  if (wider.length) fail(`Google granted ${wider.join(' ')}; only ${GSC_READONLY_SCOPE} is allowed. Token discarded.`);
  if (!scopes.includes(GSC_READONLY_SCOPE)) fail(`Google did not grant ${GSC_READONLY_SCOPE} (granted: ${data.scope || 'nothing'}). Tick the Search Console permission on the consent screen.`);
  if (!data.refresh_token) fail('Google returned no refresh token. Remove the app at https://myaccount.google.com/permissions and run this again.');

  process.stdout.write(
    `${data.refresh_token}\n\n` +
      'Keep this refresh token secret. Use it with the same client id and secret:\n' +
      '  .env (Node/Docker):  GOOGLE_OAUTH_CLIENT_ID=...  GOOGLE_OAUTH_CLIENT_SECRET=...  GOOGLE_OAUTH_REFRESH_TOKEN=<token above>\n' +
      '  Workers:             npx wrangler secret put GOOGLE_OAUTH_REFRESH_TOKEN   (and GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET)\n' +
      'Remove GOOGLE_SERVICE_ACCOUNT_JSON / GOOGLE_APPLICATION_CREDENTIALS: only one sign-in method may be set.\n' +
      'Set GSC_ALLOWED_SITES to limit which of the account\'s properties clients can read.\n',
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err: Error) => fail(err.message));
}
