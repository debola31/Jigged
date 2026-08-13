import { describe, it, expect, vi, beforeEach } from 'vitest';
import userEvent from '@testing-library/user-event';
import { render, screen, waitFor, resetRouterMocks } from '../../test-utils';
import DashboardMetrics from '@/components/dashboard/DashboardMetrics';

/**
 * The scorecard row: what each role sees, and where the period control lives.
 *
 * The money line is admin-only. That is a DISPLAY choice, not a security
 * boundary — RLS is company-scoped, not column-scoped, so the figures stay
 * readable through the API by anyone who can reach the company. What it buys is
 * that a salesperson sees the deals they work on rather than the shop's whole
 * book totalled up on the landing page.
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
    render(<DashboardMetrics companyId="c1" />);

    await waitFor(() => expect(screen.getByText('63')).toBeInTheDocument());

    for (const label of ['Overdue', 'Open Jobs', 'Completed', 'Open Quotes']) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    expect(screen.queryByText(/Edit metrics/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Add metric/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Next metrics/i)).not.toBeInTheDocument();
  });

  it('shows an admin the money, labelled by which KIND of money it is', async () => {
    render(<DashboardMetrics companyId="c1" />);

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

    render(<DashboardMetrics companyId="c1" />);

    await waitFor(() => expect(screen.getByText('63')).toBeInTheDocument());

    // Counts still there; not one dollar figure is.
    expect(screen.getByText('8')).toBeInTheDocument();
    expect(screen.queryByText('$9,766')).not.toBeInTheDocument();
    expect(screen.queryByText('$85,293')).not.toBeInTheDocument();
    expect(screen.queryByText('$12,480')).not.toBeInTheDocument();
    expect(screen.queryByText('not yet shipped')).not.toBeInTheDocument();
  });

  it('names the split with the same labels the jobs list uses', async () => {
    render(<DashboardMetrics companyId="c1" />);

    // The one thing the old two-card split was good for: whether work is
    // flowing or piling up.
    await waitFor(() => expect(screen.getByText('51 Not Started · 12 In Progress')).toBeInTheDocument());
  });

  it('shows the split to a non-admin too — it carries no money', async () => {
    mockUseUserRole.mockReturnValue({ role: 'user', isAdmin: false, loading: false });

    render(<DashboardMetrics companyId="c1" />);

    await waitFor(() => expect(screen.getByText('51 Not Started · 12 In Progress')).toBeInTheDocument());
  });

  it('puts the period toggle on Completed and nowhere else', async () => {
    render(<DashboardMetrics companyId="c1" />);

    await waitFor(() => expect(screen.getByText('63')).toBeInTheDocument());

    // Exactly one toggle pair on the whole row — the other three cards are a
    // snapshot of now and would be lying if they claimed a window.
    expect(screen.getAllByRole('button', { name: 'Today' })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: 'Week' })).toHaveLength(1);
  });

  it('gives Open Quotes a count and no money even for an admin', async () => {
    render(<DashboardMetrics companyId="c1" />);

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

    render(<DashboardMetrics companyId="c1" />);

    await waitFor(() => expect(screen.getByText('63')).toBeInTheDocument());
    // Open Jobs still has its label; Overdue's is gone with its money.
    expect(screen.getAllByText('not yet shipped')).toHaveLength(1);
    expect(screen.queryByText('$0')).not.toBeInTheDocument();
  });

  it('drops the delta when nothing shipped in the prior period', async () => {
    // A delta against zero is not a comparison — the percentage is undefined
    // and the absolute change just repeats the headline, so the card would
    // print the same figure twice.
    mockGetDashboardMetrics.mockResolvedValue({
      ...VALUES,
      completed_jobs: { count: 3, money: 15080, previousMoney: 0 },
    });

    render(<DashboardMetrics companyId="c1" />);

    await waitFor(() => expect(screen.getByText('$15,080')).toBeInTheDocument());
    expect(screen.getAllByText('$15,080')).toHaveLength(1);
    expect(screen.queryByText('vs last week')).not.toBeInTheDocument();
  });

  it('refetches and persists when the period changes', async () => {
    const user = userEvent.setup();
    render(<DashboardMetrics companyId="c1" />);

    await waitFor(() => expect(screen.getByText('63')).toBeInTheDocument());
    mockGetDashboardMetrics.mockClear();

    await user.click(screen.getByRole('button', { name: 'Today' }));

    await waitFor(() => expect(mockGetDashboardMetrics).toHaveBeenCalledWith('c1', 'today'));
    expect(mockSetCompletedPeriod).toHaveBeenCalledWith('today');
  });
});
