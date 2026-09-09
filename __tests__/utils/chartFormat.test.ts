import { describe, expect, it } from 'vitest';
import { formatCompact, formatKpi, formatLabel, formatValue, temporalKey } from '@/utils/chartFormat';

describe('formatLabel', () => {
  it('reads a first-of-month ISO date as a month', () => {
    expect(formatLabel('2026-03-01')).toBe('Mar 2026');
  });
  it('reads a mid-month ISO date as a day', () => {
    expect(formatLabel('2026-03-14T12:00:00')).toBe('Mar 14');
  });
  it('reads a UTC-midnight timestamp as the date it is, whatever the viewer\'s zone', () => {
    // DATE_TRUNC('month', ship_date) on a timestamptz column arrives as midnight UTC;
    // in local time that is the evening before, and June rendered as "May 2026".
    expect(formatLabel('2026-06-01T00:00:00+00:00')).toBe('Jun 2026');
    expect(formatLabel('2026-06-01T00:00:00Z')).toBe('Jun 2026');
    expect(formatLabel('2026-06-15T00:00:00+00:00')).toBe('Jun 15');
  });
  it('shortens a long nominal label', () => {
    expect(formatLabel('Hastings Machine Company')).toBe('Hastings Mac...');
  });
  it('trims the space a cut would leave dangling before the ellipsis', () => {
    expect(formatLabel('Helix Steel Fabrication')).toBe('Helix Steel...');
  });
  it('keeps the whole label when the caller lifts the cap', () => {
    // The PDF renderer measures real widths and fits labels itself.
    expect(formatLabel('Hastings Machine Company', Number.POSITIVE_INFINITY)).toBe('Hastings Machine Company');
  });
});

describe('temporalKey', () => {
  it('orders ISO dates, month names with and without a year, and quarters', () => {
    const keys = ['2026-01-15', '2026-03-01', 'Jul 2026', 'September 2026'].map(temporalKey) as number[];
    expect(keys.every((k) => k !== null)).toBe(true);
    expect([...keys].sort((a, b) => a - b)).toEqual(keys);
    expect(temporalKey('July')! < temporalKey('August')!).toBe(true);
    expect(temporalKey('Sept')! > temporalKey('Aug')!).toBe(true);
    expect(temporalKey('Q1 2026')! < temporalKey('Q3 2026')!).toBe(true);
    expect(temporalKey('Q3')! > temporalKey('Q2')!).toBe(true);
  });
  it('is null for a name that merely starts like a month', () => {
    // "Marlin", "Decatur" and "Junction" are customers, not March, December and June.
    for (const label of ['Marlin', 'Decatur', 'Junction Tool', 'Hastings Machine Company', 'A']) {
      expect(temporalKey(label)).toBeNull();
    }
  });
});

describe('formatCompact', () => {
  it('abbreviates thousands, millions and billions', () => {
    expect(formatCompact(7749)).toBe('7.7K');
    expect(formatCompact(1_200_000)).toBe('1.2M');
    expect(formatCompact(2_000_000_000)).toBe('2B');
  });
  it('leaves small numbers alone', () => {
    expect(formatCompact(950)).toBe('950');
  });
});

describe('formatValue', () => {
  it('prints whole dollars past $100 and cents below it', () => {
    expect(formatValue(13367, 'currency')).toBe('$13,367');
    expect(formatValue(99251.4, 'currency')).toBe('$99,251');
    expect(formatValue(12.5, 'currency')).toBe('$12.50');
  });
  it('rounds integers and drops a trailing .0 on percents', () => {
    expect(formatValue(83.6, 'integer')).toBe('84');
    expect(formatValue(71.0, 'percent')).toBe('71%');
    expect(formatValue(71.25, 'percent')).toBe('71.3%');
  });
  it('keeps plain numbers readable', () => {
    expect(formatValue(1182, 'plain')).toBe('1,182');
    expect(formatValue(3.14159, 'plain')).toBe('3.14');
  });
  it('never prints NaN', () => {
    expect(formatValue(Number.NaN, 'currency')).toBe('—');
  });
});

describe('formatKpi', () => {
  it('compacts a tile figure the way the reference band does', () => {
    expect(formatKpi(99251, 'currency')).toBe('$99.3k');
    expect(formatKpi(59002, 'currency')).toBe('$59k');
    expect(formatKpi(1_250_000, 'currency')).toBe('$1.3M');
  });
  it('leaves a small figure exact', () => {
    expect(formatKpi(1182, 'currency')).toBe('$1,182');
    expect(formatKpi(115, 'integer')).toBe('115');
    expect(formatKpi(71, 'percent')).toBe('71%');
  });
});
