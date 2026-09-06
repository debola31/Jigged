'use client';

import { useEffect, useState } from 'react';
import Box from '@mui/material/Box';

import type { Job, JobPart } from '@/types/job';
import { FulfillmentStatusChip } from './JobStatusChip';
import { getJobShipmentSummary } from '@/utils/shipmentsAccess';
import type { JobShipmentSummary } from '@/types/shipment';

interface JobFulfillmentChipProps {
  job: Pick<Job, 'id' | 'fulfillment_status'>;
  parts: Array<Pick<JobPart, 'id' | 'quantity' | 'fulfillment_status'>>;
}

/**
 * The fulfillment chip, and only that.
 *
 * NARROWED FROM A BLOCK OF FOUR FIELDS. It began as a band above the page, then
 * became four rows inside the Job Details card — but the card lays its fields
 * out in two explicit columns now, and a component that renders four of them in
 * a fixed order cannot be split across columns. Production, Created and Due are
 * plain values the page renders itself; this is the one that is NOT plain.
 *
 * `Partially Shipped — 25 of 100` needs the shipment summary, which is fetched
 * lazily here. The chip renders immediately from the job row so the card's
 * layout is stable before that lands.
 */
export default function JobFulfillmentChip({ job, parts }: JobFulfillmentChipProps) {
  const [summary, setSummary] = useState<JobShipmentSummary | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const s = await getJobShipmentSummary(job.id);
        if (!cancelled) setSummary(s);
      } catch (err) {
        console.warn('JobFulfillmentChip: failed to load shipment summary', err);
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

  return fulfillmentLabel ? (
    // Override the chip label when we have a quantity breakdown.
    <FulfillmentStatusChipWithLabel status={job.fulfillment_status} label={fulfillmentLabel} />
  ) : (
    <FulfillmentStatusChip status={job.fulfillment_status} size="medium" />
  );
}

/**
 * Dates as the shop reads them, and a DATE-ONLY string is not a moment.
 * `due_date` is a plain `YYYY-MM-DD`; handing that to `new Date()` parses it as
 * UTC midnight and prints the day before for anyone west of Greenwich.
 * Exported because the job page prints Created and Due itself now.
 */
export function formatShipDate(value: string): string {
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
