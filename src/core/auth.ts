/** Who a bearer token belongs to and what it may read. */
export interface AuthContext {
  tokenId: string;
  /** Properties this token may read, on top of GSC_ALLOWED_SITES. undefined = no extra limit. */
  allowedSites?: string[];
  /** ISO expiry of the token, if it has one. */
  expiresAt?: string;
}

/** Resolves a bearer token to its AuthContext, or null if it isn't valid. */
export type VerifyToken = (token: string) => Promise<AuthContext | null>;

export const sha256 = async (s: string) => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));

/** Constant-time comparison of equal-length byte arrays. */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

/** One shared token (MCP_AUTH_TOKEN); hashing first makes lengths equal. */
export function singleTokenVerifier(token: string): VerifyToken {
  const expected = sha256(token);
  return async (candidate) => (timingSafeEqual(await sha256(candidate), await expected) ? { tokenId: 'default' } : null);
}
