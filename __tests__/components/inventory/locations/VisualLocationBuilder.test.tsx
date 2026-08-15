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

/** Into the per-location editor, which reshape no longer opens on by default. */
const intoDetail = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(await screen.findByRole('button', { name: /edit locations one by one/i }));
};

// ── Reshape ──────────────────────────────────────────────────────────────────

/**
 * **It opens on the numbers, pre-filled with what the unit already is.**
 *
 * The first version opened on the per-location editor. The founder, on seeing it: *"I was expecting
 * that it would bring up the same modal you use when creating a storage unit and just let you change
 * it. So let's say you created something that was 5x5, you could just change it to 4x4."* The tests
 * below are that sentence.
 */
describe('reshape mode — the numbers, pre-filled', () => {
  it('opens on the same controls that BUILT the unit, showing its current shape', async () => {
    reshape();

    // "Call them: Row" and "How many: 3" — read back off the cabinet, not a 5-row default.
    expect(await screen.findByDisplayValue('Row')).toBeInTheDocument();
    expect(screen.getByRole('spinbutton')).toHaveValue(3);
    // Not the per-location editor.
    expect(screen.queryByRole('textbox', { name: /^name of/i })).not.toBeInTheDocument();
  });

  it('changes 3 rows to 2 by turning the number down — the 5x5 → 4x4 case', async () => {
    const user = userEvent.setup();
    reshape();

    await user.click(await screen.findByRole('button', { name: /fewer/i }));

    expect(await screen.findByText(/Removing 1 location, all of them empty/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /review changes/i })).toBeEnabled();
  });

  it('keeps the surviving rows’ ids, so the change is a removal and not a rebuild', async () => {
    const user = userEvent.setup();
    reshape();

    await user.click(await screen.findByRole('button', { name: /fewer/i }));
    await user.click(screen.getByRole('button', { name: /review changes/i }));
    await user.click(await screen.findByRole('button', { name: /apply changes/i }));

    const [unitId, payload] = (applyLocationLayout as Mock).mock.calls[0];
    expect(unitId).toBe('cab-3');
    expect(payload.removals).toEqual(['row3']);
    // Rows 1 and 2 ride along by id — their stock and their printed labels survive.
    expect(payload.nodes.map((n: { ref: string }) => n.ref)).toEqual(['id:row1', 'id:row2']);
  });

  it('says nothing at all until something changes', async () => {
    // It used to open with "test is unchanged so far. Edit the names, add or remove locations, or
    // reshape it by the numbers." above a SECOND info alert about the editing mode — two boxes of
    // prose before one number had been touched.
    reshape();
    await screen.findByDisplayValue('Row');

    expect(screen.queryByText(/unchanged so far/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    // The disabled button is what says nothing has changed.
    expect(screen.getByRole('button', { name: /review changes/i })).toBeDisabled();
  });

  it('names the unit it is changing, so you know where you are', () => {
    reshape();
    expect(screen.getByText('Change the layout of Cabinet 3')).toBeInTheDocument();
  });

  it('adds a level, which is how a flat unit gains bins', async () => {
    const user = userEvent.setup();
    reshape();

    await user.click(await screen.findByRole('button', { name: /add a deeper level/i }));

    expect(await screen.findByText(/Creating \d+ locations/i)).toBeInTheDocument();
    expect(screen.getByText(/Dividing up 3 locations/i)).toBeInTheDocument();
  });
});

/**
 * A unit the numbers cannot describe — production has one: rows 1–5 bare, rows 6–10 split three
 * ways. Opening THAT on the numbers would greet you with "Creating 15 locations" before you had
 * touched anything, and accepting it would quietly even the unit out.
 */
describe('reshape mode — a unit the numbers cannot describe', () => {
  const ragged = () =>
    node('cab-3', 'Cabinet 3', [
      node('row1', 'Row 1', [node('r1l', 'Left', [], 0), node('r1r', 'Right', [], 1)], 0),
      node('row2', 'Row 2', [], 1),
    ]);

  it('opens on the locations themselves, and says why', async () => {
    reshape(ragged());

    expect(await screen.findByText(/regular grid/i)).toBeInTheDocument();
    expect(screen.getByDisplayValue('Row 1')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Left')).toBeInTheDocument();
  });

  it('still claims no change on open — the fallback exists to prevent exactly that', async () => {
    reshape(ragged());
    await screen.findByDisplayValue('Row 1');

    expect(screen.getByRole('button', { name: /review changes/i })).toBeDisabled();
    expect(screen.queryByText(/creating/i)).not.toBeInTheDocument();
  });

  it('offers the numbers as a deliberate choice, warning that it evens the unit out', async () => {
    const user = userEvent.setup();
    reshape(ragged());

    await user.click(await screen.findByRole('button', { name: /use rows and bins instead/i }));

    expect(await screen.findByText(/every row of Cabinet 3 would end up divided the same way/i))
      .toBeInTheDocument();
  });
});

// ── Reshape: editing individual locations ────────────────────────────────────

describe('reshape mode — editing locations one by one', () => {
  it('REMOVES rather than appends, and says so before anything is written', async () => {
    // THE ORIGINAL BUG, at the surface a user touches.
    const user = userEvent.setup();
    reshape();
    await intoDetail(user);

    await user.click(await screen.findByRole('button', { name: /remove row 3/i }));

    expect(await screen.findByText(/Removing 1 location, all of them empty/i)).toBeInTheDocument();
    expect(screen.queryByDisplayValue('Row 3')).not.toBeInTheDocument();
  });

  it('sends a rename as a rename — the location keeps its id', async () => {
    const user = userEvent.setup();
    reshape();
    await intoDetail(user);

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
    reshape(
      node('cab-3', 'Cabinet 3', [
        node('row1', 'Row 1', [node('r1l', 'Left', [], 0), node('r1r', 'Right', [], 1)], 0),
        node('row2', 'Row 2', [], 1),
      ]),
    );

    // Ragged, so it already opens on the locations.
    await user.click(await screen.findByRole('button', { name: /remove row 1/i }));
    await user.click(screen.getByRole('button', { name: /review changes/i }));
    await user.click(await screen.findByRole('button', { name: /apply changes/i }));

    const [, payload] = (applyLocationLayout as Mock).mock.calls[0];
    expect([...payload.removals].sort()).toEqual(['r1l', 'r1r', 'row1']);
  });

  it('warns in error colour when something is going away, and not otherwise', async () => {
    const user = userEvent.setup();
    reshape();
    await intoDetail(user);

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
    await intoDetail(user);

    const field = await screen.findByDisplayValue('Row 2');
    await user.clear(field);
    await user.type(field, 'Row 1');

    expect(await screen.findByText(/both called/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /review changes/i })).toBeDisabled();
  });

  it('withholds nothing on a unit with no children — that is still a plain build', async () => {
    reshape(node('yard', 'The Yard', []));
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

  /**
   * Through the NUMBERS, which is how someone would actually reach this: turn 3 rows down to 2,
   * and the row that goes is the one holding stock.
   */
  const removeLoadedRow = async (user: ReturnType<typeof userEvent.setup>) => {
    reshape(cabinet(), { row3: 2 });
    await user.click(await screen.findByRole('button', { name: /fewer/i }));
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
