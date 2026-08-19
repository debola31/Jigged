import { describe, expect, it } from 'vitest';
import { extractCutList } from '@/lib/drawingCutList';
import type { TextItem } from '@/lib/drawingText';
import fixture from '../fixtures/drawing-extraction-truth.json';

/**
 * A weldment drawing's table is a BILL OF MATERIALS — in CAD it is called a "cut
 * list", but in steel-fab software that phrase means the nesting output instead,
 * so any user-facing label says bill of materials.
 *
 * Two of customer #2's 31 drawings carry one. Both are asserted against the
 * fixture, which stores the real text entities from those sheets.
 */

interface FixtureDrawing { file: string; items: TextItem[] }
const drawings = fixture.drawings as FixtureDrawing[];
const byPrefix = (p: string) => drawings.find((d) => d.file.startsWith(p))!;

/** Lays out a table: header row then body rows, on a regular pitch. */
function table(header: string[], rows: string[][], xs: number[]): TextItem[] {
  const items: TextItem[] = [];
  header.forEach((t, i) => items.push({ text: t, x: xs[i], y: 0, height: 2 }));
  rows.forEach((r, ri) =>
    r.forEach((t, i) => {
      if (t) items.push({ text: t, x: xs[i], y: -10 * (ri + 1), height: 2 });
    }),
  );
  return items;
}

describe('extractCutList', () => {
  it('returns null when the drawing has no table', () => {
    expect(extractCutList([{ text: 'PART NAME', x: 0, y: 0, height: 2 }])).toBeNull();
  });

  it('needs at least three known headings, so a title block is not a table', () => {
    // "Description" alone appears in this template's title block.
    const items: TextItem[] = [
      { text: 'Description', x: 0, y: 0, height: 2 },
      { text: 'base frame', x: 20, y: 0, height: 2 },
    ];
    expect(extractCutList(items)).toBeNull();
  });

  it('reads a headed table into rows', () => {
    const cl = extractCutList(
      table(
        ['ITEM NO.', 'QTY.', 'DESCRIPTION', 'LENGTH', 'MATERIAL'],
        [
          ['1', '2', '2" x 2" TUBE', '450.0', 'A500'],
          ['2', '1', 'END CAP', '', ''],
        ],
        [0, 10, 20, 40, 55],
      ),
    );
    expect(cl?.rows).toHaveLength(2);
    expect(cl?.rows[0]).toMatchObject({
      item: '1', quantity: '2', description: '2" x 2" TUBE', length: '450.0', madePart: false,
    });
    // No cut length -> it is built from its own drawing, not cut from stock.
    expect(cl?.rows[1].madePart).toBe(true);
  });

  it('honours an explicit USE DRAWING length', () => {
    const cl = extractCutList(
      table(
        ['ITEM', 'QTY', 'DESCRIPTION', 'LENGTH'],
        [['1', '1', 'WELD BRACKET', 'USE DRAWING']],
        [0, 10, 20, 40],
      ),
    );
    expect(cl?.rows[0].madePart).toBe(true);
  });

  describe('against the real customer drawings', () => {
    it('reads 1006941 — three rows, two of them made parts', () => {
      const cl = extractCutList(byPrefix('1006941').items);
      expect(cl?.rows.map((r) => [r.item, r.quantity, r.description])).toEqual([
        ['1', '1', '6" x 6" x 1/4" WALL'],
        ['2', '1', 'ROBOT MOUNTING PLATE'],
        ['3', '1', 'BASE PLATE'],
      ]);
      expect(cl?.rows.filter((r) => r.madePart)).toHaveLength(2);
    });

    /**
     * The length cell wraps: "USE" is one text entity and "DRAWING" is another,
     * so the phrase never appears contiguously in the file. Grouping rows by the
     * gaps between all y values measured LINE spacing rather than ROW spacing,
     * shattered every row into three, and dropped this entirely.
     */
    it('recovers the wrapped "USE DRAWING" length on every made-part row', () => {
      for (const p of ['1006941', '1006942']) {
        const made = extractCutList(byPrefix(p).items)!.rows.filter((r) => r.madePart);
        expect(made.length).toBeGreaterThan(0);
        for (const r of made) expect(r.length).toBe('USE DRAWING');
      }
    });

    /**
     * The general-tolerance block sits at almost exactly the height of the first
     * BOM row and overlaps its columns, so its "0" was being read as a quantity
     * and its "6.3" surface-finish symbol concatenated into a description.
     */
    it('keeps the sheet notes out of the rows', () => {
      for (const p of ['1006941', '1006942']) {
        for (const r of extractCutList(byPrefix(p).items)!.rows) {
          expect(r.quantity).toMatch(/^\d+$/);
          expect(r.description).toMatch(/[A-Za-z]/);
          expect(r.description).not.toMatch(/6\.3|=/);
        }
      }
    });

    it('reads 1006942 — nine rows, numbered 1..9 with no notes leaking in', () => {
      const cl = extractCutList(byPrefix('1006942').items);
      expect(cl?.rows).toHaveLength(9);
      expect(cl?.rows.map((r) => r.item)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9']);
      // The general tolerance block and the numbered general notes sit at the same
      // y values as the table and must not appear as rows.
      expect(cl?.rows.map((r) => r.description)).not.toContain('=');
      expect(cl?.rows[5]).toMatchObject({
        quantity: '1', description: '4" x 4" x 1/4" WALL', length: '803.2',
      });
    });

    it('finds a table on exactly those two of the 31 drawings', () => {
      const withTable = drawings.filter((d) => extractCutList(d.items));
      expect(withTable.map((d) => d.file.slice(0, 7)).sort()).toEqual(['1006941', '1006942']);
    });
  });
});
