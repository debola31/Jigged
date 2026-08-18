import { describe, it, expect } from 'vitest';
import { titleBlockRegion, type TextItem } from '@/lib/drawingText';

/**
 * The input the published 90%/89% was measured on.
 *
 * This is not a cosmetic filter. The shipped client originally sent every string
 * on the sheet, which is a DIFFERENT experiment than the one that produced those
 * numbers — and on the corpus's worst drawing it is 1,396 strings, enough to be
 * refused by the route's own cap.
 */

const at = (text: string, x: number, y: number): TextItem => ({ text, x, y, height: 2 });

describe('titleBlockRegion', () => {
  it('keeps the bottom-right corner and drops the drawing area', () => {
    const items = [
      // Dimensions and notes spread across the sheet.
      ...Array.from({ length: 20 }, (_, i) => at(`DIM-${i}`, i * 5, 500 + i)),
      // The title block, bottom right.
      at('MATERIAL:', 900, 10),
      at('AL', 950, 10),
      at('TITLE:', 900, 30),
      at('SPACER', 950, 30),
    ];

    const region = titleBlockRegion(items).map((i) => i.text);

    expect(region).toContain('AL');
    expect(region).toContain('SPACER');
    expect(region.some((t) => t.startsWith('DIM-'))).toBe(false);
  });

  /**
   * Some templates run their strip across the full width. Handing the model an
   * empty list is worse than handing it a noisy one.
   */
  it('falls back to everything when the corner is nearly empty', () => {
    const items = [at('CARGO REAR TUBE', 10, 10), at('SCALE 1:5', 60, 10)];
    expect(titleBlockRegion(items)).toHaveLength(2);
  });

  it('caps the count, keeping the strings nearest the title block', () => {
    // The region is relative to the items' own bounding box, so the sheet needs a
    // far corner to establish one. 300 strings then sit inside the title block.
    const items = [
      at('FAR-CORNER', 0, 1000),
      ...Array.from({ length: 300 }, (_, i) => at(`S${i}`, 960 + (i % 40), i)),
    ];

    const region = titleBlockRegion(items, 200);

    expect(region).toHaveLength(200);
    // Kept from the bottom up — the title block sits at the bottom of the sheet,
    // so the 100 dropped are the ones furthest from it.
    expect(Math.max(...region.map((i) => i.y))).toBeLessThan(300);
  });

  it('returns nothing for nothing', () => {
    expect(titleBlockRegion([])).toEqual([]);
  });
});
