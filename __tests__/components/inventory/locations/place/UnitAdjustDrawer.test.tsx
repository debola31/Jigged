/**
 * Bulk Adjust — a whole unit, bin by bin, in a drawer.
 *
 * The test that matters most here is the last one. `counted` is derived from EVERY row, because the
 * blank-row rule requires it; the list renders only what matches the filter. Without an exemption
 * those two disagree, and the disagreement is an **invisible write**: type 550 into an o-ring,
 * filter to "bearing", and the button reads "Save 1 count" over a list showing nothing to save.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '../../../../test-utils';
import userEvent from '@testing-library/user-event';

vi.mock('@/lib/supabase', () => ({ getSupabase: () => ({}) }));

const candidate = (partId: string, partName: string, locationId: string, path: string, qty: number) => ({
  partId,
  partName,
  description: null,
  unit: 'ea',
  systemQuantity: qty,
  target: { locationId, locationName: path, locationPath: path },
});

vi.mock('@/utils/inventoryCountAccess', () => ({
  loadCountCandidatesForPlaces: vi.fn(),
  commitCount: vi.fn(async () => ({ committed: 1, failures: [] })),
}));

vi.mock('@/utils/operatorAccess', () => ({
  getCurrentMember: vi.fn(async () => ({ id: 'member-1' })),
}));

import UnitAdjustDrawer from '@/components/inventory/locations/place/UnitAdjustDrawer';
import { commitCount, loadCountCandidatesForPlaces } from '@/utils/inventoryCountAccess';
import type { InventoryLocationNode } from '@/types/inventoryLocations';

const node = (
  id: string,
  name: string,
  children: InventoryLocationNode[] = [],
): InventoryLocationNode =>
  ({
    id,
    name,
    company_id: 'co1',
    parent_id: null,
    kind: null,
    sort_order: 0,
    created_at: '',
    updated_at: '',
    children,
  }) as unknown as InventoryLocationNode;

const CABINET = node('cab3', 'Cabinet 3', [node('shelf-a', 'Shelf A'), node('shelf-b', 'Shelf B')]);

const onClose = vi.fn();

const setup = (unit: InventoryLocationNode | null = CABINET) =>
  render(
    <UnitAdjustDrawer unit={unit} companyId="co1" onClose={onClose} onChanged={vi.fn()} />,
  );

const countedFor = (part: string, place: string) =>
  screen.getByLabelText(`Counted ${part} at ${place}`);

/**
 * Re-established every test, not merely cleared.
 *
 * `clearAllMocks` resets calls but keeps implementations, so a `mockResolvedValue` set by one test
 * leaks into the next — which is how "offers no filter on a short sheet" ended up rendering the
 * ten-row fixture from the test above it.
 */
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(commitCount).mockResolvedValue({ committed: 1, failures: [] });
  vi.mocked(loadCountCandidatesForPlaces).mockResolvedValue({
    candidates: [
      candidate('p-bear', 'BUY-BEARING-608ZZ', 'shelf-a', 'Shelf A', 580),
      candidate('p-oring', 'BUY-ORING-214', 'shelf-a', 'Shelf A', 828),
      candidate('p-oring', 'BUY-ORING-214', 'shelf-b', 'Shelf B', 552),
    ],
    total: 3,
  });
});

describe('UnitAdjustDrawer', () => {
  it('audits every bin under the unit, a row per part AND place', async () => {
    setup();

    expect(await screen.findByRole('heading', { name: /bulk adjust Cabinet 3/i })).toBeInTheDocument();
    // The o-ring is in two bins, so it is two rows — aggregating them would pose a question no bin
    // can answer: counted 1,380 against 828 + 552, which shelf absorbs the difference?
    expect(screen.getAllByText('BUY-ORING-214')).toHaveLength(2);
    expect(screen.getAllByText(/Shelf A · ea/).length).toBeGreaterThan(0);
  });

  it('asks for every leaf under the unit, not the unit itself', async () => {
    setup();
    await screen.findByRole('heading', { name: /bulk adjust/i });

    expect(loadCountCandidatesForPlaces).toHaveBeenCalledWith(
      [
        expect.objectContaining({ id: 'shelf-a', name: 'Shelf A' }),
        expect.objectContaining({ id: 'shelf-b', name: 'Shelf B' }),
      ],
      expect.anything(),
    );
  });

  it('commits only the rows a number was typed into, against their own bin', async () => {
    const user = userEvent.setup();
    setup();
    await screen.findByRole('heading', { name: /bulk adjust/i });

    await user.type(countedFor('BUY-ORING-214', 'Shelf B'), '550');
    await user.click(screen.getByRole('button', { name: /save 1 count/i }));

    const [variances] = vi.mocked(commitCount).mock.calls[0];
    expect(variances).toHaveLength(1);
    expect(variances[0].candidate.target.locationId).toBe('shelf-b');
    expect(variances[0].counted).toBe(550);
    expect(variances[0].delta).toBe(-2);
  });

  /**
   * THE INVISIBLE WRITE.
   *
   * Filtering narrowed the rendered list while the batch was derived from all of them, so a row you
   * had typed into could leave the screen and stay in the save. A filled row is exempt from the
   * filter — structurally, not by warning — so whatever is about to be written is on screen at the
   * moment you press the button.
   */
  it('never filters away a row that has been counted', async () => {
    const user = userEvent.setup();
    vi.mocked(loadCountCandidatesForPlaces).mockResolvedValue({
      candidates: [
        ...Array.from({ length: 9 }, (_, i) =>
          candidate(`p${i}`, `BUY-WIDGET-${i}`, 'shelf-a', 'Shelf A', 10 + i),
        ),
        candidate('p-oring', 'BUY-ORING-214', 'shelf-b', 'Shelf B', 552),
      ],
      total: 10,
    });
    setup();
    await screen.findByRole('heading', { name: /bulk adjust/i });

    await user.type(countedFor('BUY-ORING-214', 'Shelf B'), '550');
    await user.type(screen.getByPlaceholderText(/filter by part or place/i), 'WIDGET-3');

    // Narrowed…
    expect(screen.getByText('BUY-WIDGET-3')).toBeInTheDocument();
    expect(screen.queryByText('BUY-WIDGET-5')).not.toBeInTheDocument();
    // …but never past the thing that is about to be saved.
    expect(screen.getByText('BUY-ORING-214')).toBeInTheDocument();
    expect(countedFor('BUY-ORING-214', 'Shelf B')).toHaveValue(550);
    expect(screen.getByRole('button', { name: /save 1 count/i })).toBeEnabled();
    expect(screen.getByText(/including 1 you have counted/i)).toBeInTheDocument();
  });

  it('offers no filter on a short sheet', async () => {
    setup();
    await screen.findByRole('heading', { name: /bulk adjust/i });
    expect(screen.queryByPlaceholderText(/filter by part or place/i)).not.toBeInTheDocument();
  });

  it('says so when the unit holds nothing', async () => {
    vi.mocked(loadCountCandidatesForPlaces).mockResolvedValue({ candidates: [], total: 0 });
    setup();

    expect(
      await screen.findByText(/nothing is recorded anywhere in Cabinet 3 yet/i),
    ).toBeInTheDocument();
  });
});
