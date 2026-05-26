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
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import NextLink from 'next/link';
import { buildPartHref, pushPartToChain } from '@/lib/partNavStack';
import {
  getBomForPart,
  deleteBomLine,
  addBomLine,
  updateBomLine,
  checkBomCycle,
} from '@/utils/bomAccess';
import {
  getComputedPartCost,
  getPartCostExplain,
  type PartCostMissingLeaf,
} from '@/utils/partsAccess';
import { getTiersForPart } from '@/utils/partPricingTiersAccess';
import { getSupabase } from '@/lib/supabase';
import type { BomLineFormData, BomLineWithChildPart } from '@/types/bom';
import MaterialRowEditor, {
  type MaterialEditorValue,
  type PartSelectOption,
} from '@/components/parts/MaterialRowEditor';

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

const formatQty = (q: number): string => {
  if (Number.isInteger(q)) return String(q);
  return q.toFixed(2).replace(/\.?0+$/, '');
};

/**
 * Materials editor on the part detail page.
 *
 * Mirrors the routing-operations panel's inline-row pattern: "Add Material"
 * appends an editor row at the end of the list, "Edit" swaps the read-only
 * row for an editor in place. No modal — keeps the editing flow consistent
 * with operations and avoids covering the rest of the page.
 *
 * Each saved row shows the child part name (linked), the child's
 * PartTypeChip, the BOM-line quantity + unit, and the cost contribution
 * (qty_in_primary × child_cost_at_cumulative_qty resolved live via
 * compute_part_cost_at_qty). When the child's cost is unknown, the
 * contribution shows "—" with a hover hint identifying the deepest
 * unpriced leaf — never a silent zero, since that would understate the
 * rolled-up cost without the user noticing.
 *
 * After any mutation, reloads the BOM list and pings `onChanged` so the
 * parent page can rerun the stale-cost check.
 */
interface BomRowCost {
  /** Per-parent-unit contribution: qty_in_primary × child_cost_at_cumulative_qty. */
  contribution: number | null;
  /** Tooltip text when contribution is null. Pulled from compute_part_cost_explain. */
  missingHint: string | null;
  /** Specific leaf (when known) so the tooltip can link to it. */
  missingLeaf: PartCostMissingLeaf | null;
}

/**
 * One break-point in the child part's cost ladder. For bought children
 * these come from the preferred vendor's procurement tiers; for made
 * children they come from the child's own pricing tier qty breaks. The
 * `costPerUnit` is the value returned by `compute_part_cost_at_qty(child,
 * qty)` — i.e. the exact number that feeds this BOM line into the parent's
 * rollup at each break. Showing these inline makes the rollup math
 * transparent and surfaces tier-pricing mistakes (e.g. quoted tiers that
 * don't actually drop the cost at higher qty).
 */
interface ChildCostTier {
  qty: number;
  unit: string;
  costPerUnit: number | null;
}

export default function PartBomPanel({
  partId,
  companyId,
  currentChain = [],
  readOnly = false,
  description,
  onChanged,
}: PartBomPanelProps) {
  const [rows, setRows] = useState<BomLineWithChildPart[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Per-row cost contribution computed live from compute_part_cost_at_qty.
  // The panel uses `displayQty` (= min(parent's pricing tier qty) ?? 1) so a
  // qty-agnostic card still produces a fixed number per row. When a cost is
  // null, an explain call surfaces the deepest unpriced leaf for the
  // tooltip — so the user sees which part to fix, not just a generic dash.
  const [costs, setCosts] = useState<Map<string, BomRowCost>>(new Map());
  // Per-row tier ladder (one entry per qty break point on the child). Loaded
  // lazily after rows arrive so the main contribution number renders first.
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

  // Compute the per-row cost contributions live whenever rows change. The
  // display qty is the parent's lowest-defined tier (or 1 if no tiers yet)
  // so the card always shows a fixed number that matches the cheapest qty
  // a quote could use. For sub-assembly tier cascading and unit conversion
  // we delegate to the canonical SQL function via getComputedPartCost.
  useEffect(() => {
    let cancelled = false;

    if (rows.length === 0) {
      setCosts(new Map());
      return;
    }

    (async () => {
      try {
        // Pick the display qty. min(parent's tier quantity) ?? 1.
        const tiers = await getTiersForPart(partId);
        const displayQty =
          tiers.length > 0
            ? Math.min(...tiers.map((t) => t.quantity))
            : 1;

        // Resolve unit conversions for BOM lines whose unit ≠ child's
        // primary_unit, batched in one query.
        const conversionLookups = rows
          .filter(
            (r) =>
              r.child_part.primary_unit !== null &&
              r.unit !== r.child_part.primary_unit,
          )
          .map((r) => ({ child_id: r.child_part.id, from_unit: r.unit }));

        const conversionMap = new Map<string, number>();
        if (conversionLookups.length > 0) {
          const supabase = getSupabase();
          const partIds = [...new Set(conversionLookups.map((c) => c.child_id))];
          const fromUnits = [...new Set(conversionLookups.map((c) => c.from_unit))];
          const { data: convs } = await supabase
            .from('parts_unit_conversions')
            .select('part_id, from_unit, to_primary_factor')
            .in('part_id', partIds)
            .in('from_unit', fromUnits);
          for (const c of (convs ?? []) as Array<{
            part_id: string;
            from_unit: string;
            to_primary_factor: number;
          }>) {
            conversionMap.set(`${c.part_id}:${c.from_unit}`, Number(c.to_primary_factor));
          }
        }

        const nextCosts = new Map<string, BomRowCost>();

        await Promise.all(
          rows.map(async (row) => {
            const child = row.child_part;
            const childPrimary = child.primary_unit;
            const bomUnit = row.unit;
            let qtyInPrimary: number;
            if (childPrimary !== null && bomUnit !== childPrimary) {
              const factor = conversionMap.get(`${child.id}:${bomUnit}`);
              if (factor === undefined) {
                nextCosts.set(row.id, {
                  contribution: null,
                  missingHint: `no unit conversion from "${bomUnit}" to "${childPrimary}" — add one on the child part`,
                  missingLeaf: null,
                });
                return;
              }
              qtyInPrimary = row.quantity * factor;
            } else {
              qtyInPrimary = row.quantity;
            }

            const cumulativeQty = displayQty * qtyInPrimary;

            let unitCost: number | null = null;
            try {
              unitCost = await getComputedPartCost(child.id, cumulativeQty);
            } catch (err) {
              nextCosts.set(row.id, {
                contribution: null,
                missingHint: (err as Error).message,
                missingLeaf: null,
              });
              return;
            }

            if (unitCost === null) {
              // Use explain to surface the deepest unpriced leaf.
              let leaf: PartCostMissingLeaf | null = null;
              let hint = '';
              try {
                const explain = await getPartCostExplain(child.id, cumulativeQty);
                leaf = explain.missing_leaves[0] ?? null;
                if (leaf) {
                  hint =
                    leaf.part_id === child.id
                      ? `no priced tier covers qty ${formatQty(cumulativeQty)} on this part — add a procurement tier.`
                      : `no priced tier covers qty ${formatQty(leaf.qty_required)} for ${leaf.part_name} — add a procurement tier on that part.`;
                }
              } catch {
                // explain failed; fall through to a generic message
              }
              if (!hint) {
                hint =
                  child.source === 'bought'
                    ? 'No procurement tier covers this qty — add one on the child part.'
                    : 'A leaf in this subassembly has no priced tier — open the child to inspect.';
              }
              nextCosts.set(row.id, {
                contribution: null,
                missingHint: hint,
                missingLeaf: leaf,
              });
              return;
            }

            nextCosts.set(row.id, {
              contribution: qtyInPrimary * unitCost,
              missingHint: null,
              missingLeaf: null,
            });
          }),
        );

        if (!cancelled) setCosts(nextCosts);
      } catch (err) {
        console.error('Failed to compute BOM costs:', err);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [rows, partId]);

  // Load each BOM row's tier ladder — the qty break points defined on the
  // child + the cost at each (via compute_part_cost_at_qty). These are the
  // exact numbers that feed the parent's rollup at each qty, so rendering
  // them inline lets the user trace the math. Bought children pull qty
  // break points from procurement tiers under the preferred vendor; made
  // children pull them from their own pricing tiers.
  useEffect(() => {
    let cancelled = false;

    if (rows.length === 0) {
      setTierLadders(new Map());
      return;
    }

    (async () => {
      const supabase = getSupabase();
      const next = new Map<string, ChildCostTier[]>();

      await Promise.all(
        rows.map(async (row) => {
          const child = row.child_part;
          const unit = child.primary_unit ?? '';

          let breakpoints: number[] = [];
          try {
            if (child.source === 'bought') {
              const { data: partRow } = await supabase
                .from('parts')
                .select('preferred_vendor_id')
                .eq('id', child.id)
                .maybeSingle();
              const preferred = partRow?.preferred_vendor_id ?? null;
              // Only the preferred vendor's tiers contribute to the rollup
              // (compute_part_cost_at_qty restricts to preferred_vendor_id),
              // so showing other vendors here would suggest costs that don't
              // actually apply.
              if (preferred) {
                const { data } = await supabase
                  .from('part_procurement_tiers')
                  .select('min_quantity')
                  .eq('part_id', child.id)
                  .eq('vendor_id', preferred);
                const rows = (data ?? []) as Array<{ min_quantity: number | string }>;
                breakpoints = [
                  ...new Set(rows.map((t) => Number(t.min_quantity))),
                ].sort((a, b) => a - b);
              }
            } else {
              const { data } = await supabase
                .from('part_pricing_tiers')
                .select('quantity')
                .eq('part_id', child.id)
                .order('quantity', { ascending: true });
              const rows = (data ?? []) as Array<{ quantity: number | string }>;
              breakpoints = rows.map((t) => Number(t.quantity));
            }
          } catch (err) {
            console.warn('Failed to load tier breakpoints for', child.id, err);
            breakpoints = [];
          }

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
    };

    setEditorError(null);
    setSaving(true);
    try {
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
        // Child is locked in edit mode (delete + re-add to swap), so no
        // cycle check needed — qty/unit changes can't introduce a cycle.
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
        // child-part picker is locked in edit mode, so has_routing/quantity
        // are display-only fillers — synthesize the option from the BOM row.
        childPart: {
          id: editingRow.child_part.id,
          part_name: editingRow.child_part.part_name,
          description: editingRow.child_part.description,
          has_routing: false,
          is_stocked: editingRow.child_part.is_stocked,
          source: editingRow.child_part.source,
          primary_unit: editingRow.child_part.primary_unit,
          quantity: 0,
        } satisfies PartSelectOption,
        quantity: String(editingRow.quantity),
        unit: editingRow.unit,
      }
    : undefined;

  const totalCost = rows.reduce((sum, row) => {
    const c = costs.get(row.id);
    if (!c || c.contribution === null) return sum;
    return sum + c.contribution;
  }, 0);
  const anyMissingCost = rows.some((row) => {
    const c = costs.get(row.id);
    return !c || c.contribution === null;
  });

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
            <Button
              variant="contained"
              size="small"
              startIcon={<AddIcon />}
              onClick={openAdd}
              disabled={editorOpen || saving}
            >
              Add Material
            </Button>
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
            const rowCost = costs.get(row.id);
            const contribution = rowCost ? rowCost.contribution : null;
            const ladder = tierLadders.get(row.id) ?? [];

            // Render an editor in place of the row when editing this one.
            if (editorState.mode === 'edit' && editorState.rowId === row.id) {
              return (
                <MaterialRowEditor
                  key={row.id}
                  companyId={companyId}
                  excludeIds={[partId]}
                  initial={editingInitial}
                  lockChildPart
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
                  display: 'flex',
                  alignItems: 'center',
                  gap: 2,
                  py: 1.5,
                }}
              >
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  {/* Restyled to read as an obvious link: primary color +
                      always-underlined + trailing chevron. The rest of
                      the row stays inert; edit/remove icons keep their
                      own click targets. The href pushes this part onto
                      the back chain so the destination renders a
                      breadcrumb back to here. */}
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
                  {ladder.length > 0 && (
                    <Typography
                      variant="caption"
                      color="text.secondary"
                      sx={{ display: 'block', mt: 0.25 }}
                    >
                      {'Tiers: '}
                      {ladder
                        .map((t) =>
                          `${formatQuantity(t.qty)} ${t.unit} @ ${formatCurrency(
                            t.costPerUnit,
                          )}/${t.unit}`.trim(),
                        )
                        .join(' · ')}
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
                    <Tooltip
                      title={
                        <Box>
                          <Typography variant="caption" sx={{ display: 'block' }}>
                            {rowCost?.missingHint ??
                              (child.source === 'bought'
                                ? 'No procurement tier covers this qty — add one on the child part.'
                                : 'A leaf in this subassembly has no priced tier.')}
                          </Typography>
                          {rowCost?.missingLeaf &&
                            rowCost.missingLeaf.part_id !== child.id && (
                              <Typography variant="caption" sx={{ display: 'block', mt: 0.5 }}>
                                Leaf: {rowCost.missingLeaf.part_name}
                              </Typography>
                            )}
                        </Box>
                      }
                    >
                      <Box
                        component={NextLink}
                        href={buildPartHref({
                          companyId,
                          targetPartId: rowCost?.missingLeaf?.part_id ?? child.id,
                          chain: pushPartToChain(
                            currentChain,
                            partId,
                            rowCost?.missingLeaf?.part_id ?? child.id,
                          ),
                        })}
                        sx={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 0.5,
                          color: 'text.secondary',
                          textDecoration: 'none',
                          '&:hover': { color: 'primary.main' },
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
                          onClick={() => setPendingDelete(row)}
                          disabled={editorOpen || saving}
                          sx={{
                            color: 'text.secondary',
                            '&:hover': { color: 'error.main' },
                          }}
                        >
                          <DeleteOutlineIcon fontSize="small" />
                        </IconButton>
                      </span>
                    </Tooltip>
                  </Box>
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
