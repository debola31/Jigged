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
import Snackbar from '@mui/material/Snackbar';

import EditIcon from '@mui/icons-material/Edit';
import DeleteIcon from '@mui/icons-material/Delete';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import AddIcon from '@mui/icons-material/Add';
import RemoveIcon from '@mui/icons-material/Remove';
import TuneIcon from '@mui/icons-material/Tune';

import {
  getPartWithRelations,
  deletePart,
  getPartUnitConversions,
} from '@/utils/partsAccess';
import type { Part, PartUnitConversion } from '@/types/part';
import type { InventoryTransactionType } from '@/types/partTransaction';
import PartRoutingPanel from '@/components/parts/PartRoutingPanel';
import PartPricing from '@/components/parts/PartPricing';
import PartClassificationChips from '@/components/parts/PartClassificationChips';
import PartTransactionModal from '@/components/parts/PartTransactionModal';
import PartTransactionHistoryTable from '@/components/parts/PartTransactionHistoryTable';
import PartBomPanel from '@/components/parts/PartBomPanel';
import PartWhereUsedPanel from '@/components/parts/PartWhereUsedPanel';
import PartUnitConversionsEditor from '@/components/parts/PartUnitConversionsEditor';

const formatDate = (s: string | null): string => {
  if (!s) return '—';
  return new Date(s).toLocaleString();
};

export default function PartDetailPage() {
  const params = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const companyId = params.companyId as string;
  const partId = params.partId as string;

  // Back link routes to whichever list page the user came from. Only the
  // Parts and Inventory list pages set ?from=; entry points from BOM rows,
  // routing rows, quote line items, "where used", and jobs do not, and the
  // back link falls through to /parts (the closer match for "I came from
  // somewhere that isn't a list"). Documented scope boundary: this is a
  // list-page back link, not a universal browser-history back button.
  const partsListHref = useMemo(() => {
    const from = searchParams.get('from');
    if (from === 'inventory') return `/dashboard/${companyId}/inventory`;
    return `/dashboard/${companyId}/parts`;
  }, [companyId, searchParams]);

  // Label matches the destination so the back link reflects where the user
  // came from. Same fall-through rule as partsListHref.
  const partsListLabel = useMemo(() => {
    const from = searchParams.get('from');
    return from === 'inventory' ? 'Back to Inventory' : 'Back to Parts';
  }, [searchParams]);

  const [part, setPart] = useState<Part | null>(null);
  const [unitConversions, setUnitConversions] = useState<PartUnitConversion[]>([]);

  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
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

  /**
   * Fetch the part + its side-loads. `silent: true` skips the loading
   * flag toggle so a background refresh (e.g. after auto-recalc, or after
   * an inline save) doesn't spinner the entire page out — the underlying
   * data swaps in place and the user keeps editing without interruption.
   * Used for any post-mutation refetch; the initial mount is non-silent.
   */
  const fetchPart = useCallback(
    async (silent = false) => {
      try {
        if (!silent) setLoading(true);
        const data = await getPartWithRelations(partId);
        setPart(data);
        setError(null);

        if (data) {
          // Side-load: unit conversions feed the transaction modal. Failure
          // is non-fatal; the page renders without it rather than blocking.
          try {
            const conversions = await getPartUnitConversions(partId);
            setUnitConversions(conversions);
          } catch (err) {
            console.warn('Failed to load unit conversions:', err);
            setUnitConversions([]);
          }
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load part');
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [partId],
  );

  useEffect(() => {
    fetchPart();
  }, [fetchPart]);

  /**
   * Trigger a UI refresh after a routing or BOM mutation. The old
   * `recalculate_part_cost` SQL function was dropped in migration
   * 20260514 along with the `parts.cost_per_unit` snapshot — costs are
   * now computed live by `compute_part_cost_at_qty(part_id, qty)`. The
   * PartPricing and PartBomPanel components recompute themselves via
   * the bumped refreshKey, so all this needs to do is refetch the part's
   * relation counts and bump the key.
   */
  const refreshAfterMutation = useCallback(async () => {
    await fetchPart(true);
    setRefreshKey((k) => k + 1);
  }, [fetchPart]);

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
    // Silent refresh after a stock transaction — the modal already closed,
    // a full-page spinner is unnecessary and disorienting.
    await fetchPart(true);
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

  const showInventoryPanel = part.is_stocked;
  const showRoutingPanel = part.source === 'made';
  // BOM panel: shown whenever this part is made in-house, OR when it has BOM
  // lines (covers historical / odd-classification rows that still have a BOM
  // attached).
  const showBomPanel = part.source === 'made' || bomLinesCount > 0;
  const showWhereUsed = bomParentsCount > 0;

  const belowReorder =
    part.is_stocked &&
    part.reorder_point !== null &&
    part.quantity <= part.reorder_point;

  return (
    <Box>
      {/* Top action bar: Back link left, Delete right. Edit moved into the
          header card below — the form only edits the data shown there
          (name, description, source, stocked, UOM), so anchoring it on the
          card it modifies matches the user's mental model. Delete stays
          page-level: it's the destructive global action and visually
          separating it from Edit reduces accidental-click risk. */}
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
          {partsListLabel}
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

      {error && (
        <Alert severity="error" sx={{ mb: 3 }} onClose={() => setError(null)}>
          {error}
        </Alert>
      )}

      {/* Header card: name + description on the left; classification chip +
          Edit pencil on the top right. The pencil opens the same edit form
          as before — anchoring the action on this card makes the scope
          obvious (the form edits the data shown here). The "Cost may be
          stale" badge and the live "Recalculating cost…" indicator were
          removed when the cost_per_unit snapshot was dropped — cost is
          now computed live by compute_part_cost_at_qty in PartPricing /
          PartBomPanel. */}
      <Card elevation={2} sx={{ mb: 3 }}>
        <CardContent>
          <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 2 }}>
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap' }}>
                <Typography variant="h5" sx={{ fontWeight: 600 }}>
                  {part.part_name}
                </Typography>
              </Box>
              {part.description && (
                <Typography variant="body1" color="text.secondary" sx={{ mt: 1 }}>
                  {part.description}
                </Typography>
              )}
            </Box>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
              <PartClassificationChips part={part} />
              <Tooltip title="Edit part details">
                <IconButton
                  size="small"
                  onClick={() => router.push(`/dashboard/${companyId}/parts/${partId}/edit`)}
                  disabled={actionLoading}
                  sx={{ color: 'text.secondary' }}
                >
                  <EditIcon fontSize="small" />
                </IconButton>
              </Tooltip>
            </Box>
          </Box>
        </CardContent>
      </Card>

      <Grid container spacing={3}>
        {/* Inventory panel — visible when stockable. Full-width above the
            main pricing/operations row so sub-assemblies (made + stocked)
            keep the same Pricing-left, Operations-right layout below. */}
        {showInventoryPanel && (
          <Grid size={{ xs: 12 }}>
            <Card elevation={2}>
              <CardContent sx={{ textAlign: 'center', py: 4 }}>
                {/* Centred "Current Stock" display matches the main-branch
                    inventory detail page: large quantity, prominent green/
                    red/outlined buttons. Cost per unit lives in the Pricing
                    card below, so it is not duplicated here. Reorder point
                    surfaces only when the row is below it (the alert chip);
                    preferred vendor lives in the part edit form, not here. */}
                <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
                  Current Stock
                </Typography>
                <Typography
                  variant="h2"
                  sx={{
                    fontWeight: 700,
                    color: part.quantity <= 0 ? 'error.main' : 'text.primary',
                  }}
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

                <Box
                  sx={{
                    display: 'flex',
                    gap: 2,
                    justifyContent: 'center',
                    mt: 4,
                    flexWrap: 'wrap',
                  }}
                >
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

                {/* Unit conversions — inline-editable list (chunk 14 moved
                    these out of the Part create/edit form). Sits below the
                    stock controls, left-aligned because the table reads
                    better that way. */}
                {part.primary_unit && (
                  <Box sx={{ mt: 4, textAlign: 'left' }}>
                    <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
                      Unit conversions
                    </Typography>
                    <PartUnitConversionsEditor
                      partId={partId}
                      primaryUnit={part.primary_unit}
                      onChanged={(next) => setUnitConversions(next)}
                    />
                  </Box>
                )}

                {!part.primary_unit && (
                  <Typography variant="caption" color="text.secondary" sx={{ mt: 1, display: 'block' }}>
                    Set a primary unit on this part before recording stock transactions.
                  </Typography>
                )}

                {/* Transaction history — left-aligned because the table
                    reads better that way (parent CardContent is centered
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
          </Grid>
        )}

        {/* For bought parts the Pricing card now hosts the procurement
            cost source as its top subsection — no separate Procurement
            Cost card. See PartPricing.tsx. */}

        {/* Main row for manufactured parts: Pricing on the left (md=7),
            Operations + Materials grouped together on the right (md=5).
            Mirrors the main-branch part-detail layout — the right-column
            card pairs operations and their materials visually since they
            describe the same routing. */}
        {showRoutingPanel ? (
          <>
            <Grid size={{ xs: 12, md: 7 }}>
              <Card elevation={2} sx={{ height: '100%' }}>
                <CardContent>
                  <PartPricing companyId={companyId} part={part} refreshKey={refreshKey} />
                </CardContent>
              </Card>
            </Grid>

            <Grid size={{ xs: 12, md: 5 }}>
              <Card elevation={2} sx={{ height: '100%' }}>
                <CardContent>
                  <Typography variant="h6" sx={{ fontWeight: 600 }}>
                    Operations
                  </Typography>
                  <Divider sx={{ mt: 1, mb: 2 }} />
                  <PartRoutingPanel
                    companyId={companyId}
                    partId={partId}
                    onRoutingSaved={() => {
                      refreshAfterMutation();
                    }}
                  />

                  {showBomPanel && (
                    <>
                      <Divider sx={{ my: 3 }} />
                      <Typography variant="h6" sx={{ fontWeight: 600, mb: 2 }}>
                        Materials
                      </Typography>
                      <PartBomPanel
                        partId={partId}
                        companyId={companyId}
                        description={`Parts consumed when manufacturing this ${part.part_name}.`}
                        onChanged={refreshAfterMutation}
                      />
                    </>
                  )}
                </CardContent>
              </Card>
            </Grid>
          </>
        ) : (
          <>
            {/* Non-made parts: BOM (rare — only when the row carries legacy
                lines) sits as a full-width row above Pricing. */}
            {showBomPanel && (
              <Grid size={{ xs: 12 }}>
                <Card elevation={2}>
                  <CardContent>
                    <Typography variant="h6" sx={{ fontWeight: 600, mb: 2 }}>
                      Materials
                    </Typography>
                    <Divider sx={{ mb: 2 }} />
                    <PartBomPanel
                      partId={partId}
                      companyId={companyId}
                      description={`Parts consumed when manufacturing this ${part.part_name}.`}
                      onChanged={refreshAfterMutation}
                    />
                  </CardContent>
                </Card>
              </Grid>
            )}

            <Grid size={{ xs: 12 }}>
              <Card elevation={2}>
                <CardContent>
                  <PartPricing companyId={companyId} part={part} refreshKey={refreshKey} />
                </CardContent>
              </Card>
            </Grid>
          </>
        )}

        {/* Where Used panel — full-width below the main row. */}
        {showWhereUsed && (
          <Grid size={{ xs: 12 }}>
            <Card elevation={2}>
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
