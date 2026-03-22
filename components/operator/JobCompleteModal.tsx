'use client';

import { useState, useEffect } from 'react';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import Button from '@mui/material/Button';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import CircularProgress from '@mui/material/CircularProgress';
import Alert from '@mui/material/Alert';
import Card from '@mui/material/Card';
import IconButton from '@mui/material/IconButton';
import Autocomplete from '@mui/material/Autocomplete';
import DeleteIcon from '@mui/icons-material/Delete';
import AddIcon from '@mui/icons-material/Add';
import { completeJob, getOperationMaterials } from '@/utils/operatorAccess';
import { getAllInventoryItems } from '@/utils/inventoryAccess';
import { formatDuration } from '@/types/operator';
import type { MaterialConfirmation } from '@/types/operator';
import type { InventoryItem } from '@/types/inventory';

interface JobCompleteModalProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  jobId: string;
  operatorId: string | null;
  sessionStartedAt: string | null;
  jobOperationId: string | null;
  companyId: string;
}

/**
 * Job Complete Confirmation Modal.
 *
 * Shows:
 * - Time spent summary
 * - Material confirmation from routing (pre-filled, editable)
 * - Option to add additional materials
 * - Notes field
 */
export default function JobCompleteModal({
  open,
  onClose,
  onConfirm,
  jobId,
  operatorId,
  sessionStartedAt,
  jobOperationId,
  companyId,
}: JobCompleteModalProps) {
  const [materials, setMaterials] = useState<MaterialConfirmation[]>([]);
  const [notes, setNotes] = useState('');
  const [loading, setLoading] = useState(false);
  const [loadingMaterials, setLoadingMaterials] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);

  // For adding extra materials
  const [showAddMaterial, setShowAddMaterial] = useState(false);
  const [inventoryItems, setInventoryItems] = useState<InventoryItem[]>([]);
  const [loadingItems, setLoadingItems] = useState(false);

  // Update elapsed time while modal is open
  useEffect(() => {
    if (!open || !sessionStartedAt) return;

    const start = new Date(sessionStartedAt).getTime();

    const updateElapsed = () => {
      setElapsed(Math.floor((Date.now() - start) / 1000));
    };

    updateElapsed();
    const interval = setInterval(updateElapsed, 1000);

    return () => clearInterval(interval);
  }, [open, sessionStartedAt]);

  // Fetch materials on open
  useEffect(() => {
    if (!open) return;

    setNotes('');
    setError(null);
    setShowAddMaterial(false);

    if (jobOperationId) {
      setLoadingMaterials(true);
      getOperationMaterials(jobOperationId)
        .then((mats) => setMaterials(mats))
        .catch(() => setMaterials([]))
        .finally(() => setLoadingMaterials(false));
    } else {
      setMaterials([]);
    }
  }, [open, jobOperationId]);

  const handleConfirmedQtyChange = (index: number, value: number) => {
    setMaterials((prev) => {
      const updated = [...prev];
      updated[index] = { ...updated[index], confirmed_quantity: Math.max(0, value) };
      return updated;
    });
  };

  const handleRemoveMaterial = (index: number) => {
    setMaterials((prev) => prev.filter((_, i) => i !== index));
  };

  const handleAddMaterial = async () => {
    if (inventoryItems.length === 0) {
      setLoadingItems(true);
      try {
        const items = await getAllInventoryItems(companyId);
        setInventoryItems(items);
      } catch {
        // Silently fail — user can retry
      } finally {
        setLoadingItems(false);
      }
    }
    setShowAddMaterial(true);
  };

  const handleSelectNewMaterial = (item: InventoryItem | null) => {
    if (!item) return;

    // Don't add duplicates
    if (materials.some((m) => m.inventory_item_id === item.id)) return;

    setMaterials((prev) => [
      ...prev,
      {
        inventory_item_id: item.id,
        item_name: item.name,
        expected_quantity: 0,
        confirmed_quantity: 0,
        unit: item.primary_unit,
        current_stock: item.quantity,
        primary_unit: item.primary_unit,
      },
    ]);
    setShowAddMaterial(false);
  };

  const handleConfirm = async () => {
    if (!operatorId) {
      setError('Operator not found. Please log in again.');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      // Only send materials with confirmed_quantity > 0
      const materialsToSend = materials.filter((m) => m.confirmed_quantity > 0);

      await completeJob(jobId, operatorId, {
        notes: notes.trim() || undefined,
        materials: materialsToSend.length > 0 ? materialsToSend : undefined,
      });
      onConfirm();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to complete job');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      maxWidth="sm"
      fullWidth
      PaperProps={{
        sx: {
          bgcolor: 'rgba(17, 20, 57, 0.98)',
          backdropFilter: 'blur(10px)',
        },
      }}
    >
      <DialogTitle sx={{ textAlign: 'center', pb: 1 }}>
        Complete Operation
      </DialogTitle>

      <DialogContent>
        {/* Time Summary */}
        {sessionStartedAt && (
          <Box
            sx={{
              textAlign: 'center',
              mb: 3,
              py: 2,
              bgcolor: 'rgba(70, 130, 180, 0.1)',
              borderRadius: 2,
            }}
          >
            <Typography variant="overline" color="text.secondary">
              Time Spent
            </Typography>
            <Typography
              variant="h4"
              component="div"
              sx={{ fontFamily: 'monospace', fontWeight: 600, color: 'primary.main' }}
            >
              {formatDuration(elapsed)}
            </Typography>
          </Box>
        )}

        {/* Error */}
        {error && (
          <Alert severity="error" sx={{ mb: 2 }}>
            {error}
          </Alert>
        )}

        {/* Materials Section */}
        <Typography variant="subtitle2" color="text.secondary" sx={{ mb: 1 }}>
          Material Consumption
        </Typography>

        {loadingMaterials ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }}>
            <CircularProgress size={24} />
          </Box>
        ) : materials.length === 0 && !showAddMaterial ? (
          <Box sx={{ textAlign: 'center', py: 2, mb: 2 }}>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
              No materials required for this operation.
            </Typography>
            <Button
              size="small"
              startIcon={<AddIcon />}
              onClick={handleAddMaterial}
            >
              Add Material
            </Button>
          </Box>
        ) : (
          <Stack spacing={1.5} sx={{ mb: 2 }}>
            {materials.map((material, index) => {
              const isOverStock =
                material.confirmed_quantity > 0 &&
                material.unit === material.primary_unit &&
                material.confirmed_quantity > material.current_stock;

              return (
                <Card
                  key={`${material.inventory_item_id}-${index}`}
                  elevation={1}
                  sx={{ p: 2 }}
                >
                  <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', mb: 1 }}>
                    <Box>
                      <Typography variant="body1" fontWeight={600}>
                        {material.item_name}
                      </Typography>
                      <Typography variant="caption" color="text.secondary">
                        In stock: {material.current_stock} {material.primary_unit}
                        {material.expected_quantity > 0 && (
                          <> &middot; Expected: {material.expected_quantity} {material.unit}</>
                        )}
                      </Typography>
                    </Box>
                    <IconButton
                      size="small"
                      onClick={() => handleRemoveMaterial(index)}
                      sx={{ ml: 1 }}
                    >
                      <DeleteIcon fontSize="small" />
                    </IconButton>
                  </Box>

                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                    <TextField
                      label="Qty Used"
                      type="text"
                      size="small"
                      value={material.confirmed_quantity === 0 ? '' : String(material.confirmed_quantity)}
                      onChange={(e) => {
                        const raw = e.target.value;
                        if (raw === '' || /^\d*\.?\d*$/.test(raw)) {
                          handleConfirmedQtyChange(index, raw === '' ? 0 : parseFloat(raw) || 0);
                        }
                      }}
                      inputProps={{ inputMode: 'decimal', pattern: '[0-9]*\\.?[0-9]*' }}
                      sx={{ width: 120 }}
                    />
                    <Typography variant="body2" color="text.secondary">
                      {material.unit}
                    </Typography>
                  </Box>

                  {isOverStock && (
                    <Alert severity="warning" sx={{ mt: 1 }} variant="outlined">
                      Stock short by {(material.confirmed_quantity - material.current_stock).toFixed(2)} {material.primary_unit}.
                      Inventory will be set to zero and flagged for review.
                    </Alert>
                  )}
                </Card>
              );
            })}

            {/* Add Material */}
            {showAddMaterial ? (
              <Card elevation={1} sx={{ p: 2 }}>
                <Autocomplete
                  options={inventoryItems.filter(
                    (item) => !materials.some((m) => m.inventory_item_id === item.id)
                  )}
                  getOptionLabel={(option) =>
                    `${option.name}${option.sku ? ` (${option.sku})` : ''}`
                  }
                  loading={loadingItems}
                  onChange={(_, value) => handleSelectNewMaterial(value)}
                  renderInput={(params) => (
                    <TextField
                      {...params}
                      label="Search inventory items"
                      size="small"
                      autoFocus
                    />
                  )}
                  size="small"
                />
                <Button
                  size="small"
                  onClick={() => setShowAddMaterial(false)}
                  sx={{ mt: 1 }}
                >
                  Cancel
                </Button>
              </Card>
            ) : (
              <Button
                size="small"
                startIcon={<AddIcon />}
                onClick={handleAddMaterial}
              >
                Add Material
              </Button>
            )}
          </Stack>
        )}

        {/* Notes */}
        <TextField
          label="Notes (optional)"
          multiline
          rows={3}
          fullWidth
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Any issues or comments about this operation..."
        />
      </DialogContent>

      <DialogActions sx={{ px: 3, pb: 3, pt: 1 }}>
        <Button onClick={onClose} disabled={loading} sx={{ minWidth: 100 }}>
          Cancel
        </Button>
        <Button
          variant="contained"
          onClick={handleConfirm}
          disabled={loading || !operatorId}
          sx={{ minWidth: 140, minHeight: 48 }}
        >
          {loading ? <CircularProgress size={24} /> : 'Confirm Complete'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
