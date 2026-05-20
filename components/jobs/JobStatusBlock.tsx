'use client';

import { useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';

import type { Job, JobPart } from '@/types/job';
import { ProductionStatusChip, FulfillmentStatusChip } from './JobStatusChip';
import { getJobShipmentSummary } from '@/utils/shipmentsAccess';
import type { JobShipmentSummary } from '@/types/shipment';

interface JobStatusBlockProps {
  job: Pick<Job, 'id' | 'production_status' | 'fulfillment_status'>;
  parts: Array<Pick<JobPart, 'id' | 'quantity' | 'fulfillment_status'>>;
}

/**
 * Job-level status block rendered between the header (job_number + actions)
 * and the rest of the page. Two badges — production and fulfillment — side
 * by side with a sub-row when at least one shipment exists.
 *
 * Loads the shipment summary lazily on mount. The badges render
 * immediately from the job row so the layout is stable before the
 * shipment fetch completes (FR-NEW-2: status block under 200ms).
 */
export default function JobStatusBlock({ job, parts }: JobStatusBlockProps) {
  const [summary, setSummary] = useState<JobShipmentSummary | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const s = await getJobShipmentSummary(job.id);
        if (!cancelled) setSummary(s);
      } catch (err) {
        console.warn('JobStatusBlock: failed to load shipment summary', err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [job.id]);

  // "Partially Shipped — 5 of 10" formatting when partial. Uses the
  // server summary when available; falls back to the job_part sums so
  // the number is correct on first paint.
  const totals = parts.reduce(
    (acc, p) => {
      acc.ordered += Number(p.quantity);
      return acc;
    },
    { ordered: 0 },
  );
  const shipped = summary?.qty_shipped ?? null;
  const fulfillmentLabel =
    job.fulfillment_status === 'partially_shipped' && shipped !== null
      ? `Partially Shipped — ${shipped} of ${totals.ordered}`
      : undefined;

  return (
    <Box sx={{ mb: 3 }}>
      <Stack direction="row" spacing={2} alignItems="center" flexWrap="wrap">
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <Typography variant="caption" color="text.secondary" sx={{ textTransform: 'uppercase', letterSpacing: 0.5 }}>
            Production
          </Typography>
          <ProductionStatusChip status={job.production_status} size="medium" />
        </Box>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <Typography variant="caption" color="text.secondary" sx={{ textTransform: 'uppercase', letterSpacing: 0.5 }}>
            Fulfillment
          </Typography>
          {fulfillmentLabel ? (
            // Override the chip label when we have a quantity breakdown.
            <FulfillmentStatusChipWithLabel
              status={job.fulfillment_status}
              label={fulfillmentLabel}
            />
          ) : (
            <FulfillmentStatusChip status={job.fulfillment_status} size="medium" />
          )}
        </Box>
      </Stack>

      {summary && summary.shipment_count > 0 && (
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
          Last shipment:{' '}
          <Box component="span" sx={{ color: 'text.primary', fontWeight: 600 }}>
            {summary.latest_packing_slip_number}
          </Box>
          {summary.last_ship_date && ` · ${formatShipDate(summary.last_ship_date)}`}
          {summary.shipment_count > 1 && ` · ${summary.shipment_count} shipments`}
        </Typography>
      )}
    </Box>
  );
}

function formatShipDate(value: string): string {
  const ymd = /^\d{4}-\d{2}-\d{2}$/.exec(value);
  if (ymd) {
    const [y, m, d] = value.split('-').map((n) => parseInt(n, 10));
    return new Date(y, m - 1, d).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  }
  return new Date(value).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function FulfillmentStatusChipWithLabel({
  status,
  label,
}: {
  status: 'unshipped' | 'partially_shipped' | 'fully_shipped';
  label: string;
}) {
  // Render a custom-labeled chip when the partially_shipped breakdown
  // text needs to appear inline. Falls back to the default chip color
  // mapping (FULFILLMENT_STATUS_CONFIG) — see JobStatusChip.
  const color: 'default' | 'info' | 'success' =
    status === 'fully_shipped' ? 'success' : status === 'partially_shipped' ? 'info' : 'default';
  return (
    <Box
      sx={{
        display: 'inline-flex',
        alignItems: 'center',
        px: 1.25,
        height: 32,
        borderRadius: 16,
        bgcolor: (theme) =>
          color === 'success'
            ? theme.palette.success.main
            : color === 'info'
              ? theme.palette.info.main
              : theme.palette.grey[700],
        color: 'common.white',
        fontWeight: 500,
        fontSize: '0.8125rem',
      }}
    >
      {label}
    </Box>
  );
}
