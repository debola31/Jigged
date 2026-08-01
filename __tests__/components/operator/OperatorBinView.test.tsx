import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ThemeProvider } from '@mui/material/styles';
import jiggedTheme from '@/lib/theme';

import OperatorBinViewPage from '@/app/operator/[companyId]/inventory/locations/[locationId]/page';
import {
  resolveScan,
  depleteStockAtLocation,
} from '@/utils/inventoryLocationsAccess';
import { getCurrentMember } from '@/utils/operatorAccess';

const mockPush = vi.fn();

vi.mock('next/navigation', () => ({
  useParams: () => ({ companyId: 'co1', locationId: 'loc1' }),
  useRouter: () => ({ push: mockPush }),
}));

vi.mock('@/utils/inventoryLocationsAccess', () => ({
  resolveScan: vi.fn(),
  // Move destinations: the page loads the whole tree so tapping Move doesn't wait on a fetch.
  getLocations: vi.fn(async () => []),
  // Recent activity for this bin. Empty by default — these tests are about the contents.
  getLocationHistory: vi.fn(async () => []),
  addStockAtLocation: vi.fn(),
  depleteStockAtLocation: vi.fn(),
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
  getAllJobs: vi.fn().mockResolvedValue([]),
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
  it('shows the path, sub-locations (drill-down), and stock here', async () => {
    (resolveScan as ReturnType<typeof vi.fn>).mockResolvedValue(
      scanWith(
        [loc({ id: 'sub1', name: 'Sub A', code: 'C01-B03-A' })],
        [{ part_id: 'p1', part_name: 'Steel Rod', primary_unit: 'ea', quantity: 12 }],
      ),
    );
    renderPage();

    expect(await screen.findByText('Bin 3')).toBeInTheDocument();
    expect(screen.getByText('Cabinet 1 › Bin 3')).toBeInTheDocument();
    expect(screen.getByText('Sub A')).toBeInTheDocument(); // drill-down
    expect(screen.getByText('Steel Rod')).toBeInTheDocument();
    expect(screen.getByText('12')).toBeInTheDocument();

    // tapping a sub-location navigates into its bin view
    await userEvent.click(screen.getByText('Sub A'));
    expect(mockPush).toHaveBeenCalledWith('/operator/co1/inventory/locations/sub1');
  });

  it('shows an empty state when nothing is stored here', async () => {
    (resolveScan as ReturnType<typeof vi.fn>).mockResolvedValue(scanWith([], []));
    renderPage();
    expect(await screen.findByText('Nothing stored here yet.')).toBeInTheDocument();
  });

  it('Remove depletes gracefully and stamps the operator', async () => {
    (resolveScan as ReturnType<typeof vi.fn>).mockResolvedValue(
      scanWith([], [{ part_id: 'p1', part_name: 'Steel Rod', primary_unit: 'ea', quantity: 12 }]),
    );
    (depleteStockAtLocation as ReturnType<typeof vi.fn>).mockResolvedValue({ location_balance: 7, part_quantity: 7 });
    renderPage();

    await userEvent.click(await screen.findByRole('button', { name: /^remove$/i }));

    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText(/quantity/i), '5');
    await userEvent.click(within(dialog).getByRole('button', { name: /^remove$/i }));

    await waitFor(() =>
      expect(depleteStockAtLocation).toHaveBeenCalledWith(
        'p1',
        'loc1',
        5,
        'ea',
        expect.objectContaining({ graceful: true, operatorId: 'op1' }),
      ),
    );
  });
});
