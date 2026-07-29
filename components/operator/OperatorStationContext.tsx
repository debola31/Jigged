'use client';

import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import type { ReactNode } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import { getStationOperationTypes, getStationName } from '@/utils/operatorAccess';
import type { Station } from '@/types/operator';

// The operator's selected station is a device-local "where am I right now"
// default. We persist it in localStorage (NOT sessionStorage) so it survives a
// backgrounded-tab eviction / browser restart — the shop-floor reality that had
// operators landing on a job with the station picker stacked underneath it every
// morning. A QR deep-link (?station=) always overrides the stored value.
import { logOperatorEvent } from '@/utils/operatorEventsAccess';

const STORAGE_KEY = 'jigged_operator_station';

// localStorage access can throw (Safari private mode throws on setItem; access
// can be blocked entirely). A fallback station default must never white-screen
// the whole operator app, so every access is guarded and degrades to in-memory.
function readStoredStation(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeStoredStation(id: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, id);
  } catch {
    /* storage unavailable — keep the value in memory only */
  }
}

/** Clear the persisted station (used on explicit logout). */
export function clearStoredStation(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

interface StationContextValue {
  stationId: string | null;
  stationName: string | null;
  stations: Station[];
  setStation: (id: string) => void;
  /** Station-name / stations-list resolution (drives the picker spinner). */
  loading: boolean;
  /**
   * True until the URL param + stored station have been read exactly once.
   * Consumers must wait for this before deciding "no station is selected", or a
   * returning operator flashes the station picker for one paint before the
   * stored station hydrates.
   */
  initializing: boolean;
}

const StationContext = createContext<StationContextValue>({
  stationId: null,
  stationName: null,
  stations: [],
  setStation: () => {},
  loading: true,
  initializing: true,
});

export function useStationContext() {
  return useContext(StationContext);
}

export function OperatorStationProvider({ children }: { children: ReactNode }) {
  const params = useParams();
  const searchParams = useSearchParams();
  const companyId = params.companyId as string;

  const [stationId, setStationId] = useState<string | null>(null);
  const [stationName, setStationName] = useState<string | null>(null);
  const [stations, setStations] = useState<Station[]>([]);
  const [loading, setLoading] = useState(true);
  const [initializing, setInitializing] = useState(true);

  // Seed the station from the URL param (QR scan) or the stored default, exactly
  // once on mount. Running once — not on every searchParams change — is
  // deliberate: a QR deep-link is always a fresh mount, and re-running on
  // unrelated param changes could re-seed a stale station. `initializing` flips
  // false here so consumers know the "no station" decision is now trustworthy.
  useEffect(() => {
    const urlStation = searchParams.get('station');
    const initialStation = urlStation || readStoredStation();
    if (initialStation) {
      setStationId(initialStation);
      writeStoredStation(initialStation);
    }
    setInitializing(false);
    // Run once on mount — see comment above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Fetch all stations for the company
  useEffect(() => {
    async function loadStations() {
      try {
        const stationList = await getStationOperationTypes(companyId);
        setStations(stationList);
      } catch {
        // Stations list is non-critical, fail silently
      }
    }
    loadStations();
  }, [companyId]);

  // Resolve station name when stationId changes
  useEffect(() => {
    async function resolveName() {
      if (!stationId) {
        setStationName(null);
        setLoading(false);
        return;
      }

      // Try to find name from already-loaded stations list first
      const found = stations.find((s) => s.id === stationId);
      if (found) {
        setStationName(found.name);
        setLoading(false);
        return;
      }

      // Otherwise fetch it directly
      try {
        const name = await getStationName(stationId);
        setStationName(name);
      } catch {
        setStationName(null);
      }
      setLoading(false);
    }
    resolveName();
  }, [stationId, stations]);

  // One call site covers every route in: the station picker, the header
  // dropdown, and a station-placard QR — they all land here.
  const setStation = useCallback(
    (id: string) => {
      setStationId(id);
      writeStoredStation(id);
      logOperatorEvent(companyId, 'station_selected', { workCenterId: id });
    },
    [companyId],
  );

  return (
    <StationContext.Provider
      value={{ stationId, stationName, stations, setStation, loading, initializing }}
    >
      {children}
    </StationContext.Provider>
  );
}
