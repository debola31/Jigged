import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ThemeProvider } from '@mui/material/styles';
import jiggedTheme from '@/lib/theme';

/**
 * The Storage Inventory table.
 *
 * Most of these pin promises rather than behaviour — that money is doubly gated, that the footer
 * follows the filter, and that a missing cost is never rendered as zero. Each is the kind of thing
 * that stays true only until someone reasonably "tidies" it.
 */

const { capturedGridProps } = vi.hoisted(() => ({
  capturedGridProps: { current: null as Record<string, unknown> | null },
}));

// AG Grid needs layout jsdom does not have, and the assertions here are about the column SET and
// the footer, not about the grid's own rendering.
vi.mock('ag-grid-react', () => ({
  AgGridReact: (props: Record<string, unknown>) => {
    capturedGridProps.current = props;
    return <div data-testid="grid" />;
  },
}));
vi.mock('ag-grid-community', () => ({
  ModuleRegistry: { registerModules: vi.fn() },
  AllCommunityModule: {},
}));
vi.mock('@/lib/agGridTheme', () => ({ jiggedAgGridTheme: {} }));
vi.mock('posthog-js', () => ({ default: { capture: vi.fn() } }));

const { mockGetStorageOnHand, mockGetLocations } = vi.hoisted(() => ({
  mockGetStorageOnHand: vi.fn(),
  mockGetLocations: vi.fn(),
}));
vi.mock('@/utils/inventoryOnHandAccess', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/inventoryOnHandAccess')>();
  return { ...actual, getStorageOnHand: (...a: unknown[]) => mockGetStorageOnHand(...a) };
});
vi.mock('@/utils/inventoryLocationsAccess', () => ({
  getLocations: (...a: unknown[]) => mockGetLocations(...a),
}));

// The side rail reaches the network on open; this file is about the table handing it the part.
const { mockDrawerProps } = vi.hoisted(() => ({ mockDrawerProps: { current: null as unknown } }));
vi.mock('@/components/inventory/locations/place/PartPlacesDrawer', () => ({
  default: (props: { part: unknown }) => {
    mockDrawerProps.current = props;
    return props.part ? <div data-testid="part-drawer" /> : null;
  },
}));

import StorageInventoryTable from '@/components/inventory/StorageInventoryTable';
import type { OnHandRow } from '@/utils/inventoryOnHandAccess';

function row(over: Partial<OnHandRow> = {}): OnHandRow {
  return {
    balanceId: 'b1',
    partId: 'p1',
    partName: '4140 Bar',
    primaryUnit: 'in',
    source: 'bought',
    locationId: 'A-1',
    locationName: 'A-1',
    lotId: null,
    lotCode: null,
    heatNumber: null,
    quantity: 100,
    costPerUnit: 3,
    costBelowMin: false,
    onHandCost: 300,
    gap: null,
    lastMovedAt: '2026-09-09T12:00:00Z',
    ...over,
  };
}

const LOCATIONS = [
  { id: 'rack', parent_id: null, name: 'Raw stock rack' },
  { id: 'A-1', parent_id: 'rack', name: 'A-1' },
  { id: 'cabinet', parent_id: null, name: 'Hardware cabinet' },
  { id: 'bin1', parent_id: 'cabinet', name: 'Bin 1' },
];

const onOpenPlace = vi.fn();

const renderTable = (costEnabled = true, rows: OnHandRow[] = [row()]) => {
  mockGetStorageOnHand.mockResolvedValue({ rows, truncated: false });
  return render(
    <StorageInventoryTable companyId="c1" costEnabled={costEnabled} onOpenPlace={onOpenPlace} />,
    { wrapper: ({ children }) => <ThemeProvider theme={jiggedTheme}>{children}</ThemeProvider> },
  );
};

/** Fire AG Grid's row-click through the mock, which is all the table wires up. */
const clickRow = (data: { partId: string; partName: string; primaryUnit: string | null }) =>
  (capturedGridProps.current?.onRowClicked as (e: { data: unknown }) => void)({ data });

const columnHeaders = () =>
  ((capturedGridProps.current?.columnDefs ?? []) as Array<{ headerName: string }>).map(
    (c) => c.headerName,
  );

beforeEach(() => {
  vi.clearAllMocks();
  capturedGridProps.current = null;
  mockGetLocations.mockResolvedValue(LOCATIONS);
});

describe('money is gated, and the rest is not', () => {
  it('shows cost columns and the total when cost is enabled', async () => {
    renderTable(true);
    await screen.findByTestId('grid');
    expect(columnHeaders()).toEqual([
      'Part',
      'Places',
      'Updated',
      'On hand',
      'Cost / unit',
      'Value',
    ]);
    expect(screen.getByText('Total at our cost')).toBeInTheDocument();
    expect(screen.getByText('$300')).toBeInTheDocument();
  });

  it('drops every cost column and the total when it is not', async () => {
    renderTable(false);
    await screen.findByTestId('grid');
    expect(columnHeaders()).toEqual(['Part', 'Places', 'Updated', 'On hand']);
    expect(screen.queryByText('Total at our cost')).not.toBeInTheDocument();
    // No dollar figure anywhere on the surface.
    expect(document.body.textContent).not.toMatch(/\$/);
  });

  it('keeps quantities, places and the count visible whatever the flag says', async () => {
    renderTable(false);
    await screen.findByTestId('grid');
    // How complete a shop's cost data is, is not itself a dollar figure.
    expect(screen.getByText('1 part')).toBeInTheDocument();
  });

  it('shows the uncosted disclosure even when the money is hidden', async () => {
    renderTable(false, [row({ costPerUnit: null, onHandCost: null, gap: 'no_cost_tier' })]);
    await screen.findByTestId('grid');
    expect(screen.getByText(/no cost on file/)).toBeInTheDocument();
  });
});

describe('the total is honest or absent', () => {
  it('says so rather than printing $0 when nothing has a cost', async () => {
    renderTable(true, [row({ costPerUnit: null, onHandCost: null, gap: 'no_cost_tier' })]);
    await screen.findByTestId('grid');
    // "$0" would claim what is on the shelf is worth nothing, which is a different and false claim.
    expect(screen.getByText('No costs on file')).toBeInTheDocument();
    expect(screen.queryByText('$0')).not.toBeInTheDocument();
  });

  it('withholds the total entirely when the read was truncated', async () => {
    mockGetStorageOnHand.mockResolvedValue({ rows: [row()], truncated: true });
    render(<StorageInventoryTable companyId="c1" costEnabled onOpenPlace={onOpenPlace} />, {
      wrapper: ({ children }) => <ThemeProvider theme={jiggedTheme}>{children}</ThemeProvider>,
    });
    await screen.findByTestId('grid');
    // A total quietly missing a shelf is the one an owner would act on.
    expect(screen.queryByText('Total at our cost')).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(/more than this table can total/i);
  });

  it('never renders a summed quantity across parts, nor a percentage', async () => {
    renderTable(true, [
      row({ partId: 'p1', quantity: 40, primaryUnit: 'ea' }),
      row({ balanceId: 'b2', partId: 'p2', quantity: 3, primaryUnit: 'ea', onHandCost: 9 }),
    ]);
    await screen.findByTestId('grid');
    // 40 bearings + 3 castings sums to nothing meaningful; money is the only common denominator.
    expect(document.body.textContent).not.toMatch(/\b43\b/);
    expect(document.body.textContent).not.toMatch(/%/);
  });
});

describe('filters move the total', () => {
  it('narrows the footer to the filtered rows', async () => {
    const user = userEvent.setup();
    renderTable(true, [
      row({ balanceId: 'b1', partId: 'p1', partName: '4140 Bar', onHandCost: 300 }),
      row({ balanceId: 'b2', partId: 'p2', partName: 'Viton O-ring', onHandCost: 50 }),
    ]);
    await screen.findByTestId('grid');
    expect(screen.getByText('$350')).toBeInTheDocument();

    await user.type(screen.getByRole('textbox', { name: /Filter parts/ }), '4140');

    await waitFor(() => expect(screen.getByText('$300')).toBeInTheDocument());
    expect(screen.getByText('1 part')).toBeInTheDocument();
  });

  it('typing a rack name narrows to the bins inside it', async () => {
    const user = userEvent.setup();
    renderTable(true, [
      row({ balanceId: 'b1', locationId: 'A-1', onHandCost: 300 }),
      row({ balanceId: 'b2', partId: 'p2', locationId: 'bin1', onHandCost: 50 }),
    ]);
    await screen.findByTestId('grid');

    // Stock only ever sits at a LEAF, so matching only the leaf name would answer "Raw stock rack"
    // with nothing — indistinguishable from an empty rack. The search matches the full path, which
    // is how one box does what a separate Where control used to.
    await user.type(screen.getByRole('textbox', { name: /Filter parts/ }), 'Raw stock rack');

    await waitFor(() => expect(screen.getByText('$300')).toBeInTheDocument());
    expect(screen.getByText('1 part')).toBeInTheDocument();
  });

  it('finds a row by its heat', async () => {
    const user = userEvent.setup();
    renderTable(true, [
      row({ balanceId: 'b1', heatNumber: 'H-4471', onHandCost: 300 }),
      row({ balanceId: 'b2', partId: 'p2', heatNumber: null, onHandCost: 50 }),
    ]);
    await screen.findByTestId('grid');

    await user.type(screen.getByRole('textbox', { name: /Filter parts/ }), 'H-4471');
    await waitFor(() => expect(screen.getByText('$300')).toBeInTheDocument());
  });
});

describe('the Updated column', () => {
  const updatedValue = (r: OnHandRow) => {
    const cols = (capturedGridProps.current?.columnDefs ?? []) as Array<{
      field?: string;
      valueFormatter?: (p: { value: unknown; data: unknown }) => string;
    }>;
    const col = cols.find((c) => c.field === 'lastMovedAt');
    return col?.valueFormatter?.({ value: r.lastMovedAt, data: r });
  };

  it('renders the day the stock last moved', async () => {
    renderTable(true, [row()]);
    await screen.findByTestId('grid');
    // Formatted through `formatDateOnly`, whose regex is anchored — a timestamptz falls through to
    // the plain parse and renders the day the SHOP saw, not its UTC calendar day.
    expect(updatedValue(row())).toBe(new Date('2026-09-09T12:00:00Z').toLocaleDateString());
  });

  it('sorts on the timestamp, not the formatted string', async () => {
    renderTable(true, [row()]);
    await screen.findByTestId('grid');
    const cols = (capturedGridProps.current?.columnDefs ?? []) as Array<{ field?: string }>;
    // The field is the raw value; only the formatter is cosmetic. Sorting the rendered string
    // would order "Sep 9" after "Sep 10" alphabetically.
    expect(cols.find((c) => c.field === 'lastMovedAt')).toBeTruthy();
  });

  /**
   * The heat is gone from this table on purpose. A row could only ever carry ONE of a part's
   * heats, so a part on three shelves read as three unrelated things; the side rail breaks a part
   * down by heat, which is where that question is answered.
   */
  it('has no Heat column', async () => {
    renderTable(true, [row()]);
    await screen.findByTestId('grid');
    expect(columnHeaders()).not.toContain('Heat');
  });
});

describe('one line per part', () => {
  it('rolls a part on two shelves into a single row', async () => {
    renderTable(true, [
      row({ balanceId: 'b1', locationId: 'A-1', quantity: 40, onHandCost: 100 }),
      row({ balanceId: 'b2', locationId: 'bin1', quantity: 12, onHandCost: 30 }),
    ]);
    await screen.findByTestId('grid');

    const rows = (capturedGridProps.current?.rowData ?? []) as Array<{
      quantity: number;
      placeCount: number;
      onHandCost: number;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].quantity).toBe(52);
    // WHICH places is the side rail's job; the list says only how many.
    expect(rows[0].placeCount).toBe(2);
    expect(rows[0].onHandCost).toBe(130);
    expect(screen.getByText('$130')).toBeInTheDocument();
    expect(screen.getByText('1 part')).toBeInTheDocument();
  });

  it('has no Place column — one column cannot show three shelves', async () => {
    renderTable(true, [row()]);
    await screen.findByTestId('grid');
    expect(columnHeaders()).not.toContain('Place');
  });
});

describe('a row opens the part', () => {
  it('hands the clicked row s part to the side rail', async () => {
    renderTable(true, [row({ partId: 'p9', partName: '4140 Bar', primaryUnit: 'in' })]);
    await screen.findByTestId('grid');

    clickRow(row({ partId: 'p9', partName: '4140 Bar', primaryUnit: 'in' }));

    // A row is a part somewhere, so clicking it opens that PART — everywhere it is, with the four
    // verbs against each place.
    expect(await screen.findByTestId('part-drawer')).toBeInTheDocument();
    expect((mockDrawerProps.current as { part: unknown }).part).toEqual({
      id: 'p9',
      name: '4140 Bar',
      unit: 'in',
    });
  });
});
