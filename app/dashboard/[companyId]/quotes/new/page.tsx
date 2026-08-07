'use client';

import { useParams } from 'next/navigation';
import Box from '@mui/material/Box';
import CircularProgress from '@mui/material/CircularProgress';
import QuoteForm from '@/components/quotes/QuoteForm';
import { EMPTY_QUOTE_FORM, defaultExpirationDate } from '@/types/quote';
import { getCompany } from '@/utils/companyAccess';
import { readQuoteValidityDays } from '@/lib/companyDefaults';
import { useLoad } from '@/hooks/useLoad';
import SubscriptionRequiredNotice from '@/components/billing/SubscriptionRequiredNotice';

export default function NewQuotePage() {
  const params = useParams();
  const companyId = params.companyId as string;

  // Pre-fill the expiration date from the company's configured quote-validity
  // window (companies.settings.defaults.quote_validity_days). While loading (or
  // on failure) readQuoteValidityDays falls back to the default validity.
  const { data: company, loading } = useLoad(
    () => getCompany(companyId),
    [companyId],
  );

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
        <CircularProgress />
      </Box>
    );
  }

  const initialData = {
    ...EMPTY_QUOTE_FORM,
    expiration_date: defaultExpirationDate(readQuoteValidityDays(company)),
  };

  return (
    <Box>
      <SubscriptionRequiredNotice entityPlural="quotes" />
      <QuoteForm mode="create" initialData={initialData} />
    </Box>
  );
}
