import { describe, it, expect } from 'vitest';
import { calculateActualRunHours } from '@/utils/sessionDuration';

describe('calculateActualRunHours', () => {
  it('calculates hours from a single session', () => {
    const sessions = [
      {
        started_at: '2026-03-27T09:00:00.000Z',
        ended_at: '2026-03-27T11:30:00.000Z',
      },
    ];
    // 2.5 hours
    expect(calculateActualRunHours(sessions)).toBeCloseTo(2.5, 5);
  });

  it('sums durations from multiple sessions (stop/restart pattern)', () => {
    const sessions = [
      {
        started_at: '2026-03-27T09:00:00.000Z',
        ended_at: '2026-03-27T10:00:00.000Z', // 1 hour
      },
      {
        started_at: '2026-03-27T13:00:00.000Z',
        ended_at: '2026-03-27T14:30:00.000Z', // 1.5 hours
      },
    ];
    // Should be 2.5 hours total (NOT 5.5 hours from first start to last end)
    expect(calculateActualRunHours(sessions)).toBeCloseTo(2.5, 5);
  });

  it('handles sessions spanning midnight', () => {
    const sessions = [
      {
        started_at: '2026-03-27T23:00:00.000Z',
        ended_at: '2026-03-28T01:30:00.000Z', // 2.5 hours
      },
    ];
    expect(calculateActualRunHours(sessions)).toBeCloseTo(2.5, 5);
  });

  it('handles multiple sessions with one spanning midnight', () => {
    const sessions = [
      {
        started_at: '2026-03-27T08:00:00.000Z',
        ended_at: '2026-03-27T09:00:00.000Z', // 1 hour
      },
      {
        started_at: '2026-03-27T23:30:00.000Z',
        ended_at: '2026-03-28T00:30:00.000Z', // 1 hour
      },
    ];
    expect(calculateActualRunHours(sessions)).toBeCloseTo(2.0, 5);
  });

  it('returns 0 for an empty array', () => {
    expect(calculateActualRunHours([])).toBe(0);
  });

  it('handles very short sessions (seconds)', () => {
    const sessions = [
      {
        started_at: '2026-03-27T09:00:00.000Z',
        ended_at: '2026-03-27T09:00:30.000Z', // 30 seconds
      },
    ];
    // 30 seconds = 0.00833... hours
    expect(calculateActualRunHours(sessions)).toBeCloseTo(30 / 3600, 5);
  });
});
