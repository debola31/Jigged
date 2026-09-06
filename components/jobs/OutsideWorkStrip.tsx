'use client';

import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import LocalShippingIcon from '@mui/icons-material/LocalShipping';

import type { OutsideOperation } from '@/types/operator';

export interface OutsideWorkStripProps {
  /** The company-wide outside queue the Jobs page already loads for its At-vendor chip. */
  outsideOps: OutsideOperation[];
  onOpen: () => void;
}

/** Whole days since an ISO instant, floored. */
function daysSince(iso: string): number {
  return Math.floor((Date.now() - Date.parse(iso)) / 86_400_000);
}

/**
 * "Something is at a vendor" — the door, and nothing more.
 *
 * IT ONLY EXISTS WHILE SOMETHING IS OUT. That is the whole reason it earns a
 * place above the grid: on the days nothing is at a vendor — most days, for a
 * shop with three outside steps on the board — the Jobs page is exactly what it
 * was, with no empty state, no zero count and no column of dashes.
 *
 * IT COSTS NO QUERY. Every number here is derived from the outside queue the
 * page already loads to decide which rows get an At-vendor chip. The DRAWER
 * behind it pays for the detail, and only when someone opens it.
 *
 * The unit is JOBS, not pieces, because this is the jobs page and that is the
 * row the reader is about to look at. Quantities are the drawer's job — and
 * summing them here would need a second query to say something less useful.
 *
 * There is deliberately no send or receive here. Those live on the operation,
 * and a second place to act on the same row is what got the outside-work tab
 * deleted in Aug 2026 (docs/modules/jobs.md).
 */
export default function OutsideWorkStrip({ outsideOps, onOpen }: OutsideWorkStripProps) {
  const atVendor = outsideOps.filter((o) => o.status === 'sent');
  if (atVendor.length === 0) return null;

  const jobCount = new Set(atVendor.map((o) => o.job_id)).size;
  const vendorCount = new Set(atVendor.map((o) => o.vendor_id ?? o.vendor_name)).size;

  const ages = atVendor
    .map((o) => (o.sent_at ? daysSince(o.sent_at) : null))
    .filter((d): d is number => d !== null);
  const oldest = ages.length ? Math.max(...ages) : null;
  const oldestOp = oldest !== null
    ? atVendor.find((o) => o.sent_at && daysSince(o.sent_at) === oldest)
    : undefined;

  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 2,
        mb: 2,
        px: 2,
        py: 1.5,
        borderRadius: 1,
        // Amber, matching the At-vendor chip on the rows below and the operator's
        // own at-vendor line. One colour means one fact across three surfaces.
        bgcolor: 'rgba(245, 158, 11, 0.10)',
        border: '1px solid rgba(245, 158, 11, 0.35)',
        borderLeft: '3px solid',
        borderLeftColor: 'warning.main',
      }}
    >
      <LocalShippingIcon sx={{ color: 'warning.main', flexShrink: 0 }} />
      <Box sx={{ minWidth: 0 }}>
        <Typography variant="body1">
          <Box component="strong" sx={{ color: 'warning.light' }}>
            {jobCount} {jobCount === 1 ? 'job has' : 'jobs have'} parts
          </Box>{' '}
          at {vendorCount} {vendorCount === 1 ? 'vendor' : 'vendors'}
        </Typography>
        {oldest !== null && oldestOp && (
          <Typography variant="body2" color="text.secondary">
            Longest out: {oldestOp.job_number} at {oldestOp.vendor_name ?? 'a vendor'}
            {oldest === 0 ? ', sent today' : `, ${oldest} ${oldest === 1 ? 'day' : 'days'}`}
          </Typography>
        )}
      </Box>
      <Box sx={{ flex: 1 }} />
      {/**
       * AMBER, not the theme's default text-button blue, and MEASURED rather
       * than eyeballed.
       *
       * `lib/theme.ts` paints every text button `primary.light` (#6FA3D8)
       * regardless of its `color` prop -- which is right on the app's own
       * ground and wrong on this one. Against the amber-tinted band it measures
       * **3.83:1 at rest and 3.03:1 on hover**, where WCAG AA wants 4.5:1 for
       * normal text; hover is worse because it lightens the ground under a
       * light foreground. `warning.light` measures 6.09:1 and 4.81:1, passing
       * in both states, and it ties the action to the band it sits in.
       *
       * The underline is not decoration either: without it the only thing
       * marking this as a control is its hue, which is the same colour-alone
       * failure `StatusDot` exists to avoid.
       */}
      <Button
        onClick={onOpen}
        sx={{
          flexShrink: 0,
          whiteSpace: 'nowrap',
          color: 'warning.light',
          textDecoration: 'underline',
          '&:hover': { color: 'warning.light', textDecoration: 'underline' },
        }}
      >
        See what&apos;s out
      </Button>
    </Box>
  );
}
