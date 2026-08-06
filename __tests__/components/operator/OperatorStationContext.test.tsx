import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';

vi.mock('@/utils/operatorEventsAccess', () => ({ logOperatorEvent: vi.fn() }));

// Mutable, because the bug this file now guards IS a company change: with a
// fixed arrow there is no way to express "the same device, a different company"
// at all, which is why the original five cases all passed while the leak shipped.
const params = { companyId: 'c1' };
vi.mock('next/navigation', () => ({
  useParams: () => params,
}));

vi.mock('@/utils/operatorAccess', () => ({
  getStationOperationTypes: vi.fn().mockResolvedValue([]),
  getStationName: vi.fn().mockResolvedValue('Anca Grinder'),
}));

import { getStationName } from '@/utils/operatorAccess';
import {
  OperatorStationProvider,
  useStationContext,
  clearStoredStation,
} from '@/components/operator/OperatorStationContext';

const mockGetStationName = vi.mocked(getStationName);

// The station is stored PER COMPANY. `LEGACY_KEY` is the flat key devices wrote
// before that, kept here because retiring it is behaviour with its own test.
const keyFor = (companyId: string) => `jigged_operator_station:${companyId}`;
const KEY = keyFor('c1');
const LEGACY_KEY = 'jigged_operator_station';

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
  params.companyId = 'c1';
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

  // An archived machine used to stay selected forever: getStationName ignored
  // deleted_at, so the id resolved, and even once it stopped resolving the
  // provider kept the id with a blank name — a station-gated app pointed at a
  // machine nobody can stand at, with no way out from the floor.
  it('forgets a stored station whose machine has been archived, dropping back to the picker', async () => {
    window.localStorage.setItem(KEY, 'st-archived');
    mockGetStationName.mockResolvedValueOnce(null);

    const { result } = renderHook(() => useStationContext(), { wrapper: OperatorStationProvider });

    await waitFor(() => expect(result.current.stationId).toBeNull());
    expect(result.current.stationName).toBeNull();
    expect(window.localStorage.getItem(KEY)).toBeNull();
  });

  it('keeps the stored station when the lookup fails, because a dropped connection is not an archive', async () => {
    window.localStorage.setItem(KEY, 'st-anca');
    mockGetStationName.mockRejectedValueOnce(new Error('network down'));

    const { result } = renderHook(() => useStationContext(), { wrapper: OperatorStationProvider });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.stationId).toBe('st-anca');
    expect(window.localStorage.getItem(KEY)).toBe('st-anca');
  });
});

// The August-2026 bug: one flat localStorage key held the station for the whole
// DEVICE, so a user with access to two companies (demo mode hands out two
// routinely) carried company A's machine into company B. The header named a
// station absent from the picker, My Station went silently empty WITHOUT
// offering the picker — `showStationSelector` requires `!stationId` — and the
// first maintenance note was rejected by notes_validate_subject() as
// "Could not save that."
//
// Nothing here needs a live param flip: the App Router keys the `[companyId]`
// segment subtree by the param value, so a company change remounts the provider.
// Remounting under a different companyId IS the real scenario.
describe('OperatorStationProvider — station is per company', () => {
  // Drives the selection through setStation rather than seeding localStorage
  // directly, so the assertion does not depend on the key format. Seeding a
  // company-scoped key by hand would pass vacuously against the flat-key bug
  // this exists to catch — the old code simply would not find that key.
  it('does not inherit the other company\'s station on a company switch', async () => {
    const inC1 = renderHook(() => useStationContext(), { wrapper: OperatorStationProvider });
    await waitFor(() => expect(inC1.result.current.initializing).toBe(false));
    act(() => inC1.result.current.setStation('st-haas'));
    inC1.unmount();

    params.companyId = 'c2';
    const inC2 = renderHook(() => useStationContext(), { wrapper: OperatorStationProvider });

    await waitFor(() => expect(inC2.result.current.initializing).toBe(false));
    expect(inC2.result.current.stationId).toBeNull();
    // Not merely cleared afterwards — never adopted under c2. Resolving it there
    // would mean a paint with the wrong machine named in the header, off a lookup
    // that (with genuine access to both companies) would have SUCCEEDED.
    expect(mockGetStationName).not.toHaveBeenCalledWith('st-haas', 'c2');
  });

  it('keeps each company\'s station, so switching back still remembers it', async () => {
    const inC1 = renderHook(() => useStationContext(), { wrapper: OperatorStationProvider });
    await waitFor(() => expect(inC1.result.current.initializing).toBe(false));
    act(() => inC1.result.current.setStation('st-anca'));
    inC1.unmount();

    params.companyId = 'c2';
    const inC2 = renderHook(() => useStationContext(), { wrapper: OperatorStationProvider });
    await waitFor(() => expect(inC2.result.current.initializing).toBe(false));
    act(() => inC2.result.current.setStation('st-edm'));
    inC2.unmount();

    params.companyId = 'c1';
    const backInC1 = renderHook(() => useStationContext(), { wrapper: OperatorStationProvider });
    await waitFor(() => expect(backInC1.result.current.initializing).toBe(false));

    // Under one flat key, c2's choice would have clobbered c1's.
    expect(backInC1.result.current.stationId).toBe('st-anca');
  });

  // Company-scoping alone would leave a station the user genuinely CAN read —
  // RLS admits every company they belong to — so the lookup has to reject it too.
  it('forgets a station the company lookup rejects, dropping back to the picker', async () => {
    window.localStorage.setItem(KEY, 'st-foreign');
    mockGetStationName.mockResolvedValueOnce(null);

    const { result } = renderHook(() => useStationContext(), { wrapper: OperatorStationProvider });

    await waitFor(() => expect(result.current.stationId).toBeNull());
    expect(mockGetStationName).toHaveBeenCalledWith('st-foreign', 'c1');
    expect(window.localStorage.getItem(KEY)).toBeNull();
  });

  // Devices already out on floors hold the flat key. Dropping it outright would
  // put every operator in front of the picker one morning for a bug they never
  // hit, so it is adopted once by whichever company opens first.
  it('migrates the legacy flat key into the current company, exactly once', async () => {
    window.localStorage.setItem(LEGACY_KEY, 'st-anca');

    const first = renderHook(() => useStationContext(), { wrapper: OperatorStationProvider });
    await waitFor(() => expect(first.result.current.stationId).toBe('st-anca'));

    expect(window.localStorage.getItem(keyFor('c1'))).toBe('st-anca');
    // Consumed, not copied: leaving it would re-seed every other company in turn
    // with the same wrong machine.
    expect(window.localStorage.getItem(LEGACY_KEY)).toBeNull();

    params.companyId = 'c2';
    const second = renderHook(() => useStationContext(), { wrapper: OperatorStationProvider });
    await waitFor(() => expect(second.result.current.initializing).toBe(false));
    expect(second.result.current.stationId).toBeNull();
  });

  // A shop phone that changes hands must not hand the next person a station in
  // ANY company — Supabase's own sign-out never touches device-local state.
  it('clearStoredStation() with no company wipes every company, and the legacy key', () => {
    window.localStorage.setItem(keyFor('c1'), 'st-anca');
    window.localStorage.setItem(keyFor('c2'), 'st-edm');
    window.localStorage.setItem(LEGACY_KEY, 'st-old');
    window.localStorage.setItem('jigged_unrelated', 'keep-me');

    clearStoredStation();

    expect(window.localStorage.getItem(keyFor('c1'))).toBeNull();
    expect(window.localStorage.getItem(keyFor('c2'))).toBeNull();
    expect(window.localStorage.getItem(LEGACY_KEY)).toBeNull();
    expect(window.localStorage.getItem('jigged_unrelated')).toBe('keep-me');
  });

  it('clearStoredStation(companyId) forgets only that company', () => {
    window.localStorage.setItem(keyFor('c1'), 'st-anca');
    window.localStorage.setItem(keyFor('c2'), 'st-edm');

    clearStoredStation('c1');

    expect(window.localStorage.getItem(keyFor('c1'))).toBeNull();
    expect(window.localStorage.getItem(keyFor('c2'))).toBe('st-edm');
  });
});
