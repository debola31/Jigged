import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '../../test-utils';
import Sidebar from '@/components/layout/Sidebar';

// Mock the useUserRole hook
const mockUseUserRole = vi.fn();
vi.mock('@/hooks/useUserRole', () => ({
  useUserRole: () => mockUseUserRole(),
}));

// No useCompanyFeatures mock: the Sidebar stopped calling that hook when the last flag-gated nav
// item (Storage, on `inventory_locations`) went unconditional in Aug 2026. An inert mock left
// behind here would keep passing against a component that no longer reads it.

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
    // 'Inventory' became 'Storage' when the /inventory list folded into Parts. Parts now
    // holds the quantities — i.e. Parts *is* the inventory — so keeping the old word here
    // would have the two labels swapped relative to their meanings: inventory = the items,
    // storage = the places. Sits between Parts and Work Centers.
    //
    // Unconditional: no mocked feature state is set up anywhere in this file, so this also proves
    // Storage renders on first paint with no flag read at all. It used to sit behind
    // `inventory_locations` and hold its slot with a Skeleton while that resolved.
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

  // The sidebar is office navigation only. The way to the shop floor is the labelled
  // button in the Header, which reaches every page at every width — this one wouldn't,
  // since the sidebar is behind a hamburger on a phone. See Header.test.tsx.
  it('does not duplicate the Header shop-floor door', () => {
    mockUseUserRole.mockReturnValue({ role: 'admin', isAdmin: true, loading: false });

    render(<Sidebar />);

    expect(screen.queryByText(/shop floor/i)).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /^dashboard$/i })).toHaveAttribute(
      'href',
      '/dashboard/test-company-id',
    );
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

  // The Shipments nav item was removed when the standalone Shipments page was retired — a slip
  // now lives on its job. Storage, gated on `inventory_locations`, was the last flag-gated entry
  // and went unconditional in Aug 2026; the flag-gating and Skeleton machinery went with it, so
  // MenuItem no longer carries a `featureFlag` field at all.
  // One row for buying, for admins AND users: purchasing is office work for both roles (plan §2),
  // so it must not be filtered with Team and Settings. Placed after Storage — buying is how stock
  // gets in — and pointing at the hub, whose tabs hold the orders, receipts, To buy and RFQs.
  it.each([
    ['admin', true],
    ['user', false],
  ])('shows one Purchasing row, after Storage, for %s', (role, isAdmin) => {
    mockUseUserRole.mockReturnValue({ role, isAdmin, loading: false });

    render(<Sidebar />);

    const purchasing = screen.getAllByRole('link', { name: /^purchasing$/i });
    expect(purchasing).toHaveLength(1);
    expect(purchasing[0]).toHaveAttribute('href', '/dashboard/test-company-id/purchasing');

    const names = screen.getAllByRole('link').map((a) => a.textContent ?? '');
    expect(names.indexOf('Purchasing')).toBe(names.indexOf('Storage') + 1);
  });

  it('does not render a Shipments nav item', () => {
    mockUseUserRole.mockReturnValue({ role: 'admin', isAdmin: true, loading: false });

    render(<Sidebar />);

    expect(screen.queryByText('Shipments')).not.toBeInTheDocument();
  });
});
