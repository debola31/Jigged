'use client';

import Box from '@mui/material/Box';
import ButtonBase from '@mui/material/ButtonBase';
import Typography from '@mui/material/Typography';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
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
 *
 * THE WHOLE BAND IS THE BUTTON, and it is a real `<button>` rather than a Box
 * with an onClick — so it takes keyboard focus, announces itself as a control,
 * and fires on Enter and Space for free. It replaced a small text link parked
 * at the far right of a ~1400px band: the band says exactly one thing and does
 * exactly one thing, so carving it into a clickable region and an inert one
 * only asked the reader to find the boundary.
 *
 * That has one hard consequence: NOTHING INSIDE MAY BE INTERACTIVE. A nested
 * button is invalid HTML and gives the row two competing accessible names, so
 * "See what's out" is now a plain span — the affordance, not the control. If a
 * second action is ever wanted here, the band stops being a button first.
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
    <ButtonBase
      onClick={onOpen}
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 2,
        width: '100%',
        mb: 2,
        px: 2,
        py: 1.5,
        borderRadius: 1,
        textAlign: 'left',
        justifyContent: 'flex-start',
        // Amber, matching the At-vendor chip on the rows below and the operator's
        // own at-vendor line. One colour means one fact across three surfaces.
        bgcolor: 'rgba(245, 158, 11, 0.10)',
        border: '1px solid rgba(245, 158, 11, 0.35)',
        borderLeft: '3px solid',
        borderLeftColor: 'warning.main',
        transition: 'background-color 120ms ease, border-color 120ms ease',
        // HOVER LIGHTENS THE GROUND, WHICH IS THE WORSE CASE FOR CONTRAST, so
        // the lift is deliberately small and the rest of the feedback is spent
        // on the border instead. MEASURED off the rendered page, sampling the
        // lightest pixel at the band's right end -- where the 135deg page
        // gradient and the ambient backdrop's glow are both at their brightest,
        // and where the affordance happens to sit. `warning.light` there is
        // 5.27:1 at rest and 4.93:1 hovered, against AA's 4.5:1 for normal
        // text. The same lift at 0.16 measured 4.78:1 hovered: the extra alpha
        // is not visible and the margin is.
        '&:hover': {
          bgcolor: 'rgba(245, 158, 11, 0.14)',
          borderColor: 'rgba(245, 158, 11, 0.55)',
          borderLeftColor: 'warning.main',
        },
        // ButtonBase ships no focus ring of its own. Without this the keyboard
        // path to the drawer is invisible.
        '&:focus-visible': {
          outline: '2px solid',
          outlineColor: 'warning.light',
          outlineOffset: '2px',
        },
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
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 0.5,
          flexShrink: 0,
          color: 'warning.light',
          fontWeight: 600,
          whiteSpace: 'nowrap',
        }}
      >
        <Typography variant="button" sx={{ color: 'inherit', fontWeight: 'inherit' }}>
          See what&apos;s out
        </Typography>
        <ChevronRightIcon fontSize="small" />
      </Box>
    </ButtonBase>
  );
}
