'use client';

import NextLink from 'next/link';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import MuiLink from '@mui/material/Link';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';

import { vendorPoPath } from '@/lib/purchasingRoutes';
import { formatShortDate } from '@/lib/purchasing/priceDefault';
import { formatUnitQuantity, unitLabel } from '@/lib/purchasing/purchaseUnits';
import { VENDOR_PO_OVERDUE } from '@/lib/purchasing/vendorPoStatus';
import type { VendorPoJobLine } from '@/types/vendorPo';

export interface JobPartBuyingLineProps {
  companyId: string;
  jobPartId: string;
  /**
   * The job's vendor PO lines (`listVendorPoLinesForJob`), every kind — this keeps only the part
   * lines for THIS job part. `null` when they could not be read, which is never "none".
   */
  lines: readonly VendorPoJobLine[] | null;
  /** Offer "Buy it". False once the part has shipped or the job is cancelled: nothing to buy for. */
  canBuy: boolean;
  /** Re-read the lines after a failed load. */
  onRetry?: () => void;
}

/** "40 of 100 ea received" — in the line's purchase unit, as it reads on the PO. */
function progressText(line: VendorPoJobLine): string {
  return `${formatUnitQuantity(line.receivedQuantity)} of ${formatUnitQuantity(line.quantity)} ${unitLabel(line.unit)} received`;
}

function BuyingRow({ line, companyId }: { line: VendorPoJobLine; companyId: string }) {
  const isDraft = line.status === 'draft';
  // Still owed something: the due date is a promise worth stating, and Overdue a fact about it.
  const outstanding = line.status === 'open' || line.status === 'partially_received';
  return (
    <Typography variant="body2" color="text.secondary" data-testid="job-part-buying-line">
      {isDraft ? 'Draft ' : 'Bought · '}
      <MuiLink component={NextLink} href={vendorPoPath(companyId, line.vendorPurchaseOrderId)} sx={{ fontWeight: 500 }}>
        {line.poNumber}
      </MuiLink>
      {` (${line.vendorName})`}
      {isDraft
        ? ' · not sent yet'
        : ` · ${progressText(line)}${line.status === 'closed' ? ' · closed short' : ''}`}
      {outstanding && line.expectedOn ? ` · due ${formatShortDate(line.expectedOn)}` : ''}
      {outstanding && line.isLate && (
        <>
          {' · '}
          {/* Amber, and in words: a late PO is behind, not broken. */}
          <Box component="span" sx={{ color: 'warning.light', fontWeight: 600 }}>
            {VENDOR_PO_OVERDUE.label}
          </Box>
        </>
      )}
    </Typography>
  );
}

/**
 * The purchasing line under a BOUGHT part on the job page, where "No operations on this part."
 * used to sit (plan §3.13 "Elsewhere").
 *
 * A bought job part is `completed` the moment the job is created (it has nothing to make), so its
 * production status says nothing about whether anyone ordered it. This is where the page says so:
 * "Bought · PO-1042 (Acme) · 40 of 100 ea received · due 3/4/26", or "Not on a purchase order · Buy
 * it", which opens a new PO with the job part on it. Receiving never moves the part's status — the
 * founder decision that there is no "received" gate on a bought part.
 *
 * READ FROM THE JOB PAGE'S ONE READ of the job's PO lines, which also feeds the operation cards and
 * the Vendor POs row — so the three can never disagree about which POs the job is on.
 *
 * A FAILED READ IS NOT "NOT ON A PURCHASE ORDER." Saying so would offer "Buy it" for a part that is
 * already on a PO, which is how a shop orders it twice.
 */
export default function JobPartBuyingLine({ companyId, jobPartId, lines, canBuy, onRetry }: JobPartBuyingLineProps) {
  if (lines === null) {
    return (
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, pl: 1, flexWrap: 'wrap' }}>
        <Typography variant="body2" sx={{ color: 'error.light' }}>
          Couldn&apos;t check its purchase orders.
        </Typography>
        {onRetry && (
          <Button size="small" onClick={onRetry}>
            Retry
          </Button>
        )}
      </Box>
    );
  }

  const mine = lines.filter((l) => l.lineKind === 'part' && l.jobPartId === jobPartId);

  if (mine.length === 0) {
    return (
      <Typography variant="body2" color="text.secondary" sx={{ pl: 1 }} data-testid="job-part-buying-line">
        Not on a purchase order
        {canBuy && (
          <>
            {' · '}
            <MuiLink
              component={NextLink}
              href={`${vendorPoPath(companyId, 'new')}?jobPart=${encodeURIComponent(jobPartId)}`}
              sx={{ fontWeight: 500 }}
            >
              Buy it
            </MuiLink>
          </>
        )}
      </Typography>
    );
  }

  return (
    <Stack spacing={0.5} sx={{ pl: 1 }}>
      {mine.map((line) => (
        <BuyingRow key={line.lineId} line={line} companyId={companyId} />
      ))}
    </Stack>
  );
}

/**
 * What goes where a job part with no operations used to say "No operations on this part.":
 *   - `buying` — the buying line: the part is on a vendor PO (a made part bought whole from a
 *     subcontractor counts), or it is a bought part. A bought part whose PO lines could not be read
 *     lands here too, so the line can say so with its Retry;
 *   - `plain`  — the old sentence: a made part with no routing, on no PO;
 *   - `pending` — nothing yet: a read it depends on is still in flight, so neither sentence flashes.
 */
export function noOperationsSlot(args: {
  jobPartId: string;
  /** `parts.source`, when known. */
  partSource: string | null | undefined;
  /** The job's vendor PO lines; `null` when unknown. */
  lines: readonly VendorPoJobLine[] | null;
  /** The PO lines or the part's source are still loading. */
  pending: boolean;
}): 'buying' | 'plain' | 'pending' {
  if ((args.lines ?? []).some((l) => l.lineKind === 'part' && l.jobPartId === args.jobPartId)) return 'buying';
  if (args.pending) return 'pending';
  return args.partSource === 'bought' ? 'buying' : 'plain';
}

/**
 * The job's vendor POs, once each — the one "Vendor POs" row in the Job Details card.
 *
 * NOT A TOOLBAR MENU. The job page already refused a second document menu beside Shipments because
 * the two were easy to confuse, and a job's POs already show where they act: the bought-part line,
 * the operation card and the Materials card. This row is the index of them. It renders nothing
 * when the job is on no PO, and nothing while the lines are unknown (the buying line carries that
 * error, with its Retry).
 */
export function JobVendorPosSummary({
  companyId,
  lines,
}: {
  companyId: string;
  lines: readonly VendorPoJobLine[] | null;
}) {
  if (!lines || lines.length === 0) return null;
  const pos = new Map<string, { poNumber: string; vendorName: string }>();
  for (const l of lines) {
    if (!pos.has(l.vendorPurchaseOrderId)) pos.set(l.vendorPurchaseOrderId, { poNumber: l.poNumber, vendorName: l.vendorName });
  }
  const entries = [...pos.entries()];
  return (
    <Box>
      <Typography variant="caption" color="text.secondary">
        Vendor POs
      </Typography>
      <Box sx={{ display: 'flex', flexWrap: 'wrap', columnGap: 1.5, rowGap: 0.5 }}>
        {entries.map(([poId, po]) => (
          <Typography key={poId} component="span" fontWeight={500}>
            <MuiLink component={NextLink} href={vendorPoPath(companyId, poId)}>
              {po.poNumber}
            </MuiLink>
            <Typography component="span" variant="body2" color="text.secondary">
              {` (${po.vendorName})`}
            </Typography>
          </Typography>
        ))}
      </Box>
    </Box>
  );
}
