import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '../../test-utils';
import userEvent from '@testing-library/user-event';
import AuthProvider, { useAuth } from '@/components/providers/AuthProvider';

// Shared Supabase singleton the provider talks to.
const sharedSupabase = {
  auth: {
    getSession: vi.fn(),
    onAuthStateChange: vi.fn(() => ({
      data: { subscription: { unsubscribe: vi.fn() } },
    })),
    signOut: vi.fn(),
  },
};

vi.mock('@/lib/supabase', () => ({
  getSupabase: () => sharedSupabase,
}));

vi.mock('@sentry/nextjs', () => ({
  captureException: vi.fn(),
  setUser: vi.fn(),
}));

// Minimal consumer that exercises the context signOut with each scope.
function SignOutHarness() {
  const { signOut } = useAuth();
  return (
    <>
      <button onClick={() => signOut()}>default</button>
      <button onClick={() => signOut('global')}>global</button>
      <button onClick={() => signOut('others')}>others</button>
    </>
  );
}

describe('AuthProvider signOut scope', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sharedSupabase.auth.getSession.mockResolvedValue({
      data: { session: { user: { id: 'user-1', email: 'op@example.com' } } },
    });
    sharedSupabase.auth.signOut.mockResolvedValue({ error: null });
  });

  it("defaults to local scope so logging out one device doesn't revoke others", async () => {
    render(
      <AuthProvider>
        <SignOutHarness />
      </AuthProvider>,
    );

    await userEvent.click(screen.getByRole('button', { name: 'default' }));

    await waitFor(() => {
      expect(sharedSupabase.auth.signOut).toHaveBeenCalledWith({ scope: 'local' });
    });
  });

  it('passes an explicit scope through (global for password reset)', async () => {
    render(
      <AuthProvider>
        <SignOutHarness />
      </AuthProvider>,
    );

    await userEvent.click(screen.getByRole('button', { name: 'global' }));
    await userEvent.click(screen.getByRole('button', { name: 'others' }));

    await waitFor(() => {
      expect(sharedSupabase.auth.signOut).toHaveBeenCalledWith({ scope: 'global' });
      expect(sharedSupabase.auth.signOut).toHaveBeenCalledWith({ scope: 'others' });
    });
  });
});
