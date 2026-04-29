'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Alert from '@mui/material/Alert';
import CircularProgress from '@mui/material/CircularProgress';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import MarkupRateForm from '@/components/markup-rates/MarkupRateForm';
import { getMarkupRate } from '@/utils/markupRatesAccess';
import {
  type MarkupRateFormData,
  markupRateToFormData,
} from '@/types/markupRates';

export default function EditMarkupRatePage() {
  const params = useParams();
  const router = useRouter();
  const companyId = params.companyId as string;
  const rateId = params.rateId as string;

  const [initial, setInitial] = useState<MarkupRateFormData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getMarkupRate(rateId)
      .then((rate) => {
        if (cancelled) return;
        if (!rate) {
          setError('Markup rate not found.');
          return;
        }
        setInitial(markupRateToFormData(rate));
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Failed to load markup rate');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [rateId]);

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
