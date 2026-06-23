import { describe, it, expect } from 'vitest';
import {
  getPartSetupStatus,
  type PartSetupState,
} from '@/components/parts/workspace/partSetupStatus';
import type { Part } from '@/types/part';

type StatusInput = Pick<Part, 'source' | 'routing' | 'bom_lines_count'>;

const routing = (nodes_count: number): Part['routing'] => ({
  id: 'r1',
  nodes_count,
  total_run_time_per_unit: nodes_count > 0 ? 5 : null,
});

describe('getPartSetupStatus', () => {
  it('a priceable part is ready (success) with no next step, regardless of source', () => {
    for (const source of ['made', 'bought'] as const) {
      const status = getPartSetupStatus(
        { source, routing: routing(2), bom_lines_count: 1 },
        true,
      );
      expect(status.state).toBe('ready');
      expect(status.color).toBe('success');
      expect(status.nextStep).toBeNull();
    }
  });

  it('an empty made part (no routing, no BOM, not priceable) is a neutral needs_setup (info)', () => {
    const status = getPartSetupStatus(
      { source: 'made', routing: null, bom_lines_count: 0 },
      false,
    );
    expect(status.state).toBe('needs_setup');
    expect(status.color).toBe('info');
    expect(status.nextStep).toMatch(/operations/i);
  });

  it('a made part with structure but not priceable warns needs_cost', () => {
    const withRouting = getPartSetupStatus(
      { source: 'made', routing: routing(1), bom_lines_count: 0 },
      false,
    );
    const withBom = getPartSetupStatus(
      { source: 'made', routing: null, bom_lines_count: 3 },
      false,
    );
    for (const status of [withRouting, withBom]) {
      expect(status.state).toBe('needs_cost');
      expect(status.color).toBe('warning');
      expect(status.nextStep).toBeTruthy();
    }
  });

  it('a not-priceable bought part is needs_cost for the chip but emits NO banner (nextStep null)', () => {
    // Bought parts surface the missing-cost gap inline in the Cost card (a red
    // starter tier in PartProcurementPricingPanel), not as a workspace banner —
    // so the chip still reads "Needs cost" (warning) but nextStep is null.
    const status = getPartSetupStatus(
      { source: 'bought', routing: null, bom_lines_count: 0 },
      false,
    );
    expect(status.state).toBe('needs_cost');
    expect(status.color).toBe('warning');
    expect(status.nextStep).toBeNull();
  });

  it('only ever emits theme palette colour keys (never a hardcoded hex)', () => {
    const inputs: Array<[StatusInput, boolean]> = [
      [{ source: 'made', routing: routing(2), bom_lines_count: 1 }, true],
      [{ source: 'made', routing: null, bom_lines_count: 0 }, false],
      [{ source: 'made', routing: routing(1), bom_lines_count: 0 }, false],
      [{ source: 'bought', routing: null, bom_lines_count: 0 }, false],
    ];
    const allowed = new Set(['success', 'info', 'warning']);
    const seenStates = new Set<PartSetupState>();
    for (const [part, priceable] of inputs) {
      const status = getPartSetupStatus(part, priceable);
      expect(allowed.has(status.color)).toBe(true);
      expect(status.color).not.toMatch(/#/);
      seenStates.add(status.state);
    }
    // The fixtures exercise every state.
    expect(seenStates).toEqual(new Set(['ready', 'needs_setup', 'needs_cost']));
  });
});
