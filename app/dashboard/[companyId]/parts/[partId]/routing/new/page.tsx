'use client';

import { useParams } from 'next/navigation';
import Box from '@mui/material/Box';
import RoutingWizard from '@/components/routings/RoutingWizard';

export default function NewPartRoutingPage() {
  const params = useParams();
  const companyId = params.companyId as string;
  const partId = params.partId as string;

  return (
    <Box>
      <RoutingWizard companyId={companyId} partId={partId} mode="create" />
    </Box>
  );
}
