/**
 * The RFQ detail page (Pattern B): number, status and dates inline; the lines, the vendors, the
 * comparison. Close / Reopen / Archive, each through set_vendor_rfq_state, then one refresh. An
 * archived RFQ opened by id is read-only with a banner.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import userEvent from '@testing-library/user-event';
import { render, screen, waitFor, routerMocks } from '../../test-utils';

const m = vi.hoisted(() => ({ get: vi.fn(), setState: vi.fn() }));

vi.mock('@/lib/supabase', () => ({ getSupabase: () => ({}), createClient: () => ({}) }));
vi.mock('posthog-js', () => ({ default: { capture: vi.fn() } }));
vi.mock('@/utils/vendorRfqAccess', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/vendorRfqAccess')>()),
  getVendorRfq: (...a: unknown[]) => m.get(...a),
  setVendorRfqState: (...a: unknown[]) => m.setState(...a),
}));
// The children have suites of their own; here they only need to mount.
vi.mock('@/components/purchasing/RfqCompareMatrix', () => ({
  default: ({ readOnly }: { readOnly?: boolean }) => <div data-testid="matrix">{readOnly ? 'matrix read-only' : 'matrix'}</div>,
}));
vi.mock('@/components/purchasing/RfqVendorsCard', () => ({
  default: ({ readOnly }: { readOnly?: boolean }) => <div data-testid="vendors">{readOnly ? 'vendors read-only' : 'vendors'}</div>,
}));
vi.mock('@/components/purchasing/RfqPreviewDialog', () => ({ default: () => null }));
vi.mock('@/components/purchasing/RfqResponseEditor', () => ({ default: () => null }));
vi.mock('@/components/purchasing/RfqForm', () => ({ default: () => <div>rfq form</div> }));

import RfqDetail from '@/components/purchasing/RfqDetail';
import { rfqDetail } from './rfqFixtures';

beforeEach(() => {
  vi.clearAllMocks();
  m.get.mockResolvedValue(rfqDetail());
  m.setState.mockResolvedValue({ id: 'rfq-1', rfqNumber: 'RFQ-0007', action: 'close', status: 'closed', deletedAt: null });
});

describe('RfqDetail', () => {
  const user = userEvent.setup();

  it('leads with the number, the status and the dates, then the lines', async () => {
    render(<RfqDetail companyId="c1" rfqId="rfq-1" />);
    expect(await screen.findByRole('heading', { name: 'RFQ-0007' })).toBeInTheDocument();
    expect(screen.getByText('Quoted')).toBeInTheDocument();
    expect(screen.getByText(/Respond by/)).toBeInTheDocument();
    expect(screen.getByText('BAR-6061')).toBeInTheDocument();
    expect(screen.getByText('Deburring brushes')).toBeInTheDocument();
    expect(screen.getByText(/Push Acme on lead time/)).toBeInTheDocument();
    expect(m.get).toHaveBeenCalledWith('rfq-1', expect.objectContaining({ today: expect.any(String) }));
  });

  it('Close asks for an optional reason, closes, and refreshes in place', async () => {
    render(<RfqDetail companyId="c1" rfqId="rfq-1" />);
    await user.click(await screen.findByRole('button', { name: 'Close RFQ' }));
    await user.type(screen.getByLabelText(/Reason/), 'Bought elsewhere');
    await user.click(screen.getByRole('button', { name: 'Close it' }));
    await waitFor(() => expect(m.setState).toHaveBeenCalledWith('rfq-1', 'close', 'Bought elsewhere'));
    await waitFor(() => expect(m.get).toHaveBeenCalledTimes(2));
    // Refreshed in place: the page never went back to a spinner. (`hidden`: the closing dialog
    // keeps the page aria-hidden until its exit transition ends.)
    expect(screen.getByRole('heading', { name: 'RFQ-0007', hidden: true })).toBeInTheDocument();
    expect(screen.queryByRole('progressbar', { hidden: true })).toBeNull();
  });

  it('a closed RFQ says so, offers Reopen, and its vendors and quotes are read-only', async () => {
    m.get.mockResolvedValue(rfqDetail({ header: { closedAt: '2026-11-09T12:00:00Z', closedReason: 'Bought elsewhere' }, status: 'closed' }));
    render(<RfqDetail companyId="c1" rfqId="rfq-1" />);
    expect(await screen.findByText(/This RFQ is closed/)).toBeInTheDocument();
    expect(screen.getByText('vendors read-only')).toBeInTheDocument();
    expect(screen.getByText('matrix read-only')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Reopen' }));
    await waitFor(() => expect(m.setState).toHaveBeenCalledWith('rfq-1', 'reopen'));
  });

  it('Archive asks first, never blocks, and returns to the RFQ list', async () => {
    render(<RfqDetail companyId="c1" rfqId="rfq-1" />);
    await user.click(await screen.findByRole('button', { name: 'Delete RFQ' }));
    expect(screen.getByText(/Delete 1 RFQ\?/)).toBeInTheDocument();
    // Not revivable by name: an RFQ has a number, not a name.
    expect(screen.queryByText(/re-creating or re-importing the same name/)).toBeNull();
    await user.click(screen.getByRole('button', { name: /^Delete$/ }));
    await waitFor(() => expect(m.setState).toHaveBeenCalledWith('rfq-1', 'archive'));
    await waitFor(() => expect(routerMocks.push).toHaveBeenCalledWith('/dashboard/c1/purchasing?view=rfqs'));
  });

  it('an archived RFQ opened by id is read-only, with a banner and no actions', async () => {
    m.get.mockResolvedValue(rfqDetail({ header: { deletedAt: '2026-11-09T12:00:00Z', isArchived: true } }));
    render(<RfqDetail companyId="c1" rfqId="rfq-1" />);
    expect(await screen.findByText(/This RFQ is archived/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Close RFQ' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete RFQ' })).toBeNull();
    expect(screen.getByText('vendors read-only')).toBeInTheDocument();
  });

  it('Edit swaps the page for the form', async () => {
    render(<RfqDetail companyId="c1" rfqId="rfq-1" />);
    await user.click(await screen.findByRole('button', { name: 'Edit' }));
    expect(screen.getByText('rfq form')).toBeInTheDocument();
  });

  it('an id the caller cannot see says so', async () => {
    m.get.mockResolvedValue(null);
    render(<RfqDetail companyId="c1" rfqId="nope" />);
    expect(await screen.findByText(/RFQ not found/)).toBeInTheDocument();
  });

  it('a failed load offers Try Again', async () => {
    m.get.mockRejectedValue(new Error('Failed to load the RFQ.'));
    render(<RfqDetail companyId="c1" rfqId="rfq-1" />);
    expect(await screen.findByText(/Couldn't load this RFQ/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Try Again/ })).toBeInTheDocument();
  });
});
