/**
 * The email-link confirmation route, and what it does when the token is dead.
 *
 * The bug these exist for (#722): `/auth/confirm` failed closed to a bare `/login`. An invitee
 * whose link had aged out — an hour was all it took — got an unexplained sign-in form, typed
 * credentials for an account that had never been given a password, and was told "Invalid login
 * credentials". Three people at one shop stalled on that screen until the invites were re-sent
 * live on a call.
 *
 * Failing closed is still right; failing closed *silently* was not. So the assertions here are
 * about what travels with the redirect — a reason, and the invitation the person was trying to
 * reach — without loosening the open-redirect guard that makes `next` safe to carry.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const mockVerifyOtp = vi.fn();

vi.mock('@/utils/supabase/server', () => ({
  createClient: async () => ({
    auth: { verifyOtp: (...args: unknown[]) => mockVerifyOtp(...args) },
  }),
}));

import { GET } from '@/app/auth/confirm/route';

const ORIGIN = 'https://www.jigged.app';
const INVITE_NEXT = '/accept-invite/59df141a-874e-41aa-b176-caa512c76b53';

function confirmUrl(params: Record<string, string>): NextRequest {
  const url = new URL('/auth/confirm', ORIGIN);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return new NextRequest(url);
}

/** The `location` a route handler redirected to, as a parsed URL. */
async function redirectOf(request: NextRequest): Promise<URL> {
  const response = await GET(request);
  return new URL(response.headers.get('location') as string);
}

beforeEach(() => {
  mockVerifyOtp.mockReset();
});

describe('GET /auth/confirm', () => {
  it('forwards to `next` once the token verifies', async () => {
    mockVerifyOtp.mockResolvedValue({ error: null });

    const location = await redirectOf(
      confirmUrl({ token_hash: 'live-token', type: 'invite', next: INVITE_NEXT })
    );

    expect(location.pathname).toBe(INVITE_NEXT);
    expect(location.searchParams.get('reason')).toBeNull();
  });

  it('explains an expired invite link instead of dumping the invitee on a login form', async () => {
    mockVerifyOtp.mockResolvedValue({ error: { message: 'Token has expired or is invalid' } });

    const location = await redirectOf(
      confirmUrl({ token_hash: 'dead-token', type: 'invite', next: INVITE_NEXT })
    );

    expect(location.pathname).toBe('/login');
    expect(location.searchParams.get('reason')).toBe('invite-link-expired');
    // Carries the invitation, which is what lets /login offer a fresh link rather than
    // sending them back to their administrator.
    expect(location.searchParams.get('returnTo')).toBe(INVITE_NEXT);
  });

  it('names the recovery flow when a password-reset link is the dead one', async () => {
    mockVerifyOtp.mockResolvedValue({ error: { message: 'Token has expired or is invalid' } });

    const location = await redirectOf(
      confirmUrl({ token_hash: 'dead-token', type: 'recovery', next: '/reset-password' })
    );

    expect(location.searchParams.get('reason')).toBe('reset-link-expired');
  });

  it('refuses an unknown otp type without calling verifyOtp', async () => {
    const location = await redirectOf(
      confirmUrl({ token_hash: 'whatever', type: 'not-a-type', next: INVITE_NEXT })
    );

    expect(mockVerifyOtp).not.toHaveBeenCalled();
    expect(location.pathname).toBe('/login');
  });

  it.each([
    ['protocol-relative', '//evil.example'],
    ['backslash-normalised', '/\\evil.example'],
  ])('drops a %s `next` rather than carrying it into the redirect', async (_label, hostile) => {
    mockVerifyOtp.mockResolvedValue({ error: { message: 'nope' } });

    const location = await redirectOf(
      confirmUrl({ token_hash: 'dead-token', type: 'invite', next: hostile })
    );

    expect(location.origin).toBe(ORIGIN);
    expect(location.pathname).toBe('/login');
    // `/` is the sanitised fallback, and a returnTo of `/` is worth nothing — so it is omitted
    // rather than shipped as an empty promise.
    expect(location.searchParams.get('returnTo')).toBeNull();
  });

  it('keeps a hostile `next` out of the success redirect too', async () => {
    mockVerifyOtp.mockResolvedValue({ error: null });

    const location = await redirectOf(
      confirmUrl({ token_hash: 'live-token', type: 'invite', next: '//evil.example' })
    );

    expect(location.origin).toBe(ORIGIN);
    expect(location.pathname).toBe('/');
  });
});
