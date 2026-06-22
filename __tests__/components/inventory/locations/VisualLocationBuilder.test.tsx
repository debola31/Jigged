/**
 * VisualLocationBuilder: the no-AI stepper that turns a picked storage type +
 * configured divisions into a location tree. Asserts the happy path —
 * palette → layout → review board → Create calls materializeLocationSpec with
 * the assembled spec and reports the count. The spec math itself is covered by
 * locationSpec.test.ts; here we test the wiring.
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
  it('picks a type, shows the live build step, and creates the materialized spec', async () => {
    const user = userEvent.setup();
    const onCreated = vi.fn();
    const onClose = vi.fn();
    render(
      <VisualLocationBuilder open companyId="co1" onClose={onClose} onCreated={onCreated} />,
    );

    // Step 1 — palette: pick Cabinet (defaults to 1 cabinet × 5 rows × {Left,Right} = 16)
    await user.click(screen.getByText('Cabinet'));

    // Step 2 — Build: controls + live board are shown together, Create carries the count
    expect(await screen.findByText('Cabinet 1')).toBeInTheDocument();
    const createBtn = await screen.findByRole('button', { name: /create 16 locations/i });
    await user.click(createBtn);

    expect(materializeLocationSpec).toHaveBeenCalledTimes(1);
    const [companyId, parentId, spec] = (materializeLocationSpec as Mock).mock.calls[0];
    expect(companyId).toBe('co1');
    expect(parentId).toBeNull();
    expect(spec[0].name).toBe('Cabinet 1');
    expect(spec[0].is_qr_anchor).toBe(true); // default QR anchor = top container
    expect(onCreated).toHaveBeenCalledWith(16);
  });

  it('lets you prune a tile in the live preview, lowering the count', async () => {
    const user = userEvent.setup();
    render(
      <VisualLocationBuilder open companyId="co1" onClose={vi.fn()} onCreated={vi.fn()} />,
    );

    await user.click(screen.getByText('Bins')); // flat: 6 bins, shown live on the build step
    expect(await screen.findByRole('button', { name: /create 6 locations/i })).toBeInTheDocument();

    // remove one bin tile from the preview
    await user.click(screen.getByRole('button', { name: /remove bin 1/i }));
    expect(await screen.findByRole('button', { name: /create 5 locations/i })).toBeInTheDocument();
  });
});
