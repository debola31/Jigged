import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, resetRouterMocks } from '../../test-utils';
import AdminGuard from '@/components/auth/AdminGuard';

// Mock the useUserRole hook
const mockUseUserRole = vi.fn();
vi.mock('@/hooks/useUserRole', () => ({
  useUserRole: () => mockUseUserRole(),
}));

describe('AdminGuard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetRouterMocks();
    mockUseUserRole.mockReset();
  });

  it('shows loading spinner while role loads', () => {
    mockUseUserRole.mockReturnValue({ role: null, isAdmin: false, loading: true });

    render(
      <AdminGuard>
        <div>Admin Content</div>
      </AdminGuard>
    );

    expect(screen.getByRole('progressbar')).toBeInTheDocument();
    expect(screen.queryByText('Admin Content')).not.toBeInTheDocument();
  });

  it('renders children for admin role', () => {
    mockUseUserRole.mockReturnValue({ role: 'admin', isAdmin: true, loading: false });

    render(
      <AdminGuard>
        <div>Admin Content</div>
      </AdminGuard>
    );

    expect(screen.getByText('Admin Content')).toBeInTheDocument();
  });

  it('renders children for owner role', () => {
    mockUseUserRole.mockReturnValue({ role: 'owner', isAdmin: true, loading: false });

    render(
      <AdminGuard>
        <div>Admin Content</div>
      </AdminGuard>
    );

    expect(screen.getByText('Admin Content')).toBeInTheDocument();
  });

  it('shows permission denied for user role', () => {
    mockUseUserRole.mockReturnValue({ role: 'user', isAdmin: false, loading: false });

    render(
      <AdminGuard>
        <div>Admin Content</div>
      </AdminGuard>
    );

    expect(screen.queryByText('Admin Content')).not.toBeInTheDocument();
    expect(screen.getByText(/don\u2019t have permission/i)).toBeInTheDocument();
  });

  it('shows "Back to Dashboard" button for non-admins', () => {
    mockUseUserRole.mockReturnValue({ role: 'user', isAdmin: false, loading: false });

    render(
      <AdminGuard>
        <div>Admin Content</div>
      </AdminGuard>
    );

    expect(screen.getByRole('button', { name: /back to dashboard/i })).toBeInTheDocument();
  });

  it('uses custom message when provided', () => {
    mockUseUserRole.mockReturnValue({ role: 'user', isAdmin: false, loading: false });

    render(
      <AdminGuard message="Custom access denied message">
        <div>Admin Content</div>
      </AdminGuard>
    );

    expect(screen.getByText('Custom access denied message')).toBeInTheDocument();
  });
});
