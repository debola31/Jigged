import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '../../test-utils';
import Sidebar from '@/components/layout/Sidebar';

// Mock the useUserRole hook
const mockUseUserRole = vi.fn();
vi.mock('@/hooks/useUserRole', () => ({
  useUserRole: () => mockUseUserRole(),
}));

// Mock useCompanyFeatures — without it, the hook calls getCompany() which
// transitively creates a Supabase client and fails when env vars aren't
// set in the test runner. We only want to verify rendering logic here.
const mockUseCompanyFeatures = vi.fn();
vi.mock('@/hooks/useCompanyFeatures', () => ({
  useCompanyFeatures: () => mockUseCompanyFeatures(),
}));

// Mock CompanySwitcher to avoid its own dependencies
vi.mock('@/components/layout/CompanySwitcher', () => ({
  default: () => <div data-testid="company-switcher">CompanySwitcher</div>,
}));

describe('Sidebar', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseUserRole.mockReset();
    // Default: features finished loading, nothing enabled. Individual
    // tests override to flip the Shipments flag on/off.
    mockUseCompanyFeatures.mockReturnValue({
      features: { shipments: false },
      loading: false,
    });
  });

  it('renders all menu items for admin', () => {
    mockUseUserRole.mockReturnValue({ role: 'admin', isAdmin: true, loading: false });
    mockUseCompanyFeatures.mockReturnValue({
      features: { shipments: false, inventory_locations: true },
      loading: false,
    });

    render(<Sidebar />);

    expect(screen.getByText('Dashboard')).toBeInTheDocument();
    expect(screen.getByText('Quotes')).toBeInTheDocument();
    expect(screen.getByText('Jobs')).toBeInTheDocument();
    expect(screen.getByText('Parts')).toBeInTheDocument();
    // 'Inventory' became 'Storage' when the /inventory list folded into Parts. Parts now
    // holds the quantities — i.e. Parts *is* the inventory — so keeping the old word here
    // would have the two labels swapped relative to their meanings: inventory = the items,
    // storage = the places. Sits between Parts and Work Centers.
    expect(screen.getByText('Storage')).toBeInTheDocument();
    expect(screen.queryByText('Inventory')).not.toBeInTheDocument();
    expect(screen.getByText('Work Centers')).toBeInTheDocument();
    expect(screen.getByText('Vendors')).toBeInTheDocument();
    expect(screen.getByText('Customers')).toBeInTheDocument();
    expect(screen.getByText('Team')).toBeInTheDocument();
    expect(screen.getByText('Settings')).toBeInTheDocument();
    // Operations was deleted earlier and stays gone.
    expect(screen.queryByText('Operations')).not.toBeInTheDocument();
  });

  it('hides Storage when the locations flag is off — such a shop has no places at all', () => {
    mockUseUserRole.mockReturnValue({ role: 'admin', isAdmin: true, loading: false });
    mockUseCompanyFeatures.mockReturnValue({
      features: { shipments: false, inventory_locations: false },
      loading: false,
    });

    render(<Sidebar />);

    expect(screen.queryByText('Storage')).not.toBeInTheDocument();
    // Parts is still the item master either way — the count moves to its toolbar.
    expect(screen.getByText('Parts')).toBeInTheDocument();
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

  // The Shipments nav item (the only feature-flag-gated entry) was removed
  // when the standalone Shipments page was retired — a slip now lives on its
  // job. The flag-gating + skeleton tests went with it.
  it('does not render a Shipments nav item', () => {
    mockUseUserRole.mockReturnValue({ role: 'admin', isAdmin: true, loading: false });
    mockUseCompanyFeatures.mockReturnValue({
      features: { shipments: true },
      loading: false,
    });

    render(<Sidebar />);

    expect(screen.queryByText('Shipments')).not.toBeInTheDocument();
  });
});
