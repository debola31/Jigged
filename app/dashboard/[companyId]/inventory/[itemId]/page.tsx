'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter, useParams } from 'next/navigation';
import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import Grid from '@mui/material/Grid';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Alert from '@mui/material/Alert';
import Divider from '@mui/material/Divider';
import EditIcon from '@mui/icons-material/Edit';
import AddIcon from '@mui/icons-material/Add';
import RemoveIcon from '@mui/icons-material/Remove';
import TuneIcon from '@mui/icons-material/Tune';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import { getInventoryItemWithTransactionCount } from '@/utils/inventoryAccess';
import { formatQuantityWithUnit } from '@/types/inventory';
import { getStandardUnitsForUnit, getConversionFactor } from '@/lib/unitPresets';
import type { InventoryItemWithRelations } from '@/types/inventory';
import InventoryTransactionModal from '@/components/inventory/InventoryTransactionModal';
import TransactionHistoryTable from '@/components/inventory/TransactionHistoryTable';

export default function InventoryDetailPage() {
  const router = useRouter();
  const params = useParams();
  const companyId = params.companyId as string;
  const itemId = params.itemId as string;

  const [item, setItem] = useState<InventoryItemWithRelations | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Transaction modal state
  const [transactionModalOpen, setTransactionModalOpen] = useState(false);
  const [transactionType, setTransactionType] = useState<'addition' | 'depletion' | 'adjustment'>('addition');

  // Refresh key for transaction history
  const [refreshKey, setRefreshKey] = useState(0);

  const fetchItem = useCallback(async () => {
    try {
      const data = await getInventoryItemWithTransactionCount(itemId);
      if (!data) {
        setError('Item not found');
        return;
      }
      setItem(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error loading item');
    } finally {
      setLoading(false);
    }
  }, [itemId]);

  useEffect(() => {
    fetchItem();
  }, [fetchItem]);

  const handleTransactionSuccess = () => {
    // Refresh item data and transaction history
    fetchItem();
    setRefreshKey((prev) => prev + 1);
  };

  const openTransactionModal = (type: 'addition' | 'depletion' | 'adjustment') => {
    setTransactionType(type);
    setTransactionModalOpen(true);
  };

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}>
        <CircularProgress />
      </Box>
    );
  }

  if (error || !item) {
    return (
      <Box>
        <Button
          startIcon={<ArrowBackIcon />}
          onClick={() => router.push(`/dashboard/${companyId}/inventory`)}
          sx={{ mb: 2 }}
        >
          Back to Inventory
        </Button>
        <Alert severity="error">{error || 'Item not found'}</Alert>
      </Box>
    );
  }

  return (
    <Box>
      {/* Back button */}
      <Button
        startIcon={<ArrowBackIcon />}
        onClick={() => router.push(`/dashboard/${companyId}/inventory`)}
        sx={{ mb: 3 }}
      >
        Back to Inventory
      </Button>

      {/* Header with actions */}
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', mb: 3 }}>
        <Box>
          <Typography variant="h4" sx={{ fontWeight: 600, mb: 1 }}>
            {item.name}
          </Typography>
          {item.sku && (
            <Typography variant="body1" color="text.secondary">
              SKU: {item.sku}
            </Typography>
          )}
        </Box>
        <Button
          variant="outlined"
          startIcon={<EditIcon />}
          onClick={() => router.push(`/dashboard/${companyId}/inventory/${itemId}/edit`)}
        >
          Edit
        </Button>
      </Box>

      <Grid container spacing={3}>
        {/* Left column - Info and quantity */}
        <Grid size={{ xs: 12, md: 8 }}>
          {/* Large Quantity Display */}
          <Card elevation={2} sx={{ mb: 3 }}>
            <CardContent sx={{ textAlign: 'center', py: 4 }}>
              <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
                Current Stock
              </Typography>
              <Typography
                variant="h2"
                sx={{
                  fontWeight: 700,
                  color: item.quantity <= 0 ? 'error.main' : 'text.primary',
                }}
              >
                {item.quantity.toLocaleString(undefined, { maximumFractionDigits: 4 })}
              </Typography>
              <Typography variant="h5" color="text.secondary">
                {item.primary_unit}
              </Typography>

              {/* Quick action buttons */}
              <Box sx={{ display: 'flex', gap: 2, justifyContent: 'center', mt: 4 }}>
                <Button
                  variant="contained"
                  color="success"
                  startIcon={<AddIcon />}
                  onClick={() => openTransactionModal('addition')}
                  size="large"
                >
                  Add Stock
                </Button>
                <Button
                  variant="contained"
                  color="error"
                  startIcon={<RemoveIcon />}
                  onClick={() => openTransactionModal('depletion')}
                  size="large"
                  disabled={item.quantity <= 0}
                >
                  Remove Stock
                </Button>
                <Button
                  variant="outlined"
                  color="info"
                  startIcon={<TuneIcon />}
                  onClick={() => openTransactionModal('adjustment')}
                  size="large"
                >
                  Adjust
                </Button>
              </Box>
            </CardContent>
          </Card>

          {/* Transaction History */}
          <Card elevation={2}>
            <CardContent>
              <Typography variant="h6" sx={{ fontWeight: 600, mb: 2 }}>
                Transaction History
              </Typography>
              <TransactionHistoryTable
                itemId={itemId}
                companyId={companyId}
                refreshKey={refreshKey}
              />
            </CardContent>
          </Card>
        </Grid>

        {/* Right column - Details */}
        <Grid size={{ xs: 12, md: 4 }}>
          {/* Item Details */}
          <Card elevation={2} sx={{ mb: 3 }}>
            <CardContent>
              <Typography variant="h6" sx={{ fontWeight: 600, mb: 2 }}>
                Details
              </Typography>

              <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                {item.description && (
                  <Box>
                    <Typography variant="body2" color="text.secondary">
                      Description
                    </Typography>
                    <Typography variant="body1">{item.description}</Typography>
                  </Box>
                )}

                <Box>
                  <Typography variant="body2" color="text.secondary">
                    Primary Unit
                  </Typography>
                  <Typography variant="body1">{item.primary_unit}</Typography>
                </Box>

                {item.cost_per_unit !== null && (
                  <Box>
                    <Typography variant="body2" color="text.secondary">
                      Cost per Unit
                    </Typography>
                    <Typography variant="body1">
                      ${item.cost_per_unit.toFixed(2)} / {item.primary_unit}
                    </Typography>
                  </Box>
                )}

                <Divider />

                <Box>
                  <Typography variant="body2" color="text.secondary">
                    Created
                  </Typography>
                  <Typography variant="body1">
                    {new Date(item.created_at).toLocaleDateString('en-US', {
                      month: 'short',
                      day: 'numeric',
                      year: 'numeric',
                    })}
                  </Typography>
                </Box>

                <Box>
                  <Typography variant="body2" color="text.secondary">
                    Last Updated
                  </Typography>
                  <Typography variant="body1">
                    {new Date(item.updated_at).toLocaleDateString('en-US', {
                      month: 'short',
                      day: 'numeric',
                      year: 'numeric',
                      hour: 'numeric',
                      minute: '2-digit',
                    })}
                  </Typography>
                </Box>
              </Box>
            </CardContent>
          </Card>

          {/* Unit Conversions */}
          {(() => {
            const standardUnits = getStandardUnitsForUnit(item.primary_unit);
            const hasStandard = standardUnits.length > 0;
            const hasCustom = item.unit_conversions.length > 0;

            if (!hasStandard && !hasCustom) return null;

            return (
              <Card elevation={2}>
                <CardContent>
                  <Typography variant="h6" sx={{ fontWeight: 600, mb: 2 }}>
                    Available Units
                  </Typography>

                  <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                    {/* Standard same-category conversions */}
                    {standardUnits.map((unit) => {
                      const factor = getConversionFactor(unit, item.primary_unit);
                      return (
                        <Box
                          key={`std-${unit}`}
                          sx={{
                            display: 'flex',
                            justifyContent: 'space-between',
                            alignItems: 'center',
                            p: 1,
                            borderRadius: 1,
                            border: '1px solid',
                            borderColor: 'divider',
                          }}
                        >
                          <Typography variant="body2">
                            1 {unit}
                          </Typography>
                          <Typography variant="body2" color="text.secondary">
                            = {factor !== undefined ? Number(factor.toPrecision(6)) : '?'} {item.primary_unit}
                          </Typography>
                        </Box>
                      );
                    })}

                    {/* Custom conversions */}
                    {hasStandard && hasCustom && (
                      <Divider sx={{ my: 0.5 }} />
                    )}
                    {item.unit_conversions.map((conv) => (
                      <Box
                        key={conv.id}
                        sx={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          p: 1,
                          borderRadius: 1,
                          border: '1px solid',
                          borderColor: 'divider',
                        }}
                      >
                        <Typography variant="body2">
                          1 {conv.from_unit}
                        </Typography>
                        <Typography variant="body2" color="text.secondary">
                          = {conv.to_primary_factor} {item.primary_unit}
                        </Typography>
                      </Box>
                    ))}
                  </Box>
                </CardContent>
              </Card>
            );
          })()}
        </Grid>
      </Grid>

      {/* Transaction Modal */}
      <InventoryTransactionModal
        open={transactionModalOpen}
        onClose={() => setTransactionModalOpen(false)}
        item={item}
        onSuccess={handleTransactionSuccess}
        defaultType={transactionType}
      />
    </Box>
  );
}
