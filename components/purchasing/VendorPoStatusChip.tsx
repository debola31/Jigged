'use client';

import StatusChip from '@/components/common/StatusChip';
import { vendorPoStatusDisplay } from '@/lib/purchasing/vendorPoStatus';
import type { VendorPoStatus } from '@/types/vendorPo';

export interface VendorPoStatusChipProps {
  /** The status the database derived (`vendor_purchase_order_status.status`). */
  status: VendorPoStatus;
  size?: 'small' | 'medium';
}

/**
 * A purchase order's status on a DETAIL surface — Draft · Sent · Partly received · Received ·
 * Closed. Lists use `StatusDot` with the same label and colour (design-system.md "Status Badges"),
 * both read from lib/purchasing/vendorPoStatus.ts, so a PO's dot in the list and its chip on its
 * page can never disagree. The status itself is computed once, in SQL; this only names it.
 */
export default function VendorPoStatusChip({ status, size = 'small' }: VendorPoStatusChipProps) {
  const display = vendorPoStatusDisplay(status);
  return <StatusChip label={display.label} color={display.color} size={size} />;
}
