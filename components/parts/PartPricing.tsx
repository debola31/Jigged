'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import TextField from '@mui/material/TextField';
import Alert from '@mui/material/Alert';
import CircularProgress from '@mui/material/CircularProgress';
import Table from '@mui/material/Table';
import TableHead from '@mui/material/TableHead';
import TableBody from '@mui/material/TableBody';
import TableRow from '@mui/material/TableRow';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import Link from 'next/link';
import AddIcon from '@mui/icons-material/Add';
import DeleteIconButton from '@/components/common/DeleteIconButton';
import { unitShortLabel } from '@/lib/standardUnits';
import {
  calculateRoutingCost,
  type RoutingCostBreakdown,
} from '@/utils/routingCostCalculation';
import { getTiersForPart, replaceTiersForPart } from '@/utils/partPricingTiersAccess';
import { unitPriceFromBase } from '@/utils/quotePricingResolver';
import {
  addPartPricingNote,
  getComputedPartCost,
  updatePartCostingBatchQuantity,
} from '@/utils/partsAccess';
import { getCurrentMember } from '@/utils/operatorAccess';
import { calculateMarkupFromUnitPrice } from '@/types/quote';
import type { Part } from '@/types/part';
import { buildPartHref, pushPartToChain } from '@/lib/partNavStack';
import { isValidQuantityInput, isValidQuantityValue } from '@/lib/quantityInput';
import { quantityUnitSuffix } from '@/lib/standardUnits';
import SaveStatus, { type SaveState } from '@/components/common/SaveStatus';

interface PartPricingProps {
  companyId: string;
  part: Part;
  /** Bumped by the parent whenever the routing changes — triggers a reload + recompute. */
  refreshKey?: number;
  /**
   * Drill-down chain on the page hosting this card — passed through to
   * `pushPartToChain` when building the href on each "Heads up" warning
   * link so back-navigation breadcrumbs accumulate. Defaults to empty
   * for callers outside the part-detail page.
   */
  currentChain?: string[];
  /**
   * Called after this card saves the part's pricing tiers. Lets the parent
   * re-fetch so the workspace completeness banner reflects the new markup
   * instead of going stale.
   */
  onPricingChanged?: () => void;
}

/**
 * Working-copy of a tier inside the editor.
 *
 * For made parts: markup % is the source of truth; unit_price derives from
 * `base_cost × (1 + markup/100)` and is editable as a back-calculation.
 * For bought parts: only quantity + markup % are surfaced (cost is dynamic
 * from procurement tier sheets at quote time, so unit_price isn't a static
 * field that lives in this card).
 */
interface EditRow {
  id?: string;
  sequence: number;
  quantity: string;
  markupPercent: string;
  unitPrice: string;
  /** null when materials are incomplete or the breakdown is missing — render
   * "—" rather than $0. See `RoutingCostBreakdown.materials_complete`. */
  baseCostPerUnit: number | null;
}

function formatCurrency(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value);
}

function parseNumber(s: string): number | null {
  if (s.trim() === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * Recompute a tier row's Base/unit and Unit price from the SINGLE-SOURCE base
 * cost at that tier's own quantity — `baseCostByQty` holds
 * `getComputedPartCost(part, qty)` results (the same engine the quote form and
 * the persisted line use, so a tier's price here matches a quote at that qty).
 * Base absent from the map = not fetched yet → render "—" until it lands.
 */
function recomputeRow(row: EditRow, baseCostByQty: Map<number, number | null>): EditRow {
  const qty = parseNumber(row.quantity);
  if (qty === null || qty <= 0) {
    return { ...row, baseCostPerUnit: null };
  }
  const base = baseCostByQty.has(qty) ? baseCostByQty.get(qty) ?? null : undefined;
  if (base === undefined) {
    return { ...row, baseCostPerUnit: null };
  }
  const markup = parseNumber(row.markupPercent);
  const baseCostPerUnit = base === null ? null : Math.round(base * 100) / 100;
  const unitPrice = unitPriceFromBase(base, markup);
  return {
    ...row,
    baseCostPerUnit,
    unitPrice: unitPrice !== null ? String(unitPrice) : '',
  };
}

/**
 * One blank, unfilled tier row (min qty 1, markup empty) shown when a part has
 * no persisted tiers yet — the user fills the markup and saves. Until then the
 * part reads as "no markup / not priceable".
 */
function blankRow(): EditRow {
  return {
    sequence: 10,
    quantity: '1',
    markupPercent: '',
    unitPrice: '',
    baseCostPerUnit: 0,
  };
}

/**
 * Per-part Pricing card.
 *
 * Each part owns its markup directly — a set of quantity-break tiers
 * (Min qty / Markup %), always inline-editable. There is no shared or named
 * markup-rate layer; a new part opens with a single unfilled row to fill in.
 *
 * The markup tier table is **identical for made and bought parts** — the same
 * Qty / Base / Markup % / Unit price columns. Unit price is editable and
 * back-calculates the markup; markup % stays the source of truth and the unit
 * price is always derived `base × (1 + markup/100)`.
 *
 *   Made parts:
 *     - Cost build-up (run labor / setup / materials) summarised at top,
 *       then the markup tier table
 *     - Base / unit comes from the routing + BOM at each tier qty
 *
 *   Bought parts:
 *     - Cost source (part-level procurement tiers) lives in a separate
 *       PartProcurementPricingPanel card above this one — keeping
 *       cost-of-goods and markup visually distinct
 *     - Base / unit comes from get_procurement_cost(qty) at each tier qty
 *       (same compute engine, getComputedPartCost), so the card shows the
 *       final unit-price-after-markup just like a made part. (Since PR #567
 *       collapsed procurement to part-level tiers, this cost is deterministic
 *       — no "which vendor wins" ambiguity.)
 *
 * Pricing feeds quotes (financial data), so tier edits are committed via an
 * explicit Save — not auto-saved.
 */
export default function PartPricing({
  companyId,
  part,
  refreshKey = 0,
  currentChain = [],
  onPricingChanged,
}: PartPricingProps) {
  const partId = part.id;
  const isBought = part.source === 'bought';
  // Label the Min qty column with the part's unit (e.g. "Min qty (in)") so a
  // fractional break reads unambiguously. null unit -> plain "Min qty".
  const qtyUnitLabel = quantityUnitSuffix(part.primary_unit);
  const qtyColumnHeader = qtyUnitLabel ? `Min qty (${qtyUnitLabel})` : 'Min qty';

  const [rows, setRows] = useState<EditRow[]>([]);
  const [breakdown, setBreakdown] = useState<RoutingCostBreakdown | null>(null);
  // Base cost per tier quantity, from the ONE canonical engine
  // (getComputedPartCost → compute_part_cost_at_qty) — the same source the quote
  // form and the persisted line use, so a tier's Base/unit + Unit price match a
  // quote at that qty. `breakdown` is kept only for the cost build-up + warnings.
  const [tierBaseCosts, setTierBaseCosts] = useState<Map<number, number | null>>(new Map());
  const inFlightTierQtys = useRef<Set<number>>(new Set());
  const tierBaseCostsRef = useRef(tierBaseCosts);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [dirty, setDirty] = useState(false);
  const saving = saveState === 'saving';

  // Costing lot size — the production run this part's cost amortizes over, and
  // the quantity it's valued at when consumed as a component. Drives the live
  // Cost breakdown below (setup / N). Made parts only.
  const [costingQtyStr, setCostingQtyStr] = useState<string>(
    String(part.costing_batch_quantity ?? 1),
  );
  const [costingDirty, setCostingDirty] = useState(false);
  const [costingSaveState, setCostingSaveState] = useState<SaveState>('idle');
  const [breakdownLoading, setBreakdownLoading] = useState<boolean>(!isBought);
  const costingSaving = costingSaveState === 'saving';
  const costingQty = (() => {
    const n = parseFloat(costingQtyStr);
    return Number.isFinite(n) && n > 0 ? n : 1;
  })();
  const costingUnit = unitShortLabel(part.primary_unit) ?? (part.primary_unit || 'unit');

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // Only the persisted markup tiers load here. The cost breakdown is owned
      // by the costing-qty effect below (it re-amortizes at the chosen lot
      // size); bought parts have no routing breakdown at all.
      const tiers = await getTiersForPart(partId);

      // baseCostPerUnit is purely a UI display value (computed live from the
      // breakdown + tier qty). The column was dropped from part_pricing_tiers
      // in migration 20260514 — the canonical truth at save time is
      // compute_part_cost_at_qty, called inside replaceTiersForPart.
      const asRows: EditRow[] = tiers.map((t) => ({
        id: t.id,
        sequence: t.sequence,
        quantity: String(t.quantity),
        markupPercent: t.markup_percent !== null ? String(t.markup_percent) : '',
        // unitPrice + baseCostPerUnit are filled in by the base-cost effect
        // (getComputedPartCost per tier qty → base × markup) once the async
        // costs land; start blank so nothing stale renders.
        unitPrice: '',
        baseCostPerUnit: null,
      }));
      // A never-configured part shows a single unfilled row to fill in — NOT
      // dirty, so Save stays disabled until the user actually edits it.
      const seeded = asRows.length > 0 ? asRows : [blankRow()];
      setRows(seeded.map((r) => recomputeRow(r, tierBaseCostsRef.current)));
      setDirty(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load pricing');
    } finally {
      setLoading(false);
    }
  }, [partId, isBought]);

  useEffect(() => {
    // Data-fetch-on-mount false positive: loadAll's setState all runs post-await
    // (documented class in eslint.config.mjs). loadAll seeds the EDITABLE tier
    // rows, so useLoad (immutable data) doesn't fit — kept as-is.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadAll();
  }, [loadAll, refreshKey]);

  // Keep the ref current for loadAll (see tierBaseCostsRef).
  useEffect(() => {
    tierBaseCostsRef.current = tierBaseCosts;
  }, [tierBaseCosts]);

  // Re-seed the costing-qty field when the persisted part value changes.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setCostingQtyStr(String(part.costing_batch_quantity ?? 1));
    setCostingDirty(false);
    setCostingSaveState('idle');
  }, [part.costing_batch_quantity]);

  // The Cost breakdown, computed at the costing lot size (setup amortized over
  // it; bought-child tiers resolve at the resulting consumption). Debounced so
  // typing a qty doesn't spam the engine; old values stay visible during the
  // recompute (no spinner flash). Bought parts have no routing breakdown.
  useEffect(() => {
    if (isBought) {
      setBreakdown(null);
      setBreakdownLoading(false);
      return;
    }
    let cancelled = false;
    setBreakdownLoading(true);
    const handle = setTimeout(() => {
      calculateRoutingCost(partId, costingQty)
        .then((b) => {
          if (cancelled) return;
          setBreakdown(b);
          setBreakdownLoading(false);
        })
        .catch(() => {
          if (cancelled) return;
          setBreakdown(null);
          setBreakdownLoading(false);
        });
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [partId, isBought, costingQty, refreshKey]);

  // Fetch the single-source base cost for each distinct tier quantity via the
  // canonical engine (getComputedPartCost → compute_part_cost_at_qty), the same
  // one the quote form and the persisted line use. Debounced so editing a tier
  // qty doesn't refetch on every keystroke. Works for BOTH made and bought parts
  // — for a bought part the engine reads its procurement tiers — so the Pricing
  // card can show the same Base/unit + final Unit-price columns for both.
  useEffect(() => {
    const qtys = [
      ...new Set(
        rows
          .map((r) => parseNumber(r.quantity))
          .filter((q): q is number => q !== null && q > 0),
      ),
    ];
    const missing = qtys.filter((q) => !tierBaseCosts.has(q) && !inFlightTierQtys.current.has(q));
    if (missing.length === 0) return;
    let cancelled = false;
    const handle = setTimeout(() => {
      for (const q of missing) {
        inFlightTierQtys.current.add(q);
        getComputedPartCost(partId, q)
          .catch(() => null)
          .then((base) => {
            inFlightTierQtys.current.delete(q);
            if (cancelled) return;
            setTierBaseCosts((prev) => new Map(prev).set(q, base));
          });
      }
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [rows, tierBaseCosts, partId, isBought]);

  // A routing / BOM / child-batch change (refreshKey) invalidates the cached
  // base costs — the rolled-up cost is different now, so clear and refetch.
  useEffect(() => {
    inFlightTierQtys.current.clear();
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTierBaseCosts(new Map());
  }, [refreshKey]);

  // Re-price every tier row when base costs arrive/change (base × markup).
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setRows((prev) => prev.map((r) => recomputeRow(r, tierBaseCosts)));
  }, [tierBaseCosts]);

  const updateRows = (mapper: (prev: EditRow[]) => EditRow[]) => {
    setRows((prev) => mapper(prev));
    setDirty(true);
    setSaveState('idle');
  };

  /**
   * Persist the current tiers. Explicit (button-driven) rather than auto-saved
   * because pricing feeds quotes.
   */
  const handleSave = async (): Promise<void> => {
    const allValid = rows.every((r) => {
      const q = parseNumber(r.quantity);
      return q !== null && isValidQuantityValue(q);
    });
    if (!allValid) {
      setError('Every tier needs a quantity greater than 0.');
      return;
    }
    setSaveState('saving');
    setError(null);
    try {
      const sortedRows = [...rows].sort((a, b) => a.sequence - b.sequence);
      const payload = sortedRows.map((r, i) => ({
        id: r.id,
        sequence: (i + 1) * 10,
        quantity: parseNumber(r.quantity) as number,
        markup_percent: parseNumber(r.markupPercent),
      }));
      await replaceTiersForPart(companyId, partId, payload);
      // Auto-log the change as a 'pricing' note (audit trail in the Notes feed).
      // Non-fatal: a note-write failure must never block the pricing save.
      try {
        const operator = await getCurrentMember(companyId);
        if (operator) {
          const summary = payload
            .map((t) => `@${t.quantity} → ${t.markup_percent ?? '—'}%`)
            .join(', ');
          const label = payload.length === 1 ? 'tier' : 'tiers';
          await addPartPricingNote(
            partId,
            companyId,
            operator.id,
            `Pricing updated — ${payload.length} ${label}: ${summary}`,
          );
        }
      } catch (noteErr) {
        console.error('Failed to log pricing note:', noteErr);
      }
      // Reload so newly-inserted rows pick up real ids.
      const fresh = await getTiersForPart(partId);
      setRows(
        fresh.map((t) =>
          recomputeRow(
            {
              id: t.id,
              sequence: t.sequence,
              quantity: String(t.quantity),
              markupPercent: t.markup_percent !== null ? String(t.markup_percent) : '',
              unitPrice: '',
              baseCostPerUnit: null,
            },
            tierBaseCosts,
          ),
        ),
      );
      setDirty(false);
      setSaveState('saved');
      // Refresh the parent so the workspace "missing markup" banner reflects
      // the new markup instead of going stale.
      onPricingChanged?.();
    } catch (err) {
      console.error('Failed to save pricing tiers:', err);
      setSaveState('error');
      setError(err instanceof Error ? err.message : 'Failed to save pricing tiers');
    }
  };

  const handleQuantityChange = (idx: number, value: string): void => {
    // Tier minimum quantities are decimal-capable (universal, up to 4 dp) so a
    // part sold by length/weight/volume can set a fractional break like 0.32.
    if (!isValidQuantityInput(value)) return;
    updateRows((prev) => {
      const next = [...prev];
      next[idx] = recomputeRow({ ...next[idx], quantity: value }, tierBaseCosts);
      return next;
    });
  };

  const handleMarkupChange = (idx: number, value: string): void => {
    if (value !== '' && !/^\d*\.?\d*$/.test(value)) return;
    updateRows((prev) => {
      const next = [...prev];
      next[idx] = recomputeRow({ ...next[idx], markupPercent: value }, tierBaseCosts);
      return next;
    });
  };

  const handleUnitPriceChange = (idx: number, value: string): void => {
    if (value !== '' && !/^\d*\.?\d*$/.test(value)) return;
    updateRows((prev) => {
      const next = [...prev];
      const row = next[idx];
      const unitPrice = parseNumber(value);
      const base = row.baseCostPerUnit;
      let markupStr = row.markupPercent;
      // Back-solve markup only when we actually know the base cost. With
      // missing materials the base is null and there's nothing to invert
      // against — leave markup alone.
      if (unitPrice !== null && base !== null && base > 0) {
        const back = calculateMarkupFromUnitPrice(base, unitPrice);
        if (back !== null) markupStr = String(back);
      }
      next[idx] = { ...row, unitPrice: value, markupPercent: markupStr };
      return next;
    });
  };

  const addTier = (): void => {
    updateRows((prev) => {
      const nextSequence = prev.length > 0 ? Math.max(...prev.map((r) => r.sequence)) + 10 : 10;
      const row: EditRow = {
        sequence: nextSequence,
        quantity: '',
        markupPercent: '',
        unitPrice: '',
        baseCostPerUnit: 0,
      };
      return [...prev, recomputeRow(row, tierBaseCosts)];
    });
  };

  const removeRow = (idx: number): void => {
    updateRows((prev) => prev.filter((_, i) => i !== idx));
  };

  const handleCostingSave = async (): Promise<void> => {
    setCostingSaveState('saving');
    try {
      await updatePartCostingBatchQuantity(partId, costingQty);
      setCostingSaveState('saved');
      setCostingDirty(false);
      // Deliberately NOT calling onPricingChanged: the batch size doesn't affect
      // this part's own pricing tiers (their base is at the order qty) or its
      // priceability — only its value as a component on OTHER parts' pages. A
      // refresh here would just re-fetch the same numbers and flicker.
    } catch (err) {
      setCostingSaveState('error');
      setError(err instanceof Error ? err.message : 'Failed to save costing quantity');
    }
  };

  const runPerUnit = breakdown ? Math.round(breakdown.total_labor_cost * 100) / 100 : 0;
  // total_setup_cost is the one-time setup; amortize it over the batch here so
  // the row is per-unit and changes live with the quantity (calculateRoutingCost
  // keeps setup un-amortized — the tier layer / this card divide it).
  const setupPerUnit = breakdown
    ? Math.round((breakdown.total_setup_cost / costingQty) * 100) / 100
    : 0;
  // null when materials are incomplete: render "Materials / unit: —" so the
  // gap is visible. 0 (or no rendering) is reserved for "no BOM at all".
  const materialPerUnit: number | null = breakdown
    ? breakdown.total_material_cost === null
      ? null
      : Math.round(breakdown.total_material_cost * 100) / 100
    : 0;
  // The three lines sum to the part's unit cost at the batch size.
  const costPerUnit: number | null =
    materialPerUnit === null
      ? null
      : Math.round((runPerUnit + setupPerUnit + materialPerUnit) * 100) / 100;

  const warningsAlert =
    !isBought && breakdown && breakdown.warnings.length > 0 ? (
      <Alert severity="warning" sx={{ mb: 2 }}>
        <Typography variant="body2" sx={{ fontWeight: 600, mb: 0.5 }}>
          Heads up:
        </Typography>
        {breakdown.warnings.map((w, i) => {
          // missing_material_cost warnings expose `child_part_name` +
          // `detail` so the part name itself can be the link (no
          // trailing "Open child →"). Other warning types fall back
          // to the bare `message` string with no link, since they
          // don't point at a navigable target.
          const isLinkable = !!w.child_part_id && !!w.child_part_name;
          return (
            <Typography key={i} variant="body2">
              {'• '}
              {isLinkable ? (
                <>
                  <Link
                    href={buildPartHref({
                      companyId,
                      targetPartId: w.child_part_id as string,
                      chain: pushPartToChain(
                        currentChain,
                        part.id,
                        w.child_part_id as string,
                      ),
                    })}
                    style={{
                      color: 'inherit',
                      textDecoration: 'underline',
                      fontWeight: 600,
                    }}
                  >
                    {w.child_part_name} ›
                  </Link>{' '}
                  {w.detail ?? ''}
                </>
              ) : (
                w.message
              )}
            </Typography>
          );
        })}
      </Alert>
    ) : null;

  const spinner = (
    <Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }}>
      <CircularProgress size={24} />
    </Box>
  );

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      {error && (
        <Alert severity="error" onClose={() => setError(null)}>
          {error}
        </Alert>
      )}

      {/* COST card — made parts only. A bought part's cost lives in the
          procurement (Cost) panel rendered alongside this one, so the page
          reads the same for both: Cost card, then Pricing card. */}
      {!isBought && (
        <Card elevation={2}>
          <CardContent>
            {/* Header + the costing lot size. Changing it re-amortizes setup and
                updates the build-up live; it's also the qty this part is valued
                at when consumed as a material in another part. */}
            <Box
              sx={{ display: 'flex', alignItems: 'center', gap: 1.5, mb: 1, flexWrap: 'wrap' }}
            >
              <Typography variant="h6" sx={{ fontWeight: 600 }}>
                Cost
              </Typography>
              <Box sx={{ flex: 1 }} />
              <TextField
                label={`Batch size (${costingUnit})`}
                value={costingQtyStr}
                onChange={(e) => {
                  setCostingQtyStr(e.target.value);
                  setCostingDirty(true);
                  setCostingSaveState('idle');
                }}
                type="number"
                size="small"
                inputProps={{ min: 1, step: 'any', inputMode: 'decimal' }}
                sx={{ width: 170 }}
              />
              <SaveStatus state={costingSaveState} />
              <Button
                variant="contained"
                size="small"
                onClick={handleCostingSave}
                disabled={!costingDirty || costingSaving}
              >
                Save
              </Button>
            </Box>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 2 }}>
              Setup spreads across the run this part is made in. This quantity is
              also what it&apos;s valued at when used as a material in another part.
            </Typography>

            {breakdownLoading && !breakdown && spinner}

            {!breakdownLoading && !breakdown && (
              <Box
                sx={{
                  py: 4,
                  px: 2,
                  textAlign: 'center',
                  border: (theme) => `1px dashed ${theme.palette.divider}`,
                  borderRadius: 1,
                }}
              >
                <Typography variant="body2" color="text.secondary">
                  Add operations or materials to calculate cost
                </Typography>
              </Box>
            )}

            {warningsAlert}

            {breakdown && (
              <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
                <SummaryRow label="Run labor / unit" value={formatCurrency(runPerUnit)} />
                <SummaryRow label="Setup / unit" value={formatCurrency(setupPerUnit)} />
                {(materialPerUnit === null || materialPerUnit > 0) && (
                  <SummaryRow label="Materials / unit" value={formatCurrency(materialPerUnit)} />
                )}
                <Box
                  sx={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    mt: 1,
                    pt: 1,
                    borderTop: (theme) => `1px solid ${theme.palette.divider}`,
                  }}
                >
                  <Typography variant="body2" sx={{ fontWeight: 700 }}>
                    Cost / unit
                  </Typography>
                  <Typography variant="body2" sx={{ fontWeight: 700 }}>
                    {formatCurrency(costPerUnit)}
                  </Typography>
                </Box>
              </Box>
            )}
          </CardContent>
        </Card>
      )}

      {/* PRICING card — markup tiers (bought + made). */}
      <Card elevation={2}>
        <CardContent>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, mb: 2 }}>
            <Typography variant="h6" sx={{ fontWeight: 600 }}>
              Pricing
            </Typography>
            <SaveStatus state={saveState} />
          </Box>

          {loading && spinner}

          {/* Markup tiers — always inline-editable. Made and bought parts show the
              same columns (Base / unit, Markup %, Unit price); the base cost comes
              from the routing/BOM for made parts and from the procurement tiers for
              bought parts (same compute engine), so both surface a final unit price
              after markup. */}
          {!loading && (isBought || breakdown) && (
            <>
              <TableContainer>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>{qtyColumnHeader}</TableCell>
                  <TableCell align="right">Base / unit</TableCell>
                  <TableCell align="right">Markup %</TableCell>
                  <TableCell align="right">Unit price</TableCell>
                  <TableCell align="right"></TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {rows.map((row, idx) => {
                  return (
                    <TableRow key={row.id ?? `tier-${idx}`}>
                      <TableCell sx={{ minWidth: 90 }}>
                        <TextField
                          size="small"
                          value={row.quantity}
                          onChange={(e) => handleQuantityChange(idx, e.target.value)}
                          inputMode="decimal"
                        />
                      </TableCell>
                      <TableCell align="right">
                        {formatCurrency(row.baseCostPerUnit)}
                      </TableCell>
                      <TableCell align="right" sx={{ minWidth: 120 }}>
                        <TextField
                          size="small"
                          value={row.markupPercent}
                          onChange={(e) => handleMarkupChange(idx, e.target.value)}
                          inputMode="decimal"
                          sx={{ width: 100 }}
                        />
                      </TableCell>
                      <TableCell align="right" sx={{ minWidth: 130 }}>
                        <TextField
                          size="small"
                          value={row.unitPrice}
                          onChange={(e) => handleUnitPriceChange(idx, e.target.value)}
                          inputMode="decimal"
                          sx={{ width: 120 }}
                        />
                      </TableCell>
                      <TableCell align="right">
                        <DeleteIconButton
                          ariaLabel="Remove tier"
                          onClick={() => removeRow(idx)}
                        />
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </TableContainer>

          <Box
            sx={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              mt: 2,
              gap: 1.5,
              flexWrap: 'wrap',
            }}
          >
            <Button size="small" variant="outlined" onClick={addTier} startIcon={<AddIcon />}>
              Add tier
            </Button>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
              {dirty && saveState !== 'saving' && (
                <Typography variant="caption" color="text.secondary">
                  Unsaved changes
                </Typography>
              )}
              <SaveStatus state={saveState} />
              <Button
                variant="contained"
                size="small"
                onClick={handleSave}
                disabled={!dirty || saving}
              >
                Save pricing
              </Button>
            </Box>
          </Box>
            </>
          )}
        </CardContent>
      </Card>
    </Box>
  );
}

function SummaryRow({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
      <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1 }}>
        <Typography variant="body2" color="text.secondary">
          {label}
        </Typography>
        {hint && (
          <Typography variant="caption" color="text.secondary">
            ({hint})
          </Typography>
        )}
      </Box>
      <Typography variant="body2" fontWeight={500}>
        {value}
      </Typography>
    </Box>
  );
}
