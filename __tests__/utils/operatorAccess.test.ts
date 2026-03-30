import { describe, it, expect } from 'vitest';
import { calculateActualRunMinutes } from '@/utils/sessionDuration';

describe('calculateActualRunMinutes', () => {
  it('calculates minutes from a single session', () => {
    const sessions = [
      {
        started_at: '2026-03-27T09:00:00.000Z',
        ended_at: '2026-03-27T11:30:00.000Z',
      },
    ];
    // 150 minutes
    expect(calculateActualRunMinutes(sessions)).toBeCloseTo(150, 5);
  });

  it('sums durations from multiple sessions (stop/restart pattern)', () => {
    const sessions = [
      {
        started_at: '2026-03-27T09:00:00.000Z',
        ended_at: '2026-03-27T10:00:00.000Z', // 60 min
      },
      {
        started_at: '2026-03-27T13:00:00.000Z',
        ended_at: '2026-03-27T14:30:00.000Z', // 90 min
      },
    ];
    // Should be 150 minutes total (NOT 330 min from first start to last end)
    expect(calculateActualRunMinutes(sessions)).toBeCloseTo(150, 5);
  });

  it('handles sessions spanning midnight', () => {
    const sessions = [
      {
        started_at: '2026-03-27T23:00:00.000Z',
        ended_at: '2026-03-28T01:30:00.000Z', // 150 min
      },
    ];
    expect(calculateActualRunMinutes(sessions)).toBeCloseTo(150, 5);
  });

  it('handles multiple sessions with one spanning midnight', () => {
    const sessions = [
      {
        started_at: '2026-03-27T08:00:00.000Z',
        ended_at: '2026-03-27T09:00:00.000Z', // 60 min
      },
      {
        started_at: '2026-03-27T23:30:00.000Z',
        ended_at: '2026-03-28T00:30:00.000Z', // 60 min
      },
    ];
    expect(calculateActualRunMinutes(sessions)).toBeCloseTo(120, 5);
  });

  it('returns 0 for an empty array', () => {
    expect(calculateActualRunMinutes([])).toBe(0);
  });

  it('handles very short sessions (seconds)', () => {
    const sessions = [
      {
        started_at: '2026-03-27T09:00:00.000Z',
        ended_at: '2026-03-27T09:00:30.000Z', // 30 seconds
      },
    ];
    // 30 seconds = 0.5 minutes
    expect(calculateActualRunMinutes(sessions)).toBeCloseTo(0.5, 5);
  });
});
