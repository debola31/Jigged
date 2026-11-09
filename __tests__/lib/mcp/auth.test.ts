import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Which tokens the MCP server accepts.
 *
 * Only tokens Supabase's OAuth server issued to an assistant (they carry `client_id`). A browser
 * session token copied into an assistant's config is refused: it was never granted to that
 * assistant, does not show in the user's connected apps and cannot be revoked from there.
 */

const mockGetClaims = vi.fn();
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({ auth: { getClaims: (...args: unknown[]) => mockGetClaims(...args) } }),
}));

import { callerFromClaims, callerOf, verifyMcpToken } from '@/lib/mcp/auth';

const NOW = 1_800_000_000;
const OAUTH = {
  sub: 'user-1',
  role: 'authenticated',
  aud: 'authenticated',
  client_id: 'client-9',
  exp: NOW + 600,
  email: 'owner@shop.test',
  session_id: 'session-1',
};

describe('callerFromClaims', () => {
  it('accepts a token Supabase issued to an OAuth client', () => {
    expect(callerFromClaims('tok', OAUTH, NOW)).toEqual({
      token: 'tok',
      clientId: 'client-9',
      userId: 'user-1',
      email: 'owner@shop.test',
      expiresAt: NOW + 600,
    });
  });

  it('refuses a browser session token, which has no client_id', () => {
    const { client_id: _omit, ...session } = OAUTH;
    expect(callerFromClaims('tok', session, NOW)).toBeNull();
  });

  it.each([
    ['anon role', { role: 'anon' }],
    ['service role', { role: 'service_role' }],
    ['another audience', { aud: 'something-else' }],
    ['an anonymous user', { is_anonymous: true }],
    ['an expired token', { exp: NOW }],
    ['no subject', { sub: '' }],
    ['an empty client_id', { client_id: '' }],
  ])('refuses %s', (_label, override) => {
    expect(callerFromClaims('tok', { ...OAUTH, ...override }, NOW)).toBeNull();
  });

  it('accepts an audience list that includes authenticated', () => {
    expect(callerFromClaims('tok', { ...OAUTH, aud: ['authenticated', 'x'] }, NOW)?.userId).toBe('user-1');
  });

  it('carries no email when the token has none', () => {
    const { email: _omit, ...noEmail } = OAUTH;
    expect(callerFromClaims('tok', noEmail, NOW)?.email).toBeNull();
  });
});

describe('verifyMcpToken', () => {
  const future = () => Math.floor(Date.now() / 1000) + 600;

  beforeEach(() => mockGetClaims.mockReset());

  it('returns undefined without a bearer token and checks nothing', async () => {
    expect(await verifyMcpToken(new Request('https://x.test/mcp'))).toBeUndefined();
    expect(mockGetClaims).not.toHaveBeenCalled();
  });

  it('returns undefined when the signature check fails', async () => {
    mockGetClaims.mockResolvedValue({ data: null, error: new Error('invalid JWT') });
    expect(await verifyMcpToken(new Request('https://x.test/mcp'), 'bad')).toBeUndefined();
  });

  it('refuses a valid browser session token', async () => {
    const { client_id: _omit, ...session } = { ...OAUTH, exp: future() };
    mockGetClaims.mockResolvedValue({ data: { claims: session }, error: null });
    expect(await verifyMcpToken(new Request('https://x.test/mcp'), 'session-token')).toBeUndefined();
  });

  it('turns an OAuth token into AuthInfo that rebuilds the same caller', async () => {
    const exp = future();
    mockGetClaims.mockResolvedValue({ data: { claims: { ...OAUTH, exp } }, error: null });
    const info = await verifyMcpToken(new Request('https://x.test/mcp'), 'oauth-token');
    expect(mockGetClaims).toHaveBeenCalledWith('oauth-token');
    expect(info).toMatchObject({ token: 'oauth-token', clientId: 'client-9', scopes: [], expiresAt: exp });
    expect(callerOf(info)).toEqual({
      token: 'oauth-token',
      clientId: 'client-9',
      userId: 'user-1',
      email: 'owner@shop.test',
      expiresAt: exp,
    });
  });
});

describe('callerOf', () => {
  it('is null for a request no token verified', () => {
    expect(callerOf(undefined)).toBeNull();
    expect(callerOf({ token: 't', clientId: 'c', scopes: [], expiresAt: 1, extra: {} })).toBeNull();
  });
});
