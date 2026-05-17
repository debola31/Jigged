import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, routerMocks, resetRouterMocks } from '../../test-utils';
import userEvent from '@testing-library/user-event';
import ChangePassword from '@/components/auth/ChangePassword';

// Shared `supabase` singleton — the user's real session lives here.
const sharedAuthStateListeners: Array<(event: string) => void> = [];

const sharedSupabase = {
  auth: {
    getSession: vi.fn(),
    signInWithPassword: vi.fn(),
    updateUser: vi.fn(),
    signOut: vi.fn(),
    onAuthStateChange: vi.fn((cb: (event: string) => void) => {
      sharedAuthStateListeners.push(cb);
      return { data: { subscription: { unsubscribe: vi.fn() } } };
    }),
  },
};

vi.mock('@/lib/supabase', () => ({
  getSupabase: () => sharedSupabase,
}));

// Throwaway verifier client built via createClient(...). The whole
// point of this component's design is that this client is separate
// from the shared one, so verification doesn't touch the user's
// real session.
const verifierClient = {
  auth: {
    signInWithPassword: vi.fn(),
  },
};

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => verifierClient),
}));

vi.mock('@/utils/companyAccess', () => ({
  getPostLoginRoute: vi.fn(async () => '/dashboard/test-company-id'),
}));

vi.mock('@sentry/nextjs', () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));

describe('ChangePassword (logged-in self-rotate)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetRouterMocks();
    sharedAuthStateListeners.length = 0;

    // Default: a valid logged-in session.
    sharedSupabase.auth.getSession.mockResolvedValue({
      data: {
        session: {
          access_token: 'tok',
          user: { id: 'user-1', email: 'shop-owner@example.com' },
        },
      },
    });
    sharedSupabase.auth.updateUser.mockResolvedValue({
      data: { user: { id: 'user-1', email: 'shop-owner@example.com' } },
      error: null,
    });
    sharedSupabase.auth.signOut.mockResolvedValue({ error: null });
    verifierClient.auth.signInWithPassword.mockResolvedValue({ data: {}, error: null });

    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon';
  });

  async function fillAndSubmit(opts: {
    current: string;
    next: string;
    confirm?: string;
  }) {
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/current password/i), opts.current);
    await user.type(screen.getByLabelText(/^new password/i), opts.next);
    await user.type(
      screen.getByLabelText(/confirm new password/i),
      opts.confirm ?? opts.next,
    );
    await user.click(screen.getByRole('button', { name: /change password/i }));
  }

  it('redirects to /login when no session', async () => {
    sharedSupabase.auth.getSession.mockResolvedValueOnce({ data: { session: null } });

    render(<ChangePassword />);

    await waitFor(() => {
      expect(routerMocks.replace).toHaveBeenCalledWith('/login');
    });
  });

  it('happy path: verifies via throwaway client, then updates on shared client, then signs out others', async () => {
    render(<ChangePassword />);
    await waitFor(() => screen.getByLabelText(/current password/i));

    await fillAndSubmit({ current: 'OldPassword!1', next: 'BrandNewPassword!2' });

    await waitFor(() => {
      expect(verifierClient.auth.signInWithPassword).toHaveBeenCalledWith({
        email: 'shop-owner@example.com',
        password: 'OldPassword!1',
      });
    });
    expect(sharedSupabase.auth.updateUser).toHaveBeenCalledWith({
      password: 'BrandNewPassword!2',
    });
    expect(sharedSupabase.auth.signOut).toHaveBeenCalledWith({ scope: 'others' });

    // CRITICAL REGRESSION GUARD: signInWithPassword must NEVER be called on
    // the shared client. Doing so would replace the persisted session
    // mid-flow and fire SIGNED_IN on every auth-state subscriber.
    expect(
      (sharedSupabase.auth as { signInWithPassword?: ReturnType<typeof vi.fn> })
        .signInWithPassword,
    ).not.toHaveBeenCalled();
  });

  it('wrong current password: surfaces error, does NOT call updateUser', async () => {
    verifierClient.auth.signInWithPassword.mockResolvedValueOnce({
      data: {},
      error: { message: 'Invalid login credentials', status: 400 },
    });

    render(<ChangePassword />);
    await waitFor(() => screen.getByLabelText(/current password/i));

    await fillAndSubmit({ current: 'NotMyPassword!', next: 'BrandNewPassword!2' });

    await waitFor(() => {
      expect(screen.getByText(/current password is incorrect/i)).toBeInTheDocument();
    });
    expect(sharedSupabase.auth.updateUser).not.toHaveBeenCalled();
    expect(sharedSupabase.auth.signOut).not.toHaveBeenCalled();
  });

  it('rate-limited verify: surfaces lockout message, does NOT call updateUser', async () => {
    verifierClient.auth.signInWithPassword.mockResolvedValueOnce({
      data: {},
      error: { message: 'Rate limit exceeded', status: 429 },
    });

    render(<ChangePassword />);
    await waitFor(() => screen.getByLabelText(/current password/i));

    await fillAndSubmit({ current: 'OldPassword!1', next: 'BrandNewPassword!2' });

    await waitFor(() => {
      expect(screen.getByText(/too many attempts/i)).toBeInTheDocument();
    });
    expect(sharedSupabase.auth.updateUser).not.toHaveBeenCalled();
  });

  it('mismatched confirm password: blocks submit, never hits verifier', async () => {
    render(<ChangePassword />);
    await waitFor(() => screen.getByLabelText(/current password/i));

    await fillAndSubmit({
      current: 'OldPassword!1',
      next: 'BrandNewPassword!2',
      confirm: 'Different!2',
    });

    // The error message appears both as an Alert and as the confirm field's
    // helper-text — use the role='alert' lookup to disambiguate.
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/passwords do not match/i);
    });
    expect(verifierClient.auth.signInWithPassword).not.toHaveBeenCalled();
    expect(sharedSupabase.auth.updateUser).not.toHaveBeenCalled();
  });

  it('updateUser failure: surfaces error, signOut NOT called', async () => {
    // The component re-throws updateUser's error object — give it a real
    // Error instance so the catch's `err instanceof Error` branch passes
    // through the message (matches what the real Supabase client returns).
    sharedSupabase.auth.updateUser.mockResolvedValueOnce({
      data: { user: null },
      error: Object.assign(new Error('Password too weak'), { name: 'AuthError' }),
    });

    render(<ChangePassword />);
    await waitFor(() => screen.getByLabelText(/current password/i));

    await fillAndSubmit({ current: 'OldPassword!1', next: 'BrandNewPassword!2' });

    await waitFor(() => {
      expect(screen.getByText(/password too weak/i)).toBeInTheDocument();
    });
    expect(sharedSupabase.auth.signOut).not.toHaveBeenCalled();
  });
});
