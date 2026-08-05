'use client';

import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import type { ReactNode } from 'react';
import { useParams } from 'next/navigation';
import { getStationOperationTypes, getStationName } from '@/utils/operatorAccess';
import type { Station } from '@/types/operator';

import { logOperatorEvent } from '@/utils/operatorEventsAccess';

// The persistence itself lives in lib/ because sign-out paths outside the
// operator tree need to clear it — see the note at the top of that module.
import {
  readStoredStation,
  writeStoredStation,
  clearStoredStation,
} from '@/lib/operatorStationStorage';

// Re-exported so existing importers (and the provider's own callers) keep one
// obvious place to reach for it.
export { clearStoredStation };

interface StationContextValue {
  stationId: string | null;
  stationName: string | null;
  stations: Station[];
  setStation: (id: string) => void;
  /** Station-name / stations-list resolution (drives the picker spinner). */
  loading: boolean;
  /**
   * True until the stored station has been read exactly once. Consumers must
   * wait for this before deciding "no station is selected", or a returning
   * operator flashes the station picker for one paint before the stored station
   * hydrates.
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
  const companyId = params.companyId as string;

  const [stationId, setStationId] = useState<string | null>(null);
  const [stationName, setStationName] = useState<string | null>(null);
  const [stations, setStations] = useState<Station[]>([]);
  const [loading, setLoading] = useState(true);
  const [initializing, setInitializing] = useState(true);

  // Seed the station from THIS COMPANY's stored default. Runs once per mounted
  // company: the App Router keys the `[companyId]` segment subtree by the param
  // value, so a company switch remounts this provider rather than re-running the
  // effect under a live instance. localStorage is read, not subscribed.
  // `initializing` flips false here so consumers know the "no station" decision
  // is now trustworthy.
  useEffect(() => {
    setStationId(readStoredStation(companyId));
    setInitializing(false);
  }, [companyId]);

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

      // Otherwise fetch it directly, scoped to this company.
      try {
        const name = await getStationName(stationId, companyId);
        if (name === null) {
          // The stored station names a machine that has been archived, or one
          // that lives in a DIFFERENT company. Both want the same handling, so
          // getStationName answers null for both rather than making this branch
          // tell them apart. Forget it rather than sitting on a station with no
          // name: the header would read "Select Station" while every
          // station-gated surface still believed one was chosen, and nothing on
          // the floor offers a way out of that.
          clearStoredStation(companyId);
          setStationId(null);
          setStationName(null);
        } else {
          setStationName(name);
        }
      } catch {
        // A failed lookup is not evidence the machine is gone — most likely the
        // shop wifi dropped. Keep the selection and leave the name blank; the
        // next resolve fixes it.
        setStationName(null);
      }
      setLoading(false);
    }
    resolveName();
  }, [stationId, stations, companyId]);

  // One call site covers every route in: the station picker and the header
  // dropdown both land here.
  const setStation = useCallback(
    (id: string) => {
      setStationId(id);
      writeStoredStation(companyId, id);
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
