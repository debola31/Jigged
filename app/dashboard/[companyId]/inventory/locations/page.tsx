'use client';

import { useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Box from '@mui/material/Box';
import CircularProgress from '@mui/material/CircularProgress';

import { usePageTitle } from '@/components/layout/PageTitleProvider';
import { useCompanyFeatures } from '@/hooks/useCompanyFeatures';
import LocationsManager from '@/components/inventory/locations/LocationsManager';

export default function InventoryLocationsPage() {
  const params = useParams();
  const router = useRouter();
  const companyId = params.companyId as string;
  const { setTitle } = usePageTitle();
  const { features, companyName, loading } = useCompanyFeatures();
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
      {/* The "Back to Inventory" button is gone. Storage is a top-level sidebar item now, so
          there is nothing to go back *to* — and the page it pointed at no longer exists, so it
          would have bounced through a redirect to land on Parts. A back link out of a top-level
          destination is chrome pretending to be navigation. */}
      {/* `companyName` was never passed before, so the QR label sheet printed with no heading —
          the prop existed and read `undefined` on every call. */}
      <LocationsManager companyId={companyId} companyName={companyName ?? undefined} />
    </Box>
  );
}
