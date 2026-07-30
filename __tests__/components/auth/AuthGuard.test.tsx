import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, routerMocks, resetRouterMocks } from '../../test-utils';
import userEvent from '@testing-library/user-event';
import * as Sentry from '@sentry/nextjs';
import AuthGuard from '@/components/auth/AuthGuard';

vi.mock('@sentry/nextjs', () => ({
  captureException: vi.fn(),
}));

// Mock the auth provider
const mockUseAuth = vi.fn();
vi.mock('@/components/providers/AuthProvider', () => ({
  useAuth: () => mockUseAuth(),
}));

// Mock the company access utilities
const mockVerifyCompanyAccess = vi.fn();
const mockSetLastCompany = vi.fn();
const mockGetUserRole = vi.fn();
vi.mock('@/utils/companyAccess', () => ({
  verifyCompanyAccess: (...args: unknown[]) => mockVerifyCompanyAccess(...args),
  setLastCompany: (...args: unknown[]) => mockSetLastCompany(...args),
  getUserRole: (...args: unknown[]) => mockGetUserRole(...args),
}));

// Mock consumeSessionExpiry only — isTransientAbortError and toError are the real
// implementations on purpose, since the abort-classification logic is exactly what
// these tests are exercising. Stubbing it would test the mock, not the fix.
const mockConsumeSessionExpiry = vi.fn();
vi.mock('@/lib/supabaseErrors', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/supabaseErrors')>();
  return {
    ...actual,
    consumeSessionExpiry: () => mockConsumeSessionExpiry(),
  };
});

/** The shape @supabase/auth-js rejects with when another call steals the auth lock. */
const lockStolenError = () => ({
  code: '',
  details: '',
  hint: 'Request was aborted (timeout or manual cancellation)',
  message: 'AbortError: Lock was stolen by another request',
});

describe('AuthGuard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetRouterMocks();
    mockVerifyCompanyAccess.mockReset();
    mockSetLastCompany.mockReset();
    mockGetUserRole.mockReset();
    mockUseAuth.mockReset();
    mockConsumeSessionExpiry.mockReset();
    mockConsumeSessionExpiry.mockReturnValue(null);
  });

  // ============== Loading States ==============

  describe('loading states', () => {
    it('shows loading spinner when auth is loading', () => {
      mockUseAuth.mockReturnValue({
        user: null,
        loading: true,
      });

      render(
        <AuthGuard companyId="company-1">
          <div>Protected Content</div>
        </AuthGuard>
      );

      expect(screen.getByRole('progressbar')).toBeInTheDocument();
      expect(screen.queryByText('Protected Content')).not.toBeInTheDocument();
    });

    it('shows loading spinner while checking company access', async () => {
      mockUseAuth.mockReturnValue({
        user: { id: 'user-1', email: 'test@example.com' },
        loading: false,
      });

      // Never resolve to keep loading
      mockVerifyCompanyAccess.mockImplementation(() => new Promise(() => {}));

      render(
        <AuthGuard companyId="company-1">
          <div>Protected Content</div>
        </AuthGuard>
      );

      expect(screen.getByRole('progressbar')).toBeInTheDocument();
    });
  });

  // ============== Not Authenticated ==============

  describe('not authenticated', () => {
    it('redirects to /login when user is not authenticated', async () => {
      mockUseAuth.mockReturnValue({
        user: null,
        loading: false,
      });

      render(
        <AuthGuard companyId="company-1">
          <div>Protected Content</div>
        </AuthGuard>
      );

      await waitFor(() => {
        expect(routerMocks.replace).toHaveBeenCalledWith('/login');
      });
    });
  });

  // ============== No Company Required ==============

  describe('no company required', () => {
    it('renders children when authenticated and no company required', async () => {
      mockUseAuth.mockReturnValue({
        user: { id: 'user-1', email: 'test@example.com' },
        loading: false,
      });

      render(
        <AuthGuard requireCompany={false}>
          <div>Protected Content</div>
        </AuthGuard>
      );

      await waitFor(() => {
        expect(screen.getByText('Protected Content')).toBeInTheDocument();
      });

      // Should not call company access functions
      expect(mockVerifyCompanyAccess).not.toHaveBeenCalled();
    });

    it('renders children when authenticated and no companyId provided', async () => {
      mockUseAuth.mockReturnValue({
        user: { id: 'user-1', email: 'test@example.com' },
        loading: false,
      });

      render(
        <AuthGuard>
          <div>Protected Content</div>
        </AuthGuard>
      );

      await waitFor(() => {
        expect(screen.getByText('Protected Content')).toBeInTheDocument();
      });

      expect(mockVerifyCompanyAccess).not.toHaveBeenCalled();
    });
  });

  // ============== Company Access Granted ==============

  describe('company access granted', () => {
    it('renders children when user has company access', async () => {
      mockUseAuth.mockReturnValue({
        user: { id: 'user-1', email: 'test@example.com' },
        loading: false,
      });
      mockVerifyCompanyAccess.mockResolvedValue(true);
      mockGetUserRole.mockResolvedValue('admin');
      mockSetLastCompany.mockResolvedValue(undefined);

      render(
        <AuthGuard companyId="company-1">
          <div>Protected Content</div>
        </AuthGuard>
      );

      await waitFor(() => {
        expect(screen.getByText('Protected Content')).toBeInTheDocument();
      });

      expect(mockVerifyCompanyAccess).toHaveBeenCalledWith('user-1', 'company-1');
    });

    it('sets last company when access is granted', async () => {
      mockUseAuth.mockReturnValue({
        user: { id: 'user-1', email: 'test@example.com' },
        loading: false,
      });
      mockVerifyCompanyAccess.mockResolvedValue(true);
      mockGetUserRole.mockResolvedValue('admin');
      mockSetLastCompany.mockResolvedValue(undefined);

      render(
        <AuthGuard companyId="company-1">
          <div>Protected Content</div>
        </AuthGuard>
      );

      await waitFor(() => {
        expect(mockSetLastCompany).toHaveBeenCalledWith('user-1', 'company-1');
      });
    });
  });

  // ============== Operator Redirect ==============

  describe('operator redirect', () => {
    it('redirects operator to /operator/{companyId}', async () => {
      mockUseAuth.mockReturnValue({
        user: { id: 'user-1', email: 'operator@example.com' },
        loading: false,
      });
      mockVerifyCompanyAccess.mockResolvedValue(true);
      mockGetUserRole.mockResolvedValue('operator');

      render(
        <AuthGuard companyId="company-1">
          <div>Protected Content</div>
        </AuthGuard>
      );

      await waitFor(() => {
        expect(routerMocks.replace).toHaveBeenCalledWith('/operator/company-1');
      });
    });

    it('does not redirect admin to operator view', async () => {
      mockUseAuth.mockReturnValue({
        user: { id: 'user-1', email: 'admin@example.com' },
        loading: false,
      });
      mockVerifyCompanyAccess.mockResolvedValue(true);
      mockGetUserRole.mockResolvedValue('admin');
      mockSetLastCompany.mockResolvedValue(undefined);

      render(
        <AuthGuard companyId="company-1">
          <div>Protected Content</div>
        </AuthGuard>
      );

      await waitFor(() => {
        expect(screen.getByText('Protected Content')).toBeInTheDocument();
      });

      expect(routerMocks.replace).not.toHaveBeenCalledWith(
        expect.stringContaining('/operator/')
      );
    });

    it('does not redirect user role to operator view', async () => {
      mockUseAuth.mockReturnValue({
        user: { id: 'user-1', email: 'user@example.com' },
        loading: false,
      });
      mockVerifyCompanyAccess.mockResolvedValue(true);
      mockGetUserRole.mockResolvedValue('user');
      mockSetLastCompany.mockResolvedValue(undefined);

      render(
        <AuthGuard companyId="company-1">
          <div>Protected Content</div>
        </AuthGuard>
      );

      await waitFor(() => {
        expect(screen.getByText('Protected Content')).toBeInTheDocument();
      });

      expect(routerMocks.replace).not.toHaveBeenCalledWith(
        expect.stringContaining('/operator/')
      );
    });

    it('does not call setLastCompany for operators', async () => {
      mockUseAuth.mockReturnValue({
        user: { id: 'user-1', email: 'operator@example.com' },
        loading: false,
      });
      mockVerifyCompanyAccess.mockResolvedValue(true);
      mockGetUserRole.mockResolvedValue('operator');

      render(
        <AuthGuard companyId="company-1">
          <div>Protected Content</div>
        </AuthGuard>
      );

      await waitFor(() => {
        expect(routerMocks.replace).toHaveBeenCalledWith('/operator/company-1');
      });

      expect(mockSetLastCompany).not.toHaveBeenCalled();
    });
  });

  // ============== Company Access Denied ==============

  describe('company access denied', () => {
    it('shows no access message when user lacks company access', async () => {
      mockUseAuth.mockReturnValue({
        user: { id: 'user-1', email: 'test@example.com' },
        loading: false,
      });
      mockVerifyCompanyAccess.mockResolvedValue(false);

      render(
        <AuthGuard companyId="company-1">
          <div>Protected Content</div>
        </AuthGuard>
      );

      await waitFor(() => {
        expect(screen.getByText(/don't have access to this company/i)).toBeInTheDocument();
      });

      expect(screen.queryByText('Protected Content')).not.toBeInTheDocument();
    });

    it('shows button to select different company', async () => {
      mockUseAuth.mockReturnValue({
        user: { id: 'user-1', email: 'test@example.com' },
        loading: false,
      });
      mockVerifyCompanyAccess.mockResolvedValue(false);

      render(
        <AuthGuard companyId="company-1">
          <div>Protected Content</div>
        </AuthGuard>
      );

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /select a different company/i })).toBeInTheDocument();
      });
    });

    it('does not set last company when access is denied', async () => {
      mockUseAuth.mockReturnValue({
        user: { id: 'user-1', email: 'test@example.com' },
        loading: false,
      });
      mockVerifyCompanyAccess.mockResolvedValue(false);

      render(
        <AuthGuard companyId="company-1">
          <div>Protected Content</div>
        </AuthGuard>
      );

      await waitFor(() => {
        expect(screen.getByText(/don't have access/i)).toBeInTheDocument();
      });

      expect(mockSetLastCompany).not.toHaveBeenCalled();
    });
  });

  // ============== Error Handling ==============

  describe('error handling', () => {
    // This block previously asserted that a thrown error shows "You don't have access
    // to this company" — it encoded the bug. A failed *check* is not a denial, and
    // conflating them locked real users out of companies they had access to (Sentry
    // JAVASCRIPT-NEXTJS-9 / -H, 4 users, running since March).
    it('shows a retryable "could not check" state — NOT a denial — when the check throws', async () => {
      mockUseAuth.mockReturnValue({
        user: { id: 'user-1', email: 'test@example.com' },
        loading: false,
      });
      mockVerifyCompanyAccess.mockRejectedValue(new Error('Database error'));

      render(
        <AuthGuard companyId="company-1">
          <div>Protected Content</div>
        </AuthGuard>
      );

      await waitFor(() => {
        expect(screen.getByText(/couldn't check your access/i)).toBeInTheDocument();
      });

      expect(screen.queryByText(/don't have access to this company/i)).not.toBeInTheDocument();
      expect(screen.queryByText('Protected Content')).not.toBeInTheDocument();
    });

    it('reports a genuine error to Sentry as a real Error, not a raw object', async () => {
      mockUseAuth.mockReturnValue({
        user: { id: 'user-1', email: 'test@example.com' },
        loading: false,
      });
      // A raw Supabase-shaped rejection: previously handed straight to Sentry, which
      // produced an ungroupable issue titled "e".
      mockVerifyCompanyAccess.mockRejectedValue({
        code: '42501',
        details: '',
        hint: '',
        message: 'permission denied for table user_company_access',
      });

      render(
        <AuthGuard companyId="company-1">
          <div>Protected Content</div>
        </AuthGuard>
      );

      await waitFor(() => {
        expect(screen.getByText(/couldn't check your access/i)).toBeInTheDocument();
      });

      expect(Sentry.captureException).toHaveBeenCalledTimes(1);
      const reported = vi.mocked(Sentry.captureException).mock.calls[0][0];
      expect(reported).toBeInstanceOf(Error);
      expect((reported as Error).message).toBe(
        'permission denied for table user_company_access'
      );
      // The Postgres code survives normalisation so it still reaches Sentry's context.
      expect((reported as Error & { code?: string }).code).toBe('42501');
    });

    it('lets the user retry after a failed check', async () => {
      mockUseAuth.mockReturnValue({
        user: { id: 'user-1', email: 'test@example.com' },
        loading: false,
      });
      mockVerifyCompanyAccess.mockRejectedValueOnce(new Error('Database error'));
      mockGetUserRole.mockResolvedValue('admin');
      mockSetLastCompany.mockResolvedValue(undefined);

      render(
        <AuthGuard companyId="company-1">
          <div>Protected Content</div>
        </AuthGuard>
      );

      await waitFor(() => {
        expect(screen.getByText(/couldn't check your access/i)).toBeInTheDocument();
      });

      mockVerifyCompanyAccess.mockResolvedValue(true);
      await userEvent.click(screen.getByRole('button', { name: /try again/i }));

      await waitFor(() => {
        expect(screen.getByText('Protected Content')).toBeInTheDocument();
      });
    });
  });

  // ============== Auth-lock Contention (the production bug) ==============

  describe('stolen auth lock', () => {
    it('retries and succeeds when the auth lock is stolen once', async () => {
      mockUseAuth.mockReturnValue({
        user: { id: 'user-1', email: 'test@example.com' },
        loading: false,
      });
      // @supabase/auth-js serialises token refreshes with the Web Locks API; a
      // concurrent call steals the lock and the loser rejects. The winner is doing the
      // same work, so retrying resolves it.
      mockVerifyCompanyAccess
        .mockRejectedValueOnce(lockStolenError())
        .mockResolvedValue(true);
      mockGetUserRole.mockResolvedValue('admin');
      mockSetLastCompany.mockResolvedValue(undefined);

      render(
        <AuthGuard companyId="company-1">
          <div>Protected Content</div>
        </AuthGuard>
      );

      await waitFor(() => {
        expect(screen.getByText('Protected Content')).toBeInTheDocument();
      });

      expect(mockVerifyCompanyAccess).toHaveBeenCalledTimes(2);
      // Never renders the denial screen on the way through.
      expect(screen.queryByText(/don't have access to this company/i)).not.toBeInTheDocument();
    });

    it('does not report a stolen lock to Sentry — it is a benign race, not a bug', async () => {
      mockUseAuth.mockReturnValue({
        user: { id: 'user-1', email: 'test@example.com' },
        loading: false,
      });
      mockVerifyCompanyAccess.mockRejectedValue(lockStolenError());

      render(
        <AuthGuard companyId="company-1">
          <div>Protected Content</div>
        </AuthGuard>
      );

      await waitFor(() => {
        expect(screen.getByText(/couldn't check your access/i)).toBeInTheDocument();
      });

      expect(Sentry.captureException).not.toHaveBeenCalled();
    });

    it('never claims denial when the lock is stolen on every attempt', async () => {
      mockUseAuth.mockReturnValue({
        user: { id: 'user-1', email: 'test@example.com' },
        loading: false,
      });
      mockVerifyCompanyAccess.mockRejectedValue(lockStolenError());

      render(
        <AuthGuard companyId="company-1">
          <div>Protected Content</div>
        </AuthGuard>
      );

      await waitFor(() => {
        expect(screen.getByText(/couldn't check your access/i)).toBeInTheDocument();
      });

      // The whole point: a lock race must never present as "you don't have access".
      expect(screen.queryByText(/don't have access to this company/i)).not.toBeInTheDocument();
      // Retried exactly once, then gave a recoverable state rather than looping.
      expect(mockVerifyCompanyAccess).toHaveBeenCalledTimes(2);
    });
  });

  // ============== Session Expiry ==============

  describe('session expiry', () => {
    it('redirects to /login with expiry params when sessionStorage has expiry info', async () => {
      mockUseAuth.mockReturnValue({
        user: null,
        loading: false,
      });
      mockConsumeSessionExpiry.mockReturnValue({
        expired: true,
        returnTo: '/dashboard/company-1/parts',
      });

      render(
        <AuthGuard companyId="company-1">
          <div>Protected Content</div>
        </AuthGuard>
      );

      await waitFor(() => {
        expect(routerMocks.replace).toHaveBeenCalledWith(
          '/login?expired=true&returnTo=%2Fdashboard%2Fcompany-1%2Fparts'
        );
      });
    });

    it('redirects to plain /login when no expiry info in sessionStorage', async () => {
      mockUseAuth.mockReturnValue({
        user: null,
        loading: false,
      });
      mockConsumeSessionExpiry.mockReturnValue(null);

      render(
        <AuthGuard companyId="company-1">
          <div>Protected Content</div>
        </AuthGuard>
      );

      await waitFor(() => {
        expect(routerMocks.replace).toHaveBeenCalledWith('/login');
      });
    });
  });
});
