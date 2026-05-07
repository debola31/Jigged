'use client';

import { useCallback, useEffect, useState } from 'react';
import Box from '@mui/material/Box';
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
import Link from '@mui/material/Link';
import Divider from '@mui/material/Divider';
import AddIcon from '@mui/icons-material/Add';
import EditIcon from '@mui/icons-material/Edit';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import HelpOutlineIcon from '@mui/icons-material/HelpOutline';
import NextLink from 'next/link';
import { getBomForPart, deleteBomLine } from '@/utils/bomAccess';
import type { BomLine, BomLineWithChildPart } from '@/types/bom';
import { partKind } from '@/types/part';
import PartTypeChip from '@/components/parts/PartTypeChip';
import AddBomLineModal from '@/components/parts/AddBomLineModal';

interface PartBomPanelProps {
  partId: string;
  companyId: string;
  /** When true, hides add/edit/remove controls (display-only mode). */
  readOnly?: boolean;
  /**
   * Fired after each successful add/update/delete so the parent page can
   * refresh sibling pieces of state (e.g. the cost-stale badge, total cost
   * display).
   */
  onChanged?: () => void;
}

const formatCurrency = (n: number | null): string => {
  if (n === null || !Number.isFinite(n)) return '—';
  return n.toLocaleString(undefined, {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  });
};

const formatQuantity = (n: number): string =>
  n.toLocaleString(undefined, { maximumFractionDigits: 4 });

/**
 * BOM editor on the part detail page.
 *
 * Lists the part's children (parts_bom rows where this part is parent), with
 * inline add/edit/remove. Each row shows the child part name (linked), the
 * child's PartTypeChip, the BOM-line quantity + unit, optional notes, and the
 * cost contribution (qty × child.cost_per_unit). When the child's cost is
 * unknown, the contribution shows "—" with a hover hint — never a silent
 * zero, since that would understate the rolled-up cost without the user
 * noticing.
 *
 * After any mutation, reloads the BOM list and pings `onChanged` so the
 * parent page can rerun the stale-cost check.
 */
export default function PartBomPanel({
  partId,
  companyId,
  readOnly = false,
  onChanged,
}: PartBomPanelProps) {
  const [rows, setRows] = useState<BomLineWithChildPart[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [addModalOpen, setAddModalOpen] = useState(false);
  const [editing, setEditing] = useState<BomLine | null>(null);
  const [pendingDelete, setPendingDelete] = useState<BomLineWithChildPart | null>(null);
  const [deleting, setDeleting] = useState(false);

  const fetchRows = useCallback(async () => {
    try {
      setLoading(true);
      const data = await getBomForPart(partId);
      setRows(data);
      setError(null);
    } catch (err) {
      console.error('Failed to load BOM:', err);
      setError(err instanceof Error ? err.message : 'Failed to load BOM.');
    } finally {
      setLoading(false);
    }
  }, [partId]);

  useEffect(() => {
    fetchRows();
  }, [fetchRows]);

  const handleSaved = async () => {
    await fetchRows();
    onChanged?.();
  };

  const handleConfirmDelete = async () => {
    if (!pendingDelete) return;
    setDeleting(true);
    try {
      await deleteBomLine(pendingDelete.id);
      setPendingDelete(null);
      await fetchRows();
      onChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete BOM line.');
    } finally {
      setDeleting(false);
    }
  };

  const totalCost = rows.reduce((sum, row) => {
    if (row.child_part.cost_per_unit === null) return sum;
    return sum + row.quantity * row.child_part.cost_per_unit;
  }, 0);
  const anyMissingCost = rows.some((row) => row.child_part.cost_per_unit === null);

  return (
    <Box>
      {error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>
          {error}
        </Alert>
      )}

      {!readOnly && (
        <Box sx={{ display: 'flex', justifyContent: 'flex-end', mb: 2 }}>
          <Button
            variant="outlined"
            size="small"
            startIcon={<AddIcon />}
            onClick={() => {
              setEditing(null);
              setAddModalOpen(true);
            }}
          >
            Add Material
          </Button>
        </Box>
      )}

      {loading ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
          <CircularProgress size={28} />
        </Box>
      ) : rows.length === 0 ? (
        <Box sx={{ textAlign: 'center', py: 4 }}>
          <Typography variant="body2" color="text.secondary">
            No BOM lines yet. Add the parts consumed when this part is manufactured.
          </Typography>
        </Box>
      ) : (
        <Stack divider={<Divider flexItem />} spacing={0}>
          {rows.map((row) => {
            const child = row.child_part;
            const contribution =
              child.cost_per_unit === null ? null : row.quantity * child.cost_per_unit;
            return (
              <Box
                key={row.id}
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 2,
                  py: 1.5,
                }}
              >
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                    <PartTypeChip kind={partKind(child)} size="small" />
                    <Link
                      component={NextLink}
                      href={`/dashboard/${companyId}/parts/${child.id}`}
                      underline="hover"
                      sx={{ fontWeight: 500 }}
                    >
                      {child.part_name}
                    </Link>
                  </Box>
                  {row.notes && (
                    <Typography
                      variant="caption"
                      color="text.secondary"
                      sx={{ display: 'block', mt: 0.5 }}
                    >
                      {row.notes}
                    </Typography>
                  )}
                </Box>
                <Box sx={{ minWidth: 110, textAlign: 'right' }}>
                  <Typography variant="body2" sx={{ fontWeight: 500 }}>
                    {formatQuantity(row.quantity)} {row.unit}
                  </Typography>
                </Box>
                <Box sx={{ minWidth: 100, textAlign: 'right' }}>
                  {contribution === null ? (
                    <Tooltip title="Child part has no cost calculated yet — recalc the child to include it in the rollup.">
                      <Box
                        sx={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 0.5,
                          color: 'text.secondary',
                        }}
                      >
                        <HelpOutlineIcon sx={{ fontSize: 14 }} />
                        <Typography variant="body2">—</Typography>
                      </Box>
                    </Tooltip>
                  ) : (
                    <Typography variant="body2" sx={{ fontWeight: 500 }}>
                      {formatCurrency(contribution)}
                    </Typography>
                  )}
                </Box>
                {!readOnly && (
                  <Box sx={{ display: 'flex', gap: 0.5 }}>
                    <Tooltip title="Edit">
                      <IconButton
                        size="small"
                        onClick={() => {
                          setEditing(row);
                          setAddModalOpen(true);
                        }}
                      >
                        <EditIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                    <Tooltip title="Remove">
                      <IconButton
                        size="small"
                        onClick={() => setPendingDelete(row)}
                        sx={{
                          color: 'text.secondary',
                          '&:hover': { color: 'error.main' },
                        }}
                      >
                        <DeleteOutlineIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                  </Box>
                )}
              </Box>
            );
          })}
        </Stack>
      )}

      {rows.length > 0 && !loading && (
        <Box
          sx={{
            mt: 2,
            pt: 2,
            borderTop: '1px solid',
            borderColor: 'divider',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <Typography variant="caption" color="text.secondary">
            {anyMissingCost
              ? 'Material total excludes lines with no child cost.'
              : 'Material total (per parent unit)'}
          </Typography>
          <Typography variant="body2" sx={{ fontWeight: 600 }}>
            {formatCurrency(totalCost)}
          </Typography>
        </Box>
      )}

      <AddBomLineModal
        open={addModalOpen}
        onClose={() => {
          setAddModalOpen(false);
          setEditing(null);
        }}
        parentPartId={partId}
        companyId={companyId}
        existing={editing ?? undefined}
        onSaved={handleSaved}
      />

      <Dialog open={!!pendingDelete} onClose={deleting ? undefined : () => setPendingDelete(null)}>
        <DialogTitle>Remove BOM line?</DialogTitle>
        <DialogContent>
          <Typography>
            Remove <strong>{pendingDelete?.child_part.part_name}</strong> from this BOM? This
            cannot be undone, but you can re-add the line later.
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
            startIcon={deleting ? <CircularProgress size={16} color="inherit" /> : null}
          >
            {deleting ? 'Removing...' : 'Remove'}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
