'use client';

import { useState } from 'react';
import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Alert from '@mui/material/Alert';
import AddIcon from '@mui/icons-material/Add';
import RemoveIcon from '@mui/icons-material/Remove';
import TuneIcon from '@mui/icons-material/Tune';
import LocationOnOutlinedIcon from '@mui/icons-material/LocationOnOutlined';

import type { Part, PartUnitConversion } from '@/types/part';
import type { InventoryTransactionType } from '@/types/partTransaction';
import PartTransactionHistoryTable from '@/components/parts/PartTransactionHistoryTable';
import PartUnitConversionsEditor from '@/components/parts/PartUnitConversionsEditor';
import PartLocationInventory from '@/components/parts/PartLocationInventory';
import { enableLocationTracking } from '@/utils/inventoryLocationsAccess';
import { useCompanyFeatures } from '@/hooks/useCompanyFeatures';

interface InventoryTabProps {
  part: Part;
  partId: string;
  companyId: string;
  transactionsRefreshKey: number;
  openTxnModal: (type: InventoryTransactionType) => void;
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
  openTxnModal,
  onConversionsChanged,
  onStockChanged,
}: InventoryTabProps) {
  const belowReorder =
    part.reorder_point !== null && part.quantity <= part.reorder_point;
  const { features } = useCompanyFeatures();

  const [enabling, setEnabling] = useState(false);
  const [enableError, setEnableError] = useState<string | null>(null);

  const handleEnableTracking = async () => {
    setEnabling(true);
    setEnableError(null);
    try {
      await enableLocationTracking(partId);
      await onStockChanged();
    } catch (e) {
      setEnableError(e instanceof Error ? e.message : 'Failed to enable location tracking.');
    } finally {
      setEnabling(false);
    }
  };

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

        {part.is_location_tracked ? (
          <Box sx={{ mt: 4 }}>
            <PartLocationInventory
              part={part}
              partId={partId}
              companyId={companyId}
              onStockChanged={onStockChanged}
            />
          </Box>
        ) : (
          <>
            <Box sx={{ display: 'flex', gap: 2, justifyContent: 'center', mt: 4, flexWrap: 'wrap' }}>
              <Button
                variant="contained"
                color="success"
                size="large"
                startIcon={<AddIcon />}
                onClick={() => openTxnModal('addition')}
                disabled={!part.primary_unit}
              >
                Add Stock
              </Button>
              <Button
                variant="contained"
                color="error"
                size="large"
                startIcon={<RemoveIcon />}
                onClick={() => openTxnModal('depletion')}
                disabled={!part.primary_unit || part.quantity <= 0}
              >
                Remove Stock
              </Button>
              <Button
                variant="outlined"
                color="info"
                size="large"
                startIcon={<TuneIcon />}
                onClick={() => openTxnModal('adjustment')}
                disabled={!part.primary_unit}
              >
                Adjust
              </Button>
            </Box>

            {part.primary_unit && features.inventory_locations && (
              <Box sx={{ mt: 2 }}>
                <Button
                  variant="text"
                  startIcon={<LocationOnOutlinedIcon />}
                  onClick={handleEnableTracking}
                  disabled={enabling}
                >
                  Enable location tracking
                </Button>
                <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
                  Track where this part is stored across cabinets and bins. Current stock moves to an
                  “Unassigned” location you can distribute from.
                </Typography>
                {enableError && (
                  <Alert severity="error" sx={{ mt: 1 }}>
                    {enableError}
                  </Alert>
                )}
              </Box>
            )}
          </>
        )}

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
