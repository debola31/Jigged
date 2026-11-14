/**
 * The unit presets (plan §3.5 "Units", criterion L3): `hundred` and `thousand` join the count
 * category, so "per 100" pricing is one pick instead of a custom conversion on every part.
 *
 * The presets are mirrored by hand in `api/services/uom_normalizer.py` (the importer's canonical
 * set), and `lib/mcp/tools/imports.ts` treats the two as the same list. The last test reads that
 * file so the mirror cannot silently fall behind.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ALL_UNITS,
  UNITS_BY_CATEGORY,
  UNIT_CATEGORIES,
  convertUnits,
  getConversionFactor,
  getStandardUnitsForUnit,
  resolveUnitAlias,
} from '@/lib/unitPresets';

describe('count presets — hundred and thousand (L3)', () => {
  it('lists them after dozen in the count category', () => {
    expect(UNIT_CATEGORIES.count.units).toEqual(['pieces', 'each', 'dozen', 'hundred', 'thousand']);
    expect(UNIT_CATEGORIES.count.conversions).toMatchObject({ hundred: 100, thousand: 1000 });
  });

  it('converts them to each and pieces', () => {
    expect(getConversionFactor('hundred', 'each')).toBe(100);
    expect(getConversionFactor('thousand', 'pieces')).toBe(1000);
    expect(getConversionFactor('thousand', 'hundred')).toBe(10);
    expect(getConversionFactor('each', 'hundred')).toBe(0.01);
    expect(convertUnits(2.5, 'hundred', 'each')).toBe(250);
  });

  it('converts through an alias, so an `ea` part buys per hundred too', () => {
    expect(getConversionFactor('hundred', 'ea')).toBe(100);
  });

  it('offers them beside a counted part, as the Storage and receive menus do', () => {
    expect(getStandardUnitsForUnit('each')).toEqual(['pieces', 'dozen', 'hundred', 'thousand']);
    expect(getStandardUnitsForUnit('hundred')).toEqual(['pieces', 'each', 'dozen', 'thousand']);
  });

  it('never relates them to another kind of unit', () => {
    expect(getConversionFactor('hundred', 'inches')).toBeUndefined();
  });

  it('adds them to the flat and grouped lists the pickers read', () => {
    expect(ALL_UNITS).toContain('hundred');
    expect(ALL_UNITS).toContain('thousand');
    const count = UNITS_BY_CATEGORY.find((g) => g.category === 'Count');
    expect(count?.units).toEqual(['pieces', 'each', 'dozen', 'hundred', 'thousand']);
  });

  it('adds no alias — `M` already means meters, and `C` is not safe to guess', () => {
    expect(resolveUnitAlias('M')).toBe('M');
    expect(resolveUnitAlias('C')).toBe('C');
    expect(resolveUnitAlias('m')).toBe('meters');
  });
});

describe('the Python importer mirrors the canonical units (L3)', () => {
  it('lists exactly ALL_UNITS in CANONICAL_UNITS', () => {
    const source = readFileSync(join(process.cwd(), 'api/services/uom_normalizer.py'), 'utf8');
    const block = /CANONICAL_UNITS[^=]*=\s*\{([\s\S]*?)\n\}/.exec(source);
    expect(block, 'CANONICAL_UNITS block not found in uom_normalizer.py').not.toBeNull();
    // Comments are stripped first: they may quote unit names too.
    const body = (block?.[1] ?? '').replace(/#[^\n]*/g, '');
    const pythonUnits = [...body.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect([...pythonUnits].sort()).toEqual([...ALL_UNITS].sort());
  });
});
