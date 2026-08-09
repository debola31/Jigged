import { describe, it, expect, vi } from 'vitest';

import { drawQrCode, qrMatrix, QR_QUIET_MODULES } from '@/lib/qrVector';

/**
 * The vector renderer, checked against the matrix it claims to be drawing.
 *
 * The interesting property is not "it drew some rectangles" but **exactly the dark modules and
 * nothing else** — a run-merging bug that swallowed one light module would still produce a
 * plausible-looking picture and an undecodable code, and no snapshot would catch it. So these tests
 * rasterise the emitted rectangles back into a grid and compare it to the source matrix.
 */

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
  style?: string;
}

function capture(text: string, size: number, ec: 'M' | 'H' = 'M') {
  const rects: Rect[] = [];
  const fills: number[][] = [];
  const doc = {
    setFillColor: (r: number, g: number, b: number) => fills.push([r, g, b]),
    rect: (x: number, y: number, w: number, h: number, style?: string) =>
      rects.push({ x, y, w, h, style }),
  };
  const matrix = drawQrCode(doc, text, { x: 0, y: 0, size, errorCorrectionLevel: ec });
  return { rects, fills, matrix, doc };
}

/** Rebuild the module grid from the drawn rectangles, sampling each module's centre. */
function rasterise(rects: Rect[], modules: number, size: number): boolean[][] {
  const step = size / modules;
  const grid: boolean[][] = Array.from({ length: modules }, () =>
    Array.from({ length: modules }, () => false),
  );
  for (let row = 0; row < modules; row++) {
    for (let col = 0; col < modules; col++) {
      const cx = (col + 0.5) * step;
      const cy = (row + 0.5) * step;
      grid[row][col] = rects.some(
        (r) => cx >= r.x && cx <= r.x + r.w && cy >= r.y && cy <= r.y + r.h,
      );
    }
  }
  return grid;
}

const PAYLOAD = 'HTTPS://WWW.JIGGED.APP/T/CEIRCEJCEIZTGRCEKVKVKVKVKUTGMZTGMIRB3XOZTGKVKVKVKVKU';

describe('drawQrCode', () => {
  it('paints exactly the dark modules, and no light one', () => {
    const SIZE = 100;
    const { rects, matrix } = capture(PAYLOAD, SIZE);
    expect(matrix).not.toBeNull();

    const drawn = rasterise(rects, matrix!.size, SIZE);
    for (let row = 0; row < matrix!.size; row++) {
      for (let col = 0; col < matrix!.size; col++) {
        expect(drawn[row][col], `module ${row},${col}`).toBe(matrix!.isDark(row, col));
      }
    }
  });

  it('merges horizontal runs, so it emits fewer rects than dark modules', () => {
    const { rects, matrix } = capture(PAYLOAD, 100);
    let dark = 0;
    for (let row = 0; row < matrix!.size; row++) {
      for (let col = 0; col < matrix!.size; col++) if (matrix!.isDark(row, col)) dark++;
    }
    // A QR's data region is high-entropy, so runs average under two modules — the saving is real
    // but modest, and claiming more than this would be inventing a number.
    expect(rects.length).toBeLessThan(dark * 0.75);
    expect(rects.length).toBeGreaterThan(0);
  });

  it('overlaps adjacent runs so a PDF renderer cannot antialias a hairline between them', () => {
    const SIZE = 100;
    const { rects, matrix } = capture(PAYLOAD, SIZE);
    const modulePt = SIZE / matrix!.size;
    // Every rect is grown past its module boundary — that growth IS the seam fix.
    for (const r of rects) {
      expect(r.h).toBeGreaterThan(modulePt);
      expect(r.w % modulePt).toBeGreaterThan(0);
    }
  });

  it('fills black only, and never strokes', () => {
    const { rects, fills } = capture(PAYLOAD, 100);
    expect(fills.every(([r, g, b]) => r === 0 && g === 0 && b === 0)).toBe(true);
    expect(rects.every((r) => r.style === 'F')).toBe(true);
  });

  it('draws no quiet zone — the page around it supplies that', () => {
    const SIZE = 100;
    const { rects, matrix } = capture(PAYLOAD, SIZE);
    const modulePt = SIZE / matrix!.size;
    // The finder pattern's outer ring is dark at module 0, so ink starts at the very edge of the
    // box. Anything inset would mean a margin had been baked in.
    expect(Math.min(...rects.map((r) => r.x))).toBe(0);
    expect(Math.min(...rects.map((r) => r.y))).toBe(0);
    expect(Math.max(...rects.map((r) => r.x + r.w))).toBeLessThanOrEqual(SIZE + modulePt);
  });

  it('scales to the box it is given', () => {
    const small = capture(PAYLOAD, 50);
    const large = capture(PAYLOAD, 200);
    expect(small.matrix!.size).toBe(large.matrix!.size);
    expect(Math.max(...large.rects.map((r) => r.x + r.w))).toBeGreaterThan(
      Math.max(...small.rects.map((r) => r.x + r.w)) * 3,
    );
  });

  it('draws nothing and returns null when the payload cannot be encoded', () => {
    const rect = vi.fn();
    const doc = { setFillColor: vi.fn(), rect };
    // Far past version 40's capacity at H.
    const result = drawQrCode(doc, 'x'.repeat(5000), {
      x: 0,
      y: 0,
      size: 50,
      errorCorrectionLevel: 'H',
    });
    expect(result).toBeNull();
    expect(rect).not.toHaveBeenCalled();
  });
});

describe('qrMatrix', () => {
  it('reports the version and side length the ceiling guard asserts on', () => {
    const m = qrMatrix(PAYLOAD, 'M');
    expect(m).toEqual(expect.objectContaining({ version: 4, size: 33 }));
  });

  it('states the quiet zone the QR spec requires, so callers compute it rather than guess', () => {
    expect(QR_QUIET_MODULES).toBe(4);
  });
});
