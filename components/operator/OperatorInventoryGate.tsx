'use client';

/**
 * Flag gate for the operator inventory routes.
 *
 * The `inventory_locations` flag is a real entitlement boundary, not a nav preference: the founder
 * flips it per shop and nobody else can. The operator *tab* respected that
 * (`app/operator/[companyId]/layout.tsx` hides it when the flag is off) — but the routes behind it
 * did not, so `/operator/<co>/inventory` and every bin under it answered to anyone who typed or
 * bookmarked the URL. A hidden tab is not access control.
 *
 * Bounces to `/operator/<co>/jobs` rather than rendering an explanation, matching the owner side
 * (`app/dashboard/[companyId]/inventory/locations/page.tsx`): a shop without the flag has no places
 * at all, so there is nothing here to explain.
 */

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Box from '@mui/material/Box';
import CircularProgress from '@mui/material/CircularProgress';
import { useCompanyFeatures } from '@/hooks/useCompanyFeatures';

export default function OperatorInventoryGate({
  companyId,
  children,
}: {
  companyId: string;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const { features, loading } = useCompanyFeatures();
  const enabled = Boolean(features.inventory_locations);

  useEffect(() => {
    if (!loading && !enabled) router.replace(`/operator/${companyId}/jobs`);
  }, [loading, enabled, router, companyId]);

  // Renders the spinner while deciding, so a flag-off operator never sees a frame of the page.
  if (loading || !enabled) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}>
        <CircularProgress />
      </Box>
    );
  }

  return <>{children}</>;
}
