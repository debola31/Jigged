'use client';

import { useEffect, useState } from 'react';
import { useLoad } from '@/hooks/useLoad';
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
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutline';
import NextLink from 'next/link';
import { buildPartHref, pushPartToChain } from '@/lib/partNavStack';
import {
  getBomForPart,
  deleteBomLine,
  addBomLine,
  updateBomLine,
  checkBomCycle,
} from '@/utils/bomAccess';
import { getComputedPartCost, ensurePartUnitConversion } from '@/utils/partsAccess';
import { getSuggestedConversionFactor } from '@/lib/unitPresets';
import { getTypedSupabase as getSupabase } from '@/lib/supabase';
import type { BomLineFormData, BomLineWithChildPart } from '@/types/bom';
import MaterialRowEditor, {
  type MaterialEditorValue,
  type PartSelectOption,
} from '@/components/parts/MaterialRowEditor';
import SaveStatus from '@/components/common/SaveStatus';

interface PartBomPanelProps {
  partId: string;
  companyId: string;
  /**
   * The drill-down chain on the page hosting this panel — i.e. the result
   * of `parseBackChain(searchParams)` from the part-detail page. Used to
   * build child-part hrefs that push the *current* part onto the trail
   * via `pushPartToChain`. Defaults to empty so callers outside the
   * part-detail page don't need to thread it through.
   */
  currentChain?: string[];
  /** When true, hides add/edit/remove controls (display-only mode). */
  readOnly?: boolean;
  /**
   * Optional sub-heading rendered to the left of the Add Material button on
   * the panel's header row (e.g. "Parts consumed when manufacturing this
   * BRACKET-300."). Mirrors how the Operations panel pairs its summary
   * line with the Add Operation button on a single row.
   */
  description?: string;
  /**
   * Fired after each successful add/update/delete so the parent page can
   * refresh sibling pieces of state (e.g. the total cost display).
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
 * Materials editor on the part detail page.
 *
 * Mirrors the routing-operations panel's inline-row pattern: "Add Material"
 * appends an editor row at the end of the list, "Edit" swaps the read-only
 * row for an editor in place. No modal — keeps the editing flow consistent
 * with operations and avoids covering the rest of the page.
 *
 * Each saved row shows the child part name (linked), the BOM-line
 * quantity + unit, and a small table of the child's tier ladder (qty
 * break + cost/unit from compute_part_cost_at_qty). The ladder is the
 * full transparency a parent's tier pricing depends on: at parent qty N
 * the child cost flows through `compute_part_cost_at_qty(child_id, N ×
 * bom_qty_in_primary)`, which picks the child's tier matching that
 * cascaded qty.
 *
 * Per-parent-unit totals are deliberately not rendered — the contribution
 * varies by which parent tier you're at, so a single "Material total"
 * number would mislead. The user reads the table per child to see how
 * each tier price is built.
 *
 * After any mutation, reloads the BOM list and pings `onChanged` so the
 * parent page can rerun the stale-cost check.
 */
interface ChildCostTier {
  qty: number;
  unit: string;
  costPerUnit: number | null;
}

// Stable empty fallback so the tier-ladder effect + render don't churn while
// the first load runs.
const EMPTY_ROWS: BomLineWithChildPart[] = [];

export default function PartBomPanel({
  partId,
  companyId,
  currentChain = [],
  readOnly = false,
  description,
  onChanged,
}: PartBomPanelProps) {
  const [error, setError] = useState<string | null>(null);
  // Per-row tier ladder (one entry per qty break point on the child).
  // Loaded after rows arrive. Each entry's costPerUnit comes from
  // compute_part_cost_at_qty so the displayed numbers match what the
  // parent's rollup uses at the corresponding cascaded qty.
  const [tierLadders, setTierLadders] = useState<Map<string, ChildCostTier[]>>(
    new Map(),
  );

  // Inline editor state machine — same shape as RoutingOperationsList.
  const [editorState, setEditorState] = useState<
    | { mode: 'closed' }
    | { mode: 'add' }
    | { mode: 'edit'; rowId: string }
  >({ mode: 'closed' });
  const [editorError, setEditorError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [pendingDelete, setPendingDelete] = useState<BomLineWithChildPart | null>(null);
  const [deleting, setDeleting] = useState(false);

  const {
    data: rowsData,
    loading,
    reload: fetchRows,
  } = useLoad(() => getBomForPart(partId), [partId], {
    onError: (err) => {
      console.error('Failed to load BOM:', err);
      setError(err instanceof Error ? err.message : 'Failed to load BOM.');
    },
  });
  const rows = rowsData ?? EMPTY_ROWS;

  // Load each BOM row's tier ladder — the qty break points defined on the
  // child + the cost at each (via compute_part_cost_at_qty). These are the
  // exact numbers that feed the parent's rollup at each qty, so rendering
  // them inline lets the user trace the math. Bought children pull qty
  // break points from their part-level procurement tiers; made children
  // pull them from their own pricing tiers.
  useEffect(() => {
    let cancelled = false;

    if (rows.length === 0) {
      setTierLadders(new Map());
      return;
    }

    (async () => {
      const supabase = getSupabase();
      const next = new Map<string, ChildCostTier[]>();

      // Discover each child's qty break points in a fixed number of queries
      // (was ~2 per child — a per-row fan-out that scaled with BOM size).
      // Bought children take break points from their part-level procurement
      // tiers; made children take them from their own pricing tiers.
      const boughtIds = rows
        .filter((r) => r.child_part.source === 'bought')
        .map((r) => r.child_part.id);
      const madeIds = rows
        .filter((r) => r.child_part.source !== 'bought')
        .map((r) => r.child_part.id);

      const breakpointsByChild = new Map<string, number[]>();
      try {
        if (boughtIds.length > 0) {
          // All bought children's part-level procurement tiers in one query.
          // Procurement tiers are part-level now (vendor is a label, not a cost
          // filter), so every tier's break point applies.
          const { data: procRows } = await supabase
            .from('part_procurement_tiers')
            .select('part_id, min_quantity')
            .in('part_id', boughtIds);
          const qtysByChild = new Map<string, number[]>();
          for (const t of (procRows ?? []) as Array<{
            part_id: string;
            min_quantity: number | string;
          }>) {
            const arr = qtysByChild.get(t.part_id) ?? [];
            arr.push(Number(t.min_quantity));
            qtysByChild.set(t.part_id, arr);
          }
          for (const [partId, qtys] of qtysByChild) {
            breakpointsByChild.set(partId, [...new Set(qtys)].sort((a, b) => a - b));
          }
        }

        if (madeIds.length > 0) {
          // All made children's pricing tiers in one query, ordered by qty so
          // each child's break points come out ascending (matches the prior
          // per-child .order('quantity') behavior).
          const { data: priceRows } = await supabase
            .from('part_pricing_tiers')
            .select('part_id, quantity')
            .in('part_id', madeIds)
            .order('quantity', { ascending: true });
          for (const t of (priceRows ?? []) as Array<{
            part_id: string;
            quantity: number | string;
          }>) {
            const arr = breakpointsByChild.get(t.part_id) ?? [];
            arr.push(Number(t.quantity));
            breakpointsByChild.set(t.part_id, arr);
          }
        }
      } catch (err) {
        // Degrade to empty ladders (matches the prior per-child catch).
        console.warn('Failed to load BOM tier break points', err);
      }

      // Cost ladder per row — one compute_part_cost_at_qty per (child, qty),
      // parallelized exactly as before.
      await Promise.all(
        rows.map(async (row) => {
          const child = row.child_part;
          const unit = child.primary_unit ?? '';
          const breakpoints = breakpointsByChild.get(child.id) ?? [];

          if (breakpoints.length === 0) {
            next.set(row.id, []);
            return;
          }

          const ladder = await Promise.all(
            breakpoints.map(async (qty) => {
              let costPerUnit: number | null = null;
              try {
                costPerUnit = await getComputedPartCost(child.id, qty);
              } catch {
                costPerUnit = null;
              }
              return { qty, unit, costPerUnit };
            }),
          );
          next.set(row.id, ladder);
        }),
      );

      if (!cancelled) setTierLadders(next);
    })();

    return () => {
      cancelled = true;
    };
  }, [rows]);

  const closeEditor = () => {
    setEditorState({ mode: 'closed' });
    setEditorError(null);
  };

  const openAdd = () => {
    setEditorError(null);
    setEditorState({ mode: 'add' });
  };

  const openEdit = (rowId: string) => {
    setEditorError(null);
    setEditorState({ mode: 'edit', rowId });
  };

  const handleEditorSave = async (value: MaterialEditorValue) => {
    if (!value.childPart) return;

    const formData: BomLineFormData = {
      child_part_id: value.childPart.id,
      quantity: value.quantity,
      unit: value.unit,
      consume_whole_units: value.consume_whole_units,
    };

    setEditorError(null);
    setSaving(true);
    try {
      // If the line uses a standard same-dimension unit (e.g. feet on an inches
      // part), the cost engine bridges to the child's primary via
      // parts_unit_conversions — materialize that row with the known factor so
      // the conversion exists at rest. Existing/custom conversions are untouched.
      const primaryUnit = value.childPart.primary_unit;
      if (primaryUnit && value.unit && value.unit !== primaryUnit) {
        await ensurePartUnitConversion(
          value.childPart.id,
          value.unit,
          getSuggestedConversionFactor(value.unit, primaryUnit),
        );
      }

      if (editorState.mode === 'add') {
        // Cycle pre-check before insert. The DB trigger is the ultimate
        // guard; the pre-check just gives a friendlier path-traced error.
        const cycle = await checkBomCycle(partId, value.childPart.id);
        if (cycle.would_create_cycle) {
          setEditorError(
            `Adding this material would create a cycle: ${cycle.cycle_path?.join(' → ') ?? '(path unavailable)'}.`,
          );
          setSaving(false);
          return;
        }
        await addBomLine(partId, formData);
      } else if (editorState.mode === 'edit') {
        const existing = rows.find((r) => r.id === editorState.rowId);
        if (!existing) {
          setEditorError('Row no longer exists. Refresh and try again.');
          setSaving(false);
          return;
        }
        // The child part can be changed in edit mode; updateBomLine re-runs the
        // cycle pre-check internally when the child differs.
        await updateBomLine(existing.id, formData);
      }
      closeEditor();
      await fetchRows();
      onChanged?.();
    } catch (err) {
      // Surface the DB / access-layer error verbatim — includes the cycle
      // trigger's message and the duplicate-child error from the unique
      // index.
      setEditorError(err instanceof Error ? err.message : 'Failed to save material.');
    } finally {
      setSaving(false);
    }
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
      setError(err instanceof Error ? err.message : 'Failed to delete material.');
    } finally {
      setDeleting(false);
    }
  };

  const editorOpen = editorState.mode !== 'closed';

  // Build the editor's initial value from the row being edited.
  const editingRow =
    editorState.mode === 'edit'
      ? rows.find((r) => r.id === editorState.rowId)
      : null;
  const editingInitial: MaterialEditorValue | undefined = editingRow
    ? {
        // has_routing/quantity/is_location_tracked are display-only fillers — synthesize the
        // option from the BOM row, which carries none of them. The material editor shows a name
        // and a unit; it never reads stock, so a filler here cannot mislead anyone.
        childPart: {
          id: editingRow.child_part.id,
          part_name: editingRow.child_part.part_name,
          description: editingRow.child_part.description,
          has_routing: false,
          is_stocked: editingRow.child_part.is_stocked,
          is_location_tracked: false,
          source: editingRow.child_part.source,
          primary_unit: editingRow.child_part.primary_unit,
          quantity: 0,
        } satisfies PartSelectOption,
        quantity: String(editingRow.quantity),
        unit: editingRow.unit,
        consume_whole_units: editingRow.consume_whole_units,
      }
    : undefined;

  return (
    <Box>
      {error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>
          {error}
        </Alert>
      )}

      {(description || !readOnly) && (
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 1,
            mb: 2,
            flexWrap: 'wrap',
          }}
        >
          {description ? (
            <Typography variant="body2" color="text.secondary">
              {description}
            </Typography>
          ) : (
            <Box />
          )}
          {!readOnly && (
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
              <SaveStatus state={saving ? 'saving' : 'idle'} />
              <Button
                variant="contained"
                size="small"
                startIcon={<AddIcon />}
                onClick={openAdd}
                disabled={editorOpen || saving}
              >
                Add Material
              </Button>
            </Box>
          )}
        </Box>
      )}

      {loading ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
          <CircularProgress size={28} />
        </Box>
      ) : rows.length === 0 && !editorOpen ? (
        <Box sx={{ textAlign: 'center', py: 4 }}>
          <Typography variant="body2" color="text.secondary">
            No materials yet. Add the parts consumed when this part is manufactured.
          </Typography>
        </Box>
      ) : (
        <Stack divider={<Divider flexItem />} spacing={0}>
          {rows.map((row) => {
            const child = row.child_part;
            const ladder = tierLadders.get(row.id) ?? [];
            // Localized validation: once the ladder has loaded, a child with no
            // breakpoints (or whose costs all resolve to null) can't be costed,
            // so the parent can't be priced — flag the offending row directly.
            const ladderLoaded = tierLadders.has(row.id);
            const missingCost =
              ladderLoaded &&
              (ladder.length === 0 || ladder.every((t) => t.costPerUnit === null));
            // Fixed batch this made child is valued at when consumed here (null
            // Made children are valued at their standard costing lot size. Show
            // the batch only when it's a non-trivial run (>1) — a lot size of 1
            // is the default and not worth annotating.
            const pinnedBatch =
              child.source === 'made' &&
              child.costing_batch_quantity != null &&
              child.costing_batch_quantity > 1
                ? child.costing_batch_quantity
                : null;

            // Render an editor in place of the row when editing this one.
            if (editorState.mode === 'edit' && editorState.rowId === row.id) {
              return (
                <MaterialRowEditor
                  key={row.id}
                  companyId={companyId}
                  excludeIds={[partId]}
                  initial={editingInitial}
                  saving={saving}
                  error={editorError}
                  onSave={handleEditorSave}
                  onCancel={closeEditor}
                />
              );
            }

            return (
              <Box
                key={row.id}
                sx={{
                  py: 1.5,
                  pl: 1.5,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 1,
                  borderLeft: '3px solid',
                  borderColor: missingCost ? 'error.main' : 'transparent',
                }}
              >
                {/* Header row: name + BOM qty + actions on one line, all
                    centered at the part-name baseline. The tier table
                    renders BELOW so the actions can't drift downward when
                    a long ladder makes the left column taller. */}
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                  <Box sx={{ flex: 1, minWidth: 0 }}>
                    <Link
                      component={NextLink}
                      href={buildPartHref({
                        companyId,
                        targetPartId: child.id,
                        chain: pushPartToChain(currentChain, partId, child.id),
                      })}
                      underline="always"
                      color="primary.main"
                      sx={{
                        fontWeight: 500,
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 0.25,
                      }}
                    >
                      {child.part_name}
                      <ChevronRightIcon sx={{ fontSize: 16 }} />
                    </Link>
                  </Box>
                  <Box sx={{ minWidth: 130, textAlign: 'right' }}>
                    <Typography variant="body2" sx={{ fontWeight: 500 }}>
                      {formatQuantity(row.quantity)} {row.unit}
                    </Typography>
                    {(row.consume_whole_units || pinnedBatch !== null) && (
                      <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                        {row.consume_whole_units ? 'whole units' : 'fractional'}
                        {pinnedBatch !== null ? ` · batch ${formatQuantity(pinnedBatch)}` : ''}
                      </Typography>
                    )}
                  </Box>
                  {!readOnly && (
                    <Box sx={{ display: 'flex', gap: 0.5 }}>
                      <Tooltip title="Edit">
                        <span>
                          <IconButton
                            size="small"
                            onClick={() => openEdit(row.id)}
                            disabled={editorOpen || saving}
                          >
                            <EditIcon fontSize="small" />
                          </IconButton>
                        </span>
                      </Tooltip>
                      <Tooltip title="Remove">
                        <span>
                          <IconButton
                            size="small"
                            color="error"
                            onClick={() => setPendingDelete(row)}
                            disabled={editorOpen || saving}
                          >
                            <DeleteOutlineIcon fontSize="small" />
                          </IconButton>
                        </span>
                      </Tooltip>
                    </Box>
                  )}
                </Box>

                {ladder.length > 0 && (
                  <Box
                    sx={{
                      display: 'grid',
                      gridTemplateColumns: 'auto auto',
                      columnGap: 2,
                      rowGap: 0.25,
                      alignItems: 'baseline',
                      width: 'fit-content',
                    }}
                  >
                    <Typography
                      variant="caption"
                      color="text.secondary"
                      sx={{ fontWeight: 600 }}
                    >
                      Qty
                    </Typography>
                    <Typography
                      variant="caption"
                      color="text.secondary"
                      sx={{ fontWeight: 600, textAlign: 'right' }}
                    >
                      Cost / unit
                    </Typography>
                    {ladder.map((t, i) => (
                      <Box key={`tier-${i}`} sx={{ display: 'contents' }}>
                        <Typography variant="caption">
                          {formatQuantity(t.qty)} {t.unit}
                        </Typography>
                        <Typography variant="caption" sx={{ textAlign: 'right' }}>
                          {t.costPerUnit === null
                            ? '—'
                            : `${formatCurrency(t.costPerUnit)}/${t.unit}`}
                        </Typography>
                      </Box>
                    ))}
                  </Box>
                )}
                {missingCost && (
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, color: 'error.main' }}>
                    <ErrorOutlineIcon sx={{ fontSize: 16 }} />
                    <Typography variant="caption">
                      No cost on file — add{' '}
                      {child.source === 'bought' ? 'a vendor price' : 'pricing tiers'} on this
                      material so it can be costed.
                    </Typography>
                  </Box>
                )}
                {/* Non-trivial lot size: the ladder above is the child's OWN
                    qty-break costs, which differ from the fixed batch cost this
                    BOM values it at. Label so the two aren't read as a
                    contradiction. */}
                {pinnedBatch !== null && ladder.length > 0 && (
                  <Typography variant="caption" color="text.secondary">
                    Ladder shows {child.part_name}&apos;s own qty-break costs; consumed
                    here it&apos;s valued at its costing lot size of {formatQuantity(pinnedBatch)}.
                  </Typography>
                )}
              </Box>
            );
          })}

          {editorState.mode === 'add' && (
            <MaterialRowEditor
              companyId={companyId}
              excludeIds={[partId]}
              saving={saving}
              error={editorError}
              onSave={handleEditorSave}
              onCancel={closeEditor}
            />
          )}
        </Stack>
      )}

      <Dialog open={!!pendingDelete} onClose={deleting ? undefined : () => setPendingDelete(null)}>
        <DialogTitle>Remove material?</DialogTitle>
        <DialogContent>
          <Typography>
            Remove <strong>{pendingDelete?.child_part.part_name}</strong> from this BOM? This
            cannot be undone, but you can re-add the material later.
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
