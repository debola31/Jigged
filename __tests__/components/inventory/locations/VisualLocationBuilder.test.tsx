/**
 * VisualLocationBuilder: pick a type, see the full nested live preview, fine-tune
 * individual branches (non-uniform), and create. The spec math + per-branch
 * edits are covered by locationSpec.test.ts; here we test the wiring.
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

beforeEach(() => vi.clearAllMocks());

describe('VisualLocationBuilder', () => {
  it('picks a type, shows the full nested preview, and creates the spec', async () => {
    const user = userEvent.setup();
    const onCreated = vi.fn();
    render(<VisualLocationBuilder open companyId="co1" onClose={vi.fn()} onCreated={onCreated} />);

    // Cabinet default: 1 cabinet × 5 rows × {Left, Right} = 16
    await user.click(screen.getByText('Cabinet'));

    // whole nesting visible, no drill-in
    expect(await screen.findByText('Cabinet 1')).toBeInTheDocument();
    expect(screen.getByText('Row 1')).toBeInTheDocument();
    expect(screen.getAllByText('Left').length).toBeGreaterThan(0);

    await user.click(await screen.findByRole('button', { name: /create 16 locations/i }));

    expect(materializeLocationSpec).toHaveBeenCalledTimes(1);
    const [companyId, parentId, spec] = (materializeLocationSpec as Mock).mock.calls[0];
    expect(companyId).toBe('co1');
    expect(parentId).toBeNull();
    expect(spec[0].name).toBe('Cabinet 1');
    expect(onCreated).toHaveBeenCalledWith(16);
  });

  it('customizes per branch from the config, then can start over', async () => {
    const user = userEvent.setup();
    render(<VisualLocationBuilder open companyId="co1" onClose={vi.fn()} onCreated={vi.fn()} />);

    await user.click(screen.getByText('Cabinet'));
    expect(await screen.findByRole('button', { name: /create 16 locations/i })).toBeInTheDocument();

    // editing is in the config now — enter the per-branch editor
    await user.click(screen.getByRole('button', { name: /customize individual spots/i }));
    expect(await screen.findByText('Cabinet 1 › Row 1')).toBeInTheDocument(); // config reflects branches
    expect(screen.getByRole('button', { name: /^start over$/i })).toBeInTheDocument();

    // add one to a single branch → count rises
    await user.click(screen.getAllByRole('button', { name: /^add$/i })[0]);
    expect(await screen.findByRole('button', { name: /create 17 locations/i })).toBeInTheDocument();

    // start over → confirm → back to the uniform numbers form
    await user.click(screen.getByRole('button', { name: /^start over$/i }));
    const confirms = screen.getAllByRole('button', { name: /^start over$/i });
    await user.click(confirms[confirms.length - 1]);
    expect(await screen.findByRole('button', { name: /create 16 locations/i })).toBeInTheDocument();
    expect(screen.getAllByText('Call them').length).toBeGreaterThan(0); // uniform controls back
  });

  it('duplicates a top-level entry from the customize editor', async () => {
    const user = userEvent.setup();
    render(<VisualLocationBuilder open companyId="co1" onClose={vi.fn()} onCreated={vi.fn()} />);

    await user.click(screen.getByText('Cabinet')); // 16 nodes
    await user.click(screen.getByRole('button', { name: /customize individual spots/i }));

    // duplicate the cabinet → a second one like it → 32 nodes
    await user.click(await screen.findByRole('button', { name: /duplicate cabinet 1/i }));
    expect(await screen.findByRole('button', { name: /create 32 locations/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /duplicate cabinet 2/i })).toBeInTheDocument();
  });
});

/**
 * Subdivide — the same wizard aimed at an existing unit.
 *
 * The nested-create path (`materializeLocationSpec`'s `parentId`) was fully built and had **no
 * caller**: the wizard only ever created at the top level. These tests cover both halves of
 * turning it on — that the parent is actually passed, and that the palette can't produce a
 * cabinet inside a cabinet.
 */
describe('VisualLocationBuilder — subdividing an existing unit', () => {
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

  /**
   * The trap, pinned.
   *
   * Every `STORAGE_TYPES` entry's level 0 *is* the container, so reusing that palette while
   * subdividing Cabinet 3 would create `Cabinet 3 › Cabinet 1 › Row 1 › Left`. `slice(1)` isn't
   * the fix either — a sliced `Bins` or `Single shelf` is an empty spec that creates nothing.
   */
  it('offers no container cards, so it cannot nest a cabinet inside a cabinet', () => {
    subdivide();

    expect(screen.getByText(/how is this unit divided up inside/i)).toBeInTheDocument();
    expect(screen.queryByText('Cabinet')).not.toBeInTheDocument();
    expect(screen.queryByText('Shelving unit')).not.toBeInTheDocument();
    expect(screen.queryByText('Pallet rack')).not.toBeInTheDocument();
    // What it offers instead: divisions.
    expect(screen.getByText('Rows')).toBeInTheDocument();
    expect(screen.getByText('Shelves')).toBeInTheDocument();
    expect(screen.getByText('Sides')).toBeInTheDocument();
    expect(screen.getByText('Levels × positions')).toBeInTheDocument();
  });

  it('creates under the parent, with the parent code prefixed and no nested container', async () => {
    const user = userEvent.setup();
    subdivide();

    await user.click(screen.getByText('Rows'));
    await user.click(await screen.findByRole('button', { name: /create 5 locations/i }));

    const [companyId, parentId, spec] = (materializeLocationSpec as Mock).mock.calls[0];
    expect(companyId).toBe('co1');
    expect(parentId).toBe('cab-3'); // the dormant path, finally called
    expect(spec[0].name).toBe('Row 1'); // NOT 'Cabinet 1'
    expect(spec[0].code).toBe('CAB3-R01');
    expect(spec[0].children).toHaveLength(0);
  });

  it('continues the numbering when the unit already holds rows', async () => {
    const user = userEvent.setup();
    subdivide({ existingSiblingNames: ['Row 1', 'Row 2', 'Row 3'] });

    await user.click(screen.getByText('Rows'));
    // The preview shows the continuation before anything is written.
    expect(await screen.findByText('Row 4')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /create 5 locations/i }));
    const spec = (materializeLocationSpec as Mock).mock.calls[0][2];
    expect(spec.map((n: { name: string }) => n.name)).toEqual([
      'Row 4', 'Row 5', 'Row 6', 'Row 7', 'Row 8',
    ]);
    expect(spec[0].code).toBe('CAB3-R04');
  });

  it('names the unit it is dividing, so you know where you are', () => {
    subdivide();
    expect(screen.getByText('Subdivide Cabinet 3')).toBeInTheDocument();
  });

  it('still offers the container palette when building at the top level', () => {
    render(<VisualLocationBuilder open companyId="co1" onClose={vi.fn()} onCreated={vi.fn()} />);
    expect(screen.getByText('Cabinet')).toBeInTheDocument();
    expect(screen.getByText(/what kind of storage are you setting up/i)).toBeInTheDocument();
  });

  // Their own export: 118 of 121 legacy locations were flat, and many real names were places
  // rather than furniture. A palette that only offers structures forces "on the floor by the saw"
  // to be modelled as a cabinet.
  it('offers single-level places at the top level, not only furniture', () => {
    render(<VisualLocationBuilder open companyId="co1" onClose={vi.fn()} onCreated={vi.fn()} />);
    expect(screen.getByText('Floor space')).toBeInTheDocument();
    expect(screen.getByText('Outside / yard')).toBeInTheDocument();
    expect(screen.getByText('Bench')).toBeInTheDocument();
  });
});
