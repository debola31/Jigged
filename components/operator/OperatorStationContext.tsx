'use client';

import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import type { ReactNode } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import { getStationOperationTypes, getStationName } from '@/utils/operatorAccess';
import type { Station } from '@/types/operator';

const SESSION_STORAGE_KEY = 'jigged_operator_station';

interface StationContextValue {
  stationId: string | null;
  stationName: string | null;
  stations: Station[];
  setStation: (id: string) => void;
  loading: boolean;
}

const StationContext = createContext<StationContextValue>({
  stationId: null,
  stationName: null,
  stations: [],
  setStation: () => {},
  loading: true,
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

  // Initialize station from URL param or sessionStorage
  useEffect(() => {
    const urlStation = searchParams.get('station');
    const storedStation = typeof window !== 'undefined'
      ? sessionStorage.getItem(SESSION_STORAGE_KEY)
      : null;

    const initialStation = urlStation || storedStation;
    if (initialStation) {
      setStationId(initialStation);
      if (typeof window !== 'undefined') {
        sessionStorage.setItem(SESSION_STORAGE_KEY, initialStation);
      }
    }
  }, [searchParams]);

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

  const setStation = useCallback((id: string) => {
    setStationId(id);
    if (typeof window !== 'undefined') {
      sessionStorage.setItem(SESSION_STORAGE_KEY, id);
    }
  }, []);

  return (
    <StationContext.Provider
      value={{ stationId, stationName, stations, setStation, loading }}
    >
      {children}
    </StationContext.Provider>
  );
}
