'use client';

import { useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Box from '@mui/material/Box';
import CircularProgress from '@mui/material/CircularProgress';
import { useCompanyFeatures } from '@/hooks/useCompanyFeatures';
import { useStationContext } from '@/components/operator/OperatorStationContext';
import StationSelector from '@/components/operator/StationSelector';
import MachineLogPanel from '@/components/maintenance/MachineLogPanel';

/**
 * The Maintenance tab: the logbook for the machine the operator is standing at.
 *
 * THERE IS NO MACHINE PICKER, and that is the design rather than a shortcut. A
 * station IS a machine — the station list is work_centers filtered to
 * kind='internal' — so selecting a station has already answered the only question
 * a picker would ask. Asking again would be ceremony.
 *
 * There is nothing to scan on the machine either. A shop this size has few
 * machines and the operator has already told the app which one they are at, so a
 * code posted on the machine would solve a navigation problem this product does
 * not have.
 *
 * The consequence, accepted knowingly: an operator who notices something about a
 * machine that is not their selected station changes station first, with the
 * selector that already exists. At this machine count that is fine. If it turns
 * out not to be, the answer is revisiting THIS question — not reviving a code on
 * the machine.
 */
export default function OperatorMaintenancePage() {
  const params = useParams();
  const router = useRouter();
  const companyId = params.companyId as string;

  const { features, loading: flagsLoading } = useCompanyFeatures();
  const { stationId, stationName, initializing } = useStationContext();
  const enabled = features.machine_maintenance;

  // Bounce a company that hasn't opted in, matching the inventory-locations
  // precedent. The tab is already hidden for them; this covers a stale link.
  useEffect(() => {
    if (!flagsLoading && !enabled) router.replace(`/operator/${companyId}/jobs`);
  }, [flagsLoading, enabled, router, companyId]);

  if (flagsLoading || !enabled || initializing) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}>
        <CircularProgress />
      </Box>
    );
  }

  // Reachable without a station only by deep link — the tab itself is
  // station-gated. The picker is the way forward, not an error.
  if (!stationId) return <StationSelector />;

  return (
    <MachineLogPanel
      workCenterId={stationId}
      companyId={companyId}
      machineName={stationName}
    />
  );
}
