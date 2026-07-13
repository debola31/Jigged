'use client';

import { useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import TextField from '@mui/material/TextField';
import CircularProgress from '@mui/material/CircularProgress';
import {
  calculateRoutingCost,
  type RoutingCostBreakdown,
} from '@/utils/routingCostCalculation';
import { isValidQuantityInput } from '@/lib/quantityInput';
import { unitShortLabel } from '@/lib/standardUnits';

interface CostAtQtyPreviewProps {
  partId: string;
  /** Bumped by the parent when routing/BOM/pricing changes, to refresh. */
  refreshKey?: number;
}

function formatCurrency(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value);
}

function formatQty(n: number): string {
  return Number.isInteger(n) ? String(n) : Number(n.toFixed(4)).toString();
}

/**
 * "Cost at qty N" preview for a made part's Pricing card.
 *
 * Whole-unit (ceiling) and batch-pinned materials make per-part cost a step
 * function of the order quantity — order 20 consumes 1 strip ($5.45/part),
 * order 21 rounds up to 2 strips ($10.38/part). The per-tier markup table can't
 * show that, so this box lets the user punch in a quantity and see the actual
 * material consumption + per-part cost the quote engine would produce. It calls
 * the same `calculateRoutingCost(partId, N)` the quote snapshot uses, so the
 * number shown is the number quoted.
 */
export default function CostAtQtyPreview({ partId, refreshKey = 0 }: CostAtQtyPreviewProps) {
  const [qtyInput, setQtyInput] = useState('1');
  const [breakdown, setBreakdown] = useState<RoutingCostBreakdown | null>(null);
  const [loading, setLoading] = useState(false);

  const qty = Number(qtyInput);
  const qtyValid = Number.isFinite(qty) && qty > 0;

  // Debounced recompute — calculateRoutingCost hits cost RPCs, so don't fire on
  // every keystroke. No AI involved (pure cost math), safe to run on change.
  useEffect(() => {
    if (!qtyValid) {
      setBreakdown(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    const handle = setTimeout(() => {
      calculateRoutingCost(partId, qty)
        .then((b) => {
          if (!cancelled) setBreakdown(b);
        })
        .catch(() => {
          if (!cancelled) setBreakdown(null);
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [partId, qty, qtyValid, refreshKey]);

  const materials = breakdown?.material_items ?? [];
  const materialPerUnit =
    breakdown && breakdown.total_material_cost !== null ? breakdown.total_material_cost : null;
  // Any material line whose consumption doesn't scale linearly with qty (ceiling
  // rounded up, so units_consumed ≠ qty × per-part) is worth calling out.
  const hasCeiling = materials.some(
    (m) => m.consume_whole_units && Math.abs(m.units_consumed - qty * m.qty_in_primary) > 1e-9,
  );

  return (
    <Box
      sx={{
        mt: 2,
        p: 1.5,
        border: (theme) => `1px dashed ${theme.palette.divider}`,
        borderRadius: 1,
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, flexWrap: 'wrap' }}>
        <Typography variant="body2" sx={{ fontWeight: 600 }}>
          Cost at quantity
        </Typography>
        <TextField
          size="small"
          value={qtyInput}
          onChange={(e) => {
            if (isValidQuantityInput(e.target.value)) setQtyInput(e.target.value);
          }}
          inputMode="decimal"
          sx={{ width: 100 }}
        />
        {loading && <CircularProgress size={16} />}
      </Box>

      {qtyValid && !loading && breakdown && (
        <Box sx={{ mt: 1.5 }}>
          {materials.length > 0 ? (
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.25 }}>
              {materials.map((m, i) => {
                const short = unitShortLabel(m.unit) ?? m.unit;
                return (
                  <Typography key={`${m.item_name}-${i}`} variant="caption" color="text.secondary">
                    {m.item_name}: needs{' '}
                    <strong>
                      {formatQty(m.units_consumed)} {short}
                    </strong>{' '}
                    × {formatCurrency(m.cost_per_unit)} = {formatCurrency(m.units_consumed * m.cost_per_unit)}
                    {m.consume_whole_units ? ' (whole-unit)' : ''} →{' '}
                    {formatCurrency(m.cost)}/part
                  </Typography>
                );
              })}
            </Box>
          ) : (
            <Typography variant="caption" color="text.secondary">
              No materials on this part.
            </Typography>
          )}
          <Typography variant="body2" sx={{ mt: 0.75, fontWeight: 600 }}>
            Materials / part: {formatCurrency(materialPerUnit)}
            {hasCeiling && (
              <Typography component="span" variant="caption" color="text.secondary" sx={{ ml: 1 }}>
                (rounds up to whole units at this qty)
              </Typography>
            )}
          </Typography>
        </Box>
      )}
      {qtyValid && !loading && !breakdown && (
        <Typography variant="caption" color="text.secondary" sx={{ mt: 1, display: 'block' }}>
          No routing or BOM to cost yet.
        </Typography>
      )}
    </Box>
  );
}
