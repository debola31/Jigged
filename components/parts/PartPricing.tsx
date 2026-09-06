'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import TextField from '@mui/material/TextField';
import InputAdornment from '@mui/material/InputAdornment';
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
  getComputedPartChargeBase,
  updatePartCostingBatchQuantity,
} from '@/utils/partsAccess';
import { getCurrentMember } from '@/utils/operatorAccess';
import { getCompany, readCompanyPricingDefaults } from '@/utils/companyAccess';
import { calculateMarkupFromUnitPrice } from '@/types/quote';
import type { Part } from '@/types/part';
import { buildPartHref, pushPartToChain } from '@/lib/partNavStack';
import { isValidQuantityInput, isValidQuantityValue } from '@/lib/quantityInput';
import { quantityUnitSuffix } from '@/lib/standardUnits';
import SaveStatus, { type SaveState } from '@/components/common/SaveStatus';
import UnsavedChangesBar, { unsavedFieldSx } from '@/components/common/UnsavedChangesBar';

interface PartPricingProps {
  companyId: string;
  part: Part;
  /** Bumped by the parent whenever the routing changes — triggers a reload + recompute. */
  refreshKey?: number;
  /**
   * Reports whether this card is holding staged tier edits, so the workspace can
   * confirm before a tab switch or page unload throws them away
   * (interaction-standards.md §2, exit guard). Must be referentially stable.
   */
  onDirtyChange?: (dirty: boolean) => void;
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
  /**
   * What a BOUGHT part costs us at this break — editable, and the base the
   * markup is applied to. Empty string for a made part, whose base is the
   * routing + BOM rollup rather than a stored number.
   */
  costPerUnit: string;
  markupPercent: string;
  unitPrice: string;
  /** null when materials are incomplete or the breakdown is missing — render
   * "—" rather than $0. See `RoutingCostBreakdown.materials_complete`. */
  baseCostPerUnit: number | null;
}

/**
 * The persisted values a set of rows was seeded from. "Unsaved" is DERIVED by
 * comparing the live rows against this, never tracked as a sticky flag — so
 * typing 1 → 10 → 1 ends up genuinely clean again instead of nagging for a save
 * that would write nothing.
 *
 * Quantity, cost and markup are compared: they are what `replaceTiersForPart`
 * persists. `unitPrice` is derived (base × markup) and `baseCostPerUnit` is a
 * display value, so neither can differ without one of the three differing too.
 */
interface TierSnapshot {
  quantity: string;
  costPerUnit: string;
  markupPercent: string;
}

function snapshotRows(rows: EditRow[]): TierSnapshot[] {
  return rows.map((r) => ({
    quantity: r.quantity.trim(),
    costPerUnit: r.costPerUnit.trim(),
    markupPercent: r.markupPercent.trim(),
  }));
}

function rowDiffersFromBaseline(row: EditRow, base: TierSnapshot | undefined): boolean {
  if (!base) return true; // a row with no counterpart is newly added
  return (
    row.quantity.trim() !== base.quantity ||
    row.costPerUnit.trim() !== base.costPerUnit ||
    row.markupPercent.trim() !== base.markupPercent
  );
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
 * base at that tier's own quantity — `baseCostByQty` holds
 * `getComputedPartChargeBase(part, qty)` results (the same engine the quote form and
 * the persisted line use, so a tier's price here matches a quote at that qty).
 * Base absent from the map = not fetched yet → render "—" until it lands.
 */
function recomputeRow(
  row: EditRow,
  baseCostByQty: Map<number, number | null>,
  isBought = false,
): EditRow {
  const qty = parseNumber(row.quantity);
  if (qty === null || qty <= 0) {
    return { ...row, baseCostPerUnit: null };
  }
  // A bought part's base IS the cost on this row — it has no BOM, so its charge
  // base and its true cost are the same number. Reading the cell rather than the
  // engine means the price updates as the cost is typed, instead of after a save
  // and a refetch.
  const base = isBought
    ? parseNumber(row.costPerUnit)
    : baseCostByQty.has(qty)
      ? baseCostByQty.get(qty) ?? null
      : undefined;
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
/** A markup for prose: trims the trailing zeros a numeric(10,6) round-trips. */
function formatPercentValue(n: number): string {
  return `${n.toLocaleString(undefined, { maximumFractionDigits: 6 })}%`;
}

function blankRow(): EditRow {
  return {
    sequence: 10,
    quantity: '1',
    costPerUnit: '',
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
 *       (same compute engine, getComputedPartChargeBase), so the card shows the
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
  onDirtyChange,
}: PartPricingProps) {
  const partId = part.id;
  const isBought = part.source === 'bought';
  // Label the Min qty column with the part's unit (e.g. "Min qty (in)") so a
  // fractional break reads unambiguously. null unit -> plain "Min qty".
  const qtyUnitLabel = quantityUnitSuffix(part.primary_unit);
  const qtyColumnHeader = qtyUnitLabel ? `Min qty (${qtyUnitLabel})` : 'Min qty';

  const [rows, setRows] = useState<EditRow[]>([]);
  const [breakdown, setBreakdown] = useState<RoutingCostBreakdown | null>(null);
  // Base per tier quantity, from the ONE canonical engine
  // (getComputedPartChargeBase → compute_part_charge_base_at_qty) — the same
  // source the quote form and the persisted line use, so a tier's Base/unit +
  // Unit price match a quote at that qty. `breakdown` is kept only for the cost
  // build-up + warnings.
  const [tierBaseCosts, setTierBaseCosts] = useState<Map<number, number | null>>(new Map());
  const inFlightTierQtys = useRef<Set<number>>(new Set());
  const tierBaseCostsRef = useRef(tierBaseCosts);
  // Latest partId, so an in-flight base-cost fetch can tell whether the part
  // changed under it before persisting its result (guards cross-part staleness
  // without a per-effect-run `cancelled` flag — see the fetch effect below). Kept
  // current in the ref-sync effect (refs must not be written during render).
  const partIdRef = useRef(partId);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  // The persisted values `rows` was seeded from. Dirty state is derived against
  // this rather than latched on edit, so undoing an edit by hand clears it.
  const [baseline, setBaseline] = useState<TierSnapshot[]>([]);
  // Mirrors the derived `dirty` for the load effect's isolation guard. Kept
  // current by the publish effect below, which MUST stay declared above the load
  // effect — React runs effects in declaration order within a commit.
  const dirtyRef = useRef(false);
  // Which part the tier rows currently hold. A genuine part change must reload
  // even if the previous part left staged edits behind; a sibling-panel refresh
  // on the SAME part must not.
  const loadedPartIdRef = useRef<string | null>(null);
  // The shop's starting markup for this part's source. Read once per company;
  // used to SEED the first tier and to caption where that number came from.
  // null while it loads — the starter write waits rather than guessing 0.
  const [starterMarkup, setStarterMarkup] = useState<number | null>(null);
  const saving = saveState === 'saving';

  const dirtyRowFlags = rows.map((r, i) => rowDiffersFromBaseline(r, baseline[i]));
  const dirty = rows.length !== baseline.length || dirtyRowFlags.some(Boolean);

  /**
   * Which row currently holds the LOWEST break.
   *
   * Derived from what is typed, not from position, so it follows an edit without
   * the rows jumping around under the cursor — they reorder on save, not on
   * every keystroke. The lowest break is the one the engine floors to when no
   * break covers the quantity, so it also applies to everything beneath it; the
   * caption on that cell says so instead of the field being taken away.
   */
  const lowestBreakIdx = rows.reduce<number>((best, r, i) => {
    const q = parseNumber(r.quantity);
    if (q === null || q <= 0) return best;
    const bestQ = best === -1 ? null : parseNumber(rows[best].quantity);
    return bestQ === null || q < bestQ ? i : best;
  }, -1);

  /**
   * Breaks typed twice. `part_pricing_tiers` is unique on (part_id, quantity) —
   * one break, one row — so this would come back as a raw 23505. Saying it here
   * beats surfacing a constraint name.
   */
  const duplicateQuantities = (() => {
    const seen = new Map<number, number>();
    const dupes: number[] = [];
    rows.forEach((r) => {
      const q = parseNumber(r.quantity);
      if (q === null || q <= 0) return;
      const n = (seen.get(q) ?? 0) + 1;
      seen.set(q, n);
      if (n === 2) dupes.push(q);
    });
    return dupes;
  })();

  // Costing lot size — the production run this part's cost amortizes over, and
  // the quantity it's valued at when consumed as a component. Drives the live
  // Cost breakdown below (setup / N). Made parts only.
  const [costingQtyStr, setCostingQtyStr] = useState<string>(
    String(part.costing_batch_quantity ?? 1),
  );
  /**
   * The persisted batch size this field was seeded from. Kept locally rather
   * than read straight off `part`, because saving it deliberately does NOT
   * refresh the parent — so the prop stays stale and would keep the field
   * looking dirty forever. Same derive-don't-latch rule as the tier tables:
   * typing 30 → 302 → 30 settles back to clean.
   */
  const [costingBaseline, setCostingBaseline] = useState<string>(
    String(part.costing_batch_quantity ?? 1),
  );
  const [costingSaveState, setCostingSaveState] = useState<SaveState>('idle');
  const costingDirty = costingQtyStr.trim() !== costingBaseline.trim();
  const [breakdownLoading, setBreakdownLoading] = useState<boolean>(!isBought);

  useEffect(() => {
    let cancelled = false;
    getCompany(companyId)
      .then((c) => {
        if (cancelled) return;
        const starters = readCompanyPricingDefaults(c);
        setStarterMarkup(isBought ? starters.bought : starters.made);
      })
      .catch(() => {
        // Leave it null: the starter tier simply doesn't fire, and the card
        // behaves as it did before the setting existed. Guessing 0 here would
        // write a markup the shop may not have chosen.
      });
    return () => {
      cancelled = true;
    };
  }, [companyId, isBought]);
  const costingSaving = costingSaveState === 'saving';
  const costingQty = (() => {
    const n = parseFloat(costingQtyStr);
    return Number.isFinite(n) && n > 0 ? n : 1;
  })();
  const costingUnit = unitShortLabel(part.primary_unit) ?? (part.primary_unit || 'unit');

  const loadAll = useCallback(async (opts?: { showSpinner?: boolean }) => {
    // Only the first load of a given part shows the spinner. A silent reload
    // (sibling panel saved, or our own save landed) keeps the table on screen
    // instead of collapsing it to a spinner and back.
    if (opts?.showSpinner !== false) setLoading(true);
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
        costPerUnit: t.cost_per_unit !== null ? String(t.cost_per_unit) : '',
        markupPercent: t.markup_percent !== null ? String(t.markup_percent) : '',
        // unitPrice + baseCostPerUnit are filled in by the base effect
        // (getComputedPartChargeBase per tier qty → base × markup) once the
        // async values land; start blank so nothing stale renders.
        unitPrice: '',
        baseCostPerUnit: null,
      }));
      // A never-configured part shows a single unfilled row to fill in — NOT
      // dirty, so Save stays disabled until the user actually edits it.
      const seeded = asRows.length > 0 ? asRows : [blankRow()];
      // A ladder reads low-to-high. Rows arrive ordered by `sequence`, which
      // tracks the break after a save but need not on rows written by an
      // importer or a migration, so sort on the number the user actually reads.
      seeded.sort((a, b) => (parseNumber(a.quantity) ?? 0) - (parseNumber(b.quantity) ?? 0));
      const recomputed = seeded.map((r) => recomputeRow(r, tierBaseCostsRef.current, isBought));
      setRows(recomputed);
      // These rows now mirror the database, so they become the clean baseline.
      setBaseline(snapshotRows(recomputed));
      dirtyRef.current = false;
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
    //
    // SECTION ISOLATION (docs/interaction-standards.md §2). A `refreshKey` bump
    // is a SIBLING panel reporting that it saved — a routing operation, a BOM
    // row, a preferred-vendor pick. That legitimately changes the DERIVED base
    // cost, which the two effects below refetch. It must never re-seed these
    // rows from the database: doing so silently discarded staged tier edits
    // (type a Min qty, then save an operation, and the typed value reverted
    // with no warning — the reported bug).
    //
    // A real part change still reloads: `dirty` belongs to the part we were
    // editing, so it must not keep the NEXT part's tiers off screen.
    const partChanged = loadedPartIdRef.current !== partId;
    if (!partChanged && dirtyRef.current) return;
    loadedPartIdRef.current = partId;
    void loadAll({ showSpinner: partChanged });
  }, [loadAll, partId, refreshKey]);

  // Publish staged-edit state to the workspace, which owns the exit guard, and
  // keep `dirtyRef` current for the load effect's isolation guard. MUST remain
  // declared above that effect — effects run in declaration order per commit.
  // The cleanup clears the parent's flag on unmount so a discarded draft can't
  // leave the guard armed forever.
  useEffect(() => {
    dirtyRef.current = dirty;
    onDirtyChange?.(dirty);
    return () => onDirtyChange?.(false);
  }, [dirty, onDirtyChange]);

  // Keep the refs current for loadAll (tierBaseCostsRef) and the base-cost fetch
  // guard (partIdRef) — written here, not during render.
  useEffect(() => {
    tierBaseCostsRef.current = tierBaseCosts;
    partIdRef.current = partId;
  }, [tierBaseCosts, partId]);

  // Re-seed the costing-qty field when the persisted part value changes.
  useEffect(() => {
    const persisted = String(part.costing_batch_quantity ?? 1);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setCostingQtyStr(persisted);
    setCostingBaseline(persisted);
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

  // Fetch the single-source base for each distinct tier quantity via the
  // canonical engine, the same one the quote form and the persisted line use.
  //
  // It is the CHARGE base (compute_part_charge_base_at_qty), not true cost:
  // markup applies to what materials are charged into the part at, so a BOM line
  // set to charge its child at price is already inside this number. Identical to
  // true cost until someone sets that toggle — and when they diverge, the Cost
  // card above names the gap (Material markup / unit → Price base / unit) so the
  // two cards can't look like they disagree. Debounced so editing a tier
  // qty doesn't refetch on every keystroke.
  //
  // MADE PARTS ONLY. A bought part's base is the cost typed on its own row — it
  // has no BOM, so its charge base and true cost are the same number the grid
  // already holds. Asking the engine for it would be a round trip to be told
  // what is on screen, and it would lag a keystroke behind.
  useEffect(() => {
    if (isBought) return;
    const qtys = [
      ...new Set(
        rows
          .map((r) => parseNumber(r.quantity))
          .filter((q): q is number => q !== null && q > 0),
      ),
    ];
    const missing = qtys.filter((q) => !tierBaseCosts.has(q) && !inFlightTierQtys.current.has(q));
    if (missing.length === 0) return;
    // `tierBaseCosts` is a dependency so a refreshKey-driven cache wipe (below)
    // re-runs this and refetches every tier. That means resolving ONE qty re-runs
    // the effect — so we must NOT use a per-run `cancelled` flag to gate the
    // write: it would cancel the still-in-flight sibling qtys, leaving an
    // untouched tier permanently without a base cost ("—" + blank Unit price)
    // after save. Each result is a pure function of (partId, qty); persist it as
    // long as we're still on the same part (partIdRef guards a real part change).
    const forPartId = partId;
    const handle = setTimeout(() => {
      for (const q of missing) {
        inFlightTierQtys.current.add(q);
        getComputedPartChargeBase(forPartId, q)
          .catch(() => null)
          .then((base) => {
            inFlightTierQtys.current.delete(q);
            if (forPartId !== partIdRef.current) return;
            setTierBaseCosts((prev) => new Map(prev).set(q, base));
          });
      }
    }, 300);
    return () => {
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
    setRows((prev) => prev.map((r) => recomputeRow(r, tierBaseCosts, isBought)));
  }, [tierBaseCosts, isBought]);


  const updateRows = (mapper: (prev: EditRow[]) => EditRow[]) => {
    setRows((prev) => mapper(prev));
    // No dirty flag to set — it's derived from `baseline` on the next render,
    // which is what makes an edit-then-undo settle back to clean.
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
    if (duplicateQuantities.length > 0) {
      setError(
        `Two tiers share the same min qty (${duplicateQuantities.join(', ')}). ` +
          'One break, one row — give them different quantities or remove one.',
      );
      return;
    }
    setSaveState('saving');
    setError(null);
    try {
      // Ascending by BREAK, not by the old sequence. A ladder reads bottom-up,
      // and sequence is renumbered to match so the next load comes back in the
      // same order. Sorting here rather than on every keystroke is deliberate:
      // reordering as somebody types would move the row out from under them.
      const sortedRows = [...rows].sort(
        (a, b) => (parseNumber(a.quantity) ?? 0) - (parseNumber(b.quantity) ?? 0),
      );
      // Each row KEEPS its own sequence. Renumbering by position used to be
      // harmless because the sort was by sequence; sorting by break can swap two
      // rows, and `replaceTiersForPart` updates one row at a time against
      // UNIQUE (part_id, sequence) — so a swap would collide halfway through.
      // Display order comes from the break now, which is what a reader sorts by
      // anyway, so sequence has nothing left to encode.
      const payload = sortedRows.map((r) => ({
        id: r.id,
        sequence: r.sequence,
        quantity: parseNumber(r.quantity) as number,
        // Made parts store no cost — their base is the routing + BOM rollup.
        cost_per_unit: isBought ? parseNumber(r.costPerUnit) : null,
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
      // Clear the guard first: the reload below re-seeds these rows, and the
      // isolation guard deliberately refuses to re-seed while dirty. (The
      // rendered dirty state clears on its own once loadAll resets `baseline`.)
      dirtyRef.current = false;
      // Reload so newly-inserted rows pick up real ids. Silent — the table
      // stays on screen rather than collapsing to a spinner.
      await loadAll({ showSpinner: false });
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

  /**
   * Drop staged tier edits and re-seed from the database. The counterpart to
   * Save in the unsaved-changes footer: the user needs a deliberate way to back
   * out that isn't "navigate away and hope nothing was kept".
   */
  const handleDiscard = (): void => {
    dirtyRef.current = false;
    setSaveState('idle');
    setError(null);
    void loadAll({ showSpinner: false });
  };

  const handleQuantityChange = (idx: number, value: string): void => {
    // Tier minimum quantities are decimal-capable (universal, up to 4 dp) so a
    // part sold by length/weight/volume can set a fractional break like 0.32.
    if (!isValidQuantityInput(value)) return;
    updateRows((prev) => {
      const next = [...prev];
      next[idx] = recomputeRow({ ...next[idx], quantity: value }, tierBaseCosts, isBought);
      return next;
    });
  };

  const handleMarkupChange = (idx: number, value: string): void => {
    if (value !== '' && !/^\d*\.?\d*$/.test(value)) return;
    updateRows((prev) => {
      const next = [...prev];
      next[idx] = recomputeRow({ ...next[idx], markupPercent: value }, tierBaseCosts, isBought);
      return next;
    });
  };

  const handleCostChange = (idx: number, value: string): void => {
    if (value !== '' && !/^\d*\.?\d*$/.test(value)) return;
    updateRows((prev) => {
      const next = [...prev];
      next[idx] = recomputeRow({ ...next[idx], costPerUnit: value }, tierBaseCosts, isBought);
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
        // A new break inherits the cost of the row above: a volume break is
        // usually about the markup, and restating an unchanged cost by hand is
        // how the two ladders drifted apart in the first place.
        costPerUnit: prev.length > 0 ? prev[prev.length - 1].costPerUnit : '',
        markupPercent: '',
        unitPrice: '',
        baseCostPerUnit: 0,
      };
      return [...prev, recomputeRow(row, tierBaseCosts, isBought)];
    });
  };

  const removeRow = (idx: number): void => {
    updateRows((prev) => prev.filter((_, i) => i !== idx));
  };

  /**
   * Batch size commits via an explicit Save, NOT auto-save on blur.
   *
   * It looks like a harmless scalar, but `compute_part_cost_at_qty` values this
   * part as a made child at exactly this quantity in every parent's BOM
   * (`v_child_val_qty := v_bom.child_costing_batch_quantity`). So a fat-fingered
   * 30 → 300 silently re-costs every parent part and flows into their quoted
   * prices. That is financial data by §2's own test, and financial data does not
   * auto-save.
   *
   * Deliberately does NOT call onPricingChanged: the batch size doesn't affect
   * this part's own pricing tiers (their base is at the order qty) or its
   * priceability — only its value as a component on OTHER parts' pages. A
   * refresh here would just re-fetch the same numbers and flicker.
   */
  const handleCostingSave = async (): Promise<void> => {
    setCostingSaveState('saving');
    try {
      await updatePartCostingBatchQuantity(partId, costingQty);
      setCostingSaveState('saved');
      // The parent is deliberately not refreshed (see above), so `part` keeps
      // the old value — advance the local baseline or the field stays "dirty".
      setCostingBaseline(String(costingQty));
    } catch (err) {
      setCostingSaveState('error');
      setError(err instanceof Error ? err.message : 'Failed to save costing quantity');
    }
  };

  /** Put the batch size back to the persisted value. */
  const handleCostingDiscard = (): void => {
    setCostingQtyStr(costingBaseline);
    setCostingSaveState('idle');
  };


  // The single tier the part was set up with, still sitting at the shop's
  // starting markup. Not "any tier that matches" — a shop with two breaks
  // has been in here and made choices, and one that typed the same number by
  // hand doesn't need telling where it came from either (it stops matching the
  // moment they change it, which is the only time the hint has anything to say).
  const isUntouchedStarterTier =
    !dirty &&
    starterMarkup !== null &&
    rows.length === 1 &&
    rows[0]?.id !== undefined &&
    parseNumber(rows[0]?.markupPercent) === starterMarkup;

  // Removing a row leaves no dirty row to count; UnsavedChangesBar falls back
  // to generic phrasing rather than claiming zero.
  const dirtyRowCount = dirtyRowFlags.filter(Boolean).length;

  const runPerUnit = breakdown ? Math.round(breakdown.total_labor_cost * 100) / 100 : 0;
  // total_setup_cost is the one-time setup; amortize it over the batch here so
  // the row is per-unit and changes live with the quantity (calculateRoutingCost
  // keeps setup un-amortized — the tier layer / this card divide it).
  const setupPerUnit = breakdown
    ? Math.round((breakdown.total_setup_cost / costingQty) * 100) / 100
    : 0;
  // null when materials are incomplete: render "Materials / unit: —" so the
  // gap is visible. 0 (or no rendering) is reserved for "no BOM at all".
  //
  // Two figures now (#727). `materialPerUnit` is TRUE cost — what the materials
  // cost us — because this card is the Cost card and "Cost / unit" must mean
  // cost. `materialChargedPerUnit` is what the price is built on: it includes
  // any child charged at its marked-up price. Identical until someone sets that
  // toggle, and the card only grows the extra rows when they diverge.
  const materialPerUnit: number | null = breakdown
    ? breakdown.total_material_true_cost === null
      ? null
      : Math.round(breakdown.total_material_true_cost * 100) / 100
    : 0;
  const materialChargedPerUnit: number | null = breakdown
    ? breakdown.total_material_cost === null
      ? null
      : Math.round(breakdown.total_material_cost * 100) / 100
    : 0;
  // The three lines sum to the part's TRUE unit cost at the batch size.
  const costPerUnit: number | null =
    materialPerUnit === null
      ? null
      : Math.round((runPerUnit + setupPerUnit + materialPerUnit) * 100) / 100;
  // The markup our own materials carry into the price, and the base the Pricing
  // card's tier table applies its markup to. Rendered only when non-zero, so
  // the common card is unchanged.
  const materialMarkupPerUnit: number | null =
    materialPerUnit === null || materialChargedPerUnit === null
      ? null
      : Math.round((materialChargedPerUnit - materialPerUnit) * 100) / 100;
  const showMaterialMarkup =
    materialMarkupPerUnit !== null && Math.abs(materialMarkupPerUnit) >= 0.005;
  const priceBasePerUnit: number | null =
    materialChargedPerUnit === null
      ? null
      : Math.round((runPerUnit + setupPerUnit + materialChargedPerUnit) * 100) / 100;

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
                  setCostingSaveState('idle');
                }}
                type="number"
                size="small"
                inputProps={{ min: 1, step: 'any', inputMode: 'decimal' }}
                // Marks the changed input itself — the single-field counterpart
                // to the tier rows' left accent.
                sx={{ width: 170, ...(costingDirty ? unsavedFieldSx : {}) }}
              />
              <SaveStatus state={costingSaveState} />
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

                {/* Only when a material is charged at price. Two extra lines
                    make the Pricing card's Base / unit traceable from here —
                    otherwise the two cards would show different numbers with
                    nothing on screen to explain the gap. */}
                {showMaterialMarkup && (
                  <>
                    <SummaryRow
                      label="Material markup / unit"
                      value={formatCurrency(materialMarkupPerUnit)}
                    />
                    <Box
                      sx={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        pt: 0.5,
                      }}
                    >
                      <Typography variant="body2" sx={{ fontWeight: 700 }}>
                        Price base / unit
                      </Typography>
                      <Typography variant="body2" sx={{ fontWeight: 700 }}>
                        {formatCurrency(priceBasePerUnit)}
                      </Typography>
                    </Box>
                    <Typography variant="caption" color="text.secondary">
                      Materials on this BOM are charged at their marked-up price, so
                      the Pricing card below applies its markup to the price base,
                      not to cost.
                    </Typography>
                  </>
                )}
              </Box>
            )}

            {/* Batch size is staged-explicit-Save like the tier tables (it
                re-costs every parent part), so it gets the identical unsaved
                affordance rather than a lone Save button in the header. No
                count — a single field. */}
            {costingDirty && (
              <UnsavedChangesBar
                saveLabel="Save batch size"
                saving={costingSaving}
                onSave={() => void handleCostingSave()}
                onDiscard={handleCostingDiscard}
              />
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
                  <TableCell align="right">{isBought ? 'Unit cost' : 'Base / unit'}</TableCell>
                  <TableCell align="right">Markup %</TableCell>
                  <TableCell align="right">Unit price</TableCell>
                  <TableCell align="right"></TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {rows.map((row, idx) => {
                  return (
                    <TableRow
                      key={row.id ?? `tier-${idx}`}
                      sx={{
                        // The same 3px left accent the incomplete BOM rows and
                        // routing rows use, one rung down that ladder:
                        // error.main = broken, warning.main = wants your
                        // attention, transparent = fine. An unsaved edit is the
                        // middle rung — it is not a mistake, so it must not
                        // read like one. Transparent (not absent) when clean so
                        // the row doesn't shift when the accent appears.
                        '& > td:first-of-type': {
                          borderLeft: '3px solid',
                          borderLeftColor: dirtyRowFlags[idx] ? 'warning.main' : 'transparent',
                        },
                      }}
                    >
                      {/* Every break is editable, including the lowest. It is
                          still true that the lowest one cannot gate anything —
                          the engine floors to it when no break covers the
                          quantity — but that is a fact to STATE, not a field to
                          confiscate. A shop that prices from 0.5 up has to be
                          able to say 0.5. The caption below says what the lowest
                          break actually does. */}
                      <TableCell sx={{ minWidth: 90 }}>
                        <TextField
                          size="small"
                          value={row.quantity}
                          onChange={(e) => handleQuantityChange(idx, e.target.value)}
                          inputMode="decimal"
                          helperText={idx === lowestBreakIdx ? 'and below' : undefined}
                        />
                      </TableCell>
                      <TableCell align="right" sx={{ minWidth: 120 }}>
                        {isBought ? (
                          <TextField
                            size="small"
                            value={row.costPerUnit}
                            onChange={(e) => handleCostChange(idx, e.target.value)}
                            inputMode="decimal"
                            sx={{ width: 110 }}
                            slotProps={{ input: { startAdornment: <InputAdornment position="start">$</InputAdornment> } }}
                          />
                        ) : (
                          formatCurrency(row.baseCostPerUnit)
                        )}
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

          {/* A number the card wrote, not one the user typed — so it says where
              it came from. At 0% it also says what that means, because "sells at
              cost" is the part a shop must not discover on an accepted quote.
              Disappears the moment the markup is changed. */}
          {isUntouchedStarterTier && (
            <Typography
              variant="caption"
              color="text.secondary"
              sx={{ display: 'block', mt: 1 }}
            >
              {starterMarkup === 0
                ? 'Ready to quote at 0% markup — this part sells for what it costs. '
                : `Ready to quote at ${formatPercentValue(starterMarkup)} markup. `}
              That is your shop&apos;s starting markup for parts you{' '}
              {isBought ? 'buy' : 'make'}, from{' '}
              <Link href={`/dashboard/${companyId}/settings`} style={{ color: 'inherit' }}>
                Settings
              </Link>
              . Change it here for this part alone.
            </Typography>
          )}

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
            {!dirty && <SaveStatus state={saveState} />}
          </Box>

          {dirty && (
            <UnsavedChangesBar
              count={dirtyRowCount}
              saveLabel="Save pricing"
              saving={saving}
              onSave={() => void handleSave()}
              onDiscard={handleDiscard}
            />
          )}
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
