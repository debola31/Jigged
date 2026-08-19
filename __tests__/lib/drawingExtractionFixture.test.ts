import { describe, expect, it } from 'vitest';
import { extractDrawingFields, isPlausible, type TextItem } from '@/lib/drawingText';
import fixture from '../fixtures/drawing-extraction-truth.json';

/**
 * The regression net for the extractor, built from customer #2's 31-drawing
 * package (`scripts/drawingFixtureBuild.ts`).
 *
 * The fixture stores TEXT ENTITIES, not drawings — the .dxf files belong to a
 * third party and stay out of the repo. What is asserted here is the matcher, which
 * is where every regression so far has actually lived.
 *
 * part_number and drawing_number come from the FILENAME, which encodes both
 * independently of the extractor, so these are genuine expectations. The
 * description assertions are change detectors: nothing outside the drawing
 * corroborates them.
 */

interface FixtureDrawing {
  file: string;
  items: TextItem[];
  expect: { part_number: string; drawing_number: string; description: string | null };
}
const drawings = fixture.drawings as FixtureDrawing[];
const run = (d: FixtureDrawing) =>
  extractDrawingFields(d.items, { filenameStem: d.file.replace(/\.dxf$/i, '') });

describe('drawing extraction — customer #2 regression fixture', () => {
  it('has all 31 drawings', () => {
    expect(drawings).toHaveLength(31);
  });

  it('reads the part number on every drawing', () => {
    const wrong = drawings
      .map((d) => ({ file: d.file, want: d.expect.part_number, got: run(d).part_number?.value }))
      .filter((r) => r.got !== r.want);
    expect(wrong).toEqual([]);
  });

  it('reads the drawing number on every drawing', () => {
    const wrong = drawings
      .map((d) => ({ file: d.file, want: d.expect.drawing_number, got: run(d).drawing_number?.value }))
      .filter((r) => r.got !== r.want);
    expect(wrong).toEqual([]);
  });

  it('reads a description on every drawing', () => {
    const wrong = drawings
      .map((d) => ({ file: d.file, want: d.expect.description, got: run(d).description?.value }))
      .filter((r) => r.got !== r.want);
    expect(wrong).toEqual([]);
  });

  /**
   * The regression that motivated the plausibility rule: `material` came back as
   * the literal caption "HEAT TREAT:" on all 31 drawings, because MATERIAL:'s own
   * cell is empty and HEAT TREAT: is the next caption inside the search window. It
   * read as a 100% extraction rate and was 100% noise.
   */
  it('never returns a caption as a value, in any role', () => {
    const captionish = drawings.flatMap((d) =>
      Object.entries(run(d))
        .filter(([, f]) => /:\s*$/.test(f.value))
        .map(([role, f]) => `${d.file} ${role}=${f.value}`),
    );
    expect(captionish).toEqual([]);
  });

  /**
   * "Index" heads a COLUMN of the (empty) revision-history table. Anchoring on it
   * reached past its own blank cell to the sheet border digits and produced a
   * revision on 22 of 31 drawings that carry none. Absent is the correct answer.
   */
  it('reports no revision — these drawings genuinely have none', () => {
    const invented = drawings
      .map((d) => ({ file: d.file, got: run(d).revision?.value }))
      .filter((r) => r.got);
    expect(invented).toEqual([]);
  });

  /** Every value must be a literal string from the drawing — never synthesised. */
  it('only ever returns strings that appear on the drawing', () => {
    const ghosts = drawings.flatMap((d) => {
      const bag = new Set(d.items.map((i) => i.text.trim()));
      return Object.entries(run(d))
        .filter(([, f]) => ![...bag].some((t) => t.includes(f.value)))
        .map(([role, f]) => `${d.file} ${role}=${f.value}`);
    });
    expect(ghosts).toEqual([]);
  });

  it('holds the plausibility line the fixture depends on', () => {
    expect(isPlausible('material', 'HEAT TREAT:')).toBe(false);
    expect(isPlausible('revision', '5')).toBe(false);
  });
});
