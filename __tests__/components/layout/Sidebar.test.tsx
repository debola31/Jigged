import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '../../test-utils';
import Sidebar from '@/components/layout/Sidebar';

// Mock the useUserRole hook
const mockUseUserRole = vi.fn();
vi.mock('@/hooks/useUserRole', () => ({
  useUserRole: () => mockUseUserRole(),
}));

// Mock CompanySwitcher to avoid its own dependencies
vi.mock('@/components/layout/CompanySwitcher', () => ({
  default: () => <div data-testid="company-switcher">CompanySwitcher</div>,
}));

describe('Sidebar', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseUserRole.mockReset();
  });

  it('renders all menu items for admin', () => {
    mockUseUserRole.mockReturnValue({ role: 'admin', isAdmin: true, loading: false });

    render(<Sidebar />);

    expect(screen.getByText('Dashboard')).toBeInTheDocument();
    expect(screen.getByText('Quotes')).toBeInTheDocument();
    expect(screen.getByText('Jobs')).toBeInTheDocument();
    expect(screen.getByText('Parts')).toBeInTheDocument();
    // Inventory came back as its own list page (Parts/Inventory split). It
    // sits between Parts and Work Centers in the sidebar.
    expect(screen.getByText('Inventory')).toBeInTheDocument();
    expect(screen.getByText('Work Centers')).toBeInTheDocument();
    expect(screen.getByText('Vendors')).toBeInTheDocument();
    expect(screen.getByText('Customers')).toBeInTheDocument();
    expect(screen.getByText('Team')).toBeInTheDocument();
    expect(screen.getByText('Settings')).toBeInTheDocument();
    // Operations was deleted earlier and stays gone.
    expect(screen.queryByText('Operations')).not.toBeInTheDocument();
  });

  it('hides Team and Settings for user role', () => {
    mockUseUserRole.mockReturnValue({ role: 'user', isAdmin: false, loading: false });

    render(<Sidebar />);

    expect(screen.getByText('Dashboard')).toBeInTheDocument();
    expect(screen.getByText('Quotes')).toBeInTheDocument();
    expect(screen.getByText('Jobs')).toBeInTheDocument();
    expect(screen.queryByText('Team')).not.toBeInTheDocument();
    expect(screen.queryByText('Settings')).not.toBeInTheDocument();
  });

  it('shows non-admin items for all roles', () => {
    mockUseUserRole.mockReturnValue({ role: 'user', isAdmin: false, loading: false });

    render(<Sidebar />);

    const alwaysVisible = ['Dashboard', 'Quotes', 'Jobs', 'Parts', 'Customers'];
    for (const item of alwaysVisible) {
      expect(screen.getByText(item)).toBeInTheDocument();
    }
  });
});
