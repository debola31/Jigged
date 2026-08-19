import { describe, it, expect } from 'vitest';
import { summariseFiles } from '@/lib/drawingFileSummary';
import type { DrawingFileKind } from '@/types/drawingImport';

const part = (...kinds: DrawingFileKind[]) => ({ kinds });

describe('summariseFiles', () => {
  it('says "each" only when it is true of every part', () => {
    const s = summariseFiles([part('dxf', 'pdf', 'step'), part('pdf', 'dxf', 'step')], 6);
    expect(s.headline).toBe('2 parts from 6 files.');
    expect(s.majority).toBe('Each has DXF, PDF and STEP.');
    expect(s.exceptions).toEqual([]);
  });

  it('counts the majority instead of claiming "each" when one differs', () => {
    // 29 of 31 is the real package. Saying "each" there is the kind of small lie
    // that makes someone stop trusting the other numbers on the page.
    const s = summariseFiles(
      [...Array(29).fill(part('dxf', 'pdf', 'step')), part('pdf'), part('pdf')],
      89,
    );
    expect(s.majority).toBe('29 have DXF, PDF and STEP.');
    expect(s.exceptions).toEqual(['2 have PDF']);
  });

  it('names every exception, most common first', () => {
    const s = summariseFiles(
      [part('dxf', 'pdf'), part('dxf', 'pdf'), part('pdf'), part('pdf'), part('pdf'), part('step')],
      9,
    );
    // PDF-only is the biggest group here, so it leads.
    expect(s.majority).toBe('3 have PDF.');
    expect(s.exceptions).toEqual(['2 have DXF and PDF', '1 has STEP']);
  });

  it('ignores file kinds a shop never asked about', () => {
    const s = summariseFiles([part('dxf', 'pdf', 'other')], 3);
    expect(s.majority).toBe('Each has DXF and PDF.');
  });

  it('reads as a sentence for a single part and a single file', () => {
    const s = summariseFiles([part('pdf')], 1);
    expect(s.headline).toBe('1 part from 1 file.');
    expect(s.majority).toBe('Each has PDF.');
  });

  it('says something sane for a part with nothing readable', () => {
    const s = summariseFiles([part('other')], 1);
    expect(s.majority).toBe('Each has no readable files.');
  });

  it('returns no claims for an empty package', () => {
    expect(summariseFiles([], 0)).toEqual({
      headline: '0 parts from 0 files.',
      majority: null,
      exceptions: [],
    });
  });
});
