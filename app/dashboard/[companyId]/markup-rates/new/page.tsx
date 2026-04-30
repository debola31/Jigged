'use client';

import { useParams, useRouter } from 'next/navigation';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import MarkupRateForm from '@/components/markup-rates/MarkupRateForm';

export default function NewMarkupRatePage() {
  const params = useParams();
  const router = useRouter();
  const companyId = params.companyId as string;

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      <Box>
        <Button
          startIcon={<ArrowBackIcon />}
          onClick={() => router.push(`/dashboard/${companyId}/markup-rates`)}
          sx={{ color: 'text.secondary' }}
        >
          Back to Markup Rates
        </Button>
      </Box>

      <MarkupRateForm companyId={companyId} mode="create" />
    </Box>
  );
}
