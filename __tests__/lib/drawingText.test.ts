import { describe, it, expect } from 'vitest';
import { extractDrawingFields, isPlausible, type TextItem } from '@/lib/drawingText';

const t = (
  text: string,
  x: number,
  y: number,
  height = 2.5,
  extra: Partial<TextItem> = {},
): TextItem => ({ text, x, y, height, layer: '0', ...extra });

/**
 * Customer #2's title block, to scale. Caption sits directly above its value at
 * the same text height — the layout the matcher was originally tuned on.
 */
const customerBlock = (scaleFactor = 1): TextItem[] => {
  const s = scaleFactor;
  return [
    t('Art-Nr.', 323 * s, 20 * s, 1.5 * s),
    t('1003308', 336 * s, 19 * s, 2.5 * s),
    t('Z-Nr.', 323 * s, 27 * s, 1.5 * s),
    t('314-092-56133-10', 336 * s, 26 * s, 2.5 * s),
    t('Description', 323 * s, 47 * s, 1.5 * s),
    t('spacer plate', 323 * s, 43 * s, 2.5 * s),
    t('Werkstoff/Material', 323 * s, 73 * s, 1.5 * s),
    t('ST', 323 * s, 70 * s, 2.5 * s),
  ];
};

describe('drawingText', () => {
  describe('extractDrawingFields', () => {
    it('reads a title block laid out like the pilot customer’s', () => {
      const f = extractDrawingFields(customerBlock());
      expect(f.part_number?.value).toBe('1003308');
      expect(f.drawing_number?.value).toBe('314-092-56133-10');
      expect(f.description?.value).toBe('spacer plate');
      expect(f.material?.value).toBe('ST');
    });

    it('REGRESSION: a 14x sheet extracts identically to a 1x sheet', () => {
      // A title block is a fixed physical size no matter how big the paper is —
      // ISO 7200 fixes it at 180mm so it fits A4. Sizing the search window as a
      // fraction of sheet extents made it 14x too wide on the package's largest
      // drawing and swept in unrelated text. The label's own height is the only
      // correct local scale. This took the pilot from 29/31 to 31/31.
      const small = extractDrawingFields(customerBlock(1));
      const huge = extractDrawingFields(customerBlock(14));
      expect(huge.part_number?.value).toBe(small.part_number?.value);
      expect(huge.drawing_number?.value).toBe(small.drawing_number?.value);
      expect(huge.description?.value).toBe(small.description?.value);
    });

    it('REGRESSION: an empty field does not inherit its neighbour’s value', () => {
      // On the real drawings the Scale box is blank, and its nearest text is the
      // material code sitting just above it. Claim-once assignment is what stops
      // Scale from stealing "ST"; without it the extractor reported a confident
      // wrong answer with no error.
      const items = [
        t('Werkstoff/Material', 323, 73, 1.5),
        t('ST', 323, 70, 2.5),
        t('Maßstab/Scale', 323, 63, 1.5), // its own cell is empty
      ];
      const f = extractDrawingFields(items);
      expect(f.material?.value).toBe('ST');
      expect(f.scale).toBeUndefined();
    });

    it('REGRESSION: a border grid number is never returned as a weight', () => {
      // The actual failure on an untuned SolidWorks drawing: the matcher missed
      // the only real value on the sheet and returned weight = "3", scavenged
      // from the sheet's border grid. Plausibility turns that class of failure
      // from wrong into empty, which is all the review screen needs.
      const items = [t('WEIGHT:', 1055, 12, 1.5), t('3', 1074, 12, 4.0)];
      expect(extractDrawingFields(items).weight).toBeUndefined();
    });

    it('prefers the authoritative half of a duplicated caption', () => {
      // "Item No." is printed twice in this block — once under "A-Nr." (an order
      // number) and once under "Art-Nr." (the article number). Only the German
      // caption anchors, so the order number cannot win.
      const items = [
        t('A-Nr.', 323, 40, 1.5),
        t('Item No.', 323, 37, 1.5),
        t('99999', 336, 36, 2.5),
        t('Art-Nr.', 323, 20, 1.5),
        t('Item No.', 323, 17, 1.5),
        t('1003308', 336, 19, 2.5),
      ];
      expect(extractDrawingFields(items).part_number?.value).toBe('1003308');
    });

    it('an unknown caption yields nothing rather than something wrong', () => {
      const items = [t('Kenmerk', 10, 10, 1.5), t('ONBEKEND', 20, 9, 2.5)];
      expect(extractDrawingFields(items)).toEqual({});
    });

    it('splits a caption fused to its value in one string', () => {
      // The SolidWorks default block emits these as single text entities, so no
      // geometry could ever pair them.
      const f = extractDrawingFields([t('SCALE:20:1', 1099, 12, 1.5)]);
      expect(f.scale?.value).toBe('20:1');
    });

    it('reaches a large value far below a small caption', () => {
      // "Small caption, big value in a big cell" is a real layout: in the
      // SolidWorks default block TITLE: is 1.5 tall and its value is 6.3,
      // sixteen caption-heights below. Reaching further is gated on the
      // candidate being visibly larger, so it is not generic widening.
      const f = extractDrawingFields([
        t('TITLE:', 1099, 48, 1.5),
        t('HDI-45 Drawing', 1134, 24, 6.3),
      ]);
      expect(f.description?.value).toBe('HDI-45 Drawing');
    });

    it('uses attribute tags directly, ignoring geometry', () => {
      const items = [
        t('314-092-56133-10', 0, 0, 2, { kind: 'ATTRIB', tag: 'DRAWING_NUMBER' }),
        t('6061-T6', 0, 0, 2, { kind: 'ATTRIB', tag: 'GEN-TITLE-MAT1' }),
      ];
      const f = extractDrawingFields(items);
      expect(f.drawing_number).toEqual({
        value: '314-092-56133-10', source: 'attribute', caption: 'DRAWING_NUMBER',
      });
      expect(f.material?.value).toBe('6061-T6');
    });

    it('ignores meaningless AUTOATTR tags and falls through to geometry', () => {
      const items = [
        t('Plain Carbon Steel', 0, 0, 2, { kind: 'ATTRIB', tag: 'AUTOATTR0' }),
        ...customerBlock(),
      ];
      const f = extractDrawingFields(items);
      // AUTOATTR carries no meaning, so material still comes from the caption.
      expect(f.material?.value).toBe('ST');
      expect(f.material?.source).toBe('geometry');
    });

    it('never treats a caption as another caption’s value', () => {
      const f = extractDrawingFields([t('MATERIAL:', 10, 20, 1.5), t('FINISH:', 10, 17, 1.5)]);
      expect(f.material).toBeUndefined();
      expect(f.finish).toBeUndefined();
    });
  });

  describe('international and multi-segment attributes', () => {
    const at = (tag: string, text: string): TextItem => ({
      text, x: 0, y: 0, height: 2, kind: 'ATTRIB', tag,
    });

    it('joins a field split across numbered segments of one tag', () => {
      // 部品番号_001 + 部品番号_002 is ONE part name split across two cells. Taking
      // only the last segment reported the part number as "(6812ZZ+XM540)".
      const f = extractDrawingFields([
        at('部品番号_001', 'アルミフレーム'),
        at('部品番号_002', '(6812ZZ+XM540)'),
      ]);
      expect(f.part_number?.value).toBe('アルミフレーム(6812ZZ+XM540)');
    });

    it('puts the space back for a title split over lines', () => {
      const f = extractDrawingFields([
        at('TITLE_1', 'ROBOT'),
        at('TITLE_2', 'PEDESTAL'),
      ]);
      expect(f.description?.value).toBe('ROBOT PEDESTAL');
    });

    it('accepts a pure-CJK part number', () => {
      expect(isPlausible('part_number', 'アルミフレーム')).toBe(true);
      expect(isPlausible('drawing_number', '図番')).toBe(true);
    });

    it('routes a fused caption to the role the INK names, not the tag', () => {
      // The タイトル (title) attribute holds "図番：RT-CRANE-X7-8-2" — a drawing
      // number. Filing that as a description is both wrong and unusable.
      const f = extractDrawingFields([at('タイトル_001', '図番：RT-CRANE-X7-8-2')]);
      expect(f.drawing_number?.value).toBe('RT-CRANE-X7-8-2');
      expect(f.description).toBeUndefined();
    });

    it('does not double-count an ATTDEF and its ATTRIB carrying the same text', () => {
      const f = extractDrawingFields([
        { text: 'CRANE-X7_HandFrame', x: 0, y: 0, height: 2, kind: 'ATTDEF', tag: '部品番号_001' },
        { text: 'CRANE-X7_HandFrame', x: 0, y: 0, height: 2, kind: 'ATTRIB', tag: '部品番号_001' },
      ]);
      expect(f.part_number?.value).toBe('CRANE-X7_HandFrame');
    });
  });

  describe('isPlausible', () => {
    it('a weight needs a decimal or a unit, not a bare digit', () => {
      expect(isPlausible('weight', '3')).toBe(false);
      expect(isPlausible('weight', '0.67')).toBe(true);
      expect(isPlausible('weight', '12 kg')).toBe(true);
    });

    it('rejects the revision letters ASME Y14.35 skips', () => {
      // A..Y skipping I, O, Q, S, X, Z — so a lone "O" is a misread 0.
      expect(isPlausible('revision', 'O')).toBe(false);
      expect(isPlausible('revision', 'I')).toBe(false);
      expect(isPlausible('revision', 'B')).toBe(true);
      expect(isPlausible('revision', 'AA')).toBe(true);
    });

    it('a material must carry a letter', () => {
      expect(isPlausible('material', '6061-T6')).toBe(true);
      expect(isPlausible('material', '1803.2')).toBe(false);
    });

    it('rejects a single character in every role', () => {
      expect(isPlausible('description', 'F')).toBe(false);
      expect(isPlausible('part_number', '7')).toBe(false);
    });

    // Measured on the customer package: `material` came back as the literal
    // string "HEAT TREAT:" on 31 of 31 drawings, because MATERIAL:'s own cell is
    // empty and HEAT TREAT: is the next caption inside the search window. A
    // caption returned as a value looks like a successful extraction and is not.
    it('never returns a caption as a value', () => {
      expect(isPlausible('material', 'HEAT TREAT:')).toBe(false);
      expect(isPlausible('material', 'MATERIAL:')).toBe(false);
      expect(isPlausible('finish', 'FINISH:')).toBe(false);
      expect(isPlausible('description', 'NOTES:')).toBe(false);
      // Colon-less captions are caught by the dictionary instead.
      expect(isPlausible('material', 'Werkstoff')).toBe(false);
      expect(isPlausible('weight', 'Gewicht (kg)')).toBe(false);
      // ...but a value that merely contains a colon is still fine.
      expect(isPlausible('scale', '1:1')).toBe(true);
    });

    it('is not fooled by Object.prototype members', () => {
      // A bare `CAPTIONS[v]` index returns a function for these.
      expect(isPlausible('material', 'constructor')).toBe(true);
      expect(isPlausible('description', 'toString')).toBe(true);
    });

    it('rejects weight fragments scavenged from dimension notes', () => {
      // "1." (11 drawings) and "5.0" (lifted out of the chamfer note
      // `4X 5.0 X 45°`) both passed the old "a digit and a dot" rule.
      expect(isPlausible('weight', '1.')).toBe(false);
      expect(isPlausible('weight', '45°')).toBe(false);
      // The fused phrasing these drawings actually use must still pass.
      expect(isPlausible('weight', 'APPROX. WEIGHT = 3.26 KG')).toBe(true);
      expect(isPlausible('weight', '0.52 kg')).toBe(true);
      expect(isPlausible('weight', '10.0')).toBe(true);
    });
  });
});
