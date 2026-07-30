/**
 * The board.
 *
 * The load-bearing test is `reports a container as occupied when only its shelves hold stock`.
 * The occupancy view reports what sits DIRECTLY at a location, so a cabinet whose shelves are
 * full has no row at all — and a board that reads it as "empty" would send someone to fill an
 * already-occupied shelf. That's the one failure mode worse than showing no fill state, and the
 * seed contains exactly this shape (Cabinet 3 › Shelf A/B).
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '../../../test-utils';
import userEvent from '@testing-library/user-event';

import LocationBoard from '@/components/inventory/locations/board/LocationBoard';
import { rollUpOccupancy } from '@/utils/locationOccupancy';
import type { InventoryLocation, InventoryLocationNode } from '@/types/inventoryLocations';

const node = (
  over: Partial<InventoryLocation> & { id: string },
  children: InventoryLocationNode[] = [],
  depth = 0,
): InventoryLocationNode => ({
  company_id: 'co1',
  parent_id: null,
  name: over.id,
  kind: null,
  code: null,
  sort_order: 0,
  created_at: '',
  updated_at: '',
  ...over,
  children,
  depth,
});

const renderBoard = (
  tree: InventoryLocationNode[],
  counts: Array<[string, number]> = [],
  overrides: Partial<{
    onOpen: () => void;
    onAddStorage: () => void;
    photoUrls: ReadonlyMap<string, string>;
  }> = {},
) => {
  const onOpen = overrides.onOpen ?? vi.fn();
  const onAddStorage = overrides.onAddStorage ?? vi.fn();
  const { container } = render(
    <LocationBoard
      tree={tree}
      occupancy={rollUpOccupancy(tree, new Map(counts))}
      photoUrls={overrides.photoUrls}
      onOpen={onOpen}
      onAddStorage={onAddStorage}
    />,
  );
  return { onOpen, onAddStorage, container };
};

const cabinetWithShelves = () => {
  const shelfA = node({ id: 'shelf-a', name: 'Shelf A', parent_id: 'cab3' }, [], 1);
  const shelfB = node({ id: 'shelf-b', name: 'Shelf B', parent_id: 'cab3' }, [], 1);
  return node({ id: 'cab3', name: 'Cabinet 3', kind: 'cabinet', code: 'CAB3' }, [shelfA, shelfB]);
};

describe('LocationBoard', () => {
  it('draws a unit with its name and code', () => {
    renderBoard([cabinetWithShelves()]);
    expect(screen.getByText('Cabinet 3')).toBeInTheDocument();
    expect(screen.getByText('CAB3')).toBeInTheDocument();
    expect(screen.getByText('Shelf A')).toBeInTheDocument();
  });

  /** The assertion the whole feature turns on. */
  it('reports a container as occupied when only its shelves hold stock', () => {
    renderBoard([cabinetWithShelves()], [['shelf-a', 2], ['shelf-b', 1]]);

    // Rolled up: the cabinet's own row is absent from the view entirely.
    expect(screen.getByRole('button', { name: 'Cabinet 3 — 3 parts' })).toBeInTheDocument();
    expect(screen.getByText('3 parts')).toBeInTheDocument();
    expect(screen.queryByText('empty')).not.toBeInTheDocument();
  });

  it('says empty only when nothing anywhere inside holds stock', () => {
    renderBoard([cabinetWithShelves()]);
    expect(screen.getByRole('button', { name: 'Cabinet 3 — empty' })).toBeInTheDocument();
    expect(screen.getByText('empty')).toBeInTheDocument();
  });

  it('singularises one part', () => {
    renderBoard([cabinetWithShelves()], [['shelf-a', 1]]);
    expect(screen.getByText('1 part')).toBeInTheDocument();
  });

  /**
   * `Unassigned` is guaranteed to exist and on a real shop is the biggest thing on the board.
   * Leading with it makes the page read "one giant tile is my inventory"; last makes it read
   * "here is my storage; separately, here is the pile to put away."
   */
  it('sorts the system bucket last however it arrives, and explains it', () => {
    const unassigned = node({ id: 'un', name: 'Unassigned', kind: 'system' });
    renderBoard([unassigned, cabinetWithShelves()], [['un', 9428]]);

    const units = screen.getAllByRole('button').map((b) => b.getAttribute('aria-label'));
    expect(units[0]).toBe('Cabinet 3 — empty');
    expect(units[1]).toBe('Unassigned — 9,428 parts');
    expect(screen.getByText(/put-away list, not a shelf/i)).toBeInTheDocument();
  });

  /**
   * The dot rendered with the right colour and **zero width** for a while, because a bare `<span>`
   * is `display: inline` and inline elements ignore width/height. jsdom has no layout engine, so
   * this can only assert the property that fixes it — the browser is what caught the bug, and this
   * is what stops it coming back.
   */
  it('gives each compartment a fill dot that can actually take a size', () => {
    const { container } = renderBoard([cabinetWithShelves()], [['shelf-a', 2]]);

    const dots = [...container.querySelectorAll('span')].filter((el) => {
      const s = window.getComputedStyle(el);
      return s.borderRadius === '50%' && (s.width === '7px' || s.height === '7px');
    });

    expect(dots.length).toBeGreaterThanOrEqual(2); // one per compartment
    for (const dot of dots) {
      // `inline` here means invisible, whatever the colour says.
      expect(window.getComputedStyle(dot).display).toBe('inline-block');
    }
  });

  it('opens the sheet for the whole unit, not for a compartment', async () => {
    const user = userEvent.setup();
    const { onOpen } = renderBoard([cabinetWithShelves()], [['shelf-a', 2]]);

    // Compartments render fill state but are deliberately not tap targets: at the 48px floor a
    // 5-row cabinet becomes a ~500px tile and the drawing — the point — is destroyed.
    expect(screen.queryByRole('button', { name: /Shelf A/ })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /^Cabinet 3/ }));
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen.mock.calls[0][0].id).toBe('cab3');
  });

  it('keeps an Add storage tile in the grid permanently, not only at first run', async () => {
    const user = userEvent.setup();
    const { onAddStorage } = renderBoard([cabinetWithShelves()], [['shelf-a', 2]]);

    await user.click(screen.getByRole('button', { name: /add storage/i }));
    expect(onAddStorage).toHaveBeenCalledTimes(1);
  });

  /**
   * The preview truncates at TOP_LIMIT = 24 and that's fine — a preview of "24 of 40" is honest.
   * A home screen that hides someone's storage is not, so the board deliberately diverges.
   */
  it('does not truncate top-level units the way the preview does', () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      node({ id: `u${i}`, name: `Unit ${i + 1}` }),
    );
    renderBoard(many);

    expect(screen.getByText('Unit 30')).toBeInTheDocument();
    expect(screen.queryByText(/\+\d+ more/)).not.toBeInTheDocument();
  });
});

/**
 * Photos on the tiles — §5.5 decision 5, "a photo of the actual rack beats any icon".
 *
 * The drawing is inferred from a free-text `kind`, i.e. a guess at what the object looks like. A
 * photograph is how someone recognises the shelf in front of them.
 */
describe('LocationBoard — photos', () => {
  const withPhoto = () =>
    node({ id: 'cab3', name: 'Cabinet 3', kind: 'cabinet', photo_path: 'co1/locations/cab3/a.jpg' });

  it('shows the photo when a URL resolved for its path', () => {
    renderBoard([withPhoto()], [], {
      photoUrls: new Map([['co1/locations/cab3/a.jpg', 'https://signed/a']]),
    });
    expect(document.querySelector('img[src="https://signed/a"]')).not.toBeNull();
  });

  /** Signed URLs expire and objects can vanish; a missing one falls back to the drawing. */
  it('falls back to the drawing when the path has no URL', () => {
    renderBoard([withPhoto()], [], { photoUrls: new Map() });
    expect(document.querySelector('img')).toBeNull();
    expect(screen.getByText('Cabinet 3')).toBeInTheDocument();
  });

  it('draws nothing extra for a location with no photo', () => {
    renderBoard([cabinetWithShelves()]);
    expect(document.querySelector('img')).toBeNull();
  });

  /** The photo identifies the unit; the compartments carry fill state. Both, not either. */
  it('keeps the compartments and their fill state alongside the photo', () => {
    const shelfA = node({ id: 'shelf-a', name: 'Shelf A', parent_id: 'cab3' }, [], 1);
    const cab = node(
      { id: 'cab3', name: 'Cabinet 3', kind: 'cabinet', photo_path: 'p.jpg' },
      [shelfA],
    );
    renderBoard([cab], [['shelf-a', 2]], { photoUrls: new Map([['p.jpg', 'https://signed/p']]) });

    expect(document.querySelector('img[src="https://signed/p"]')).not.toBeNull();
    expect(screen.getByText('Shelf A')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cabinet 3 — 2 parts' })).toBeInTheDocument();
  });
});
