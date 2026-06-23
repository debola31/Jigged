'use client';

import { useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';

import { usePageTitle } from '@/components/layout/PageTitleProvider';
import { useCompanyFeatures } from '@/hooks/useCompanyFeatures';
import LocationsManager from '@/components/inventory/locations/LocationsManager';

export default function InventoryLocationsPage() {
  const params = useParams();
  const router = useRouter();
  const companyId = params.companyId as string;
  const { setTitle } = usePageTitle();
  const { features, loading } = useCompanyFeatures();
  const enabled = features.inventory_locations;

  useEffect(() => {
    setTitle('Inventory Locations');
    return () => setTitle(null);
  }, [setTitle]);

  // Feature-flagged: bounce companies that haven't opted in back to Inventory.
  useEffect(() => {
    if (!loading && !enabled) {
      router.replace(`/dashboard/${companyId}/inventory`);
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
      <Button
        startIcon={<ArrowBackIcon />}
        onClick={() => router.push(`/dashboard/${companyId}/inventory`)}
        sx={{ mb: 2 }}
      >
        Back to Inventory
      </Button>
      <LocationsManager companyId={companyId} />
    </Box>
  );
}
