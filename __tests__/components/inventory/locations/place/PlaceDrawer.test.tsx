/**
 * The place drawer, and specifically whether it blocks the page behind it.
 *
 * ## The bug this file exists for
 *
 * The drawer was `temporary`, i.e. a `Modal`, which makes everything behind it inert. The pane
 * behind it IS the navigation — the grid, and on a deep unit two rows of section tabs — so opening
 * one location disabled the only route to any other. Reported as: *"once you click row 1 and then
 * the tabs and their cells, you can't go back anywhere to click row 2 unless you first click on
 * another root storage unit."* The tabs were on screen the whole time, greyed out.
 *
 * `hideBackdrop` does not fix it — `Modal` sets `aria-hidden` on the background whatever the
 * backdrop is doing, which was measured in a browser before this file was written. Only a
 * non-`Modal` variant does, so the drawer is `persistent` from `sm` up.
 *
 * ## Why `matchMedia` is stubbed rather than assumed
 *
 * jsdom has none, so MUI's `useMediaQuery` falls back to `false` — the phone branch. That is the
 * safe default and it is what every other test in this suite exercises by accident. The desktop
 * branch is the one that carries the fix, so it gets an explicit stub rather than going uncovered.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '../../../../test-utils';

vi.mock('@/lib/supabase', () => ({ getSupabase: () => ({}) }));
vi.mock('@/utils/inventoryLocationsAccess', () => ({
  getLocationContents: vi.fn(async () => ({ contents: [], total: 0 })),
  getLocationHistory: vi.fn(async () => []),
}));

import PlaceDrawer from '@/components/inventory/locations/place/PlaceDrawer';
import type { InventoryLocationNode } from '@/types/inventoryLocations';

const place = {
  id: 'bin-1',
  company_id: 'co1',
  parent_id: 'row-1',
  name: 'Left',
  kind: null,
  sort_order: 0,
  created_at: '',
  updated_at: '',
  children: [],
  depth: 2,
} as InventoryLocationNode;

/** MUI reads `matchMedia`; jsdom has none, so the wide branch needs one. */
function setViewport(wide: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches: wide,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }),
  });
}

const renderDrawer = () =>
  render(
    <div>
      <button type="button">a control on the page behind</button>
      <PlaceDrawer
        place={place}
        companyId="co1"
        path="Cabinet 3 › Row 1 › Left"
        moveDestinations={[]}
        hasStock={false}
        actions={{ onPrintQR: vi.fn(), onEdit: vi.fn(), onDelete: vi.fn() }}
        onClose={vi.fn()}
        onChanged={vi.fn()}
      />
    </div>,
  );

const originalMatchMedia = Object.getOwnPropertyDescriptor(window, 'matchMedia');

beforeEach(() => vi.clearAllMocks());
afterEach(() => {
  if (originalMatchMedia) Object.defineProperty(window, 'matchMedia', originalMatchMedia);
});

describe('PlaceDrawer — on a wide screen it must not block the grid', () => {
  beforeEach(() => setViewport(true));

  it('leaves the page behind it reachable', async () => {
    renderDrawer();

    expect(await screen.findByText('Left')).toBeInTheDocument();
    // THE ASSERTION. A modal drawer would have aria-hidden this, and `getByRole` respects that —
    // which is exactly how the section tabs became unreachable.
    expect(
      screen.getByRole('button', { name: 'a control on the page behind' }),
    ).toBeInTheDocument();
  });

  it('draws no backdrop, because there is nothing to dismiss by tapping away', async () => {
    const { container } = renderDrawer();
    await screen.findByText('Left');
    expect(container.ownerDocument.querySelector('.MuiBackdrop-root')).toBeNull();
  });
});

describe('PlaceDrawer — on a phone it stays modal', () => {
  beforeEach(() => setViewport(false));

  it('covers the page, which is the point when the drawer is full width', async () => {
    renderDrawer();
    await screen.findByText('Left');

    // There is nothing behind a full-width drawer worth reaching, and the backdrop is what makes
    // tapping away close it.
    expect(
      screen.queryByRole('button', { name: 'a control on the page behind' }),
    ).not.toBeInTheDocument();
  });
});
