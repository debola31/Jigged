'use client';

import { useRouter, useParams } from 'next/navigation';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import { WorkCenterForm } from '@/components/work-centers';
import { EMPTY_WORK_CENTER_FORM } from '@/types/workCenter';
import SubscriptionRequiredNotice from '@/components/billing/SubscriptionRequiredNotice';

export default function NewWorkCenterPage() {
  const router = useRouter();
  const params = useParams();
  const companyId = params.companyId as string;

  return (
    <Box>
      <Button
        startIcon={<ArrowBackIcon />}
        onClick={() => router.push(`/dashboard/${companyId}/work-centers`)}
        sx={{ color: 'text.secondary', mb: 2 }}
      >
        Back to Work Centers
      </Button>
      <SubscriptionRequiredNotice entityPlural="work centers" />
      <WorkCenterForm mode="create" initialData={EMPTY_WORK_CENTER_FORM} />
    </Box>
  );
}
