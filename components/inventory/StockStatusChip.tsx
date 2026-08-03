'use client';

import Chip from '@mui/material/Chip';

export type StockStatus = 'out' | 'low' | 'in_stock';

/**
 * Pure derivation of stock status from a part's quantity-on-hand and reorder
 * point. Exported separately so tests can hit the function without rendering
 * the chip.
 *
 * Out: quantity is 0 (regardless of reorder).
 * Low: quantity > 0 and quantity <= reorder_point (only meaningful when
 *      reorder_point is set).
 * In stock: quantity > 0 and either reorder_point is null, or quantity is
 *           above the reorder point.
 */
export function deriveStockStatus(
  quantity: number | null | undefined,
  reorderPoint: number | null | undefined,
): StockStatus {
  const q = Number(quantity ?? 0);
  if (q === 0) return 'out';
  if (reorderPoint !== null && reorderPoint !== undefined && q <= Number(reorderPoint)) {
    return 'low';
  }
  return 'in_stock';
}

/**
 * How many units short of the reorder point, or null when the question doesn't apply.
 *
 * Derived, never stored — same discipline as `deriveStockStatus`, so the two cannot disagree.
 * Returns **0 at equality** rather than null: a part sitting exactly on its reorder point IS at
 * the line and belongs on the buy list; collapsing that to "no shortfall" would quietly drop the
 * row the reorder point exists to catch.
 */
export function shortfall(
  quantity: number | null | undefined,
  reorderPoint: number | null | undefined,
): number | null {
  if (reorderPoint === null || reorderPoint === undefined) return null;
  const q = Number(quantity ?? 0);
  const r = Number(reorderPoint);
  if (q > r) return null;
  return r - q;
}

interface Visual {
  label: string;
  color: string;
  border: string;
}

const visuals: Record<StockStatus, Visual> = {
  out: { label: 'Out of stock', color: '#ef9a9a', border: 'rgba(239, 154, 154, 0.5)' },
  low: { label: 'Low', color: '#ffcc80', border: 'rgba(255, 204, 128, 0.5)' },
  in_stock: { label: 'In stock', color: '#a5d6a7', border: 'rgba(165, 214, 167, 0.5)' },
};

interface StockStatusChipProps {
  status: StockStatus;
}

/**
 * Outlined status chip used in the Inventory list. Visual treatment matches
 * PartTypeChip (chunk 19): outlined, no icon, transparent background, accent
 * color on text and border. Literal hex values mirror PartTypeChip's approach;
 * a follow-up cleanup can migrate both chips to theme palette tokens.
 */
export default function StockStatusChip({ status }: StockStatusChipProps) {
  const v = visuals[status];
  return (
    <Chip
      label={v.label}
      size="small"
      variant="outlined"
      sx={{
        fontWeight: 500,
        letterSpacing: 0.2,
        bgcolor: 'transparent',
        border: '1px solid',
        color: v.color,
        borderColor: v.border,
      }}
    />
  );
}
