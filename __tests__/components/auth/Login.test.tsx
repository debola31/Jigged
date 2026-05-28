import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, routerMocks, resetRouterMocks } from '../../test-utils';
import userEvent from '@testing-library/user-event';
import Login from '@/components/auth/Login';

const sharedSupabase = {
  auth: {
    signInWithPassword: vi.fn(),
  },
};

vi.mock('@/lib/supabase', () => ({
  getSupabase: () => sharedSupabase,
}));

const getPostLoginRoute = vi.fn();
vi.mock('@/utils/companyAccess', () => ({
  getPostLoginRoute: (...args: unknown[]) => getPostLoginRoute(...args),
}));

vi.mock('@sentry/nextjs', () => ({
  captureException: vi.fn(),
}));

describe('Login', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetRouterMocks();
    sharedSupabase.auth.signInWithPassword.mockResolvedValue({
      data: { user: { id: 'user-1', email: 'test@example.com' } },
      error: null,
    });
    getPostLoginRoute.mockResolvedValue('/dashboard/test-company');
    // Login.isValidReturnTo reads window.location.origin — jsdom provides
    // about:blank by default, which makes URL parsing flaky. Pin the origin
    // so the allowlist check is deterministic.
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: new URL('http://localhost:3000/login'),
    });
  });

  async function fillAndSubmit(email = 'test@example.com', password = 'hunter2') {
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/email/i), email);
    await user.type(screen.getByLabelText(/password/i), password);
    await user.click(screen.getByRole('button', { name: /sign in/i }));
  }

  it('renders the sign-in form', () => {
    render(<Login />);
    expect(screen.getByRole('heading', { name: /sign in/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/password/i)).toBeInTheDocument();
  });

  it('shows expired banner when expired prop is true', () => {
    render(<Login expired />);
    expect(screen.getByText(/your session expired/i)).toBeInTheDocument();
  });

  it('does NOT show expired banner by default', () => {
    render(<Login />);
    expect(screen.queryByText(/your session expired/i)).not.toBeInTheDocument();
  });

  it('signs in with email + password on submit', async () => {
    render(<Login />);
    await fillAndSubmit('me@example.com', 'pw');

    await waitFor(() => {
      expect(sharedSupabase.auth.signInWithPassword).toHaveBeenCalledWith({
        email: 'me@example.com',
        password: 'pw',
      });
    });
  });

  it('redirects to getPostLoginRoute on success when no returnTo', async () => {
    render(<Login />);
    await fillAndSubmit();

    await waitFor(() => {
      expect(getPostLoginRoute).toHaveBeenCalledWith('user-1');
      expect(routerMocks.push).toHaveBeenCalledWith('/dashboard/test-company');
    });
  });

  it('redirects to returnTo when it is a valid /dashboard path', async () => {
    render(<Login returnTo="/dashboard/abc/quotes" />);
    await fillAndSubmit();

    await waitFor(() => {
      expect(routerMocks.push).toHaveBeenCalledWith('/dashboard/abc/quotes');
    });
    // getPostLoginRoute should not be consulted when returnTo is valid
    expect(getPostLoginRoute).not.toHaveBeenCalled();
  });

  it('falls back to getPostLoginRoute when returnTo is an open-redirect attempt', async () => {
    render(<Login returnTo="https://evil.example.com/steal" />);
    await fillAndSubmit();

    await waitFor(() => {
      expect(getPostLoginRoute).toHaveBeenCalled();
      expect(routerMocks.push).toHaveBeenCalledWith('/dashboard/test-company');
    });
    // Never navigates to the attacker URL
    expect(routerMocks.push).not.toHaveBeenCalledWith('https://evil.example.com/steal');
  });

  it('falls back to getPostLoginRoute when returnTo points at a non-allowlisted path', async () => {
    render(<Login returnTo="/login" />);
    await fillAndSubmit();

    await waitFor(() => {
      expect(routerMocks.push).toHaveBeenCalledWith('/dashboard/test-company');
    });
    expect(routerMocks.push).not.toHaveBeenCalledWith('/login');
  });

  it('shows the error from Supabase when sign-in fails', async () => {
    // signInWithPassword resolves with the error nested in the response; the
    // component throws it inside the try, which lands in the catch and runs
    // `err instanceof Error ? err.message : ...`.
    sharedSupabase.auth.signInWithPassword.mockResolvedValueOnce({
      data: { user: null },
      error: new Error('Invalid login credentials'),
    });

    render(<Login />);
    await fillAndSubmit('wrong@example.com', 'wrong');

    expect(
      await screen.findByText('Invalid login credentials'),
    ).toBeInTheDocument();
    expect(routerMocks.push).not.toHaveBeenCalled();
  });

  it('does not push to a route when Supabase returns no user', async () => {
    sharedSupabase.auth.signInWithPassword.mockResolvedValueOnce({
      data: { user: null },
      error: null,
    });

    render(<Login />);
    await fillAndSubmit();

    // Give async work a tick to settle without long waits.
    await new Promise((r) => setTimeout(r, 50));
    expect(routerMocks.push).not.toHaveBeenCalled();
  });
});
