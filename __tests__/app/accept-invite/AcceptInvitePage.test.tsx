/**
 * Invite acceptance — the two paths, and the ordering that used to cost people their access.
 *
 * The bug these exist for: an existing Jigged user invited to a SECOND company was shown the
 * new-hire signup form, typed the password they already had, and got GoTrue's
 * "New password should be different from the old password" — thrown from an `updateUser` that ran
 * BEFORE `accept_invitation`, so the message named a password problem while the real outcome was
 * that they never joined the company at all.
 *
 * `docs/modules/invitation-system.md` named "existing-user invite" in its own untested-cases list.
 * This is that case.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, routerMocks, resetRouterMocks } from '@/__tests__/test-utils';
import userEvent from '@testing-library/user-event';

import AcceptInvitePage from '@/app/accept-invite/[invitationId]/page';
import { hasAnyCompanyAccess } from '@/utils/companyAccess';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockRpc = vi.fn();
const mockUpdateUser = vi.fn();
const mockSignOut = vi.fn();
let sessionUser: Record<string, unknown> = {};

vi.mock('@/lib/supabase', () => {
  const client = {
    auth: {
      getSession: async () => ({
        data: { session: { access_token: 'tok', user: sessionUser } },
      }),
      setSession: vi.fn(),
      exchangeCodeForSession: vi.fn(),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: vi.fn() } } }),
      updateUser: (...args: unknown[]) => mockUpdateUser(...args),
      signOut: (...args: unknown[]) => mockSignOut(...args),
    },
    rpc: (...args: unknown[]) => mockRpc(...args),
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            single: async () => ({ data: { id: 'member-1' }, error: null }),
          }),
        }),
      }),
    }),
  };
  return {
    getSupabase: () => client,
    getEdgeFunctionUrl: (name: string) => `https://edge.test/${name}`,
  };
});

// `homePathForRole` stays REAL — asserting the operator/dashboard split is half the point of the
// redirect tests. Only the two calls that would hit the network are stubbed.
vi.mock('@/utils/companyAccess', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/companyAccess')>();
  return {
    ...actual,
    setLastCompany: vi.fn(async () => {}),
    hasAnyCompanyAccess: vi.fn(async () => false),
  };
});

vi.mock('@/components/auth', () => ({
  AuthLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock('posthog-js', () => ({
  default: { identify: vi.fn(), capture: vi.fn() },
}));

const mockHasAnyCompanyAccess = vi.mocked(hasAnyCompanyAccess);

// ---------------------------------------------------------------------------
// Staging
// ---------------------------------------------------------------------------

const FUTURE = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

function invitation(over: Record<string, unknown> = {}) {
  return {
    id: 'inv-1',
    email: 'ada@shop.test',
    role: 'user',
    status: 'pending',
    expires_at: FUTURE,
    company_id: 'company-b',
    company_name: 'Acme Machining',
    ...over,
  };
}

/**
 * @param metadata what the invitee's auth account already knows about them. An established user
 *   has a name here; a brand-new invitee has only the invite's own bookkeeping.
 */
function stage({
  metadata = {},
  inv = invitation(),
  established = false,
}: {
  metadata?: Record<string, unknown>;
  inv?: Record<string, unknown>;
  established?: boolean;
} = {}) {
  sessionUser = { id: 'user-1', email: 'ada@shop.test', user_metadata: metadata };
  mockHasAnyCompanyAccess.mockResolvedValue(established);
  mockRpc.mockResolvedValue({ data: inv.company_id, error: null });
  mockUpdateUser.mockResolvedValue({ error: null });

  global.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    if (init?.method === 'PATCH') return { ok: true, json: async () => ({}) } as Response;
    return { ok: true, json: async () => inv } as Response;
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  vi.clearAllMocks();
  resetRouterMocks();
});

// ---------------------------------------------------------------------------

describe('accept-invite — existing Jigged user invited to a second company', () => {
  it('never asks for a password they already have', async () => {
    stage({ metadata: { first_name: 'Ada', last_name: 'Lovelace' } });
    render(<AcceptInvitePage />);

    expect(await screen.findByRole('button', { name: /join acme machining/i })).toBeInTheDocument();

    // The whole bug in one assertion: no password box means no same-password dead end.
    expect(screen.queryByLabelText(/^password/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/confirm password/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/first name/i)).not.toBeInTheDocument();
    expect(screen.getByText(/signed in as ada@shop\.test/i)).toBeInTheDocument();
  });

  it('recognises an established account by its company membership when metadata is bare', async () => {
    // Someone added by a system admin has a membership row but may carry no name metadata.
    stage({ metadata: {}, established: true });
    render(<AcceptInvitePage />);

    expect(await screen.findByRole('button', { name: /join acme machining/i })).toBeInTheDocument();
    expect(mockHasAnyCompanyAccess).toHaveBeenCalledWith('user-1');
    expect(screen.queryByLabelText(/^password/i)).not.toBeInTheDocument();
  });

  it('joins in one tap without touching the password, and lands on the new company', async () => {
    stage({ metadata: { first_name: 'Ada', last_name: 'Lovelace' } });
    render(<AcceptInvitePage />);

    await userEvent.click(await screen.findByRole('button', { name: /join acme machining/i }));

    await waitFor(() => {
      expect(routerMocks.replace).toHaveBeenCalledWith('/dashboard/company-b');
    });

    expect(mockRpc).toHaveBeenCalledWith('accept_invitation', {
      p_invitation_id: 'inv-1',
      p_user_id: 'user-1',
    });
    // No password write at all — not even an empty one.
    expect(mockUpdateUser).not.toHaveBeenCalled();
  });

  it('sends an invited operator to the shop floor, not a dashboard they get bounced from', async () => {
    stage({
      metadata: { first_name: 'Ada', last_name: 'Lovelace' },
      inv: invitation({ role: 'operator' }),
    });
    render(<AcceptInvitePage />);

    await userEvent.click(await screen.findByRole('button', { name: /join acme machining/i }));

    await waitFor(() => {
      expect(routerMocks.replace).toHaveBeenCalledWith('/operator/company-b');
    });
  });

  it('offers a way out when the wrong account is signed in', async () => {
    stage({ metadata: { display_name: 'Ada Lovelace' } });
    render(<AcceptInvitePage />);

    await userEvent.click(await screen.findByRole('button', { name: /not you\? sign out/i }));

    await waitFor(() => expect(mockSignOut).toHaveBeenCalledWith({ scope: 'local' }));
  });
});

describe('accept-invite — ordering and failure handling', () => {
  it('grants access BEFORE writing the profile', async () => {
    stage();
    render(<AcceptInvitePage />);

    await userEvent.type(await screen.findByLabelText(/first name/i), 'Grace');
    await userEvent.type(screen.getByLabelText(/last name/i), 'Hopper');
    await userEvent.type(screen.getByLabelText(/^password/i), 'hunter2');
    await userEvent.type(screen.getByLabelText(/confirm password/i), 'hunter2');
    await userEvent.click(screen.getByRole('button', { name: /accept invitation/i }));

    await waitFor(() => expect(mockUpdateUser).toHaveBeenCalled());

    // The regression that made a password complaint silently mean "no access": if updateUser is
    // ever hoisted back above the RPC, this flips.
    expect(mockRpc.mock.invocationCallOrder[0]).toBeLessThan(
      mockUpdateUser.mock.invocationCallOrder[0],
    );
  });

  it('treats GoTrue same_password as the no-op it is', async () => {
    stage();
    mockUpdateUser.mockResolvedValue({
      error: { code: 'same_password', message: 'New password should be different from the old password.' },
    });
    render(<AcceptInvitePage />);

    await userEvent.type(await screen.findByLabelText(/first name/i), 'Grace');
    await userEvent.type(screen.getByLabelText(/last name/i), 'Hopper');
    await userEvent.type(screen.getByLabelText(/^password/i), 'hunter2');
    await userEvent.type(screen.getByLabelText(/confirm password/i), 'hunter2');
    await userEvent.click(screen.getByRole('button', { name: /accept invitation/i }));

    // Accepted, redirected, and the user never sees the message.
    await waitFor(() => expect(routerMocks.replace).toHaveBeenCalledWith('/dashboard/company-b'));
    expect(screen.queryByText(/different from the old password/i)).not.toBeInTheDocument();
  });

  it('keeps the access it already granted when the profile write genuinely fails', async () => {
    stage();
    mockUpdateUser.mockResolvedValue({ error: { code: 'weak_password', message: 'Password is too weak' } });
    render(<AcceptInvitePage />);

    await userEvent.type(await screen.findByLabelText(/first name/i), 'Grace');
    await userEvent.type(screen.getByLabelText(/last name/i), 'Hopper');
    await userEvent.type(screen.getByLabelText(/^password/i), 'hunter2');
    await userEvent.type(screen.getByLabelText(/confirm password/i), 'hunter2');
    await userEvent.click(screen.getByRole('button', { name: /accept invitation/i }));

    // No dead end: they are told they're in, and can get there.
    const continueButton = await screen.findByRole('button', { name: /continue to acme machining/i });
    expect(screen.getByText(/you've been added to acme machining/i)).toBeInTheDocument();

    await userEvent.click(continueButton);
    expect(routerMocks.replace).toHaveBeenCalledWith('/dashboard/company-b');
  });

  it('does not re-run the non-idempotent RPC on a retry', async () => {
    stage();
    mockUpdateUser.mockResolvedValue({ error: { code: 'weak_password', message: 'Password is too weak' } });
    render(<AcceptInvitePage />);

    await userEvent.type(await screen.findByLabelText(/first name/i), 'Grace');
    await userEvent.type(screen.getByLabelText(/last name/i), 'Hopper');
    await userEvent.type(screen.getByLabelText(/^password/i), 'hunter2');
    await userEvent.type(screen.getByLabelText(/confirm password/i), 'hunter2');
    await userEvent.click(screen.getByRole('button', { name: /accept invitation/i }));
    await screen.findByRole('button', { name: /continue to acme machining/i });

    mockUpdateUser.mockResolvedValue({ error: null });
    await userEvent.click(screen.getByRole('button', { name: /accept invitation/i }));

    await waitFor(() => expect(routerMocks.replace).toHaveBeenCalledWith('/dashboard/company-b'));
    // A second call would raise "Invalid or expired invitation" — the invitation is no longer
    // pending — and report that as the reason the retry failed.
    expect(mockRpc).toHaveBeenCalledTimes(1);
  });
});

describe('accept-invite — brand-new invitee', () => {
  it('requires a password, since blank no longer means "I already have one"', async () => {
    stage();
    render(<AcceptInvitePage />);

    const password = await screen.findByLabelText(/^password/i);
    expect(password).toBeRequired();
    expect(screen.getByLabelText(/confirm password/i)).toBeRequired();
    expect(screen.queryByText(/leave blank if you already have one/i)).not.toBeInTheDocument();
  });

  it('refuses to submit a password shorter than the minimum', async () => {
    stage();
    render(<AcceptInvitePage />);

    await userEvent.type(await screen.findByLabelText(/first name/i), 'Grace');
    await userEvent.type(screen.getByLabelText(/last name/i), 'Hopper');
    await userEvent.type(screen.getByLabelText(/^password/i), 'abc');
    await userEvent.type(screen.getByLabelText(/confirm password/i), 'abc');
    await userEvent.click(screen.getByRole('button', { name: /accept invitation/i }));

    // By role, not by text: the field's own helper text says "At least 6 characters" too, so a
    // bare text query matches both and cannot tell a hint from a rejection.
    expect(await screen.findByRole('alert')).toHaveTextContent(/must be at least 6 characters/i);
    expect(mockRpc).not.toHaveBeenCalled();
  });
});
