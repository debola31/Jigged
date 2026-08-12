import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ThemeProvider } from '@mui/material/styles';
import jiggedTheme from '@/lib/theme';

import OperatorBinViewPage from '@/app/operator/[companyId]/inventory/locations/[locationId]/page';
import {
  getLocationContents,
  resolveScan,
  depleteStockAtLocation,
  getLocations,
} from '@/utils/inventoryLocationsAccess';
import { getCurrentMember } from '@/utils/operatorAccess';

const mockPush = vi.fn();

vi.mock('next/navigation', () => ({
  useParams: () => ({ companyId: 'co1', locationId: 'loc1' }),
  useRouter: () => ({ push: mockPush }),
}));

vi.mock('@/utils/inventoryLocationsAccess', async () => ({
  resolveScan: vi.fn(),
  // Move destinations: the page loads the whole tree so tapping Move doesn't wait on a fetch.
  getLocations: vi.fn(async () => []),
  // Recent activity for this bin. Empty by default — these tests are about the contents.
  getLocationHistory: vi.fn(async () => []),
  // Fill state for the drawn sub-locations. One aggregated read, the same view the office uses.
  getLocationOccupancy: vi.fn(async () => new Map()),
  // Not mocked away: the page builds the subtree it draws from `getLocations` above, and these
  // tests assert what that drawing contains. Re-exported so the real one runs.
  buildLocationTree: (await vi.importActual<typeof import('@/utils/inventoryLocationsAccess')>(
    '@/utils/inventoryLocationsAccess',
  )).buildLocationTree,
  addStockAtLocation: vi.fn(),
  depleteStockAtLocation: vi.fn(),
  // The shared forms read the bin themselves rather than being handed its contents — the one
  // about to WRITE is the one that must be current. Defaults to empty; tests that act set it.
  getLocationContents: vi.fn(async () => ({ contents: [], total: 0 })),
  adjustStockAtLocation: vi.fn(),
  transferStock: vi.fn(),
}));

vi.mock('@/utils/operatorAccess', () => ({
  getCurrentMember: vi.fn(),
}));

// The bin view embeds modals that import partsAccess + jobsAccess
// (→ lib/supabase). Mock them so the module graph doesn't eval the real
// Supabase client. (getAllJobs loads on the deplete modal's onEnter.)
vi.mock('@/utils/partsAccess', () => ({
  getStockedParts: vi.fn().mockResolvedValue([]),
}));
// The action modal can now attach a photo, which pulls in storageHelpers -> lib/supabase, and that
// module builds its client eagerly at import time whenever `window` exists. Stubbed rather than
// mocking the whole Supabase client: these tests never exercise an upload.
vi.mock('@/utils/storageHelpers', () => ({
  generateStoragePath: (co: string, kind: string, id: string, name: string) =>
    `${co}/${kind}/${id}/${name}`,
  uploadFileToStorage: vi.fn(async () => undefined),
}));

vi.mock('@/utils/jobsAccess', () => ({
  getAllJobs: vi.fn().mockResolvedValue({ jobs: [], total: 0, truncated: false }),
}));

const loc = (over: { id: string; name: string; code?: string | null; parent_id?: string | null }) => ({
  id: over.id,
  company_id: 'co1',
  parent_id: over.parent_id ?? null,
  name: over.name,
  kind: 'bin',
  code: over.code ?? null,
  sort_order: 0,
  created_at: '',
  updated_at: '',
});

const scanWith = (children: ReturnType<typeof loc>[], contents: Array<{ part_id: string; part_name: string; primary_unit: string | null; quantity: number }>) => ({
  node: loc({ id: 'loc1', name: 'Bin 3', code: 'C01-B03', parent_id: 'cab' }),
  path: [loc({ id: 'cab', name: 'Cabinet 1' }), loc({ id: 'loc1', name: 'Bin 3', parent_id: 'cab' })],
  children,
  contents,
});

const renderPage = () => render(<OperatorBinViewPage />, { wrapper: ({ children }) => <ThemeProvider theme={jiggedTheme}>{children}</ThemeProvider> });

beforeEach(() => {
  vi.clearAllMocks();
  (getCurrentMember as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'op1', name: 'Sam', user_id: 'u1' });
});

describe('OperatorBinViewPage', () => {
  it('shows the path and its stock', async () => {
    (resolveScan as ReturnType<typeof vi.fn>).mockResolvedValue(
      scanWith([], [{ part_id: 'p1', part_name: 'Steel Rod', primary_unit: 'ea', quantity: 12 }]),
    );
    renderPage();

    expect(await screen.findByText('Bin 3')).toBeInTheDocument();
    expect(screen.getByText('Cabinet 1 › Bin 3')).toBeInTheDocument();
    expect(screen.getByText('Steel Rod')).toBeInTheDocument();
    expect(screen.getByText('12')).toBeInTheDocument();
  });

  /**
   * Sub-locations are DRAWN now, not stacked as cards — the same `UnitGridView` the office uses,
   * at what is already the QR target route. The grid needs grandchildren to know what is a row and
   * what is a cell, which `resolveScan` does not carry, so it reads the tree from `getLocations`.
   */
  it('draws sub-locations as a grid and drills into one', async () => {
    (resolveScan as ReturnType<typeof vi.fn>).mockResolvedValue(
      scanWith([loc({ id: 'sub1', name: 'Sub A' })], []),
    );
    vi.mocked(getLocations).mockResolvedValue([
      loc({ id: 'loc1', name: 'Bin 3' }),
      loc({ id: 'sub1', name: 'Sub A', parent_id: 'loc1' }),
    ]);
    renderPage();

    // A leaf child draws as a full-width cell, and its accessible name carries the fill state
    // rather than leaving occupancy to colour alone.
    const cell = await screen.findByRole('button', { name: /^Sub A/ });
    await userEvent.click(cell);
    expect(mockPush).toHaveBeenCalledWith('/operator/co1/inventory/locations/sub1');
  });

  /**
   * The pair this used to assert together — sub-locations AND stock on one screen — is a state
   * 20260806160053 made unreachable, so the page stops offering the half that would create it.
   * It previously rendered "Stock a part" directly above the line "No stock recorded directly here
   * — open a sub-location above", i.e. a button inviting you to break the sentence beside it. The
   * database now refuses that write, so the button led to an error rather than a mistake.
   */
  it('offers no way to stock a place that has sub-locations', async () => {
    (resolveScan as ReturnType<typeof vi.fn>).mockResolvedValue(
      scanWith([loc({ id: 'sub1', name: 'Sub A' })], []),
    );
    vi.mocked(getLocations).mockResolvedValue([
      loc({ id: 'loc1', name: 'Bin 3' }),
      loc({ id: 'sub1', name: 'Sub A', parent_id: 'loc1' }),
    ]);
    renderPage();

    expect(await screen.findByRole('button', { name: /^Sub A/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /stock a part/i })).not.toBeInTheDocument();
    expect(screen.getByText(/stock goes in the sub-locations above/i)).toBeInTheDocument();
  });

  it('still offers a way to put stock in, on a bin with no sub-locations', async () => {
    (resolveScan as ReturnType<typeof vi.fn>).mockResolvedValue(scanWith([], []));
    renderPage();

    // `Stock a part` and its dialog are gone: the shop floor now uses the same four verbs and the
    // same forms as the office, so putting a delivery away is one form rather than six dialogs.
    expect(await screen.findByRole('button', { name: /^add$/i })).toBeInTheDocument();
    for (const verb of [/^remove$/i, /^move$/i, /^adjust$/i]) {
      expect(screen.getByRole('button', { name: verb })).toBeInTheDocument();
    }
  });

  it('shows an empty state when nothing is stored here', async () => {
    (resolveScan as ReturnType<typeof vi.fn>).mockResolvedValue(scanWith([], []));
    renderPage();
    expect(await screen.findByText(/no parts recorded here/i)).toBeInTheDocument();
    // Nothing to take out of an empty bin, but you can always put something in.
    expect(screen.getByRole('button', { name: /^remove$/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /^add$/i })).toBeEnabled();
  });

  it('Remove depletes gracefully and stamps the operator', async () => {
    (resolveScan as ReturnType<typeof vi.fn>).mockResolvedValue(
      scanWith([], [{ part_id: 'p1', part_name: 'Steel Rod', primary_unit: 'ea', quantity: 12 }]),
    );
    (depleteStockAtLocation as ReturnType<typeof vi.fn>).mockResolvedValue({ location_balance: 7, part_quantity: 7 });
    (getLocationContents as ReturnType<typeof vi.fn>).mockResolvedValue({
      contents: [
        { part_id: 'p1', part_name: 'Steel Rod', primary_unit: 'ea', quantity: 12, location_id: 'loc1' },
      ],
      total: 1,
    });
    renderPage();

    await userEvent.click(await screen.findByRole('button', { name: /^remove$/i }));

    // The shared form, expanded in place — no dialog, and the rows are the bin's contents.
    await userEvent.type(await screen.findByLabelText(/quantity for Steel Rod/i), '5');
    await userEvent.click(screen.getByRole('button', { name: /^remove stock$/i }));

    await waitFor(() =>
      expect(depleteStockAtLocation).toHaveBeenCalledWith(
        'p1',
        'loc1',
        5,
        'ea',
        // GRACEFUL SURVIVES THE REWRITE. The material is already off the shelf, so a stale count
        // must not refuse the write; the RPC floors at zero and records the shortfall in the note.
        expect.objectContaining({ graceful: true }),
      ),
    );
  });
});
