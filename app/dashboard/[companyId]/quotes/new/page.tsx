'use client';

import { useParams, useSearchParams } from 'next/navigation';
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
  const search = useSearchParams();

  /**
   * Parts handed over from another screen — today the drawings import, which has
   * just created them and knows exactly what the shop is about to quote.
   *
   * Ids only. The form resolves everything else itself, so a stale or tampered id
   * simply fails to load rather than seeding a line from URL contents.
   */
  const seededPartIds = (search.get('parts') ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  const seededCustomerId = search.get('customer') ?? '';

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
    ...(seededCustomerId ? { customer_id: seededCustomerId } : {}),
    // Quantity 1 apiece: the drawings say nothing about how many, and a guess
    // here is a number someone has to notice and correct.
    parts: seededPartIds.map((part_id) => ({ part_id, order_quantity: 1 })),
  };

  return (
    <Box>
      <SubscriptionRequiredNotice entityPlural="quotes" />
      <QuoteForm mode="create" initialData={initialData} />
    </Box>
  );
}
