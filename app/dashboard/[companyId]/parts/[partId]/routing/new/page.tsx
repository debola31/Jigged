'use client';

import { useParams, useSearchParams } from 'next/navigation';
import Box from '@mui/material/Box';
import RoutingWizard from '@/components/routings/RoutingWizard';

export default function NewPartRoutingPage() {
  const params = useParams();
  const searchParams = useSearchParams();
  const companyId = params.companyId as string;
  const partId = params.partId as string;

  // Validate returnTo is a relative path to prevent open redirects
  const returnToRaw = searchParams.get('returnTo');
  const returnTo = returnToRaw && returnToRaw.startsWith('/') && !returnToRaw.startsWith('//')
    ? returnToRaw
    : undefined;

  return (
    <Box>
      <RoutingWizard companyId={companyId} partId={partId} mode="create" returnTo={returnTo} />
    </Box>
  );
}
