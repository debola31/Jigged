'use client';

import { useCallback, useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import Alert from '@mui/material/Alert';
import CircularProgress from '@mui/material/CircularProgress';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import Stack from '@mui/material/Stack';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import Chip from '@mui/material/Chip';
import Divider from '@mui/material/Divider';
import Table from '@mui/material/Table';
import TableHead from '@mui/material/TableHead';
import TableBody from '@mui/material/TableBody';
import TableRow from '@mui/material/TableRow';
import TableCell from '@mui/material/TableCell';
import AddIcon from '@mui/icons-material/Add';
import EditIcon from '@mui/icons-material/Edit';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutline';
import {
  getTiersForPart,
  deleteTier,
  getProcurementCost,
} from '@/utils/procurementTiersAccess';
import type {
  ProcurementCostResult,
  ProcurementTier,
  ProcurementTierGroup,
} from '@/types/procurementTier';
import AddTierSheetModal from '@/components/parts/AddTierSheetModal';
import EditTierModal from '@/components/parts/EditTierModal';

interface PartProcurementPricingPanelProps {
  partId: string;
  companyId: string;
  /** parts.cost_per_unit — the default cost shown above the tier sheets. */
  defaultCost: number | null;
  /** Optional unit label for the default cost ("$0.85/lb"). */
  primaryUnit?: string | null;
  /** Optional Edit-cost link target — defaults to the part edit page. */
  editCostHref?: string;
  /** Fired after every successful add/update/delete so the parent can refresh. */
  onChanged?: () => void;
}

/** Sample quantities used by the status line at the top of the panel. */
const STATUS_SAMPLE_QTYS = [1, 10, 100, 1000];

function formatCurrency(value: number | null | undefined, max = 4): string {
  if (value === null || value === undefined || !Number.isFinite(value))
    return '—';
  return value.toLocaleString(undefined, {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: max,
  });
}

function formatQty(n: number): string {
  return n.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

function formatDate(s: string | null): string {
  if (!s) return '—';
  // ISO yyyy-mm-dd → Mon DD, YYYY (locale-friendly).
  const dt = new Date(s + 'T00:00:00');
  if (Number.isNaN(dt.getTime())) return s;
  return dt.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

/**
 * Procurement Pricing card for bought parts. Renders only on
 * `source='bought'` parts (the parent gates visibility — this component
 * doesn't double-check).
 *
 * Layout:
 *   - Header line: "Default cost: $X.XX/unit" + Edit link
 *   - Status line: "At qty=1: $X.XX (smallest tier from {vendor}). At
 *     qty=10: $Y.YY..." computed via getProcurementCost
 *   - One sub-card per tier group (vendor or "Internal estimate"), each
 *     with quoted/expires badge + a tiny tier table
 *   - Bottom CTA: "Add tier sheet from a vendor"
 */
export default function PartProcurementPricingPanel({
  partId,
  companyId,
  defaultCost,
  primaryUnit,
  editCostHref,
  onChanged,
}: PartProcurementPricingPanelProps) {
  const [groups, setGroups] = useState<ProcurementTierGroup[]>([]);
  const [costSamples, setCostSamples] = useState<
    Array<{ qty: number; result: ProcurementCostResult }>
  >([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Modal state
  const [addSheetVendorId, setAddSheetVendorId] = useState<
    string | null | undefined
  >(undefined); // undefined = pick freely; null = locked to internal; string = locked vendor
  const [addSheetOpen, setAddSheetOpen] = useState(false);
  const [editTier, setEditTier] = useState<ProcurementTier | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<ProcurementTier | null>(
    null,
  );
  const [deleting, setDeleting] = useState(false);

  const reload = useCallback(async () => {
    try {
      setLoading(true);
      const tierGroups = await getTiersForPart(partId);
      setGroups(tierGroups);

      // Compute the status-line samples in parallel. We DO NOT bail on the
      // case where a part has no tiers — getProcurementCost still returns
      // the fallback (parts.cost_per_unit) per the documented contract.
      const samples = await Promise.all(
        STATUS_SAMPLE_QTYS.map(async (qty) => ({
          qty,
          result: await getProcurementCost(partId, qty),
        })),
      );
      setCostSamples(samples);
      setError(null);
    } catch (err) {
      console.error('Failed to load procurement tiers:', err);
      setError(
        err instanceof Error ? err.message : 'Failed to load procurement tiers.',
      );
    } finally {
      setLoading(false);
    }
  }, [partId]);

  useEffect(() => {
    reload();
  }, [reload]);

  const handleSaved = async () => {
    await reload();
    onChanged?.();
  };

  const handleConfirmDelete = async () => {
    if (!pendingDelete) return;
    setDeleting(true);
    try {
      await deleteTier(pendingDelete.id);
      setPendingDelete(null);
      await reload();
      onChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete tier.');
    } finally {
      setDeleting(false);
    }
  };

  const unit = primaryUnit && primaryUnit.trim() ? primaryUnit : 'unit';
  const editHref =
    editCostHref ?? `/dashboard/${companyId}/parts/${partId}/edit`;

  const buildSampleSummary = (): string => {
    if (costSamples.length === 0) return '';
    const groupNameById = new Map<string | null, string>();
    for (const g of groups) groupNameById.set(g.vendor_id, g.vendor_name);
    return costSamples
      .map(({ qty, result }) => {
        const price = formatCurrency(result.unit_cost);
        if (result.source === 'tier') {
          const vendorName =
            groupNameById.get(result.vendor_id ?? null) ?? 'a vendor';
          return `At qty=${formatQty(qty)}: ${price} (${vendorName})`;
        }
        return `At qty=${formatQty(qty)}: ${price} (default)`;
      })
      .join('. ');
  };

  return (
    <Box>
      {error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>
          {error}
        </Alert>
      )}

      {/* Header: default cost + Edit link */}
      <Box
        sx={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: 1,
          mb: 1,
        }}
      >
        <Typography variant="body1">
          <Box component="span" sx={{ color: 'text.secondary' }}>
            Default cost:{' '}
          </Box>
          <Box component="span" sx={{ fontWeight: 600 }}>
            {formatCurrency(defaultCost)}
          </Box>
          <Box component="span" sx={{ color: 'text.secondary' }}>
            /{unit}
          </Box>
        </Typography>
        <Button
          size="small"
          variant="text"
          startIcon={<EditIcon />}
          href={editHref}
        >
          Edit default cost
        </Button>
      </Box>

      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 2 }}>
        Tier sheets below override the default for the matching quantity.
      </Typography>

      {/* Status line */}
      {!loading && costSamples.length > 0 && (
        <Alert severity="info" sx={{ mb: 2 }}>
          {buildSampleSummary()}
        </Alert>
      )}

      {loading ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
          <CircularProgress size={28} />
        </Box>
      ) : groups.length === 0 ? (
        <Box
          sx={{
            textAlign: 'center',
            py: 4,
            border: '1px dashed',
            borderColor: 'divider',
            borderRadius: 1,
          }}
        >
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            No tier sheets yet. Add one to capture vendor pricing breaks.
          </Typography>
          <Button
            variant="outlined"
            startIcon={<AddIcon />}
            onClick={() => {
              setAddSheetVendorId(undefined);
              setAddSheetOpen(true);
            }}
          >
            Add tier sheet from a vendor
          </Button>
        </Box>
      ) : (
        <Stack spacing={2}>
          {groups.map((group) => (
            <Card
              key={group.vendor_id ?? '__internal__'}
              variant="outlined"
              sx={{ bgcolor: 'background.default' }}
            >
              <CardContent>
                <Box
                  sx={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'flex-start',
                    flexWrap: 'wrap',
                    gap: 1,
                    mb: 1,
                  }}
                >
                  <Box>
                    <Typography
                      variant="subtitle1"
                      sx={{
                        fontWeight: 600,
                        fontStyle: group.vendor_id === null ? 'italic' : 'normal',
                      }}
                    >
                      {group.vendor_name}
                    </Typography>
                    <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap', mt: 0.5 }}>
                      <Typography variant="caption" color="text.secondary">
                        Quoted: {formatDate(group.quoted_at)}
                      </Typography>
                      <Typography variant="caption" color="text.secondary">
                        Expires: {formatDate(group.expires_at)}
                      </Typography>
                      {group.is_expired && (
                        <Chip
                          icon={<ErrorOutlineIcon />}
                          label="Expired"
                          size="small"
                          color="error"
                          sx={{ height: 22 }}
                        />
                      )}
                      {!group.is_expired && group.is_expiring && (
                        <Chip
                          icon={<WarningAmberIcon />}
                          label="Expiring soon"
                          size="small"
                          color="warning"
                          sx={{ height: 22 }}
                        />
                      )}
                    </Box>
                  </Box>
                  <Button
                    size="small"
                    startIcon={<AddIcon />}
                    onClick={() => {
                      setAddSheetVendorId(group.vendor_id);
                      setAddSheetOpen(true);
                    }}
                  >
                    Add tier
                  </Button>
                </Box>

                <Divider sx={{ mb: 1 }} />

                <Table size="small">
                  <TableHead>
                    <TableRow>
                      <TableCell>Min qty</TableCell>
                      <TableCell align="right">Unit cost</TableCell>
                      <TableCell>Notes</TableCell>
                      <TableCell align="right" sx={{ width: 100 }}>
                        Actions
                      </TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {group.tiers.map((tier) => (
                      <TableRow key={tier.id} hover>
                        <TableCell>
                          {formatQty(tier.min_quantity)} {unit}
                        </TableCell>
                        <TableCell align="right">
                          {formatCurrency(tier.cost_per_unit)}
                        </TableCell>
                        <TableCell>
                          <Typography
                            variant="caption"
                            color="text.secondary"
                            sx={{
                              display: 'block',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                              maxWidth: 240,
                            }}
                          >
                            {tier.notes || '—'}
                          </Typography>
                        </TableCell>
                        <TableCell align="right">
                          <Tooltip title="Edit tier">
                            <IconButton
                              size="small"
                              onClick={() => {
                                setEditTier(tier);
                                setEditOpen(true);
                              }}
                            >
                              <EditIcon fontSize="small" />
                            </IconButton>
                          </Tooltip>
                          <Tooltip title="Delete tier">
                            <IconButton
                              size="small"
                              onClick={() => setPendingDelete(tier)}
                              sx={{
                                color: 'text.secondary',
                                '&:hover': { color: 'error.main' },
                              }}
                            >
                              <DeleteOutlineIcon fontSize="small" />
                            </IconButton>
                          </Tooltip>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          ))}

          <Box sx={{ display: 'flex', justifyContent: 'flex-end' }}>
            <Button
              variant="outlined"
              startIcon={<AddIcon />}
              onClick={() => {
                setAddSheetVendorId(undefined);
                setAddSheetOpen(true);
              }}
            >
              Add tier sheet from a vendor
            </Button>
          </Box>
        </Stack>
      )}

      <AddTierSheetModal
        open={addSheetOpen}
        onClose={() => {
          setAddSheetOpen(false);
          setAddSheetVendorId(undefined);
        }}
        partId={partId}
        companyId={companyId}
        existingVendorId={addSheetVendorId}
        onSaved={handleSaved}
      />

      <EditTierModal
        open={editOpen}
        onClose={() => {
          setEditOpen(false);
          setEditTier(null);
        }}
        companyId={companyId}
        tier={editTier}
        onSaved={handleSaved}
      />

      <Dialog
        open={!!pendingDelete}
        onClose={deleting ? undefined : () => setPendingDelete(null)}
      >
        <DialogTitle>Delete tier?</DialogTitle>
        <DialogContent>
          <Typography>
            Delete the tier at{' '}
            <strong>
              {pendingDelete ? formatQty(pendingDelete.min_quantity) : ''} {unit}
            </strong>
            {' '}for{' '}
            <strong>
              {pendingDelete?.vendor_id === null
                ? 'Internal estimate'
                : groups.find((g) => g.vendor_id === pendingDelete?.vendor_id)
                    ?.vendor_name ?? 'this vendor'}
            </strong>
            ? This cannot be undone.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setPendingDelete(null)} disabled={deleting}>
            Cancel
          </Button>
          <Button
            onClick={handleConfirmDelete}
            color="error"
            variant="contained"
            disabled={deleting}
            startIcon={
              deleting ? <CircularProgress size={16} color="inherit" /> : null
            }
          >
            {deleting ? 'Deleting...' : 'Delete'}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
