/**
 * The "add several at once" generator — what the visual builder became.
 *
 * ## What these tests used to cover, and why they don't
 *
 * The old suite opened on a palette of icon cards and asserted a 16-node cabinet
 * (1 × 5 rows × {Left, Right}). Both halves are gone:
 *
 * - **`STORAGE_TYPES`, the top-level palette, was never reachable.** `subdividing = parentId
 *   !== null` and the only caller always passes a parent, so those cards and the title "Build
 *   storage visually" never rendered in the product. Four tests asserted them anyway — the
 *   clearest possible demonstration that a test can pin something no user can reach.
 * - **`SUBDIVISION_TYPES` did render, and bought nothing.** It pre-filled two numbers that the
 *   very next screen let you edit, so it cost a step in order to skip a step.
 *
 * The generator now opens directly on those numbers. Every test here therefore renders it the one
 * way the product does: with a parent.
 */
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { render, screen } from '../../../test-utils';
import userEvent from '@testing-library/user-event';

vi.mock('@/utils/inventoryLocationsAccess', () => ({
  materializeLocationSpec: vi.fn(async (_co: string, _p: string | null, nodes: { children: unknown[] }[]) => {
    const count = (function c(ns: { children: unknown[] }[]): number {
      return ns.reduce((s, n) => s + 1 + c(n.children as { children: unknown[] }[]), 0);
    })(nodes);
    return Array.from({ length: count }, (_, i) => ({ id: String(i) }));
  }),
}));

import VisualLocationBuilder from '@/components/inventory/locations/builder/VisualLocationBuilder';
import { materializeLocationSpec } from '@/utils/inventoryLocationsAccess';

const subdivide = (props: Partial<{ existingSiblingNames: string[] }> = {}) =>
  render(
    <VisualLocationBuilder
      open
      companyId="co1"
      parentId="cab-3"
      parentCode="CAB3"
      parentPath={['Cabinet 3']}
      onClose={vi.fn()}
      onCreated={vi.fn()}
      {...props}
    />,
  );

beforeEach(() => vi.clearAllMocks());

describe('the level generator', () => {
  /** No palette step: you land on the numbers, already filled with something concrete. */
  it('opens straight on editable levels, with no type to choose first', async () => {
    subdivide();

    expect(screen.getAllByText('Call them').length).toBeGreaterThan(0);
    // 5 rows + their 10 sides — `countSpecNodes` counts parents too.
    expect(await screen.findByRole('button', { name: /create 15 locations/i })).toBeInTheDocument();
    expect(screen.queryByText(/what kind of storage/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/how is this unit divided up inside/i)).not.toBeInTheDocument();
  });

  it('names the unit it is dividing, so you know where you are', () => {
    subdivide();
    expect(screen.getByText('Divide up Cabinet 3')).toBeInTheDocument();
  });

  it('creates under the parent, with the parent code prefixed', async () => {
    const user = userEvent.setup();
    subdivide();

    await user.click(await screen.findByRole('button', { name: /create 15 locations/i }));

    const [companyId, parentId, spec] = (materializeLocationSpec as Mock).mock.calls[0];
    expect(companyId).toBe('co1');
    expect(parentId).toBe('cab-3');
    // NOT 'Cabinet 1' — the old top-level palette would have nested a cabinet inside a cabinet.
    expect(spec[0].name).toBe('Row 1');
  });

  /** The generator's real value: it continues from what the unit already holds. */
  it('continues the numbering when the unit already holds rows', async () => {
    const user = userEvent.setup();
    subdivide({ existingSiblingNames: ['Row 1', 'Row 2', 'Row 3'] });

    // Shown before anything is written. The drawn preview is gone, so the generator's own
    // "→ Row 4, Row 5, Row 6, …" hint is now the only place the continuation is visible —
    // which makes it load-bearing rather than decorative.
    expect(await screen.findByText(/→ Row 4, Row 5, Row 6/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /create 15 locations/i }));
    const spec = (materializeLocationSpec as Mock).mock.calls[0][2];
    expect(spec.map((n: { name: string }) => n.name)).toEqual([
      'Row 4', 'Row 5', 'Row 6', 'Row 7', 'Row 8',
    ]);
  });

  it('customizes a single branch, then can start over', async () => {
    const user = userEvent.setup();
    subdivide();
    await screen.findByRole('button', { name: /create 15 locations/i });

    await user.click(screen.getByRole('button', { name: /customize individual spots/i }));
    expect(screen.getByRole('button', { name: /^start over$/i })).toBeInTheDocument();

    await user.click(screen.getAllByRole('button', { name: /^add$/i })[0]);
    expect(await screen.findByRole('button', { name: /create 16 locations/i })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /^start over$/i }));
    const confirms = screen.getAllByRole('button', { name: /^start over$/i });
    await user.click(confirms[confirms.length - 1]);
    expect(await screen.findByRole('button', { name: /create 15 locations/i })).toBeInTheDocument();
    expect(screen.getAllByText('Call them').length).toBeGreaterThan(0);
  });

  it('duplicates one branch from the customize editor', async () => {
    const user = userEvent.setup();
    subdivide();
    await screen.findByRole('button', { name: /create 15 locations/i });

    await user.click(screen.getByRole('button', { name: /customize individual spots/i }));
    await user.click(await screen.findByRole('button', { name: /duplicate row 1/i }));

    // Row 1 plus its two sides, cloned.
    expect(await screen.findByRole('button', { name: /create 18 locations/i })).toBeInTheDocument();
  });
});
