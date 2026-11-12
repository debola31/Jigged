/**
 * The Orders tab — every live PO, filtered and sorted ON THE SERVER (plan §3.13, criterion P8).
 *
 * What is pinned here is the contract with `listVendorPos` and the URL: the default view is the
 * open POs, due soonest first; every filter is in the URL (router.replace, never push, so Back still
 * leaves the page); a failed load, an empty shop, a filter with no matches and a capped page each say
 * their own sentence; and no derived column can send a sort the database cannot run.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import userEvent from '@testing-library/user-event';
import { act } from 'react';
import { render, screen, waitFor, within, routerMocks, resetRouterMocks, setSearchParams } from '../../test-utils';
import type { VendorPoListResult, VendorPoListRow } from '@/types/vendorPo';

const captured: { props: Record<string, unknown> | null } = { props: null };
vi.mock('ag-grid-react', () => ({
  AgGridReact: (props: Record<string, unknown>) => {
    captured.props = props;
    const rows = (props.rowData as VendorPoListRow[] | undefined) ?? [];
    return (
      <div data-testid="grid">
        {rows.map((r) => (
          <div key={r.id}>{r.poNumber}</div>
        ))}
      </div>
    );
  },
}));
vi.mock('ag-grid-community', () => ({
  ModuleRegistry: { registerModules: vi.fn() },
  AllCommunityModule: {},
}));
vi.mock('@/lib/agGridTheme', () => ({ jiggedAgGridTheme: {} }));
vi.mock('@/lib/localDate', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/localDate')>()),
  todayLocalISODate: () => '2026-11-12',
}));

const listVendorPos = vi.fn();
vi.mock('@/utils/vendorPoAccess', () => ({
  listVendorPos: (...args: unknown[]) => listVendorPos(...args),
}));
const getAllVendors = vi.fn();
vi.mock('@/utils/vendorsAccess', () => ({
  getAllVendors: (...args: unknown[]) => getAllVendors(...args),
}));

import VendorPoList from '@/components/purchasing/VendorPoList';

function row(over: Partial<VendorPoListRow> = {}): VendorPoListRow {
  return {
    id: 'po-1',
    companyId: 'test-company-id',
    poNumber: 'PO-1042',
    vendorId: 'v1',
    vendorName: 'Acme Steel',
    status: 'sent',
    orderedOn: '2026-11-01',
    needByOn: '2026-11-20',
    nextExpectedOn: '2026-11-20',
    isLate: false,
    revision: 0,
    sentRevision: 0,
    hasUnsentChanges: false,
    issuedAt: '2026-11-01T15:00:00Z',
    lastSentAt: '2026-11-01T15:00:00Z',
    closedAt: null,
    lineCount: 2,
    outstandingLineCount: 2,
    orderedAmount: 1250,
    openAmount: 1250,
    hasUnpricedLines: false,
    quickbooksState: 'not_sent',
    jobIds: ['j1'],
    jobNumbers: ['J-1042'],
    vendorRfqId: null,
    createdAt: '2026-11-01T15:00:00Z',
    updatedAt: '2026-11-01T15:00:00Z',
    isArchived: false,
    ...over,
  };
}

function result(rows: VendorPoListRow[], over: Partial<VendorPoListResult> = {}): VendorPoListResult {
  return { rows, total: rows.length, truncated: false, ...over };
}

const lastFilters = () => listVendorPos.mock.calls[listVendorPos.mock.calls.length - 1][1];

beforeEach(() => {
  vi.clearAllMocks();
  resetRouterMocks();
  setSearchParams();
  window.localStorage.clear();
  captured.props = null;
  listVendorPos.mockResolvedValue(result([row()]));
  getAllVendors.mockResolvedValue([
    { id: 'v1', company_id: 'test-company-id', name: 'Acme Steel', created_at: '', updated_at: '' },
    { id: 'v2', company_id: 'test-company-id', name: 'ProFinish Anodizing', created_at: '', updated_at: '' },
  ]);
});

describe('VendorPoList — what it asks the server for', () => {
  it('asks for the open POs (Draft, Sent, Partly received), due soonest first, with the caller’s date', async () => {
    render(<VendorPoList companyId="test-company-id" />);
    expect(await screen.findByText('PO-1042')).toBeInTheDocument();
    expect(listVendorPos).toHaveBeenCalledWith(
      'test-company-id',
      expect.objectContaining({
        today: '2026-11-12',
        statuses: ['draft', 'sent', 'partially_received'],
        sort: { field: 'next_expected_on', direction: 'asc' },
      }),
    );
  });

  it('takes every filter from the URL', async () => {
    setSearchParams({ status: 'closed,received', vendor: 'v2', job: 'j1', overdue: 'true', qb: 'out_of_date', q: '1042' });
    render(<VendorPoList companyId="test-company-id" />);
    await waitFor(() => expect(listVendorPos).toHaveBeenCalled());
    expect(lastFilters()).toMatchObject({
      statuses: ['closed', 'received'],
      vendorId: 'v2',
      jobId: 'j1',
      overdueOnly: true,
      quickbooksStates: ['out_of_date'],
      search: '1042',
    });
  });

  it('remembers the status choice per company, and a URL status wins over it', async () => {
    window.localStorage.setItem('jigged.purchasing.statusFilter.test-company-id', JSON.stringify(['received']));
    const { unmount } = render(<VendorPoList companyId="test-company-id" />);
    await waitFor(() => expect(lastFilters()).toMatchObject({ statuses: ['received'] }));
    unmount();

    setSearchParams({ status: 'draft' });
    render(<VendorPoList companyId="test-company-id" />);
    await waitFor(() => expect(lastFilters()).toMatchObject({ statuses: ['draft'] }));
  });

  it('sorts on the server by a real view column when a header is clicked', async () => {
    render(<VendorPoList companyId="test-company-id" />);
    await screen.findByText('PO-1042');
    const onSortChanged = captured.props?.onSortChanged as (e: unknown) => void;
    act(() => {
      onSortChanged({ api: { getColumnState: () => [{ colId: 'vendorName', sort: 'desc' }] } });
    });
    await waitFor(() => expect(lastFilters()).toMatchObject({ sort: { field: 'vendor_name', direction: 'desc' } }));
  });

  it('never offers a sort on a derived column: every colId column is sortable: false', async () => {
    render(<VendorPoList companyId="test-company-id" />);
    await screen.findByText('PO-1042');
    const columns = captured.props?.columnDefs as Array<{ colId?: string; field?: string; headerName?: string; sortable?: boolean }>;
    const jobs = columns.find((c) => c.headerName === 'Jobs');
    expect(jobs).toMatchObject({ colId: 'jobs', sortable: false });
    for (const c of columns.filter((col) => col.colId)) expect(c.sortable).toBe(false);
    expect(columns.map((c) => c.headerName)).toEqual([
      'PO #',
      'Vendor',
      'Status',
      'Ordered',
      'Next due',
      'Open value (at PO price)',
      'Jobs',
      'QuickBooks',
    ]);
  });
});

describe('VendorPoList — filters live in the URL', () => {
  it('writes Overdue only into the URL with router.replace, never push', async () => {
    const user = userEvent.setup();
    render(<VendorPoList companyId="test-company-id" />);
    await screen.findByText('PO-1042');
    await user.click(screen.getByRole('checkbox', { name: /overdue only/i }));
    expect(routerMocks.replace).toHaveBeenCalledWith('?overdue=true', { scroll: false });
    expect(routerMocks.push).not.toHaveBeenCalled();
    await waitFor(() => expect(lastFilters()).toMatchObject({ overdueOnly: true }));
  });

  it('filters by QuickBooks state — the bookkeeper’s worklist', async () => {
    const user = userEvent.setup();
    render(<VendorPoList companyId="test-company-id" />);
    await screen.findByText('PO-1042');
    await user.click(screen.getByRole('combobox', { name: /quickbooks/i }));
    await user.click(await screen.findByRole('option', { name: /out of date/i }));
    await waitFor(() => expect(lastFilters()).toMatchObject({ quickbooksStates: ['out_of_date'] }));
    expect(routerMocks.replace).toHaveBeenCalledWith('?qb=out_of_date', { scroll: false });
  });

  it('shows an incoming job filter as a chip that can be cleared', async () => {
    setSearchParams({ job: 'j1' });
    const user = userEvent.setup();
    render(<VendorPoList companyId="test-company-id" />);
    const chip = await screen.findByText('Job J-1042');
    expect(chip).toBeInTheDocument();
    const chipRoot = chip.closest('.MuiChip-root') as HTMLElement;
    await user.click(within(chipRoot).getByTestId('CancelIcon'));
    expect(routerMocks.replace).toHaveBeenCalledWith('?', { scroll: false });
    await waitFor(() => expect(lastFilters().jobId).toBeNull());
  });
});

describe('VendorPoList — four states, four sentences', () => {
  it('a failed load offers Retry and never reads as "no purchase orders"', async () => {
    listVendorPos.mockRejectedValueOnce(new Error('Failed to load purchase orders.'));
    const user = userEvent.setup();
    render(<VendorPoList companyId="test-company-id" />);
    expect(await screen.findByText(/couldn.t load purchase orders/i)).toBeInTheDocument();
    expect(screen.queryByText(/no open purchase orders/i)).not.toBeInTheDocument();
    expect(screen.queryByTestId('grid')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /try again|retry/i }));
    expect(await screen.findByText('PO-1042')).toBeInTheDocument();
  });

  it('an empty default view says there are no open POs and offers to make one or see what to buy', async () => {
    listVendorPos.mockResolvedValue(result([]));
    render(<VendorPoList companyId="test-company-id" />);
    expect(await screen.findByText('No open purchase orders')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /new purchase order/i }).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: /see what to buy/i })).toBeInTheDocument();
  });

  it('a filter with no matches says so, and offers to clear the filters', async () => {
    setSearchParams({ vendor: 'v2' });
    listVendorPos.mockResolvedValue(result([]));
    const user = userEvent.setup();
    render(<VendorPoList companyId="test-company-id" />);
    expect(await screen.findByText('No purchase orders match these filters.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /clear filters/i }));
    expect(routerMocks.replace).toHaveBeenCalledWith('?', { scroll: false });
  });

  it('a capped page says how many it is showing of how many', async () => {
    listVendorPos.mockResolvedValue(result([row()], { total: 812, truncated: true }));
    render(<VendorPoList companyId="test-company-id" />);
    expect(await screen.findByText(/showing the first 1 of 812/i)).toBeInTheDocument();
  });
});

describe('VendorPoList — what the rows say', () => {
  it('formats money at the PO price and marks an overdue PO amber with the word', async () => {
    render(<VendorPoList companyId="test-company-id" />);
    await screen.findByText('PO-1042');
    const columns = captured.props?.columnDefs as Array<{
      headerName?: string;
      valueFormatter?: (p: { value: unknown; data?: VendorPoListRow }) => string;
      cellRenderer?: (p: { value: unknown; data?: VendorPoListRow }) => React.ReactNode;
    }>;
    const open = columns.find((c) => c.headerName === 'Open value (at PO price)');
    expect(open?.valueFormatter?.({ value: 1250, data: row() })).toBe('$1,250.00');

    const due = columns.find((c) => c.headerName === 'Next due');
    const late = row({ isLate: true, nextExpectedOn: '2026-11-03' });
    render(<>{due?.cellRenderer?.({ value: late.nextExpectedOn, data: late })}</>);
    expect(screen.getByText('Overdue')).toBeInTheDocument();
  });

  it('opens a PO when its row is clicked', async () => {
    render(<VendorPoList companyId="test-company-id" />);
    await screen.findByText('PO-1042');
    const onRowClicked = captured.props?.onRowClicked as (e: { data?: VendorPoListRow }) => void;
    onRowClicked({ data: row() });
    expect(routerMocks.push).toHaveBeenCalledWith('/dashboard/test-company-id/purchasing/orders/po-1');
  });
});
