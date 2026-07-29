import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';

vi.mock('@/utils/operatorEventsAccess', () => ({ logOperatorEvent: vi.fn() }));
vi.mock('next/navigation', () => ({
  useParams: () => ({ companyId: 'c1' }),
}));

vi.mock('@/utils/operatorAccess', () => ({
  getStationOperationTypes: vi.fn().mockResolvedValue([]),
  getStationName: vi.fn().mockResolvedValue('Anca Grinder'),
}));

import {
  OperatorStationProvider,
  useStationContext,
  clearStoredStation,
} from '@/components/operator/OperatorStationContext';

const KEY = 'jigged_operator_station';

// This jsdom env has no origin, so it ships no Storage — polyfill a minimal
// in-memory one on `window` (the context reads window.localStorage).
class MemoryStorage {
  private store = new Map<string, string>();
  get length() {
    return this.store.size;
  }
  clear() {
    this.store.clear();
  }
  getItem(k: string) {
    return this.store.has(k) ? this.store.get(k)! : null;
  }
  key(i: number) {
    return Array.from(this.store.keys())[i] ?? null;
  }
  removeItem(k: string) {
    this.store.delete(k);
  }
  setItem(k: string, v: string) {
    this.store.set(k, String(v));
  }
}

beforeAll(() => {
  Object.defineProperty(window, 'localStorage', {
    value: new MemoryStorage(),
    configurable: true,
    writable: true,
  });
});

beforeEach(() => {
  window.localStorage.clear();
  vi.clearAllMocks();
});

// The May-2026-morning bug: the station lived in sessionStorage, so an evicted
// tab lost it overnight and the operation page fell back to the picker. These
// guard the fix — localStorage persistence + an `initializing` flag so consumers
// never decide "no station" before the stored value has been read.
describe('OperatorStationProvider', () => {
  it('hydrates the stored station on mount and finishes initializing', async () => {
    window.localStorage.setItem(KEY, 'st-anca');
    const { result } = renderHook(() => useStationContext(), { wrapper: OperatorStationProvider });

    await waitFor(() => expect(result.current.initializing).toBe(false));
    expect(result.current.stationId).toBe('st-anca');
  });

  it('finishes initializing with no station when nothing is stored (so the picker can show)', async () => {
    const { result } = renderHook(() => useStationContext(), { wrapper: OperatorStationProvider });

    await waitFor(() => expect(result.current.initializing).toBe(false));
    expect(result.current.stationId).toBeNull();
  });

  it('setStation persists (survives a reload); clearStoredStation wipes it on logout', async () => {
    const { result } = renderHook(() => useStationContext(), { wrapper: OperatorStationProvider });
    await waitFor(() => expect(result.current.initializing).toBe(false));

    act(() => result.current.setStation('st-x'));
    expect(window.localStorage.getItem(KEY)).toBe('st-x');

    clearStoredStation();
    expect(window.localStorage.getItem(KEY)).toBeNull();
  });
});
