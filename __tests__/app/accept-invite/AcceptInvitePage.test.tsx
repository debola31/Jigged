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

import { CURRENT_LEGAL_VERSIONS } from '@/lib/legal/manifest';
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
    if (String(url).includes('/legal/accept')) {
      acceptCalls.push({ body: JSON.parse(String(init?.body ?? '{}')), at: Date.now() });
      mockAcceptFetch();
      return { ok: true, json: async () => ({ recorded: [] }) } as Response;
    }
    if (init?.method === 'PATCH') return { ok: true, json: async () => ({}) } as Response;
    return { ok: true, json: async () => inv } as Response;
  }) as unknown as typeof fetch;
}

/** Bodies POSTed to /legal/accept during a test. */
const acceptCalls: { body: Record<string, unknown>; at: number }[] = [];
/** A spy purely so invocationCallOrder can be compared against mockRpc. */
const mockAcceptFetch = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  acceptCalls.length = 0;
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

    await screen.findByRole('button', { name: /join acme machining/i });
    await agreeToTerms();
    await userEvent.click(screen.getByRole('button', { name: /join acme machining/i }));

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

    await screen.findByRole('button', { name: /join acme machining/i });
    await agreeToTerms();
    await userEvent.click(screen.getByRole('button', { name: /join acme machining/i }));

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

/**
 * Ticks the clickwrap box. Consent is now a precondition for BOTH surfaces --
 * the name-prompt form and the one-tap join -- so every test that reaches a
 * submit has to give it first. Kept as a helper so a future change to the
 * control is one edit here rather than one per test.
 */
async function agreeToTerms() {
  const box = screen.queryByRole('checkbox', { name: /i agree to the terms/i });
  // Idempotent: consent state survives a failed submit, so a retry path calls
  // this twice and an unconditional click would UNTICK the box and re-disable
  // the button -- which is exactly what the box is supposed to do.
  if (box && !(box as HTMLInputElement).checked) await userEvent.click(box);
}

describe('accept-invite — ordering and failure handling', () => {
  it('grants access BEFORE writing the profile', async () => {
    stage();
    render(<AcceptInvitePage />);

    await userEvent.type(await screen.findByLabelText(/first name/i), 'Grace');
    await userEvent.type(screen.getByLabelText(/last name/i), 'Hopper');
    await userEvent.type(screen.getByLabelText(/^password/i), 'hunter2');
    await userEvent.type(screen.getByLabelText(/confirm password/i), 'hunter2');
    await agreeToTerms();
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
    await agreeToTerms();
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
    await agreeToTerms();
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
    await agreeToTerms();
    await userEvent.click(screen.getByRole('button', { name: /accept invitation/i }));
    await screen.findByRole('button', { name: /continue to acme machining/i });

    mockUpdateUser.mockResolvedValue({ error: null });
    await agreeToTerms();
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
    await agreeToTerms();
    await userEvent.click(screen.getByRole('button', { name: /accept invitation/i }));

    // By role, not by text: the field's own helper text says "At least 6 characters" too, so a
    // bare text query matches both and cannot tell a hint from a rejection.
    expect(await screen.findByRole('alert')).toHaveTextContent(/must be at least 6 characters/i);
    expect(mockRpc).not.toHaveBeenCalled();
  });
});


describe('accept-invite — clickwrap consent', () => {
  it('starts with the agreement box unchecked', async () => {
    stage();
    render(<AcceptInvitePage />);
    expect(await screen.findByRole('checkbox', { name: /i agree to the terms/i })).not.toBeChecked();
  });

  it('will not accept the invitation until the terms box is ticked', async () => {
    stage();
    render(<AcceptInvitePage />);

    await userEvent.type(await screen.findByLabelText(/first name/i), 'Grace');
    await userEvent.type(screen.getByLabelText(/last name/i), 'Hopper');
    await userEvent.type(screen.getByLabelText(/^password/i), 'hunter2');
    await userEvent.type(screen.getByLabelText(/confirm password/i), 'hunter2');

    // Deliberately does NOT click: the button is disabled and user-event refuses
    // the interaction. That refusal is the assertion.
    expect(screen.getByRole('button', { name: /accept invitation/i })).toBeDisabled();
    expect(mockRpc).not.toHaveBeenCalled();

    await agreeToTerms();
    expect(screen.getByRole('button', { name: /accept invitation/i })).toBeEnabled();
  });

  /** The "linked inline directly beside it" half of the requirement: consent is
   *  only informed if the documents are reachable from the control itself. */
  it('links both documents beside the box', async () => {
    stage();
    render(<AcceptInvitePage />);
    expect(await screen.findByRole('link', { name: /terms of service/i })).toHaveAttribute(
      'href',
      '/terms',
    );
    expect(screen.getByRole('link', { name: /privacy policy/i })).toHaveAttribute(
      'href',
      '/privacy',
    );
  });

  /**
   * ORDERING. Access is what the invitee came for and accept_invitation is not
   * idempotent, so the acceptance write must come AFTER it and must never be
   * able to cost them their membership.
   */
  it('records the acceptance after access is granted, not before', async () => {
    stage();
    render(<AcceptInvitePage />);

    await userEvent.type(await screen.findByLabelText(/first name/i), 'Grace');
    await userEvent.type(screen.getByLabelText(/last name/i), 'Hopper');
    await userEvent.type(screen.getByLabelText(/^password/i), 'hunter2');
    await userEvent.type(screen.getByLabelText(/confirm password/i), 'hunter2');
    await agreeToTerms();
    await userEvent.click(screen.getByRole('button', { name: /accept invitation/i }));

    await waitFor(() => expect(acceptCalls).toHaveLength(1));
    expect(mockRpc.mock.invocationCallOrder[0]).toBeLessThan(
      mockAcceptFetch.mock.invocationCallOrder[0],
    );
    expect(acceptCalls[0].body.accepted_via).toBe('invite_accept');
  });

  /**
   * The client tells the server which versions it BELIEVES it displayed, and the
   * server treats that as rejection-only. It sends no IP, no hash and no version
   * of its own -- there is nowhere in the request for them.
   */
  it('sends the versions it displayed, and never an IP or a hash', async () => {
    stage();
    render(<AcceptInvitePage />);

    await userEvent.type(await screen.findByLabelText(/first name/i), 'Grace');
    await userEvent.type(screen.getByLabelText(/last name/i), 'Hopper');
    await userEvent.type(screen.getByLabelText(/^password/i), 'hunter2');
    await userEvent.type(screen.getByLabelText(/confirm password/i), 'hunter2');
    await agreeToTerms();
    await userEvent.click(screen.getByRole('button', { name: /accept invitation/i }));

    await waitFor(() => expect(acceptCalls).toHaveLength(1));
    const body = acceptCalls[0].body as Record<string, unknown>;
    expect(body.document_types).toEqual(['tos', 'privacy']);
    expect((body.displayed_versions as Record<string, number>).tos).toBe(
      CURRENT_LEGAL_VERSIONS.tos.version,
    );
    for (const forbidden of ['ip_address', 'user_agent', 'document_sha256', 'version']) {
      expect(Object.keys(body)).not.toContain(forbidden);
    }
  });

  /**
   * A failed acceptance write must NOT cost the invitee their membership. They
   * land in the app, and TermsGate collects on the next page load through the
   * same server path -- no special case anywhere.
   */
  it('still grants access when the acceptance write fails', async () => {
    stage();
    const original = global.fetch;
    global.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).includes('/legal/accept')) throw new Error('network down');
      return (original as typeof fetch)(url as never, init as never);
    }) as unknown as typeof fetch;

    render(<AcceptInvitePage />);
    await userEvent.type(await screen.findByLabelText(/first name/i), 'Grace');
    await userEvent.type(screen.getByLabelText(/last name/i), 'Hopper');
    await userEvent.type(screen.getByLabelText(/^password/i), 'hunter2');
    await userEvent.type(screen.getByLabelText(/confirm password/i), 'hunter2');
    await agreeToTerms();
    await userEvent.click(screen.getByRole('button', { name: /accept invitation/i }));

    await waitFor(() => expect(routerMocks.replace).toHaveBeenCalled());
    expect(mockRpc).toHaveBeenCalledTimes(1);
  });
});
