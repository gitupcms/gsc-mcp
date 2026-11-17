import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildAuthUrl, pkcePair } from '../scripts/oauth-login.js';

describe('oauth-login', () => {
  it('makes an S256 PKCE pair', () => {
    const { verifier, challenge } = pkcePair();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(challenge).toBe(createHash('sha256').update(verifier).digest('base64url'));
    expect(pkcePair().verifier).not.toBe(verifier);
  });

  it('builds a read-only, offline consent URL with PKCE and state', () => {
    const url = new URL(buildAuthUrl({ clientId: 'cid', redirectUri: 'http://127.0.0.1:5555/', state: 'st4te', challenge: 'ch' }));
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: 'cid',
      redirect_uri: 'http://127.0.0.1:5555/',
      response_type: 'code',
      scope: 'https://www.googleapis.com/auth/webmasters.readonly',
      access_type: 'offline',
      prompt: 'consent',
      state: 'st4te',
      code_challenge: 'ch',
      code_challenge_method: 'S256',
    });
  });
});
