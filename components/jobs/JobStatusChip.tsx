import StatusChip from '@/components/common/StatusChip';
import type { ProductionStatus, FulfillmentStatus } from '@/types/job';
import { PRODUCTION_STATUS_CONFIG, FULFILLMENT_STATUS_CONFIG } from '@/types/job';

/**
 * Production-status badge (Not Started / In Progress / Completed / Cancelled).
 * Sourced from job.production_status / job_parts.production_status — set by
 * operator activity and the aggregation trigger.
 */
export function ProductionStatusChip({
  status,
  size = 'small',
}: {
  status: ProductionStatus;
  size?: 'small' | 'medium';
}) {
  const config = PRODUCTION_STATUS_CONFIG[status] || {
    label: status,
    color: 'default' as const,
  };
  return (
    <StatusChip label={config.label} color={config.color} size={size} sx={{ fontWeight: 500 }} />
  );
}

/**
 * Fulfillment-status badge (Not Shipped / Partially Shipped / Shipped).
 * Sourced from job.fulfillment_status / job_parts.fulfillment_status —
 * derived from shipments in PR 4.
 */
export function FulfillmentStatusChip({
  status,
  size = 'small',
}: {
  status: FulfillmentStatus;
  size?: 'small' | 'medium';
}) {
  const config = FULFILLMENT_STATUS_CONFIG[status] || {
    label: status,
    color: 'default' as const,
  };
  return (
    <StatusChip label={config.label} color={config.color} size={size} sx={{ fontWeight: 500 }} />
  );
}

// Backwards-compatible default export: kept for callers that imported the
// pre-split JobStatusChip. PR 5 (JobStatusBlock) replaces those call sites
// with explicit Production/Fulfillment chips, after which this default
// export can be removed.
export default ProductionStatusChip;
