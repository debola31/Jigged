import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ThemeProvider } from '@mui/material/styles';
import jiggedTheme from '@/lib/theme';

import OperatorWarehouseHomePage from '@/app/operator/[companyId]/inventory/page';
import { getLocationBoard } from '@/utils/inventoryLocationsAccess';

const mockPush = vi.fn();

vi.mock('next/navigation', () => ({
  useParams: () => ({ companyId: 'co1' }),
  useRouter: () => ({ push: mockPush }),
}));

/**
 * `lib/supabase` creates its browser client eagerly at module scope, so importing the real
 * access layer in jsdom throws "Your project's URL and API key are required" before any test
 * runs. Stubbing the two getters is the established pattern in this repo (see
 * `__tests__/utils/operatorAccess.test.ts`) and is what makes `importOriginal` below possible.
 */
vi.mock('@/lib/supabase', () => ({
  getSupabase: () => ({}),
  getTypedSupabase: () => ({}),
}));

/**
 * `getLocationBoard`, not `getLocations`. The operator surface now renders the SAME
 * `LocationBoard` the owner's Storage page does — drawn units, photos, rolled-up fill state —
 * so it needs the same data: locations plus per-location part counts plus one batched set of
 * signed photo URLs. A parallel list implementation was what let the two surfaces drift.
 *
 * Only the fetch is stubbed. `buildLocationTree` stays real, because the thing worth asserting
 * is that a real tree renders a board — stubbing it would test the mock.
 */
vi.mock('@/utils/inventoryLocationsAccess', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/inventoryLocationsAccess')>();
  return { ...actual, getLocationBoard: vi.fn() };
});

const loc = (over: {
  id: string;
  name: string;
  parent_id?: string | null;
  code?: string | null;
  kind?: string | null;
}) => ({
  id: over.id,
  company_id: 'co1',
  parent_id: over.parent_id ?? null,
  name: over.name,
  kind: over.kind ?? 'cabinet',
  code: over.code ?? null,
  sort_order: 0,
  photo_path: null,
  created_at: '',
  updated_at: '',
});

const board = (
  locations: ReturnType<typeof loc>[],
  directPartCounts: ReadonlyMap<string, number> = new Map(),
) => ({ locations, directPartCounts, photoUrls: new Map<string, string>() });

const renderPage = () =>
  render(<OperatorWarehouseHomePage />, {
    wrapper: ({ children }) => <ThemeProvider theme={jiggedTheme}>{children}</ThemeProvider>,
  });

beforeEach(() => vi.clearAllMocks());

describe('OperatorWarehouseHomePage', () => {
  it('draws top-level units as board tiles and drills into the bin view', async () => {
    vi.mocked(getLocationBoard).mockResolvedValue(
      board([
        loc({ id: 'cab1', name: 'Cabinet 1', code: 'C01' }),
        loc({ id: 'shelfa', name: 'Shelf A', parent_id: 'cab1' }),
      ]),
    );
    renderPage();

    // The unit is one tap target — a compartment can't be, at ~6px tall (§5.5 decision 1) —
    // so the child appears as a cell inside the tile rather than as a root row.
    const tile = await screen.findByRole('button', { name: /^Cabinet 1/ });
    await userEvent.click(tile);

    expect(mockPush).toHaveBeenCalledWith('/operator/co1/inventory/locations/cab1');
  });

  /** Creating storage is an owner's job; an operator doing it mid-shift is how MISC 8-25-21 happens. */
  it('offers no way to add storage', async () => {
    vi.mocked(getLocationBoard).mockResolvedValue(board([loc({ id: 'cab1', name: 'Cabinet 1' })]));
    renderPage();
    await screen.findByRole('button', { name: /^Cabinet 1/ });

    expect(screen.queryByRole('button', { name: /add storage/i })).not.toBeInTheDocument();
  });

  /** Scanning is a tab-bar action in the layout now — it resolves travelers too, which a
   *  button on this one page never could. */
  it('has no scan button of its own', async () => {
    vi.mocked(getLocationBoard).mockResolvedValue(board([loc({ id: 'cab1', name: 'Cabinet 1' })]));
    renderPage();
    await screen.findByRole('button', { name: /^Cabinet 1/ });

    expect(screen.queryByRole('button', { name: /scan a label/i })).not.toBeInTheDocument();
  });

  it('shows an empty state when no locations exist', async () => {
    vi.mocked(getLocationBoard).mockResolvedValue(board([]));
    renderPage();
    expect(await screen.findByText(/No storage locations yet/i)).toBeInTheDocument();
  });
});
