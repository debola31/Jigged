import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  elapsedMs,
  formatClockTime,
  formatDuration,
  formatStopwatch,
  intervalMs,
  isoToTimeInput,
  nudgeIso,
  timeInputToIso,
} from '@/lib/duration';

/** Build a local-time ISO instant, so the day-rolling tests do not depend on the runner's zone. */
function local(y: number, m: number, d: number, hh: number, mm: number): string {
  return new Date(y, m - 1, d, hh, mm, 0, 0).toISOString();
}

afterEach(() => {
  vi.useRealTimers();
});

describe('formatDuration', () => {
  it('renders compact units, never the word minutes', () => {
    // Not cosmetic: the operator Me tab asserts /minutes/i never appears on it,
    // and this formatter is what renders every duration there.
    expect(formatDuration(107 * 60_000)).toBe('1h 47m');
    expect(formatDuration(47 * 60_000)).toBe('47m');
    expect(formatDuration(2 * 3_600_000)).toBe('2h');
  });

  it('renders a sub-minute interval as <1m, never 0m', () => {
    // A recorded interval always happened. Rendering it as zero invites the
    // reader to treat it as missing data.
    expect(formatDuration(20_000)).toBe('<1m');
  });

  it('carries a rounding-up minute into the hour', () => {
    // 59.7 minutes rounds to 60, which must read as 1h and never "0h 60m".
    expect(formatDuration(59.7 * 60_000)).toBe('1h');
    expect(formatDuration((3_600_000 + 59.7 * 60_000))).toBe('2h');
  });

  it('renders an em dash for absent or nonsense input', () => {
    expect(formatDuration(null)).toBe('—');
    expect(formatDuration(undefined)).toBe('—');
    expect(formatDuration(-1)).toBe('—');
    expect(formatDuration(Number.NaN)).toBe('—');
  });
});

describe('formatStopwatch', () => {
  it('drops the hour segment until there is one', () => {
    expect(formatStopwatch(0)).toBe('0:00');
    expect(formatStopwatch(65_000)).toBe('1:05');
    expect(formatStopwatch(3_600_000 + 5 * 60_000 + 9_000)).toBe('1:05:09');
  });

  it('never renders a negative clock', () => {
    expect(formatStopwatch(-5_000)).toBe('0:00');
  });
});

describe('elapsedMs', () => {
  it('is computed from instants, so a throttled tab reports the truth', () => {
    // The regression this guards: a setInterval-accumulated counter is short by
    // however long the phone was in a pocket, because a backgrounded mobile tab
    // is throttled to one tick a minute or suspended outright.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-16T09:00:00Z'));
    const started = new Date('2026-08-16T08:00:00Z').toISOString();

    expect(elapsedMs(started)).toBe(3_600_000);

    // The tab sleeps for two hours and repaints once on resume.
    vi.setSystemTime(new Date('2026-08-16T11:00:00Z'));
    expect(elapsedMs(started)).toBe(3 * 3_600_000);
  });

  it('corrects for a phone whose own clock is wrong', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-16T09:00:00Z'));
    const started = new Date('2026-08-16T08:30:00Z').toISOString();
    // Phone runs 10 minutes fast: server_now was 10 min behind Date.now().
    expect(elapsedMs(started, -600_000)).toBe(20 * 60_000);
  });

  it('clamps to zero rather than reporting negative time', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-16T09:00:00Z'));
    expect(elapsedMs(new Date('2026-08-16T09:05:00Z').toISOString())).toBe(0);
  });
});

describe('intervalMs', () => {
  it('is null while the interval is still running', () => {
    expect(intervalMs('2026-08-16T08:00:00Z', null)).toBeNull();
  });

  it('measures a closed interval', () => {
    expect(intervalMs('2026-08-16T08:00:00Z', '2026-08-16T09:47:00Z')).toBe(107 * 60_000);
  });
});

describe('timeInputToIso', () => {
  it('anchors on the interval being corrected, not on today', () => {
    // Correcting yesterday's forgotten stop has to land on yesterday.
    const anchor = local(2026, 8, 15, 14, 30);
    const out = timeInputToIso('13:05', anchor);
    expect(out).not.toBeNull();
    const d = new Date(out!);
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(7);
    expect(d.getDate()).toBe(15);
    expect(d.getHours()).toBe(13);
    expect(d.getMinutes()).toBe(5);
  });

  it('rolls an end time past midnight forward a day', () => {
    // A night shift: started 23:50, stopped 00:20. Without the roll this is a
    // negative duration and the DB CHECK rejects it.
    const startedAt = local(2026, 8, 15, 23, 50);
    const out = timeInputToIso('00:20', startedAt, 'end');
    expect(new Date(out!).getDate()).toBe(16);
    expect(new Date(out!).getTime()).toBeGreaterThan(new Date(startedAt).getTime());
  });

  it('rolls a start time before midnight back a day', () => {
    const endedAt = local(2026, 8, 16, 0, 20);
    const out = timeInputToIso('23:50', endedAt, 'start');
    expect(new Date(out!).getDate()).toBe(15);
    expect(new Date(out!).getTime()).toBeLessThan(new Date(endedAt).getTime());
  });

  it('leaves a same-day correction on its own day', () => {
    const anchor = local(2026, 8, 16, 14, 30);
    expect(new Date(timeInputToIso('08:15', anchor)!).getDate()).toBe(16);
    expect(new Date(timeInputToIso('16:45', anchor, 'end')!).getDate()).toBe(16);
  });

  it('rejects malformed and out-of-range input', () => {
    const anchor = local(2026, 8, 16, 14, 30);
    expect(timeInputToIso('', anchor)).toBeNull();
    expect(timeInputToIso('9am', anchor)).toBeNull();
    expect(timeInputToIso('24:00', anchor)).toBeNull();
    expect(timeInputToIso('12:60', anchor)).toBeNull();
  });
});

describe('isoToTimeInput', () => {
  it('round-trips with timeInputToIso', () => {
    // The two must stay symmetric: the dialog reads with one and writes with the
    // other, so an asymmetry silently shifts every edited time.
    const anchor = local(2026, 8, 16, 9, 12);
    expect(isoToTimeInput(anchor)).toBe('09:12');
    expect(timeInputToIso(isoToTimeInput(anchor), anchor)).toBe(anchor);
  });

  it('zero-pads a single-digit hour', () => {
    expect(isoToTimeInput(local(2026, 8, 16, 7, 5))).toBe('07:05');
  });
});

describe('nudgeIso', () => {
  it('shifts by whole minutes in both directions', () => {
    const base = '2026-08-16T09:12:00.000Z';
    expect(nudgeIso(base, -15)).toBe('2026-08-16T08:57:00.000Z');
    expect(nudgeIso(base, 5)).toBe('2026-08-16T09:17:00.000Z');
  });

  it('returns the input unchanged when it is not a date', () => {
    expect(nudgeIso('not-a-date', 5)).toBe('not-a-date');
  });
});

describe('formatClockTime', () => {
  it('is empty for an unparseable instant rather than "Invalid Date"', () => {
    expect(formatClockTime('nope')).toBe('');
  });
});
