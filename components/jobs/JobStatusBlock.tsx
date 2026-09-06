'use client';

import { useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';

import type { Job, JobPart } from '@/types/job';
import { ProductionStatusChip, FulfillmentStatusChip } from './JobStatusChip';
import { getJobShipmentSummary } from '@/utils/shipmentsAccess';
import type { JobShipmentSummary } from '@/types/shipment';

interface JobStatusBlockProps {
  job: Pick<Job, 'id' | 'production_status' | 'fulfillment_status' | 'created_at' | 'due_date'>;
  parts: Array<Pick<JobPart, 'id' | 'quantity' | 'fulfillment_status'>>;
}

/**
 * The job's status and dates, as rows INSIDE the Job Details card.
 *
 * This used to be a band of its own between the header and the page body. It
 * was four facts — production, fulfillment, created, due — sitting in a strip
 * that existed only to hold them, directly above a card whose entire job is to
 * hold facts about the job. Folding them in removes a whole horizontal band
 * from the page without losing anything.
 *
 * Still a component rather than inline markup because the fulfillment label is
 * not just the status: `Partially Shipped — 25 of 100` needs the shipment
 * summary, fetched lazily here. The chips render immediately from the job row
 * so the card's layout is stable before that lands.
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
    <>
      <Box>
        <Typography variant="caption" color="text.secondary">
          Production
        </Typography>
        <Box sx={{ mt: 0.25 }}>
          <ProductionStatusChip status={job.production_status} size="medium" />
        </Box>
      </Box>

      <Box>
        <Typography variant="caption" color="text.secondary">
          Fulfillment
        </Typography>
        <Box sx={{ mt: 0.25 }}>
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
      </Box>

      {job.created_at && (
        <Box>
          <Typography variant="caption" color="text.secondary">
            Created
          </Typography>
          <Typography fontWeight={500}>{formatShipDate(job.created_at)}</Typography>
        </Box>
      )}

      {job.due_date && (
        <Box>
          <Typography variant="caption" color="text.secondary">
            Due
          </Typography>
          <Typography fontWeight={500}>{formatShipDate(job.due_date)}</Typography>
        </Box>
      )}
    </>
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
