'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import NextLink from 'next/link';
import {
  Card,
  CardContent,
  Box,
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
import { getJobPartMaterialCheck } from '@/utils/materialCheckAccess';
import type { MaterialRequirement } from '@/types/materialCheck';

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
 * "On order" is absent because purchase orders don't exist yet (Phase 3, #571). A permanently
 * empty column would just train people to ignore the row.
 */
export default function JobPartMaterialsCard({
  partId,
  jobId,
  jobPartId,
  orderQuantity,
}: JobPartMaterialsCardProps) {
  const params = useParams();
  const companyId = params.companyId as string;
  const [rows, setRows] = useState<MaterialRequirement[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    getJobPartMaterialCheck({
      companyId,
      jobId,
      jobPartId,
      madePartId: partId,
      orderQuantity: orderQuantity ?? 0,
    })
      .then((data) => {
        if (!cancelled) setRows(data);
      })
      .catch(() => {
        if (!cancelled) setRows([]);
      });
    return () => {
      cancelled = true;
    };
  }, [companyId, jobId, jobPartId, partId, orderQuantity]);

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
          {oddCount > 0 && (
            <Chip size="small" variant="outlined" label={`${oddCount} need attention`} />
          )}
        </Box>

        {rows === null ? (
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

function MaterialRow({ row, companyId }: { row: MaterialRequirement; companyId: string }) {
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
    </TableRow>
  );
}
