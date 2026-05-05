'use client';

import { useState, useEffect, useMemo, useCallback } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import Alert from '@mui/material/Alert';
import CircularProgress from '@mui/material/CircularProgress';
import Divider from '@mui/material/Divider';
import Grid from '@mui/material/Grid';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import Chip from '@mui/material/Chip';
import Stack from '@mui/material/Stack';
import Snackbar from '@mui/material/Snackbar';
import Link from '@mui/material/Link';

import EditIcon from '@mui/icons-material/Edit';
import DeleteIcon from '@mui/icons-material/Delete';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import RefreshIcon from '@mui/icons-material/Refresh';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import AddIcon from '@mui/icons-material/Add';
import RemoveIcon from '@mui/icons-material/Remove';
import TuneIcon from '@mui/icons-material/Tune';
import NextLink from 'next/link';

import {
  getPartWithRelations,
  deletePart,
  recalculatePartCost,
  getStaleCostInfo,
  getPartUnitConversions,
} from '@/utils/partsAccess';
import { getVendor } from '@/utils/vendorsAccess';
import type { Part, PartUnitConversion } from '@/types/part';
import { partKind } from '@/types/part';
import type { Vendor } from '@/types/vendor';
import type { InventoryTransactionType } from '@/types/partTransaction';
import PartRoutingPanel from '@/components/parts/PartRoutingPanel';
import PartPricing from '@/components/parts/PartPricing';
import PartTypeChip from '@/components/parts/PartTypeChip';
import PartTransactionModal from '@/components/parts/PartTransactionModal';
import PartTransactionHistoryTable from '@/components/parts/PartTransactionHistoryTable';
import PartBomPanel from '@/components/parts/PartBomPanel';
import PartWhereUsedPanel from '@/components/parts/PartWhereUsedPanel';

const formatCurrency = (n: number | null): string => {
  if (n === null || !Number.isFinite(n)) return '—';
  return n.toLocaleString(undefined, {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  });
};

const formatDate = (s: string | null): string => {
  if (!s) return '—';
  return new Date(s).toLocaleString();
};

const formatTimeAgo = (s: string | null): string => {
  if (!s) return '—';
  const then = Date.parse(s);
  if (!Number.isFinite(then)) return '—';
  const diff = Date.now() - then;
  if (diff < 60_000) return 'just now';
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} hr ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`;
  return new Date(s).toLocaleDateString();
};

export default function PartDetailPage() {
  const params = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const companyId = params.companyId as string;
  const partId = params.partId as string;

  // Preserve the active saved view (e.g. ?view=inventory) when the user
  // navigates back to the parts list. The list page reads this param to pick
  // the right filter, so the list/detail round trip lands them where they
  // started.
  const partsListHref = useMemo(() => {
    const view = searchParams.get('view');
    const validViews = ['all', 'manufactured', 'inventory'];
    if (view && validViews.includes(view) && view !== 'all') {
      return `/dashboard/${companyId}/parts?view=${view}`;
    }
    return `/dashboard/${companyId}/parts`;
  }, [companyId, searchParams]);

  const [part, setPart] = useState<Part | null>(null);
  const [unitConversions, setUnitConversions] = useState<PartUnitConversion[]>([]);
  const [preferredVendor, setPreferredVendor] = useState<Vendor | null>(null);
  const [staleInfo, setStaleInfo] = useState<{
    is_stale: boolean;
    stale_descendants: number;
  }>({ is_stale: false, stale_descendants: 0 });

  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [recalcLoading, setRecalcLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [snackbar, setSnackbar] = useState<{
    open: boolean;
    message: string;
    severity: 'success' | 'error' | 'info';
  }>({ open: false, message: '', severity: 'success' });

  // Bumped after every routing save so cost breakdown + pricing tiers reload.
  const [refreshKey, setRefreshKey] = useState(0);
  // Bumped after each stock transaction so the history table reloads.
  const [transactionsRefreshKey, setTransactionsRefreshKey] = useState(0);

  const [txnModalOpen, setTxnModalOpen] = useState(false);
  const [txnModalType, setTxnModalType] = useState<InventoryTransactionType>('addition');

  const fetchPart = useCallback(async () => {
    try {
      setLoading(true);
      const data = await getPartWithRelations(partId);
      setPart(data);
      setError(null);

      if (data) {
        // Side-loads. Failures here are non-fatal — the page renders without
        // the supplementary panels rather than showing a hard error, so the
        // user can still see the core part data and act on it.
        try {
          const conversions = await getPartUnitConversions(partId);
          setUnitConversions(conversions);
        } catch (err) {
          console.warn('Failed to load unit conversions:', err);
          setUnitConversions([]);
        }

        if (data.preferred_vendor_id) {
          try {
            const v = await getVendor(data.preferred_vendor_id);
            setPreferredVendor(v);
          } catch (err) {
            console.warn('Failed to load preferred vendor:', err);
            setPreferredVendor(null);
          }
        } else {
          setPreferredVendor(null);
        }

        if (data.is_manufacturable) {
          try {
            const info = await getStaleCostInfo(partId);
            setStaleInfo(info);
          } catch (err) {
            console.warn('Failed to compute stale cost info:', err);
            setStaleInfo({ is_stale: false, stale_descendants: 0 });
          }
        } else {
          setStaleInfo({ is_stale: false, stale_descendants: 0 });
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load part');
    } finally {
      setLoading(false);
    }
  }, [partId]);

  useEffect(() => {
    fetchPart();
  }, [fetchPart]);

  const handleRecalculate = async () => {
    setRecalcLoading(true);
    try {
      const newCost = await recalculatePartCost(partId);
      setSnackbar({
        open: true,
        message: `Cost recalculated: ${formatCurrency(newCost)}`,
        severity: 'success',
      });
      await fetchPart();
      // Pricing tiers and cost breakdown derive from the part cost — refresh
      // them too.
      setRefreshKey((k) => k + 1);
    } catch (err) {
      // Surface the SQL function's error verbatim — no swallowing. The
      // function RAISEs on missing labor rate, missing child cost, missing
      // unit conversion. These messages are meaningful to the shop owner and
      // tell them exactly which row needs attention.
      const message =
        err instanceof Error && err.message
          ? err.message
          : 'Cost recalculation failed.';
      setSnackbar({
        open: true,
        message,
        severity: 'error',
      });
    } finally {
      setRecalcLoading(false);
    }
  };

  const handleDelete = async () => {
    setActionLoading(true);
    try {
      await deletePart(partId);
      router.push(partsListHref);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete part');
      setActionLoading(false);
      setDeleteDialogOpen(false);
    }
  };

  const openTxnModal = (type: InventoryTransactionType) => {
    setTxnModalType(type);
    setTxnModalOpen(true);
  };

  const handleTxnSuccess = async () => {
    // Reload the part (quantity changed) and bump the transactions refresh
    // key so the history table refetches.
    await fetchPart();
    setTransactionsRefreshKey((k) => k + 1);
  };

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: 400 }}>
        <CircularProgress />
      </Box>
    );
  }

  if (!part) {
    return (
      <Box>
        <Alert severity="error">Part not found</Alert>
      </Box>
    );
  }

  const quotesCount = part.quotes_count ?? 0;
  const jobsCount = part.jobs_count ?? 0;
  const bomParentsCount = part.bom_parents_count ?? 0;
  const bomLinesCount = part.bom_lines_count ?? 0;

  // Delete is gated by anything that references this part — quotes, jobs, or
  // other parts' BOMs. The DB also blocks via FK (parts_bom child is
  // ON DELETE RESTRICT) but disabling up-front beats waiting for a raw error.
  const hasReferences = quotesCount > 0 || jobsCount > 0 || bomParentsCount > 0;

  const showInventoryPanel = part.is_stockable;
  const showRoutingPanel = part.is_manufacturable;
  // BOM panel: shown whenever this part is manufacturable, OR when it has BOM
  // lines (covers historical / odd-classification rows that still have a BOM
  // attached).
  const showBomPanel = part.is_manufacturable || bomLinesCount > 0;
  const showWhereUsed = bomParentsCount > 0;

  const belowReorder =
    part.is_stockable &&
    part.reorder_point !== null &&
    part.quantity <= part.reorder_point;

  return (
    <Box>
      {/* Top action bar: Back left, Edit/Delete right. The Header component
          renders the page title — no inline title here. */}
      <Box
        sx={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          mb: 3,
        }}
      >
        <Button
          startIcon={<ArrowBackIcon />}
          onClick={() => router.push(partsListHref)}
          sx={{ color: 'text.secondary' }}
        >
          Back to Parts
        </Button>

        <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
          <Button
            variant="outlined"
            startIcon={<EditIcon />}
            onClick={() => router.push(`/dashboard/${companyId}/parts/${partId}/edit`)}
            disabled={actionLoading}
          >
            Edit
          </Button>

          <Tooltip
            title={
              hasReferences
                ? 'Cannot delete — this part is referenced by quotes, jobs, or other parts\' BOMs'
                : 'Delete Part'
            }
          >
            <span>
              <IconButton
                onClick={() => setDeleteDialogOpen(true)}
                disabled={actionLoading || hasReferences}
                sx={{
                  color: 'text.secondary',
                  '&:hover': {
                    color: 'error.main',
                    bgcolor: 'rgba(239, 68, 68, 0.1)',
                  },
                }}
              >
                <DeleteIcon />
              </IconButton>
            </span>
          </Tooltip>
        </Box>
      </Box>

      {error && (
        <Alert severity="error" sx={{ mb: 3 }} onClose={() => setError(null)}>
          {error}
        </Alert>
      )}

      {/* Header card: type chip + name, optional stale-cost badge, and the
          recalculate-cost action when applicable. Mirrors the Vendor detail
          page header card. */}
      <Card elevation={2} sx={{ mb: 3 }}>
        <CardContent>
          <Box
            sx={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 2,
              flexWrap: 'wrap',
              justifyContent: 'space-between',
            }}
          >
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap' }}>
                <PartTypeChip kind={partKind(part)} />
                <Typography variant="h5" sx={{ fontWeight: 600 }}>
                  {part.part_name}
                </Typography>
              </Box>
              {part.description && (
                <Typography variant="body1" color="text.secondary" sx={{ mt: 1 }}>
                  {part.description}
                </Typography>
              )}
              {staleInfo.is_stale && (
                <Tooltip
                  title={`${staleInfo.stale_descendants} BOM descendant${staleInfo.stale_descendants === 1 ? '' : 's'} ${staleInfo.stale_descendants === 1 ? 'has' : 'have'} changed since this part's cost was last calculated. Click to recalculate.`}
                >
                  <Chip
                    icon={<WarningAmberIcon />}
                    label="Cost may be stale"
                    color="warning"
                    onClick={handleRecalculate}
                    disabled={recalcLoading}
                    sx={{ mt: 1.5, fontWeight: 500, cursor: 'pointer' }}
                  />
                </Tooltip>
              )}
            </Box>

            {part.is_manufacturable && (
              <Box sx={{ display: 'flex', alignItems: 'center' }}>
                <Button
                  variant="contained"
                  startIcon={
                    recalcLoading ? (
                      <CircularProgress size={16} color="inherit" />
                    ) : (
                      <RefreshIcon />
                    )
                  }
                  onClick={handleRecalculate}
                  disabled={recalcLoading}
                >
                  {recalcLoading ? 'Recalculating...' : 'Recalculate Cost'}
                </Button>
              </Box>
            )}
          </Box>
        </CardContent>
      </Card>

      <Grid container spacing={3}>
        {/* Inventory panel — visible when stockable. */}
        {showInventoryPanel && (
          <Grid size={{ xs: 12, md: 6 }}>
            <Card elevation={2} sx={{ height: '100%' }}>
              <CardContent>
                <Typography variant="h6" gutterBottom sx={{ fontWeight: 600 }}>
                  Inventory
                </Typography>
                <Divider sx={{ mb: 2 }} />

                <Grid container spacing={2}>
                  <Grid size={{ xs: 6 }}>
                    <Typography variant="body2" color="text.secondary">
                      Quantity on hand
                    </Typography>
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mt: 0.5 }}>
                      <Typography variant="h4" sx={{ fontWeight: 600 }}>
                        {part.quantity.toLocaleString(undefined, { maximumFractionDigits: 4 })}
                      </Typography>
                      <Typography variant="body2" color="text.secondary">
                        {part.primary_unit ?? ''}
                      </Typography>
                    </Box>
                    {belowReorder && (
                      <Chip
                        size="small"
                        label="Below reorder point"
                        color="error"
                        sx={{ mt: 1, fontWeight: 500 }}
                      />
                    )}
                  </Grid>
                  <Grid size={{ xs: 6 }}>
                    <Typography variant="body2" color="text.secondary">
                      Cost per unit
                    </Typography>
                    <Typography variant="h6" sx={{ fontWeight: 500, mt: 0.5 }}>
                      {formatCurrency(part.cost_per_unit)}
                    </Typography>
                  </Grid>
                  <Grid size={{ xs: 6 }}>
                    <Typography variant="body2" color="text.secondary">
                      Reorder point
                    </Typography>
                    <Typography variant="body1" fontWeight={500} sx={{ mt: 0.5 }}>
                      {part.reorder_point !== null
                        ? `${part.reorder_point} ${part.primary_unit ?? ''}`
                        : '—'}
                    </Typography>
                  </Grid>
                  <Grid size={{ xs: 6 }}>
                    <Typography variant="body2" color="text.secondary">
                      Preferred vendor
                    </Typography>
                    {preferredVendor ? (
                      <Link
                        component={NextLink}
                        href={`/dashboard/${companyId}/vendors/${preferredVendor.id}`}
                        underline="hover"
                        sx={{ fontWeight: 500, mt: 0.5, display: 'inline-block' }}
                      >
                        {preferredVendor.name}
                      </Link>
                    ) : (
                      <Typography variant="body1" color="text.secondary" sx={{ mt: 0.5 }}>
                        —
                      </Typography>
                    )}
                  </Grid>
                </Grid>

                {/* Unit conversions — read-only display. Edited via the Part
                    edit form. */}
                {unitConversions.length > 0 && (
                  <Box sx={{ mt: 3 }}>
                    <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
                      Unit conversions
                    </Typography>
                    <Stack spacing={0.5}>
                      {unitConversions.map((uc) => (
                        <Typography
                          key={uc.id}
                          variant="body2"
                          fontFamily="monospace"
                          color="text.secondary"
                        >
                          1 {uc.from_unit} = {uc.to_primary_factor}{' '}
                          {part.primary_unit ?? ''}
                        </Typography>
                      ))}
                    </Stack>
                  </Box>
                )}

                {/* Stock action buttons */}
                <Box sx={{ display: 'flex', gap: 1, mt: 3, flexWrap: 'wrap' }}>
                  <Button
                    variant="outlined"
                    color="success"
                    size="small"
                    startIcon={<AddIcon />}
                    onClick={() => openTxnModal('addition')}
                    disabled={!part.primary_unit}
                  >
                    Add Stock
                  </Button>
                  <Button
                    variant="outlined"
                    color="error"
                    size="small"
                    startIcon={<RemoveIcon />}
                    onClick={() => openTxnModal('depletion')}
                    disabled={!part.primary_unit || part.quantity <= 0}
                  >
                    Remove Stock
                  </Button>
                  <Button
                    variant="outlined"
                    color="info"
                    size="small"
                    startIcon={<TuneIcon />}
                    onClick={() => openTxnModal('adjustment')}
                    disabled={!part.primary_unit}
                  >
                    Adjust Stock
                  </Button>
                </Box>
                {!part.primary_unit && (
                  <Typography variant="caption" color="text.secondary" sx={{ mt: 1, display: 'block' }}>
                    Set a primary unit on this part before recording stock transactions.
                  </Typography>
                )}

                {/* Transaction history */}
                <Box sx={{ mt: 3 }}>
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
          </Grid>
        )}

        {/* Routing panel — visible when manufacturable. The PartRoutingPanel
            handles its own empty state ("create routing" CTA). */}
        {showRoutingPanel && (
          <Grid size={{ xs: 12, md: showInventoryPanel ? 6 : 7 }}>
            <Card elevation={2} sx={{ height: '100%' }}>
              <CardContent>
                <Typography variant="h6" gutterBottom sx={{ fontWeight: 600 }}>
                  Routing
                </Typography>
                <Divider sx={{ mb: 2 }} />
                <PartRoutingPanel
                  companyId={companyId}
                  partId={partId}
                  onRoutingSaved={() => {
                    // Routing changes can shift cost rollups in the BOM tree
                    // (this part's cost might affect its parents). Refresh the
                    // pricing card and recompute stale state.
                    setRefreshKey((k) => k + 1);
                    getStaleCostInfo(partId).then(setStaleInfo).catch(() => undefined);
                  }}
                />
              </CardContent>
            </Card>
          </Grid>
        )}

        {/* BOM panel */}
        {showBomPanel && (
          <Grid size={{ xs: 12, md: showWhereUsed ? 6 : 12 }}>
            <Card elevation={2} sx={{ height: '100%' }}>
              <CardContent>
                <Typography variant="h6" sx={{ fontWeight: 600 }}>
                  Bill of Materials
                </Typography>
                <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                  Parts consumed when manufacturing this {part.part_name}.
                </Typography>
                <Divider sx={{ my: 2 }} />
                <PartBomPanel
                  partId={partId}
                  companyId={companyId}
                  onChanged={() => {
                    // BOM changed — re-check stale state and refresh the
                    // header counts (bom_lines_count) so panels mount/unmount
                    // appropriately.
                    fetchPart();
                  }}
                />
              </CardContent>
            </Card>
          </Grid>
        )}

        {/* Where Used panel */}
        {showWhereUsed && (
          <Grid size={{ xs: 12, md: showBomPanel ? 6 : 12 }}>
            <Card elevation={2} sx={{ height: '100%' }}>
              <CardContent>
                <Typography variant="h6" sx={{ fontWeight: 600 }}>
                  Where Used
                </Typography>
                <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                  Other parts whose BOM includes this part as a component.
                </Typography>
                <Divider sx={{ my: 2 }} />
                <PartWhereUsedPanel partId={partId} companyId={companyId} />
              </CardContent>
            </Card>
          </Grid>
        )}

        {/* Pricing card — always present (uses part_pricing_tiers, applies to
            both manufactured and stockable parts). */}
        <Grid size={{ xs: 12 }}>
          <Card elevation={2}>
            <CardContent>
              <PartPricing companyId={companyId} part={part} refreshKey={refreshKey} />
            </CardContent>
          </Card>
        </Grid>

        {/* Footer card: relation counts + metadata */}
        <Grid size={{ xs: 12 }}>
          <Card elevation={1} sx={{ bgcolor: 'background.default' }}>
            <CardContent>
              <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 4, alignItems: 'center' }}>
                <Box>
                  <Typography variant="body2" color="text.secondary">
                    Quotes
                  </Typography>
                  <Typography variant="h6" fontWeight={500}>
                    {quotesCount}
                  </Typography>
                </Box>
                <Box>
                  <Typography variant="body2" color="text.secondary">
                    Jobs
                  </Typography>
                  <Typography variant="h6" fontWeight={500}>
                    {jobsCount}
                  </Typography>
                </Box>
                <Divider orientation="vertical" flexItem />
                <Box>
                  <Typography variant="body2" color="text.secondary">
                    Cost calculated
                  </Typography>
                  <Typography variant="body2">
                    {formatTimeAgo(part.cost_recalculated_at)}
                  </Typography>
                </Box>
                <Box>
                  <Typography variant="body2" color="text.secondary">
                    Created
                  </Typography>
                  <Typography variant="body2">{formatDate(part.created_at)}</Typography>
                </Box>
                <Box>
                  <Typography variant="body2" color="text.secondary">
                    Updated
                  </Typography>
                  <Typography variant="body2">{formatDate(part.updated_at)}</Typography>
                </Box>
                {part.legacy_id && (
                  <Box>
                    <Typography variant="body2" color="text.secondary">
                      Legacy ID
                    </Typography>
                    <Typography variant="body2" fontFamily="monospace">
                      {part.legacy_id}
                    </Typography>
                  </Box>
                )}
              </Box>
            </CardContent>
          </Card>
        </Grid>
      </Grid>

      {/* Stock transaction modal */}
      {showInventoryPanel && (
        <PartTransactionModal
          open={txnModalOpen}
          onClose={() => setTxnModalOpen(false)}
          part={part}
          unitConversions={unitConversions}
          defaultType={txnModalType}
          onSuccess={handleTxnSuccess}
        />
      )}

      {/* Delete confirmation */}
      <Dialog open={deleteDialogOpen} onClose={() => setDeleteDialogOpen(false)}>
        <DialogTitle>Delete Part?</DialogTitle>
        <DialogContent>
          <Typography>
            Are you sure you want to delete <strong>{part.part_name}</strong>? This action cannot
            be undone.
          </Typography>
          {hasReferences && (
            <Alert severity="warning" sx={{ mt: 2 }}>
              This part is referenced by{' '}
              {[
                quotesCount > 0
                  ? `${quotesCount} quote${quotesCount === 1 ? '' : 's'}`
                  : null,
                jobsCount > 0 ? `${jobsCount} job${jobsCount === 1 ? '' : 's'}` : null,
                bomParentsCount > 0
                  ? `${bomParentsCount} other part${bomParentsCount === 1 ? '' : 's'}' BOM${bomParentsCount === 1 ? '' : 's'}`
                  : null,
              ]
                .filter(Boolean)
                .join(', ')}
              . Remove those references before deleting.
            </Alert>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteDialogOpen(false)} disabled={actionLoading}>
            Cancel
          </Button>
          <Button
            onClick={handleDelete}
            color="error"
            variant="contained"
            disabled={actionLoading || hasReferences}
            startIcon={
              actionLoading ? <CircularProgress size={16} color="inherit" /> : <DeleteIcon />
            }
          >
            {actionLoading ? 'Deleting...' : 'Delete'}
          </Button>
        </DialogActions>
      </Dialog>

      <Snackbar
        open={snackbar.open}
        autoHideDuration={snackbar.severity === 'error' ? 10000 : 4000}
        onClose={() => setSnackbar((s) => ({ ...s, open: false }))}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert
          severity={snackbar.severity}
          onClose={() => setSnackbar((s) => ({ ...s, open: false }))}
          sx={{ maxWidth: 600 }}
        >
          {snackbar.message}
        </Alert>
      </Snackbar>
    </Box>
  );
}
