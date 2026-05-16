import { describe, it, expect } from 'vitest';
import {
  MAX_PART_NAV_DEPTH,
  parseBackChain,
  pushPartToChain,
  popPartFromChain,
  buildPartHref,
} from '@/lib/partNavStack';

// Stable, recognizably-distinct UUIDs so failure messages are easier to read.
const A = '00000000-0000-0000-0000-00000000000a';
const B = '00000000-0000-0000-0000-00000000000b';
const C = '00000000-0000-0000-0000-00000000000c';
const D = '00000000-0000-0000-0000-00000000000d';
const E = '00000000-0000-0000-0000-00000000000e';
const F = '00000000-0000-0000-0000-00000000000f';
const G = '00000000-0000-0000-0000-000000000010';

function params(value: string | null): URLSearchParams {
  const out = new URLSearchParams();
  if (value !== null) out.set('back', value);
  return out;
}

describe('parseBackChain', () => {
  it('returns [] when ?back= is missing', () => {
    expect(parseBackChain(params(null))).toEqual([]);
  });

  it('returns [] when ?back= is empty string', () => {
    expect(parseBackChain(params(''))).toEqual([]);
  });

  it('parses a comma-separated list of uuids', () => {
    expect(parseBackChain(params(`${A},${B},${C}`))).toEqual([A, B, C]);
  });

  it('trims whitespace around entries', () => {
    expect(parseBackChain(params(` ${A} ,  ${B}  ,${C}`))).toEqual([A, B, C]);
  });

  it('drops non-uuid garbage entries', () => {
    expect(parseBackChain(params(`${A},not-a-uuid,${B}`))).toEqual([A, B]);
  });

  it('drops empty entries from extra commas', () => {
    expect(parseBackChain(params(`${A},,${B},`))).toEqual([A, B]);
  });

  it('de-duplicates adjacent repeats (defensive against hand-edited URLs)', () => {
    expect(parseBackChain(params(`${A},${A},${B}`))).toEqual([A, B]);
  });

  it('caps at MAX_PART_NAV_DEPTH', () => {
    const ids = [A, B, C, D, E, F, G]; // 7 unique entries
    const result = parseBackChain(params(ids.join(',')));
    expect(result).toHaveLength(MAX_PART_NAV_DEPTH);
  });

  it('returns [] for null/undefined searchParams', () => {
    expect(parseBackChain(null)).toEqual([]);
    expect(parseBackChain(undefined)).toEqual([]);
  });
});

describe('pushPartToChain', () => {
  it('appends currentPartId when navigating to a fresh target', () => {
    expect(pushPartToChain([], A, B)).toEqual([A]);
    expect(pushPartToChain([A], B, C)).toEqual([A, B]);
    expect(pushPartToChain([A, B], C, D)).toEqual([A, B, C]);
  });

  it('truncates to before the target on a self-link (target === current)', () => {
    expect(pushPartToChain([A, B], C, C)).toEqual([A, B]);
    expect(pushPartToChain([], A, A)).toEqual([]);
  });

  it('truncates the chain when the target appears in it (true cycle)', () => {
    // On D after walking A → B → C → D, click a link back to B.
    // Chain becomes [A] — proposed=[A,B,C,D], B at index 1 → slice(0, 1).
    expect(pushPartToChain([A, B, C], D, B)).toEqual([A]);
  });

  it('truncates to [] when target is the chain root', () => {
    expect(pushPartToChain([A, B, C], D, A)).toEqual([]);
  });

  it('caps at MAX_PART_NAV_DEPTH (drops oldest first) on fresh push', () => {
    // Build up MAX entries then push one more.
    const full = [A, B, C, D, E]; // length 5 (= MAX)
    const result = pushPartToChain(full, F, G);
    expect(result).toHaveLength(MAX_PART_NAV_DEPTH);
    // A drops off; B..F survive in order.
    expect(result).toEqual([B, C, D, E, F]);
  });

  it('does not exceed MAX even when proposed is exactly MAX+1', () => {
    const result = pushPartToChain([A, B, C, D], E, F);
    // proposed = [A,B,C,D,E] (length 5); F not in proposed, no cycle, length within cap.
    expect(result).toEqual([A, B, C, D, E]);
  });
});

describe('popPartFromChain', () => {
  it('returns null + [] for an empty chain', () => {
    expect(popPartFromChain([])).toEqual({ previous: null, remaining: [] });
  });

  it('pops the most recent entry', () => {
    expect(popPartFromChain([A, B, C])).toEqual({
      previous: C,
      remaining: [A, B],
    });
  });

  it('pops the only entry to leave an empty remaining', () => {
    expect(popPartFromChain([A])).toEqual({ previous: A, remaining: [] });
  });
});

describe('buildPartHref', () => {
  it('builds a base href without ?back= when chain is empty', () => {
    expect(
      buildPartHref({ companyId: 'co1', targetPartId: A, chain: [] }),
    ).toBe(`/dashboard/co1/parts/${A}`);
  });

  it('appends comma-joined ?back= when chain is non-empty', () => {
    expect(
      buildPartHref({ companyId: 'co1', targetPartId: A, chain: [B, C] }),
    ).toBe(`/dashboard/co1/parts/${A}?back=${B},${C}`);
  });
});
