/**
 * What /login says to someone holding a dead invitation link.
 *
 * This screen is the far end of #722. An invitee whose link had expired arrived at a sign-in form
 * with no explanation, and the only thing it offered was a password field for an account that had
 * never been given a password — so the app answered "Invalid login credentials", which named
 * neither the real problem nor anything they could act on.
 *
 * The contract asserted here: say what happened, say why signing in won't help yet, and offer the
 * one action that resolves it. The resend endpoint takes no destination from the caller, so the
 * button can be offered to a visitor with no session at all — the assertions cover that the request
 * is keyed only by the invitation id.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@/__tests__/test-utils';
import userEvent from '@testing-library/user-event';

import Login from '@/components/auth/Login';

const mockCapture = vi.fn();

vi.mock('posthog-js', () => ({
  default: { identify: vi.fn(), capture: (...args: unknown[]) => mockCapture(...args) },
}));

vi.mock('@/lib/supabase', () => ({
  getSupabase: () => ({ auth: { signInWithPassword: vi.fn() } }),
  getEdgeFunctionUrl: (name: string) => `https://edge.test/${name}`,
}));

vi.mock('@/utils/companyAccess', () => ({
  getPostLoginRoute: vi.fn(async () => '/'),
}));

const INVITATION_ID = '59df141a-874e-41aa-b176-caa512c76b53';
const INVITE_RETURN_TO = `/accept-invite/${INVITATION_ID}`;

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockCapture.mockReset();
  fetchMock = vi.fn(async () => new Response(JSON.stringify({ success: true }), { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Login — expired invitation link', () => {
  it('says nothing about invitations on an ordinary visit', () => {
    render(<Login />);

    expect(screen.queryByText(/invitation link has expired/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /sign in/i })).toBeInTheDocument();
  });

  it('explains the expiry and warns that signing in may not work yet', () => {
    render(<Login reason="invite-link-expired" returnTo={INVITE_RETURN_TO} />);

    expect(screen.getByText(/that invitation link has expired/i)).toBeInTheDocument();
    // Hedged, because an invitee joining a second company DOES already have a password —
    // this screen cannot tell the two apart, so it must not assert either one.
    expect(screen.getByText(/if this is your\s+first Jigged invitation/i)).toBeInTheDocument();
  });

  it('offers a new link, and asks for it by invitation id alone', async () => {
    const user = userEvent.setup();
    render(<Login reason="invite-link-expired" returnTo={INVITE_RETURN_TO} />);

    await user.click(screen.getByRole('button', { name: /send me a new link/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://edge.test/team-invites/${INVITATION_ID}/request-resend`);
    expect(init.method).toBe('POST');
    // No email, no destination — the endpoint reads the address off the invitation row, which is
    // what makes an unauthenticated resend safe to offer.
    expect(init.body).toBeUndefined();

    expect(await screen.findByText(/a new link is on its way/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /send me a new link/i })).not.toBeInTheDocument();
  });

  it('surfaces a refused resend instead of claiming one was sent', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: 'A new link was just sent. Check your inbox — and your spam folder.' }), {
        status: 429,
      })
    );
    const user = userEvent.setup();
    render(<Login reason="invite-link-expired" returnTo={INVITE_RETURN_TO} />);

    await user.click(screen.getByRole('button', { name: /send me a new link/i }));

    expect(await screen.findByText(/a new link was just sent/i)).toBeInTheDocument();
    expect(screen.queryByText(/on its way/i)).not.toBeInTheDocument();
    // Still offered, because the refusal is temporary.
    expect(screen.getByRole('button', { name: /send me a new link/i })).toBeInTheDocument();
  });

  it('falls back to naming the administrator when there is no invitation to resend', () => {
    render(<Login reason="invite-link-expired" returnTo="/dashboard/abc" />);

    expect(screen.getByText(/ask your administrator to resend/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /send me a new link/i })).not.toBeInTheDocument();
  });

  it('records the drop-off, with whether self-service was possible', () => {
    render(<Login reason="invite-link-expired" returnTo={INVITE_RETURN_TO} />);

    expect(mockCapture).toHaveBeenCalledWith('invitation link expired', { can_self_resend: true });
  });

  it('points an expired reset link at forgot-password, not at a resend', () => {
    render(<Login reason="reset-link-expired" returnTo="/reset-password" />);

    expect(screen.getByText(/password reset link has expired/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /request a new one/i })).toHaveAttribute(
      'href',
      '/forgot-password'
    );
  });
});
