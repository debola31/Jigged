import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The Avery 5163 label sheet.
 *
 * Geometry is asserted against the *stock*, not against the code — a label that drifts a few points
 * still looks fine in a PDF viewer and prints straddling the die-cut, which is the failure this
 * whole sheet exists to avoid and the one nobody notices until a shop has wasted a pack of labels.
 */

const pdf = {
  setFont: vi.fn(),
  setFontSize: vi.fn(),
  setTextColor: vi.fn(),
  setFillColor: vi.fn(),
  text: vi.fn(),
  rect: vi.fn(),
  addImage: vi.fn(),
  addPage: vi.fn(),
  save: vi.fn(),
  splitTextToSize: vi.fn((s: string) => [s]),
  internal: { pageSize: { getWidth: () => 612, getHeight: () => 792 } },
};
vi.mock('jspdf', () => ({ jsPDF: function MockJsPdf() { return pdf; } }));

import {
  generateLocationLabelSheet,
  labelOrigin,
  splitLabelPath,
  LABEL_CONTENT_INSET,
  LABEL_QR_SIZE,
  LABEL_QR_TEXT_GAP,
  LABEL_QR_EC,
} from '@/utils/locationLabelPdf';

const label = (id: string, path: string[]) => ({ id, path });
const CO = '71000000-0000-0000-0000-000000000002';
const uuid = (n: number) => `0000000${n}-0000-0000-0000-00000000000${n}`;

beforeEach(() => {
  vi.clearAllMocks();
  pdf.splitTextToSize.mockImplementation((s: string) => [s]);
});

describe('Avery 5163 geometry', () => {
  it('places the first label at the stock’s own top-left margins', () => {
    // 0.15625" and 0.5", in points. Avery's numbers, not ours.
    expect(labelOrigin(0)).toEqual({ x: 11.25, y: 36 });
  });

  it('puts the second column past a 0.1875" gutter', () => {
    expect(labelOrigin(1)).toEqual({ x: 11.25 + 288 + 13.5, y: 36 });
  });

  it('stacks rows with no vertical gutter — 5163 labels touch', () => {
    expect(labelOrigin(2).y - labelOrigin(0).y).toBe(144);
  });

  it('ends the tenth label exactly at the bottom margin', () => {
    // 36pt top + 5 × 144pt = 756, leaving the same 0.5" at the foot. If this drifts, the sheet
    // walks down the page and the last row prints off the labels.
    expect(labelOrigin(9).y + 144).toBe(792 - 36);
  });

  it('leaves the QR its quiet zone on both sides that matter', () => {
    // Belt-and-braces against the computed assertion in qrVersionCeiling.test.ts: these two are the
    // only clear space a sticker on a dark shelf has.
    expect(LABEL_CONTENT_INSET).toBeGreaterThanOrEqual(14);
    expect(LABEL_QR_TEXT_GAP).toBeGreaterThanOrEqual(14);
  });

  it('sizes the QR to the label’s full content height', () => {
    expect(LABEL_QR_SIZE).toBe(144 - LABEL_CONTENT_INSET * 2);
  });

  it('prints at error correction H, because a shelf label lives for years', () => {
    expect(LABEL_QR_EC).toBe('H');
  });
});

describe('splitLabelPath', () => {
  it('makes the leaf the primary line and the ancestry the secondary one', () => {
    expect(splitLabelPath(['Cabinet 1', 'Row 3', 'Left'])).toEqual({
      name: 'Left',
      parents: 'Cabinet 1  ›  Row 3',
    });
  });

  it('gives a root-level place no parent line at all', () => {
    expect(splitLabelPath(['Yard'])).toEqual({ name: 'Yard', parents: '' });
  });

  it('surfaces an empty path rather than printing a blank sticker', () => {
    expect(splitLabelPath([])).toEqual({ name: '(unnamed)', parents: '' });
    expect(splitLabelPath(['  '])).toEqual({ name: '(unnamed)', parents: '' });
  });
});

describe('generateLocationLabelSheet', () => {
  it('draws the QR as vector modules, never as an embedded image', async () => {
    await generateLocationLabelSheet({ companyId: CO, labels: [label(uuid(1), ['Bin 1'])] });
    // The 320px PNG was ~239dpi on a 34mm label. If addImage ever comes back, so has that.
    expect(pdf.addImage).not.toHaveBeenCalled();
    expect(pdf.rect).toHaveBeenCalled();
    expect(pdf.rect.mock.calls.every((c) => c[4] === 'F')).toBe(true);
  });

  it('prints the name and the path beneath it', async () => {
    await generateLocationLabelSheet({
      companyId: CO,
      labels: [label(uuid(1), ['Cabinet 1', 'Row 3', 'Left'])],
    });
    const drawn = pdf.text.mock.calls.map((c) => c[0]);
    expect(drawn).toContain('Left');
    expect(drawn).toContain('Cabinet 1  ›  Row 3');
  });

  it('prints the place and nothing else — no heading, no jigged.app, no branding', async () => {
    await generateLocationLabelSheet({ companyId: CO, labels: [label(uuid(1), ['Bin 1'])] });
    // A company-name heading lands across label 1 on die-cut stock. A `jigged.app` micro-line was
    // drawn here briefly and removed: a sticker on a shop's shelf is the shop's, and attribution
    // belongs on a document someone reads, not on a bin.
    expect(pdf.text.mock.calls.map((c) => c[0])).toEqual(['Bin 1']);
  });

  it('paginates at ten labels per page', async () => {
    const labels = Array.from({ length: 11 }, (_, i) => label(uuid(i % 9), [`Bin ${i}`]));
    await generateLocationLabelSheet({ companyId: CO, labels });
    expect(pdf.addPage).toHaveBeenCalledTimes(1);
  });

  it('elides a very deep path rather than overrunning the label', async () => {
    // Three wrapped lines of ancestry; only two survive, and the survivor is marked as truncated.
    pdf.splitTextToSize.mockImplementation((s: string) =>
      s.includes('›') ? ['one', 'two', 'three'] : [s],
    );
    await generateLocationLabelSheet({
      companyId: CO,
      labels: [label(uuid(1), ['A', 'B', 'C', 'D', 'E'])],
    });
    const drawn = pdf.text.mock.calls.map((c) => c[0]);
    expect(drawn).toEqual(['E', 'one', 'two…']);
  });

  it('keeps every label on the sheet when one code cannot be encoded', async () => {
    // A malformed id throws inside the URL builder; the sheet must still print the rest.
    await expect(
      generateLocationLabelSheet({
        companyId: CO,
        labels: [label(uuid(1), ['Good'])],
      }),
    ).resolves.toBeDefined();
  });
});
