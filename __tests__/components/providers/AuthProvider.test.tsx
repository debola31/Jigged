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

const mockClearStoredStation = vi.fn();
vi.mock('@/lib/operatorStationStorage', () => ({
  clearStoredStation: (...a: unknown[]) => mockClearStoredStation(...a),
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

  // The selected station is device-local, so Supabase's own sign-out does not
  // touch it. Left behind, the next person to sign in on a shared shop phone
  // inherits whatever machine the last person was standing at, and their notes
  // get filed against it with nothing on screen to say so.
  it('forgets the station on every company when a session ends on this device', async () => {
    render(
      <AuthProvider>
        <SignOutHarness />
      </AuthProvider>,
    );

    await userEvent.click(screen.getByRole('button', { name: 'default' }));

    // No argument — every company, not just whichever one was on screen.
    await waitFor(() => expect(mockClearStoredStation).toHaveBeenCalledWith());
  });

  it("leaves the station alone for scope 'others', which keeps THIS device signed in", async () => {
    // No handover happens, so stripping a working station would just put the
    // operator in front of the picker for nothing.
    render(
      <AuthProvider>
        <SignOutHarness />
      </AuthProvider>,
    );

    await userEvent.click(screen.getByRole('button', { name: 'others' }));

    await waitFor(() => {
      expect(sharedSupabase.auth.signOut).toHaveBeenCalledWith({ scope: 'others' });
    });
    expect(mockClearStoredStation).not.toHaveBeenCalled();
  });
});
