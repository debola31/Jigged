'use client';

import { useParams, useSearchParams } from 'next/navigation';
import Box from '@mui/material/Box';

import SubscriptionRequiredNotice from '@/components/billing/SubscriptionRequiredNotice';
import VendorPoForm, { type VendorPoFormPrefill } from '@/components/purchasing/VendorPoForm';

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * New purchase order (plan §3.1 Routes).
 *
 * Prefilled from another screen BY IDS ONLY — `?vendor= &part= &job= &jobPart= &jobOperation=
 * &workCenter=` — following quotes/new: the form resolves everything else itself, so a stale or
 * tampered id simply fails to load rather than seeding a line from URL text. An operation card's
 * "Create PO" passes the vendor and the step; a bought part's "Buy it" passes the part and job part;
 * a machine's maintenance passes the work centre.
 */
export default function NewVendorPoPage() {
  const params = useParams();
  const companyId = params.companyId as string;
  const search = useSearchParams();

  const id = (key: string): string | null => {
    const value = search.get(key);
    return value && ID.test(value) ? value : null;
  };
  const prefill: VendorPoFormPrefill = {
    vendorId: id('vendor'),
    partId: id('part'),
    jobId: id('job'),
    jobPartId: id('jobPart'),
    jobOperationId: id('jobOperation'),
    workCenterId: id('workCenter'),
  };

  return (
    <Box>
      <SubscriptionRequiredNotice entityPlural="purchase orders" />
      {/* Keyed by the query, so following a second "Create PO" link starts a fresh form. */}
      <VendorPoForm key={search.toString()} mode="create" companyId={companyId} prefill={prefill} />
    </Box>
  );
}
