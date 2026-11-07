import { describe, it, expect } from 'vitest';
import showcase from '@/app/(marketing)/showcase/showcase.json';
import { picked, type LivePart, type Showcase } from '@/app/(marketing)/showcase/_components/showcaseData';

/**
 * Each live part shows its picked steps only (moonshot/web/export.py PICKS): ten or fewer, in the
 * plan's order, with only the setups that still have a step. The data keeps every planned step.
 */
const data = showcase as Showcase;
const live = data.parts.filter((p): p is LivePart => p.status === 'live');

describe('a live part narrowed to its picks', () => {
  it('shows ten or fewer steps, exactly its picks, in plan order', () => {
    expect(live.length).toBeGreaterThan(0);
    for (const part of live) {
      const shown = picked(part);
      expect(shown.steps.length).toBeLessThanOrEqual(10);
      expect(shown.steps.map((s) => s.id)).toEqual(part.picks);
      // The page data itself is untouched: every planned step is still there.
      expect(part.steps.length).toBeGreaterThanOrEqual(shown.steps.length);
    }
  });

  it('keeps only the setups that still have a step', () => {
    for (const part of live) {
      const shown = picked(part);
      for (const g of shown.groups) expect(shown.steps.some((s) => s.group === g.id)).toBe(true);
      for (const s of shown.steps) expect(shown.groups.some((g) => g.id === s.group)).toBe(true);
    }
  });

  it('leaves a part without picks as it is', () => {
    const part = { ...live[0], picks: undefined };
    expect(picked(part)).toBe(part);
  });
});
