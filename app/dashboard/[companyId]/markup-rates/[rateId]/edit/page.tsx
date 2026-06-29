'use client';

import { useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useLoad } from '@/hooks/useLoad';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Alert from '@mui/material/Alert';
import CircularProgress from '@mui/material/CircularProgress';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import MarkupRateForm from '@/components/markup-rates/MarkupRateForm';
import { getMarkupRate } from '@/utils/markupRatesAccess';
import { markupRateToFormData } from '@/types/markupRates';

export default function EditMarkupRatePage() {
  const params = useParams();
  const router = useRouter();
  const companyId = params.companyId as string;
  const rateId = params.rateId as string;

  const [error, setError] = useState<string | null>(null);

  // Single loader: resolves to the form data, or throws "not found" so the
  // rejection path surfaces it as an error (no synchronous setState in an effect).
  const { data: initial, loading } = useLoad(
    async () => {
      const rate = await getMarkupRate(rateId);
      if (!rate) throw new Error('Markup rate not found.');
      return markupRateToFormData(rate);
    },
    [rateId],
    {
      onError: (err) => {
        setError(err instanceof Error ? err.message : 'Failed to load markup rate');
      },
    },
  );

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

      {loading ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
          <CircularProgress />
        </Box>
      ) : error ? (
        <Alert severity="error">{error}</Alert>
      ) : initial ? (
        <MarkupRateForm
          companyId={companyId}
          mode="edit"
          rateId={rateId}
          initialData={initial}
        />
      ) : null}
    </Box>
  );
}
