'use client';

import { useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';

import { usePageTitle } from '@/components/layout/PageTitleProvider';
import LocationsManager from '@/components/inventory/locations/LocationsManager';

export default function InventoryLocationsPage() {
  const params = useParams();
  const router = useRouter();
  const companyId = params.companyId as string;
  const { setTitle } = usePageTitle();

  useEffect(() => {
    setTitle('Inventory Locations');
    return () => setTitle(null);
  }, [setTitle]);

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
