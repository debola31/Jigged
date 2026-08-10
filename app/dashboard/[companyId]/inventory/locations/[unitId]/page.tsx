'use client';

import { useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Box from '@mui/material/Box';
import CircularProgress from '@mui/material/CircularProgress';

import { usePageTitle } from '@/components/layout/PageTitleProvider';
import { useCompanyFeatures } from '@/hooks/useCompanyFeatures';
import LocationsManager from '@/components/inventory/locations/LocationsManager';

export default function StorageUnitPage() {
  const params = useParams();
  const router = useRouter();
  const companyId = params.companyId as string;
  const unitId = params.unitId as string;
  const { setTitle } = usePageTitle();
  const { features, loading } = useCompanyFeatures();
  const enabled = features.inventory_locations;

  useEffect(() => {
    // Matches the sidebar item. Said "Inventory Locations" while the nav said "Storage",
    // and "locations" carries the industry's site/warehouse meaning we don't have.
    setTitle('Storage');
    return () => setTitle(null);
  }, [setTitle]);

  // Feature-flagged: bounce companies that haven't opted in.
  //
  // Straight to /parts, not /inventory — the latter is itself now a redirect to /parts, so
  // sending them there cost a second hop for nothing.
  useEffect(() => {
    if (!loading && !enabled) {
      router.replace(`/dashboard/${companyId}/parts`);
    }
  }, [loading, enabled, router, companyId]);

  if (loading || !enabled) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}>
        <CircularProgress />
      </Box>
    );
  }

  return (
    <Box>
      {/* One storage unit, drawn.

          A real route rather than a state flag on the list, which is what it was until 2026-08-10.
          Being a route is what gives it the browser's back button, a link you can send someone, and
          a page whose chrome belongs to it — the list's "Add storage" toolbar used to follow you
          in here, acting on something you were no longer looking at. It also matches the operator
          surface, which has been route-per-location since the QR scheme was built. */}
      <LocationsManager companyId={companyId} unitId={unitId} />
    </Box>
  );
}
