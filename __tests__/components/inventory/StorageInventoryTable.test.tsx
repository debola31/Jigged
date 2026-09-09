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
const clickRow = (data: OnHandRow) =>
  (capturedGridProps.current?.onRowClicked as (e: { data: OnHandRow }) => void)({ data });

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
    expect(columnHeaders()).toEqual(['Part', 'Place', 'Heat', 'On hand', 'Cost / unit', 'Value']);
    expect(screen.getByText('Total at our cost')).toBeInTheDocument();
    expect(screen.getByText('$300')).toBeInTheDocument();
  });

  it('drops every cost column and the total when it is not', async () => {
    renderTable(false);
    await screen.findByTestId('grid');
    expect(columnHeaders()).toEqual(['Part', 'Place', 'Heat', 'On hand']);
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

    await user.type(screen.getByRole('textbox', { name: /Search parts/ }), '4140');

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
    await user.type(screen.getByRole('textbox', { name: /Search parts/ }), 'Raw stock rack');

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

    await user.type(screen.getByRole('textbox', { name: /Search parts/ }), 'H-4471');
    await waitFor(() => expect(screen.getByText('$300')).toBeInTheDocument());
  });
});

describe('the Heat column states only what a mill issued', () => {
  const heatValue = (r: OnHandRow) => {
    const cols = (capturedGridProps.current?.columnDefs ?? []) as Array<{
      field?: string;
      valueFormatter?: (p: { value: unknown; data: OnHandRow }) => string;
    }>;
    const col = cols.find((c) => c.field === 'heatNumber');
    return col?.valueFormatter?.({ value: r.heatNumber, data: r });
  };

  it('shows a real heat', async () => {
    renderTable(true, [row({ heatNumber: 'H-4471' })]);
    await screen.findByTestId('grid');
    expect(heatValue(row({ heatNumber: 'H-4471' }))).toBe('H-4471');
  });

  it.each(['LOT-260909-01', 'PRE-TRACKING'])(
    'shows an em dash, not the minted code %s',
    async (lotCode) => {
      renderTable(true, [row({ heatNumber: null, lotCode })]);
      await screen.findByTestId('grid');
      // A minted code and PRE-TRACKING are what `resolve_lot` invents so untagged bar is still
      // storable. Printing either under a column headed "Heat" would state as a mill heat a number
      // no mill ever issued — the one thing traceability may not do.
      expect(heatValue(row({ heatNumber: null, lotCode }))).toBe('—');
    },
  );
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
