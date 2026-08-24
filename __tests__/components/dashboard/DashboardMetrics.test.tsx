import { describe, it, expect, vi, beforeEach } from 'vitest';
import userEvent from '@testing-library/user-event';
import { render, screen, waitFor, resetRouterMocks } from '../../test-utils';
import DashboardMetrics from '@/components/dashboard/DashboardMetrics';

/**
 * The scorecard row: what each role sees, and where the period control lives.
 *
 * The money line has TWO independent gates and they compose: the viewer must be a company admin,
 * AND the tenant must have the `dashboard_revenue` flag (opt-out — on unless a system admin killed
 * it). Both are DISPLAY choices, not security boundaries — RLS is company-scoped, not
 * column-scoped, so the figures stay readable through the API by anyone who can reach the company.
 * What they buy is that a salesperson sees the deals they work on rather than the shop's whole book
 * totalled up on the landing page, and that a shop whose dashboard lives on a wall-mounted screen
 * can turn the totals off for everyone.
 *
 * `revenueEnabled` is a prop rather than a hook read: the dashboard page already holds the resolved
 * feature map, so reading it again here would be a second `getCompany` per load — and it would make
 * every test below need a `useCompanyFeatures` mock rather than a boolean.
 */

const mockUseUserRole = vi.fn();
vi.mock('@/hooks/useUserRole', () => ({ useUserRole: () => mockUseUserRole() }));

const mockGetDashboardMetrics = vi.fn();
const mockSetCompletedPeriod = vi.fn();
vi.mock('@/utils/dashboardAccess', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/dashboardAccess')>();
  return {
    ...actual,
    getDashboardMetrics: (...a: unknown[]) => mockGetDashboardMetrics(...a),
    getCompletedPeriod: async () => 'this_week',
    setCompletedPeriod: (...a: unknown[]) => mockSetCompletedPeriod(...a),
  };
});

const VALUES = {
  overdue_jobs: { count: 8, money: 9766 },
  open_jobs: {
    count: 63,
    money: 85293,
    split: {
      notStarted: { count: 51, money: 69859 },
      inProgress: { count: 12, money: 15434 },
    },
  },
  completed_jobs: { count: 6, money: 12480, previousMoney: 11143 },
  open_quotes: { count: 25, money: null },
};

describe('DashboardMetrics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetRouterMocks();
    mockGetDashboardMetrics.mockResolvedValue(VALUES);
    // Must resolve: the component fires this without awaiting and attaches a
    // .catch, so a bare vi.fn() returning undefined throws inside the handler.
    mockSetCompletedPeriod.mockResolvedValue(undefined);
    mockUseUserRole.mockReturnValue({ role: 'admin', isAdmin: true, loading: false });
  });

  it('renders four cards and no picker or pager', async () => {
    render(<DashboardMetrics companyId="c1" revenueEnabled />);

    await waitFor(() => expect(screen.getByText('63')).toBeInTheDocument());

    for (const label of ['Overdue Jobs', 'Open Jobs', 'Completed Jobs', 'Open Quotes']) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    expect(screen.queryByText(/Edit metrics/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Add metric/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Next metrics/i)).not.toBeInTheDocument();
  });

  it('shows an admin the money, labelled by which KIND of money it is', async () => {
    render(<DashboardMetrics companyId="c1" revenueEnabled />);

    await waitFor(() => expect(screen.getByText('$9,766')).toBeInTheDocument());

    // Overdue and Open Jobs share a label on purpose: overdue money is a SLICE
    // of open-jobs money, so a distinct word would imply a separate pot.
    expect(screen.getAllByText('not yet shipped')).toHaveLength(2);
    expect(screen.getByText('$85,293')).toBeInTheDocument();
    expect(screen.getByText('$12,480')).toBeInTheDocument();
    expect(screen.getByText('shipped this week')).toBeInTheDocument();
  });

  it('hides every money figure from a non-admin', async () => {
    mockUseUserRole.mockReturnValue({ role: 'user', isAdmin: false, loading: false });

    render(<DashboardMetrics companyId="c1" revenueEnabled />);

    await waitFor(() => expect(screen.getByText('63')).toBeInTheDocument());

    // Counts still there; not one dollar figure is.
    expect(screen.getByText('8')).toBeInTheDocument();
    expect(screen.queryByText('$9,766')).not.toBeInTheDocument();
    expect(screen.queryByText('$85,293')).not.toBeInTheDocument();
    expect(screen.queryByText('$12,480')).not.toBeInTheDocument();
    expect(screen.queryByText('not yet shipped')).not.toBeInTheDocument();
  });

  it('hides every money figure when the tenant turned dashboard revenue off, even for an admin', async () => {
    // The flag is the outer gate: an admin of a flag-off shop sees exactly what a salesperson
    // sees. That is the point of the switch — a dashboard on a screen the whole floor walks past
    // should not total the book for anybody standing in front of it.
    render(<DashboardMetrics companyId="c1" revenueEnabled={false} />);

    await waitFor(() => expect(screen.getByText('63')).toBeInTheDocument());

    // Every count survives — the flag takes the money, not the metrics.
    expect(screen.getByText('8')).toBeInTheDocument();
    expect(screen.getByText('25')).toBeInTheDocument();
    expect(screen.getByText('51 Not Started · 12 In Progress')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Today' })).toHaveLength(1);

    // Not one dollar figure, label, or delta.
    expect(screen.queryByText('$9,766')).not.toBeInTheDocument();
    expect(screen.queryByText('$85,293')).not.toBeInTheDocument();
    expect(screen.queryByText('$12,480')).not.toBeInTheDocument();
    expect(screen.queryByText('not yet shipped')).not.toBeInTheDocument();
    expect(screen.queryByText('shipped this week')).not.toBeInTheDocument();
    expect(screen.queryByText('vs last week')).not.toBeInTheDocument();
  });

  it('keeps the money hidden for a non-admin even when the flag is on', async () => {
    // The two gates are independent, so neither one alone is enough. This is the pair the
    // admin-only test above cannot express on its own.
    mockUseUserRole.mockReturnValue({ role: 'user', isAdmin: false, loading: false });

    render(<DashboardMetrics companyId="c1" revenueEnabled />);

    await waitFor(() => expect(screen.getByText('63')).toBeInTheDocument());
    expect(screen.queryByText('$85,293')).not.toBeInTheDocument();
  });

  it('names the split with the same labels the jobs list uses', async () => {
    render(<DashboardMetrics companyId="c1" revenueEnabled />);

    // The one thing the old two-card split was good for: whether work is
    // flowing or piling up.
    await waitFor(() => expect(screen.getByText('51 Not Started · 12 In Progress')).toBeInTheDocument());
  });

  it('shows the split to a non-admin too — it carries no money', async () => {
    mockUseUserRole.mockReturnValue({ role: 'user', isAdmin: false, loading: false });

    render(<DashboardMetrics companyId="c1" revenueEnabled />);

    await waitFor(() => expect(screen.getByText('51 Not Started · 12 In Progress')).toBeInTheDocument());
  });

  it('puts the period toggle on Completed and nowhere else', async () => {
    render(<DashboardMetrics companyId="c1" revenueEnabled />);

    await waitFor(() => expect(screen.getByText('63')).toBeInTheDocument());

    // Exactly one toggle pair on the whole row — the other three cards are a
    // snapshot of now and would be lying if they claimed a window.
    expect(screen.getAllByRole('button', { name: 'Today' })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: 'Week' })).toHaveLength(1);
  });

  it('gives Open Quotes a count and no money even for an admin', async () => {
    render(<DashboardMetrics companyId="c1" revenueEnabled />);

    await waitFor(() => expect(screen.getByText('25')).toBeInTheDocument());

    // No "$0 quoted" — the figure is undefined, not zero, because a quote can
    // hold several priced options for one part and only one will be chosen.
    expect(screen.queryByText('quoted')).not.toBeInTheDocument();
    expect(screen.queryByText('$0')).not.toBeInTheDocument();
  });

  it('drops the money line when the count is zero', async () => {
    // "0" over "$0 not yet shipped" says one thing twice, and undoes the reason the
    // count leads: a bare 0 is the cleanest all-clear there is.
    mockGetDashboardMetrics.mockResolvedValue({
      ...VALUES,
      overdue_jobs: { count: 0, money: 0 },
    });

    render(<DashboardMetrics companyId="c1" revenueEnabled />);

    await waitFor(() => expect(screen.getByText('63')).toBeInTheDocument());
    // Open Jobs still has its label; Overdue's is gone with its money.
    expect(screen.getAllByText('not yet shipped')).toHaveLength(1);
    expect(screen.queryByText('$0')).not.toBeInTheDocument();
  });

  it('keeps the delta and its comparison in one element, so they wrap as a phrase', async () => {
    // jsdom cannot measure a baseline, but it can hold the shape that broke it.
    // The delta used to be a nested flex box: a flex container takes its
    // baseline from its first item, which here is an SVG arrow with no text
    // baseline, so the whole group floated a few pixels above "$12,480".
    // Splitting it into separate flex items fixed the baseline and introduced a
    // worse bug — the row could then break between "+12%" and "vs last week".
    // One inline element solves both, and this is the half a test can hold.
    render(<DashboardMetrics companyId="c1" revenueEnabled />);

    await waitFor(() => expect(screen.getByText(/12%/)).toBeInTheDocument());

    const delta = screen.getByText(/12%/);
    expect(delta.textContent).toContain('vs last week');
  });

  it('drops the delta when nothing shipped in the prior period', async () => {
    // A delta against zero is not a comparison — the percentage is undefined
    // and the absolute change just repeats the headline, so the card would
    // print the same figure twice.
    mockGetDashboardMetrics.mockResolvedValue({
      ...VALUES,
      completed_jobs: { count: 3, money: 15080, previousMoney: 0 },
    });

    render(<DashboardMetrics companyId="c1" revenueEnabled />);

    await waitFor(() => expect(screen.getByText('$15,080')).toBeInTheDocument());
    expect(screen.getAllByText('$15,080')).toHaveLength(1);
    expect(screen.queryByText('vs last week')).not.toBeInTheDocument();
  });

  it('refetches and persists when the period changes', async () => {
    const user = userEvent.setup();
    render(<DashboardMetrics companyId="c1" revenueEnabled />);

    await waitFor(() => expect(screen.getByText('63')).toBeInTheDocument());
    mockGetDashboardMetrics.mockClear();

    await user.click(screen.getByRole('button', { name: 'Today' }));

    await waitFor(() => expect(mockGetDashboardMetrics).toHaveBeenCalledWith('c1', 'today'));
    expect(mockSetCompletedPeriod).toHaveBeenCalledWith('today');
  });
});
