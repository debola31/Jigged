'use client';

/**
 * Gate every operator inventory route on the `inventory_locations` flag.
 *
 * A nested layout rather than a guard pasted into each page: it covers `/inventory` and every bin
 * under `/inventory/locations/<id>` at once, and — more to the point — it covers the next route
 * added here without anyone having to remember. The hole this closes was exactly that kind of
 * omission: the operator *tab* was flag-gated in the layout above, so the feature looked contained,
 * while both routes behind it answered to a typed or bookmarked URL.
 */

import { use } from 'react';
import OperatorInventoryGate from '@/components/operator/OperatorInventoryGate';

export default function OperatorInventoryLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ companyId: string }>;
}) {
  const { companyId } = use(params);
  return <OperatorInventoryGate companyId={companyId}>{children}</OperatorInventoryGate>;
}
