'use client';

import { useParams } from 'next/navigation';
import NextLink from 'next/link';
import {
  Alert,
  Button,
  Card,
  CardContent,
  Box,
  Link as MuiLink,
  Typography,
  Chip,
  CircularProgress,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Tooltip,
} from '@mui/material';
import Inventory2OutlinedIcon from '@mui/icons-material/Inventory2Outlined';
import { useLoad } from '@/hooks/useLoad';
import { purchasingHubPath, vendorPoPath } from '@/lib/purchasingRoutes';
import { formatShortDate } from '@/lib/purchasing/priceDefault';
import { getJobPartMaterialCheck } from '@/utils/materialCheckAccess';
import type { MaterialCheckRow } from '@/types/materialCheck';

interface JobPartMaterialsCardProps {
  /** The made part this job_part produces (job_parts.part_id). */
  partId: string;
  /** Parent job — scopes the "issued" figures. */
  jobId: string;
  jobPartId: string;
  /** The job_part order quantity; the whole-order draw is computed from it. */
  orderQuantity?: number;
}

const fmt = (n: number): string => n.toLocaleString(undefined, { maximumFractionDigits: 4 });

const HEAD_SX = {
  fontSize: 11,
  letterSpacing: '0.08em',
  textTransform: 'uppercase' as const,
  color: 'text.secondary',
  fontWeight: 600,
  whiteSpace: 'nowrap' as const,
};

/** Digits line up column to column, so an outlier is visible without reading a label. */
const NUM_SX = { fontVariantNumeric: 'tabular-nums' as const };

/**
 * Material check for a job part — journey J4: *"can I say yes to this rush job right now?"*
 *
 * Required comes from the LIVE BOM (not the `job_materials` snapshot, which nothing reads),
 * on-hand from `parts.quantity`, and issued from this job's `depletion` ledger rows. Nothing
 * is stored; every figure is derived on read.
 *
 * Two honesty constraints are deliberate:
 *
 *  - **Top-level materials only.** `parts_bom` is recursive but this compares one level, so a
 *    pump job says "needs 1 pump core" and not the aluminium inside it. This used to carry a
 *    caption saying so; it was removed as page furniture, so the limitation now lives here and
 *    nowhere the reader can see. If the one-level comparison ever produces a number somebody
 *    acts on wrongly, the caption is the fix to reach for first.
 *  - **Units that can't be converted show an em dash, never a zero.** A 0 in Short by reads as
 *    "you're fine", which is the one answer we must not give when we can't actually compare.
 *
 * **On order sits beside Short by and never nets it** (plan §3.10). Short by answers J4 — what is
 * missing from the shelf right now — and steel on a purchase order is not on the shelf. The column
 * shows the SENT POs with their numbers and due dates, and drafts muted and apart ("+144 on
 * draft"): the vendor has not seen a draft, so it is not on order. The buy list is where orders are
 * netted against need, and "See shortages" opens the Purchasing page's Shortages on this job.
 *
 * **A failed load is an error with Retry**, never "No materials on this part's BOM" — the empty
 * state is the one thing a failure must not say.
 */
export default function JobPartMaterialsCard({
  partId,
  jobId,
  jobPartId,
  orderQuantity,
}: JobPartMaterialsCardProps) {
  const params = useParams();
  const companyId = params.companyId as string;
  const { data, loading, error, reload } = useLoad(
    () =>
      getJobPartMaterialCheck({
        companyId,
        jobId,
        jobPartId,
        madePartId: partId,
        orderQuantity: orderQuantity ?? 0,
      }),
    [companyId, jobId, jobPartId, partId, orderQuantity ?? 0],
  );
  // Rows only from a load that SUCCEEDED: a failure keeps whatever was there before, and a first
  // failure would otherwise fall through to the empty state.
  const rows: MaterialCheckRow[] | null = error ? null : data;

  const shortCount = (rows ?? []).filter((r) => r.status === 'short').length;
  const oddCount = (rows ?? []).filter(
    (r) => r.status === 'incomparable' || r.status === 'archived',
  ).length;

  return (
    <Card elevation={2}>
      <CardContent>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1.5, flexWrap: 'wrap' }}>
          <Inventory2OutlinedIcon fontSize="small" color="primary" />
          <Typography variant="h6" sx={{ fontWeight: 600 }}>
            Materials
          </Typography>
          {/*
            Deliberately NOT a link, and that is the third state this chip has had.
            It pointed at `/inventory/shortages` (a route never built, so it 404'd), then at
            `/dashboard/{id}/parts?status=low` once the Parts stock filter became the shop-wide
            shortage lens. That filter is gone: Parts is the item master and carries no
            quantities, so there is no shop-wide shortage lens to point at. An unknown query
            param does not 404 — it is silently ignored — so keeping the href would have left a
            chip that loads a full, unfiltered catalogue and looks like it worked. Plain text is
            the honest answer until Storage grows a shortage view.
          */}
          {shortCount > 0 && (
            <Chip size="small" color="warning" label={`${shortCount} short`} />
          )}
          {/* The next step for a shortage, beside the chip rather than inside it: the chip stays
              plain text (see above), and this names where it goes. */}
          {shortCount > 0 && (
            <MuiLink
              component={NextLink}
              href={`${purchasingHubPath(companyId, 'shortages')}&job=${encodeURIComponent(jobId)}`}
              variant="body2"
            >
              See shortages
            </MuiLink>
          )}
          {oddCount > 0 && (
            <Chip size="small" variant="outlined" label={`${oddCount} need attention`} />
          )}
        </Box>

        {error ? (
          <Alert
            severity="error"
            action={
              <Button color="inherit" size="small" onClick={() => void reload()}>
                Retry
              </Button>
            }
          >
            Couldn&apos;t load the materials for this part.
          </Alert>
        ) : loading || rows === null ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 2 }}>
            <CircularProgress size={20} />
          </Box>
        ) : rows.length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            No materials on this part&apos;s BOM.
          </Typography>
        ) : (
          <>
            <TableContainer>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell sx={HEAD_SX}>Material</TableCell>
                    <TableCell align="right" sx={HEAD_SX}>Needs</TableCell>
                    <TableCell align="right" sx={HEAD_SX}>On hand</TableCell>
                    <TableCell align="right" sx={HEAD_SX}>Issued</TableCell>
                    <TableCell align="right" sx={HEAD_SX}>Short by</TableCell>
                    <TableCell align="right" sx={HEAD_SX}>On order</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {rows.map((r) => (
                    <MaterialRow key={r.bomLineId} row={r} companyId={companyId} />
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function MaterialRow({ row, companyId }: { row: MaterialCheckRow; companyId: string }) {
  const unit = row.stockUnit ?? row.bomUnit;

  return (
    <TableRow>
      <TableCell sx={{ width: '99%' }}>
        <Typography
          variant="body2"
          component={NextLink}
          href={`/dashboard/${companyId}/parts/${row.partId}`}
          sx={{ fontWeight: 500, color: 'inherit', textDecoration: 'none', '&:hover': { textDecoration: 'underline' } }}
        >
          {row.partName}
        </Typography>
        <Box sx={{ display: 'flex', gap: 0.5, mt: 0.25, flexWrap: 'wrap' }}>
          {row.status === 'incomparable' && (
            <Tooltip
              title={`The BOM line is in ${row.basis.kind === 'incomparable' ? row.basis.bomUnit : row.bomUnit}, but stock is counted in ${unit}. Add a conversion on this part to compare them.`}
            >
              <Chip size="small" color="warning" variant="outlined" label="Can't compare units" />
            </Tooltip>
          )}
          {row.status === 'archived' && (
            <Chip size="small" variant="outlined" label="Archived material" />
          )}
          {row.hasDiscrepancy && (
            <Chip size="small" color="warning" variant="outlined" label="Shortfall recorded" />
          )}
          {/* The heats issued to this job for this material — what the packing slip will print.
              One chip per heat, only when one was recorded; nothing is the normal state. */}
          {row.heatNumbers.map((heat) => (
            <Tooltip key={heat} title="Heat number on the material issued to this job">
              <Chip size="small" variant="outlined" label={`Heat ${heat}`} />
            </Tooltip>
          ))}
        </Box>
      </TableCell>

      <TableCell align="right" sx={{ ...NUM_SX, whiteSpace: 'nowrap' }}>
        {fmt(row.requiredInBomUnit)} {row.bomUnit}
      </TableCell>

      <TableCell align="right" sx={{ ...NUM_SX, whiteSpace: 'nowrap' }}>
        {fmt(row.onHand)} {unit}
      </TableCell>

      <TableCell align="right" sx={{ ...NUM_SX, whiteSpace: 'nowrap' }}>
        {row.issued > 0 ? `${fmt(row.issued)} ${unit}` : '—'}
      </TableCell>

      {/* An em dash, never a zero: we don't know, and "0" would read as "you're fine". */}
      <TableCell align="right" sx={{ ...NUM_SX, whiteSpace: 'nowrap' }}>
        {row.shortBy === null ? (
          <Typography component="span" variant="body2" color="text.disabled">
            —
          </Typography>
        ) : row.shortBy > 0 ? (
          <Typography component="span" variant="body2" sx={{ ...NUM_SX, fontWeight: 700, color: 'warning.main' }}>
            {fmt(row.shortBy)} {unit}
          </Typography>
        ) : (
          <Typography component="span" variant="body2" color="text.disabled">
            —
          </Typography>
        )}
      </TableCell>

      <TableCell align="right" sx={{ ...NUM_SX, whiteSpace: 'nowrap' }}>
        <OnOrderCell row={row} companyId={companyId} />
      </TableCell>
    </TableRow>
  );
}

/**
 * Sent POs one per line — "PO-1042 · 288 each · due 3/9/26" — then drafts, muted and summed
 * ("+144 each on draft"), never as a PO link: a draft has not gone to the vendor. In the stock
 * unit, the same figures `part_on_order` gives the buy list and MCP.
 */
function OnOrderCell({ row, companyId }: { row: MaterialCheckRow; companyId: string }) {
  const unit = row.stockUnit ?? row.bomUnit;
  const sent = row.onOrderRefs.filter((r) => !r.isDraft);
  const onDraft = row.onDraft ?? 0;
  if (sent.length === 0 && onDraft <= 0) {
    return (
      <Typography component="span" variant="body2" color="text.disabled">
        —
      </Typography>
    );
  }
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 0.25 }}>
      {sent.map((ref) => (
        <Typography key={ref.vendorPurchaseOrderId} component="span" variant="body2" sx={NUM_SX}>
          <MuiLink component={NextLink} href={vendorPoPath(companyId, ref.vendorPurchaseOrderId)}>
            {ref.poNumber}
          </MuiLink>
          {` · ${fmt(ref.stockQuantity)} ${unit}`}
          {ref.expectedOn ? ` · due ${formatShortDate(ref.expectedOn)}` : ''}
        </Typography>
      ))}
      {onDraft > 0 && (
        <Typography component="span" variant="caption" color="text.secondary" sx={NUM_SX}>
          {`+${fmt(onDraft)} ${unit} on draft`}
        </Typography>
      )}
    </Box>
  );
}
