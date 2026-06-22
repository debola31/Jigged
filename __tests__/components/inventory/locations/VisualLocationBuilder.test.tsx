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
    expect(spec[0].is_qr_anchor).toBe(true);
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
});
