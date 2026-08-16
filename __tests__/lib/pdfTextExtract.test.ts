import { describe, it, expect } from 'vitest';
import { jsPDF } from 'jspdf';
import { extractPdfText } from '@/lib/pdfTextExtract';

/**
 * A real PDF, built at runtime. Fixtures would be opaque binaries nobody can
 * diff; here the expected text, position and font size are on the page above
 * the assertion.
 */
const PAGE_HEIGHT = 792; // US Letter, in points

const pdf = (build: (doc: jsPDF) => void): Uint8Array => {
  const doc = new jsPDF({ unit: 'pt', format: 'letter' });
  build(doc);
  return new Uint8Array(doc.output('arraybuffer'));
};

/** jsPDF measures y from the top of the sheet; PDF text space from the bottom. */
const fromTop = (y: number): number => PAGE_HEIGHT - y;

describe('extractPdfText', () => {
  it('recovers text with its position and height', async () => {
    const bytes = pdf((doc) => {
      doc.setFontSize(14);
      doc.text('SPACER PLATE', 100, 200);
    });

    const { items, hasTextLayer } = await extractPdfText(bytes);

    expect(hasTextLayer).toBe(true);
    expect(items).toHaveLength(1);
    expect(items[0].text).toBe('SPACER PLATE');
    expect(items[0].x).toBeCloseTo(100, 1);
    expect(items[0].y).toBeCloseTo(fromTop(200), 1);
    // Load-bearing: height is the matcher's only local scale, so it must be the
    // font size in page units, not some device-space number.
    expect(items[0].height).toBeCloseTo(14, 1);
  });

  it('reads every page, not just the first', async () => {
    // A cut list or revision table routinely lives on sheet 2.
    const bytes = pdf((doc) => {
      doc.text('SHEET ONE', 72, 72);
      doc.addPage();
      doc.text('SHEET TWO', 72, 72);
    });

    const { items } = await extractPdfText(bytes);

    expect(items.map((i) => i.text)).toEqual(['SHEET ONE', 'SHEET TWO']);
  });

  it('skips empty and whitespace-only runs', async () => {
    const bytes = pdf((doc) => {
      doc.text('', 72, 100);
      doc.text('   ', 72, 130);
      doc.text('REV B', 72, 160);
    });

    const { items } = await extractPdfText(bytes);

    expect(items.map((i) => i.text)).toEqual(['REV B']);
  });

  it('reports no text layer when the drawing was exported as outlines', async () => {
    // 25 of 96 real drawings looked like this — geometry only, no text
    // operators. The caller needs to say "we cannot read this", which it can
    // only do if this is distinguishable from a drawing with an empty block.
    const bytes = pdf((doc) => {
      doc.rect(100, 100, 200, 150);
    });

    expect(await extractPdfText(bytes)).toEqual({ items: [], hasTextLayer: false });
  });

  it('returns an empty result for a corrupt file instead of throwing', async () => {
    const garbage = new Uint8Array([0x25, 0x21, 0x0a, 0xde, 0xad, 0xbe, 0xef]);

    await expect(extractPdfText(garbage)).resolves.toEqual({
      items: [],
      hasTextLayer: false,
    });
  });

  it('leaves the caller its bytes — pdf.js transfers the buffer it is handed', async () => {
    // Without the defensive copy this array is detached by the read, and the
    // upload of the same file that follows silently sends nothing.
    const bytes = pdf((doc) => doc.text('MATERIAL 6061-T6', 72, 72));
    const before = bytes.byteLength;

    await extractPdfText(bytes);

    expect(bytes.byteLength).toBe(before);
    expect(bytes[0]).toBe('%'.charCodeAt(0));
  });
});
