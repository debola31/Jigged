/**
 * The layout builder, in both of its modes.
 *
 * ## What changed, and why most of this file did
 *
 * These tests used to render the dialog the one way the product did: pointed at an existing unit,
 * generating a fresh set of names that continued past what was already inside it. Three of them
 * asserted that continuation directly (`→ Row 4, Row 5, Row 6`, `create 10 places` on a cabinet
 * that already had three rows). They passed, and they were pinning the bug: the dialog is titled
 * *Change the layout of Cabinet 3* and could only ever add to it.
 *
 * So `reshape mode` below is the real subject now. `create mode` keeps what genuinely still exists:
 * the numbers editor, and the single-screen flow for a unit with nothing inside it.
 *
 * The distribute-step suite survives almost intact — its rules did not change, only its source did.
 * It used to read the stock sitting directly on the parent, which for an already-divided cabinet is
 * always empty (a container holds nothing), which is exactly why the old flow never asked about the
 * stock in the bins it was appending beside.
 */
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { render, screen, within } from '../../../test-utils';
import userEvent from '@testing-library/user-event';

vi.mock('@/utils/inventoryLocationsAccess', () => ({
  materializeLocationSpec: vi.fn(async () => [{ id: 'new' }]),
  applyLocationLayout: vi.fn(async () => [{ id: 'cab-3' }]),
  getContentsPageForLocations: vi.fn(async () => ({ contents: [], total: 0 })),
}));

vi.mock('posthog-js', () => ({ default: { capture: vi.fn() } }));

import VisualLocationBuilder from '@/components/inventory/locations/builder/VisualLocationBuilder';
import {
  applyLocationLayout,
  getContentsPageForLocations,
  materializeLocationSpec,
} from '@/utils/inventoryLocationsAccess';
import { rollUpOccupancy } from '@/utils/locationOccupancy';
import type { InventoryLocationNode } from '@/types/inventoryLocations';

const node = (
  id: string,
  name: string,
  children: InventoryLocationNode[] = [],
  sort_order = 0,
): InventoryLocationNode =>
  ({
    id,
    company_id: 'co1',
    parent_id: null,
    name,
    kind: null,
    sort_order,
    created_at: '',
    updated_at: '',
    children,
    depth: 0,
  }) as InventoryLocationNode;

/** Cabinet 3 as the shop actually built it: three bare rows. */
const cabinet = (rows = 3) =>
  node(
    'cab-3',
    'Cabinet 3',
    Array.from({ length: rows }, (_, i) => node(`row${i + 1}`, `Row ${i + 1}`, [], i)),
  );

const reshape = (unit = cabinet(), stock: Record<string, number> = {}) =>
  render(
    <VisualLocationBuilder
      open
      companyId="co1"
      unit={unit}
      parentPath={['Cabinet 3']}
      occupancy={rollUpOccupancy([unit], new Map(Object.entries(stock)))}
      onClose={vi.fn()}
      onDone={vi.fn()}
    />,
  );

const create = () =>
  render(
    <VisualLocationBuilder
      open
      companyId="co1"
      unit={null}
      siblingNames={['Cabinet 1']}
      onClose={vi.fn()}
      onDone={vi.fn()}
    />,
  );

beforeEach(() => vi.clearAllMocks());

// ── Reshape ──────────────────────────────────────────────────────────────────

describe('reshape mode', () => {
  it('opens on the unit’s REAL layout, not on a default shape', async () => {
    reshape();

    // Three real rows, editable by name. The old dialog opened on 5 rows x Left/Right regardless
    // of what the cabinet actually was, which is how it could only ever append.
    expect(await screen.findByDisplayValue('Row 1')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Row 2')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Row 3')).toBeInTheDocument();
    expect(screen.queryByDisplayValue('Left')).not.toBeInTheDocument();
  });

  it('says nothing has changed yet, and refuses to write nothing', async () => {
    reshape();
    expect(await screen.findByText(/unchanged so far/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /review changes/i })).toBeDisabled();
  });

  it('names the unit it is changing, so you know where you are', () => {
    reshape();
    expect(screen.getByText('Change the layout of Cabinet 3')).toBeInTheDocument();
  });

  it('REMOVES rather than appends, and says so before anything is written', async () => {
    // THE BUG, at the surface a user touches. Removing Row 3 must read as a removal.
    const user = userEvent.setup();
    reshape();

    await user.click(await screen.findByRole('button', { name: /remove row 3/i }));

    expect(await screen.findByText(/Removing 1 location, all of them empty/i)).toBeInTheDocument();
    expect(screen.queryByDisplayValue('Row 3')).not.toBeInTheDocument();
  });

  it('sends a rename as a rename — the location keeps its id', async () => {
    const user = userEvent.setup();
    reshape();

    const field = await screen.findByDisplayValue('Row 2');
    await user.clear(field);
    await user.type(field, 'Shelf B');

    await user.click(screen.getByRole('button', { name: /review changes/i }));
    await user.click(await screen.findByRole('button', { name: /apply changes/i }));

    const [unitId, payload] = (applyLocationLayout as Mock).mock.calls[0];
    expect(unitId).toBe('cab-3');
    expect(payload.removals).toEqual([]);
    const renamed = payload.nodes.find((n: { ref: string }) => n.ref === 'id:row2');
    expect(renamed.name).toBe('Shelf B');
  });

  it('names every removed descendant in the payload, not just the subtree root', async () => {
    const user = userEvent.setup();
    const unit = node('cab-3', 'Cabinet 3', [
      node('row1', 'Row 1', [node('r1l', 'Left', [], 0), node('r1r', 'Right', [], 1)], 0),
      node('row2', 'Row 2', [], 1),
    ]);
    reshape(unit);

    await user.click(await screen.findByRole('button', { name: /remove row 1/i }));
    await user.click(screen.getByRole('button', { name: /review changes/i }));
    await user.click(await screen.findByRole('button', { name: /apply changes/i }));

    const [, payload] = (applyLocationLayout as Mock).mock.calls[0];
    expect([...payload.removals].sort()).toEqual(['r1l', 'r1r', 'row1']);
  });

  it('warns in error colour when something is going away, and not otherwise', async () => {
    const user = userEvent.setup();
    reshape();

    // Purely additive: an ordinary primary, because dressing it red teaches people to click red.
    await user.click(screen.getAllByRole('button', { name: /duplicate row 1/i })[0]);
    await user.click(screen.getByRole('button', { name: /review changes/i }));
    let confirm = await screen.findByRole('button', { name: /apply changes/i });
    expect(confirm.className).not.toMatch(/colorError/);

    await user.click(screen.getByRole('button', { name: /^cancel$/i }));
    await user.click(await screen.findByRole('button', { name: /remove row 3/i }));
    await user.click(screen.getByRole('button', { name: /review changes/i }));
    confirm = await screen.findByRole('button', { name: /apply changes/i });
    expect(confirm.className).toMatch(/colorError/);
  });

  it('flags a duplicate sibling name as you type, not after the confirmation', async () => {
    // The database refuses it, and a confirm dialog that ends in an error is the shape
    // docs/interaction-standards.md forbids outright.
    const user = userEvent.setup();
    reshape();

    const field = await screen.findByDisplayValue('Row 2');
    await user.clear(field);
    await user.type(field, 'Row 1');

    expect(await screen.findByText(/both called/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /review changes/i })).toBeDisabled();
  });

  it('withholds nothing on a unit with no children — that is still a plain build', async () => {
    reshape(node('yard', 'The Yard', []));
    // Nothing to seed from, so it falls back to the generator, exactly as the old subdivide did.
    expect((await screen.findAllByText('Call them')).length).toBeGreaterThan(0);
    expect(screen.queryByRole('textbox', { name: /^name of/i })).not.toBeInTheDocument();
  });
});

// ── The stock journey ────────────────────────────────────────────────────────

/**
 * The invariant added in 20260806160053 is what makes this a step rather than a footnote: a
 * location cannot hold stock and sub-locations at once, and a location that is being deleted cannot
 * hold anything either. `apply_location_layout` defers the check to COMMIT, so an incomplete
 * distribution does not half-apply — it rolls the whole reshape back, deletions and all. Blocking
 * the confirmation until the arithmetic balances is what keeps that from being how a user finds out.
 */
describe('a reshape that empties a loaded location', () => {
  const CONTENTS = [
    { part_id: 'p1', part_name: 'BEARING-608ZZ', quantity: 100, primary_unit: 'each', location_id: 'row3' },
    { part_id: 'p2', part_name: 'ORING-214', quantity: 40, primary_unit: 'each', location_id: 'row3' },
  ];

  beforeEach(() => {
    (getContentsPageForLocations as Mock).mockResolvedValue({ contents: CONTENTS, total: 2 });
  });

  const removeLoadedRow = async (user: ReturnType<typeof userEvent.setup>) => {
    reshape(cabinet(), { row3: 2 });
    await user.click(await screen.findByRole('button', { name: /remove row 3/i }));
  };

  it('asks where the stock goes before it will apply anything', async () => {
    const user = userEvent.setup();
    await removeLoadedRow(user);

    // Review is not even offered yet — a loaded removal turns the primary action into Next.
    const next = await screen.findByRole('button', { name: /where does the stock go/i });
    expect(screen.queryByRole('button', { name: /review changes/i })).not.toBeInTheDocument();

    await user.click(next);
    expect(await screen.findByText('BEARING-608ZZ')).toBeInTheDocument();
    expect(screen.getByText('ORING-214')).toBeInTheDocument();
  });

  it('keeps the confirmation out of reach until every part is placed', async () => {
    const user = userEvent.setup();
    await removeLoadedRow(user);
    await user.click(await screen.findByRole('button', { name: /where does the stock go/i }));

    expect(await screen.findByRole('button', { name: /review changes/i })).toBeDisabled();

    await user.click(screen.getByLabelText(/send everything to/i));
    await user.click(screen.getAllByRole('option')[0]);

    expect(screen.getByRole('button', { name: /review changes/i })).toBeEnabled();
  });

  it('says how much is still unplaced rather than just refusing', async () => {
    const user = userEvent.setup();
    await removeLoadedRow(user);
    await user.click(await screen.findByRole('button', { name: /where does the stock go/i }));

    await user.click(screen.getByLabelText(/send everything to/i));
    await user.click(screen.getAllByRole('option')[0]);

    const qtyFields = screen.getAllByLabelText('Qty');
    await user.clear(qtyFields[0]);
    await user.type(qtyFields[0], '60');

    expect(await screen.findByText(/40 each still to place/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /review changes/i })).toBeDisabled();
  });

  it('carries each move’s source location, since a part can be leaving two at once', async () => {
    const user = userEvent.setup();
    await removeLoadedRow(user);
    await user.click(await screen.findByRole('button', { name: /where does the stock go/i }));

    await user.click(screen.getByLabelText(/send everything to/i));
    await user.click(screen.getAllByRole('option')[0]);

    await user.click(screen.getByRole('button', { name: /review changes/i }));
    await user.click(await screen.findByRole('button', { name: /apply changes/i }));

    const [, , moves] = (applyLocationLayout as Mock).mock.calls.at(-1)!;
    expect(moves).toHaveLength(2);
    expect(moves.every((m: { fromLocationId: string }) => m.fromLocationId === 'row3')).toBe(true);
    expect(moves.map((m: { quantity: number }) => m.quantity).sort((a: number, b: number) => a - b)).toEqual([40, 100]);
  });

  it('NEVER offers Unassigned, and never writes without an answer', async () => {
    // Sweeping to the put-away pile would silently declare the stock homeless. The pile is a root,
    // so it is never inside the unit being reshaped and cannot be a destination at all.
    const user = userEvent.setup();
    await removeLoadedRow(user);
    await user.click(await screen.findByRole('button', { name: /where does the stock go/i }));

    await user.click(screen.getByLabelText(/send everything to/i));
    const options = screen.getAllByRole('option');
    expect(options.map((o) => o.textContent).join(' ')).not.toMatch(/unassigned/i);
    await user.keyboard('{Escape}');

    expect(applyLocationLayout).not.toHaveBeenCalled();
  });

  it('refuses outright when there is more stock than one change can re-place', async () => {
    (getContentsPageForLocations as Mock).mockResolvedValue({ contents: CONTENTS, total: 431 });
    const user = userEvent.setup();
    await removeLoadedRow(user);
    await user.click(await screen.findByRole('button', { name: /where does the stock go/i }));

    // Truncating and pretending would look complete and roll the whole reshape back at COMMIT.
    expect(await screen.findByText(/more than one change can re-place/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /review changes/i })).toBeDisabled();
  });
});

// ── Create ───────────────────────────────────────────────────────────────────

describe('create mode', () => {
  it('opens straight on editable levels, with no type to choose first', async () => {
    create();

    expect(screen.getAllByText('Call them').length).toBeGreaterThan(0);
    // 5 rows x Left/Right = 10 LOCATIONS. The rows are structure; stock cannot sit in one.
    expect(await screen.findByRole('button', { name: /create 10 locations/i })).toBeInTheDocument();
    expect(screen.queryByText(/what kind of storage/i)).not.toBeInTheDocument();
  });

  it('names the unit and shapes it in one call', async () => {
    const user = userEvent.setup();
    create();

    await user.type(screen.getByLabelText(/what is it called/i), 'Cabinet 4');
    await user.click(await screen.findByRole('button', { name: /create 10 locations/i }));

    const [companyId, parentId, spec] = (materializeLocationSpec as Mock).mock.calls[0];
    expect(companyId).toBe('co1');
    expect(parentId).toBeNull();
    expect(spec[0].name).toBe('Cabinet 4');
    expect(spec[0].children).toHaveLength(5);
  });

  it('will not create an unnamed unit, and warns before a duplicate name', async () => {
    const user = userEvent.setup();
    create();

    expect(await screen.findByRole('button', { name: /create 10 locations/i })).toBeDisabled();

    await user.type(screen.getByLabelText(/what is it called/i), 'Cabinet 1');
    expect(await screen.findByText(/you already have a cabinet 1/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /create 10 locations/i })).toBeDisabled();
  });

  it('offers no rename fields — a name that does not exist yet is edited by its pattern', async () => {
    create();
    await screen.findByRole('button', { name: /create 10 locations/i });
    await userEvent.setup().click(
      screen.getByRole('button', { name: /customize individual spots/i }),
    );

    const topLevel = screen.getByText('Top-level').parentElement!;
    expect(within(topLevel).queryByRole('textbox')).not.toBeInTheDocument();
  });
});
