import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, routerMocks, resetRouterMocks } from '../../test-utils';
import AuthGuard from '@/components/auth/AuthGuard';

// Mock the auth provider
const mockUseAuth = vi.fn();
vi.mock('@/components/providers/AuthProvider', () => ({
  useAuth: () => mockUseAuth(),
}));

// Mock the company access utilities
const mockVerifyCompanyAccess = vi.fn();
const mockSetLastCompany = vi.fn();
vi.mock('@/utils/companyAccess', () => ({
  verifyCompanyAccess: (...args: unknown[]) => mockVerifyCompanyAccess(...args),
  setLastCompany: (...args: unknown[]) => mockSetLastCompany(...args),
}));

// Mock consumeSessionExpiry
const mockConsumeSessionExpiry = vi.fn();
vi.mock('@/lib/supabaseErrors', () => ({
  consumeSessionExpiry: () => mockConsumeSessionExpiry(),
}));

describe('AuthGuard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetRouterMocks();
    mockVerifyCompanyAccess.mockReset();
    mockSetLastCompany.mockReset();
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
    it('shows no access when verifyCompanyAccess throws', async () => {
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
        expect(screen.getByText(/don't have access to this company/i)).toBeInTheDocument();
      });

      expect(screen.queryByText('Protected Content')).not.toBeInTheDocument();
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
