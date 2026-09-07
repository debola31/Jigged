'use client';

import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Typography from '@mui/material/Typography';
import Chip from '@mui/material/Chip';

import type { Part, PartUnitConversion } from '@/types/part';
import PartTransactionHistoryTable from '@/components/parts/PartTransactionHistoryTable';
import PartUnitConversionsEditor from '@/components/parts/PartUnitConversionsEditor';
import PartLocationInventory from '@/components/parts/PartLocationInventory';

interface InventoryTabProps {
  part: Part;
  partId: string;
  companyId: string;
  transactionsRefreshKey: number;
  /** Feeds the location modal's unit dropdown — see `unitOptions` in PartLocationInventory. */
  unitConversions: PartUnitConversion[];
  onConversionsChanged: (next: PartUnitConversion[]) => void;
  /** Refresh the part (rollup quantity + history) after a location change. */
  onStockChanged: () => void | Promise<void>;
}

/**
 * Stock management for stocked parts: current on-hand, the Add/Remove/Adjust
 * controls (the transaction modal itself is owned by PartWorkspace), unit
 * conversions, and the transaction ledger. Lifted verbatim from the previous
 * monolithic page.
 */
export default function InventoryTab({
  part,
  partId,
  companyId,
  transactionsRefreshKey,
  unitConversions,
  onConversionsChanged,
  onStockChanged,
}: InventoryTabProps) {
  const belowReorder =
    part.reorder_point !== null && part.quantity <= part.reorder_point;

  return (
    <Card elevation={2}>
      <CardContent sx={{ textAlign: 'center', py: 4 }}>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
          Current Stock
        </Typography>
        <Typography
          variant="h2"
          sx={{ fontWeight: 700, color: part.quantity <= 0 ? 'error.main' : 'text.primary' }}
        >
          {part.quantity.toLocaleString(undefined, { maximumFractionDigits: 4 })}
        </Typography>
        <Typography variant="h5" color="text.secondary">
          {part.primary_unit ?? ''}
        </Typography>

        {belowReorder && (
          <Chip
            size="small"
            label={`Below reorder point (${part.reorder_point} ${part.primary_unit ?? ''})`}
            color="error"
            sx={{ mt: 2, fontWeight: 500 }}
          />
        )}

        {/*
          One engine, for every part.

          This used to branch on `is_location_tracked`: tracked parts got
          `PartLocationInventory` (per-place balances, atomic RPCs, a ledger row per movement)
          and untracked parts got three buttons writing `parts.quantity` directly from the
          browser. Which one you saw was decided by a trigger gated on a company feature flag,
          so the same screen behaved structurally differently for two shops.

          The column is gone (20260802015837) and so is the second engine. A shop that does not
          manage places still sees Add / Remove / Adjust here — they just name the one place there is,
          through the same RPC as everyone else, with the same history.
        */}
        <Box sx={{ mt: 4 }}>
          <PartLocationInventory
            part={part}
            partId={partId}
            companyId={companyId}
            unitConversions={unitConversions}
            onStockChanged={onStockChanged}
          />
        </Box>

        {/* Unit conversions — inline-editable list. */}
        {part.primary_unit && (
          <Box sx={{ mt: 4, textAlign: 'left' }}>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
              Unit conversions
            </Typography>
            <PartUnitConversionsEditor
              partId={partId}
              primaryUnit={part.primary_unit}
              onChanged={onConversionsChanged}
            />
          </Box>
        )}

        {!part.primary_unit && (
          <Typography variant="caption" color="text.secondary" sx={{ mt: 1, display: 'block' }}>
            Set a primary unit on this part before recording stock transactions.
          </Typography>
        )}

        {/* Transaction history — left-aligned (the parent CardContent is centred
            for the stock display). */}
        <Box sx={{ mt: 4, textAlign: 'left' }}>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
            Transaction history
          </Typography>
          <PartTransactionHistoryTable
            partId={partId}
            companyId={companyId}
            primaryUnit={part.primary_unit ?? ''}
            refreshKey={transactionsRefreshKey}
          />
        </Box>
      </CardContent>
    </Card>
  );
}
