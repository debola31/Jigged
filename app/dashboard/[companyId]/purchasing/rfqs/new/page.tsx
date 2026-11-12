'use client';

import { useParams, useRouter, useSearchParams } from 'next/navigation';
import Box from '@mui/material/Box';

import SubscriptionRequiredNotice from '@/components/billing/SubscriptionRequiredNotice';
import RfqForm from '@/components/purchasing/RfqForm';
import { purchasingHubPath, vendorRfqPath } from '@/lib/purchasingRoutes';

/** `?part=a&part=b` and `?part=a,b` both read as [a, b]. */
function ids(values: string[]): string[] {
  return [...new Set(values.flatMap((v) => v.split(',')).map((v) => v.trim()).filter(Boolean))];
}

/**
 * A new request for quotation (plan §3.9, §3.13).
 *
 * Prefill takes IDS ONLY — `?part=` (one or more parts to put on lines), `?vendor=` (vendors to ask)
 * and `?from=to-buy` when the buy list's "Ask for prices (RFQ)" sent the person here. The form
 * resolves every id itself, so a stale or tampered one fails to load rather than seeding a line from
 * URL contents (the rule at quotes/new).
 */
export default function NewRfqPage() {
  const params = useParams();
  const companyId = params.companyId as string;
  const search = useSearchParams();
  const router = useRouter();

  return (
    <Box>
      <SubscriptionRequiredNotice entityPlural="RFQs" />
      <RfqForm
        companyId={companyId}
        initialPartIds={ids(search.getAll('part'))}
        initialVendorIds={ids(search.getAll('vendor'))}
        fromBuyList={search.get('from') === 'to-buy'}
        onSaved={(id) => router.push(vendorRfqPath(companyId, id))}
        onCancel={() => router.push(purchasingHubPath(companyId, 'rfqs'))}
      />
    </Box>
  );
}
