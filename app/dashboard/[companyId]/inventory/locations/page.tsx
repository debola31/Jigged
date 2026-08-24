'use client';

import { useEffect } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import Box from '@mui/material/Box';

import { usePageTitle } from '@/components/layout/PageTitleProvider';
import LocationsManager from '@/components/inventory/locations/LocationsManager';

export default function InventoryLocationsPage() {
  const params = useParams();
  const companyId = params.companyId as string;
  const unitId = useSearchParams().get('unit');
  const { setTitle } = usePageTitle();

  useEffect(() => {
    // Matches the sidebar item. Said "Inventory Locations" while the nav said "Storage",
    // and "locations" carries the industry's site/warehouse meaning we don't have.
    setTitle('Storage');
    return () => setTitle(null);
  }, [setTitle]);

  return (
    <Box>
      {/* The "Back to Inventory" button is gone. Storage is a top-level sidebar item now, so
          there is nothing to go back *to* — and the page it pointed at no longer exists, so it
          would have bounced through a redirect to land on Parts. A back link out of a top-level
          destination is chrome pretending to be navigation. */}
      <LocationsManager companyId={companyId} unitId={unitId ?? undefined} />
    </Box>
  );
}
