'use client';

import { useParams } from 'next/navigation';

import RfqDetail from '@/components/purchasing/RfqDetail';

/** One RFQ (Pattern B). By id, so an archived RFQ still opens — read-only, with a banner. */
export default function RfqDetailPage() {
  const params = useParams();
  return <RfqDetail companyId={params.companyId as string} rfqId={params.rfqId as string} />;
}
