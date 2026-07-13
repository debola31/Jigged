'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Divider from '@mui/material/Divider';
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
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import Snackbar from '@mui/material/Snackbar';
import Link from 'next/link';
import AddIcon from '@mui/icons-material/Add';
import CheckIcon from '@mui/icons-material/Check';
import PercentIcon from '@mui/icons-material/Percent';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import SettingsOutlinedIcon from '@mui/icons-material/SettingsOutlined';
import TuneIcon from '@mui/icons-material/Tune';
import DeleteIconButton from '@/components/common/DeleteIconButton';
import {
  calculateRoutingCost,
  calculateTierPricing,
  type RoutingCostBreakdown,
} from '@/utils/routingCostCalculation';
import {
  getTiersForPart,
  replaceTiersForPart,
  setPartMarkupRate,
} from '@/utils/partPricingTiersAccess';
import {
  getAllMarkupRates,
  applyRateToPart,
  applyDefaultRateToPart,
} from '@/utils/markupRatesAccess';
import { addPartPricingNote } from '@/utils/partsAccess';
import { getCurrentMember } from '@/utils/operatorAccess';
import {
  type MarkupRate,
  summarizeBreakpoints,
} from '@/types/markupRates';
import { calculateMarkupFromUnitPrice } from '@/types/quote';
import type { Part } from '@/types/part';
import { buildPartHref, pushPartToChain } from '@/lib/partNavStack';
import { isValidQuantityInput, isValidQuantityValue } from '@/lib/quantityInput';
import { quantityUnitSuffix } from '@/lib/standardUnits';
import SaveStatus, { type SaveState } from '@/components/common/SaveStatus';
import CostAtQtyPreview from '@/components/parts/CostAtQtyPreview';
import CostingBasisEditor from '@/components/parts/CostingBasisEditor';

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
   * Called after this card mutates the part's pricing on its own (currently:
   * auto-applying the company Default rate to an unconfigured part). Lets the
   * parent re-fetch so the workspace completeness banner reflects the new
   * markup instead of going stale.
   */
  onPricingChanged?: () => void;
}

/**
 * Working-copy of a tier inside the editor (Custom mode only).
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

const DEFAULT_CUSTOM_MARKUP = '25';

function formatCurrency(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value);
}

function parseNumber(s: string): number | null {
  if (s.trim() === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function recomputeRow(row: EditRow, breakdown: RoutingCostBreakdown | null): EditRow {
  const qty = parseNumber(row.quantity);
  if (!breakdown || qty === null || qty <= 0) {
    return { ...row, baseCostPerUnit: null };
  }
  const markup = parseNumber(row.markupPercent);
  const { baseCostPerUnit, unitPrice } = calculateTierPricing(breakdown, qty, markup);
  return {
    ...row,
    baseCostPerUnit,
    unitPrice: unitPrice !== null ? String(unitPrice) : '',
  };
}

/**
 * Per-part Pricing card.
 *
 * Two layouts depending on `part.source`:
 *
 *   Made parts:
 *     - Cost build-up (run labor / setup / materials) summarised at top
 *     - Markup tier table with Qty / Base / unit / Markup % / Unit price
 *     - Unit price is editable and back-calculates the markup
 *
 *   Bought parts:
 *     - Cost source (per-vendor tier sheets) lives in a separate
 *       PartProcurementPricingPanel card above this one — keeping
 *       cost-of-goods and markup visually distinct
 *     - Markup tier table with just Qty / Markup %
 *     - Unit price is NOT shown in the card — it depends on which vendor
 *       wins at the actual order quantity, which is only known at quote
 *       time. The quote engine multiplies get_procurement_cost(qty) by
 *       (1 + markup/100) using the closest tier from this card.
 *
 * The mode chip at top-right ("Markup: Custom" or a rate name) and its
 * picker menu are identical in both layouts. Custom = inline editable
 * tier rows; rate-linked = read-only display of the rate's breakpoints
 * + Switch-to-Custom / Edit-the-rate buttons.
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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Pricing feeds quotes (financial data), so tier edits are committed via an
  // explicit Save — not auto-saved. `dirty` tracks unsaved edits.
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [dirty, setDirty] = useState(false);
  const saving = saveState === 'saving';

  // Local mirror of part.markup_rate_id so the UI flips instantly between
  // rate-linked (read-only) and Custom (editable) without waiting for the
  // parent to refetch the part.
  const [linkedRateId, setLinkedRateId] = useState<string | null>(part.markup_rate_id);
  useEffect(() => {
    setLinkedRateId(part.markup_rate_id);
  }, [part.markup_rate_id]);

  // Local mirror of the costing batch quantity so the CostingBasisEditor's save
  // reflects instantly; `previewRefresh` re-runs the Cost-at-qty preview and the
  // tier base recompute (both depend on this part's own valuation basis).
  const [costingBatchQty, setCostingBatchQty] = useState<number | null>(
    part.costing_batch_quantity,
  );
  useEffect(() => {
    setCostingBatchQty(part.costing_batch_quantity);
  }, [part.costing_batch_quantity]);
  const [previewRefresh, setPreviewRefresh] = useState(0);

  const [rateMenuAnchor, setRateMenuAnchor] = useState<HTMLElement | null>(null);
  const [userRates, setUserRates] = useState<MarkupRate[]>([]);
  const [applyingRateName, setApplyingRateName] = useState<string | null>(null);
  const [appliedRateName, setAppliedRateName] = useState<string | null>(null);

  const linkedRate = userRates.find((r) => r.id === linkedRateId) ?? null;
  const isCustom = linkedRateId === null;

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // Bought parts have no routing — skip the calculateRoutingCost call
      // (it would just return null) and load only the persisted tiers. The
      // procurement subsection embedded above the markup table provides the
      // cost source instead.
      const [tiers, routingBreakdown] = await Promise.all([
        getTiersForPart(partId),
        isBought ? Promise.resolve(null) : calculateRoutingCost(partId),
      ]);
      setBreakdown(routingBreakdown);

      // baseCostPerUnit is purely a UI display value (computed live from the
      // breakdown + tier qty). The column was dropped from part_pricing_tiers
      // in migration 20260514 — the canonical truth at save time is
      // compute_part_cost_at_qty, called inside replaceTiersForPart.
      const asRows: EditRow[] = tiers.map((t) => ({
        id: t.id,
        sequence: t.sequence,
        quantity: String(t.quantity),
        markupPercent: t.markup_percent !== null ? String(t.markup_percent) : '',
        // unitPrice is recomputed live by recomputeRow below; the
        // part_pricing_tiers.unit_price column has been dropped — prices
        // are always derived from the routing + BOM rollup.
        unitPrice: '',
        baseCostPerUnit: 0,
      }));
      setRows(asRows.map((r) => recomputeRow(r, routingBreakdown)));
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

  useEffect(() => {
    let cancelled = false;
    getAllMarkupRates(companyId)
      .then((rates) => {
        if (!cancelled) setUserRates(rates);
      })
      .catch((err) => console.error('Failed to load markup rates:', err));
    return () => {
      cancelled = true;
    };
  }, [companyId]);

  // Auto-default: a never-configured part (no rate link AND no tiers — e.g. a
  // freshly imported part) should silently follow the company Default rate
  // rather than prompting the user to pick one. Applied per-part, on first view;
  // the user can change it afterwards. This is deliberately a per-part write on
  // a user-navigated action, NOT a bulk backfill of data at rest.
  //
  // Latched per part so a slow/absent parent refresh can't re-trigger it, and
  // scoped to the *persisted* unconfigured state (part.markup_rate_id === null
  // && no tiers) so a deliberate "switched to Custom, cleared tiers" edit —
  // which reaches the same UI state via user action — is left alone.
  const autoDefaultedPartRef = useRef<string | null>(null);
  useEffect(() => {
    if (loading) return; // wait for the tier load to settle
    if (part.markup_rate_id !== null) return; // already rate-linked
    if (rows.length > 0) return; // has tiers (custom, or already applied)
    if (autoDefaultedPartRef.current === partId) return; // handled this part
    const defaultRate = userRates.find((r) => r.is_default);
    if (!defaultRate) return; // no company default → keep the manual prompt

    autoDefaultedPartRef.current = partId; // latch before the async write
    applyDefaultRateToPart(companyId, partId)
      .then(() => {
        setLinkedRateId(defaultRate.id);
        // Prefer the parent refresh (re-runs the workspace priceability banner
        // too); fall back to a local reload if this card is used standalone.
        if (onPricingChanged) onPricingChanged();
        else loadAll();
      })
      .catch((err) => {
        // Non-fatal: leave the part unconfigured and fall back to the manual
        // empty-state prompt. Stay latched so we don't retry-loop on a hard
        // failure (a page reload will try again).
        console.error('Failed to auto-apply default markup rate:', err);
      });
  }, [
    loading,
    part.markup_rate_id,
    rows.length,
    userRates,
    companyId,
    partId,
    onPricingChanged,
    loadAll,
  ]);

  const updateRows = (mapper: (prev: EditRow[]) => EditRow[]) => {
    setRows((prev) => mapper(prev));
    setDirty(true);
    setSaveState('idle');
  };

  /**
   * Persist the current tiers. Explicit (button-driven) rather than auto-saved
   * because pricing feeds quotes. Saving a rate-linked part forks it to Custom
   * (replaceTiersForPart with no rateId sets markup_rate_id = null).
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
      setLinkedRateId(null);
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
              baseCostPerUnit: 0,
            },
            breakdown,
          ),
        ),
      );
      setDirty(false);
      setSaveState('saved');
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
      next[idx] = recomputeRow({ ...next[idx], quantity: value }, breakdown);
      return next;
    });
  };

  const handleMarkupChange = (idx: number, value: string): void => {
    if (value !== '' && !/^\d*\.?\d*$/.test(value)) return;
    updateRows((prev) => {
      const next = [...prev];
      next[idx] = recomputeRow({ ...next[idx], markupPercent: value }, breakdown);
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
      return [...prev, recomputeRow(row, breakdown)];
    });
  };

  const removeRow = (idx: number): void => {
    updateRows((prev) => prev.filter((_, i) => i !== idx));
  };

  const handleApplyRate = async (rate: MarkupRate): Promise<void> => {
    setRateMenuAnchor(null);
    setApplyingRateName(rate.name);
    setError(null);
    try {
      await applyRateToPart(companyId, partId, rate.id);
      setLinkedRateId(rate.id);
      await loadAll();
      setAppliedRateName(rate.name);
    } catch (err) {
      console.error('Failed to apply markup rate:', err);
      setError(err instanceof Error ? err.message : 'Failed to apply markup rate');
    } finally {
      setApplyingRateName(null);
    }
  };

  const handleSwitchToCustom = async (): Promise<void> => {
    setRateMenuAnchor(null);
    if (linkedRateId === null) return;
    setError(null);
    try {
      // Flip the FK to null without rewriting tiers — the user wants to
      // start editing from the rate's current values.
      await setPartMarkupRate(partId, null);
      setLinkedRateId(null);
    } catch (err) {
      console.error('Failed to switch to custom:', err);
      setError(err instanceof Error ? err.message : 'Failed to switch to custom');
    }
  };

  const handleStartCustomFromEmpty = (): void => {
    // From the empty state "Set custom tiers" CTA: drop in one editable row
    // at qty=1 with a sensible default markup. Autosave persists it as soon
    // as the row is valid.
    updateRows(() => [
      recomputeRow(
        {
          sequence: 10,
          quantity: '1',
          markupPercent: DEFAULT_CUSTOM_MARKUP,
          unitPrice: '',
          baseCostPerUnit: 0,
        },
        breakdown,
      ),
    ]);
  };

  const runPerUnit = breakdown ? Math.round(breakdown.total_labor_cost * 100) / 100 : 0;
  const setupBatch = breakdown ? Math.round(breakdown.total_setup_cost * 100) / 100 : 0;
  // null when materials are incomplete: render "Materials / unit: —" so the
  // gap is visible. 0 (or no rendering) is reserved for "no BOM at all".
  const materialPerUnit: number | null = breakdown
    ? breakdown.total_material_cost === null
      ? null
      : Math.round(breakdown.total_material_cost * 100) / 100
    : 0;

  // Three states drive what renders in the markup section:
  //   1. linked to a rate                → read-only tier table + switch/edit bar
  //   2. Custom with at least one tier   → editable table + Add tier
  //   3. Custom with zero tiers          → empty-state cards prompting a choice
  const showReadOnly = linkedRateId !== null;
  const showEmptyState = isCustom && rows.length === 0;
  const showEditable = isCustom && rows.length > 0;

  /** Header row for the Pricing section: h6 + saving indicator + Markup
      chip. Rendered at the top of the card for both made and bought
      parts — bought parts get a separate Cost card above this one. */
  const pricingHeader = (
    <Box
      sx={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        gap: 2,
        mb: 2,
        flexWrap: 'wrap',
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
        <Typography variant="h6" sx={{ fontWeight: 600 }}>
          Pricing
        </Typography>
        <SaveStatus state={saveState} />
      </Box>
      <Button
        variant="outlined"
        size="small"
        startIcon={isCustom ? <TuneIcon /> : <PercentIcon />}
        endIcon={<KeyboardArrowDownIcon />}
        onClick={(e) => setRateMenuAnchor(e.currentTarget)}
        disabled={applyingRateName !== null}
        sx={{ borderRadius: 4, textTransform: 'none', fontWeight: 500 }}
      >
        {applyingRateName
          ? `Applying ${applyingRateName}…`
          : `Markup: ${isCustom ? 'Custom' : (linkedRate?.name ?? 'rate')}`}
      </Button>
    </Box>
  );

  return (
    <Box>
      {pricingHeader}

      {error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>
          {error}
        </Alert>
      )}

      {/* Made parts: routing breakdown gates the rest. Bought parts skip
          this entirely (the cost source above is the procurement panel). */}
      {!isBought && !loading && breakdown && breakdown.warnings.length > 0 && (
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
      )}

      {loading && (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }}>
          <CircularProgress size={24} />
        </Box>
      )}

      {/* Made parts only: routing-not-set-up empty state. */}
      {!isBought && !loading && !breakdown && (
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
            Add operations or materials to calculate pricing
          </Typography>
        </Box>
      )}

      {/* Made parts: cost build-up rows above the divider. */}
      {!isBought && !loading && breakdown && (
        <>
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5, mb: 2 }}>
            <SummaryRow label="Run labor / unit" value={formatCurrency(runPerUnit)} />
            <SummaryRow
              label="Setup (one-time)"
              value={formatCurrency(setupBatch)}
              hint="amortized across tier qty"
            />
            {(materialPerUnit === null || materialPerUnit > 0) && (
              <SummaryRow label="Materials / unit" value={formatCurrency(materialPerUnit)} />
            )}
          </Box>

          {/* Cost-at-qty preview: shows the step-function material cost (whole-
              unit ceiling / batch pinning) at a user-entered order qty, so a
              yield part's real per-part cost is visible where the tier table
              can't express it. */}
          <CostAtQtyPreview partId={partId} refreshKey={refreshKey + previewRefresh} />

          {/* Costing basis: pin how THIS made part is valued when consumed as a
              material (e.g. a batch of 25 → fixed $/unit). */}
          <CostingBasisEditor
            partId={partId}
            primaryUnit={part.primary_unit}
            costingBatchQuantity={costingBatchQty}
            onSaved={(v) => {
              setCostingBatchQty(v);
              setPreviewRefresh((n) => n + 1);
              // Tier base costs can depend on this part's own valuation basis;
              // refresh the parent (workspace banner) or reload locally.
              if (onPricingChanged) onPricingChanged();
              else loadAll();
            }}
          />

          <Divider sx={{ mt: 2, mb: 2 }} />
        </>
      )}

      {/* Markup section — same three states for both made and bought, only
          the visible columns differ. Bought parts hide Base / unit and
          Unit price (those are quote-time values; cost depends on which
          vendor wins at the actual order qty). */}
      {!loading && (isBought || breakdown) && (
        <>
          {/* (1) RATE-LINKED — read-only. */}
          {showReadOnly && (
            <>
              {/* Make customizing obvious (the old small "Switch to Custom"
                  button was missed). Prominent contained action at the top. */}
              <Box
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 2,
                  mb: 2,
                  flexWrap: 'wrap',
                }}
              >
                <Typography variant="body2" color="text.secondary">
                  Following the <strong>{linkedRate?.name ?? 'selected'}</strong> rate.
                </Typography>
                <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
                  {linkedRate && (
                    <Button
                      size="small"
                      component={Link}
                      href={`/dashboard/${companyId}/markup-rates/${linkedRate.id}/edit`}
                      endIcon={<OpenInNewIcon fontSize="small" />}
                    >
                      Edit the rate
                    </Button>
                  )}
                  <Button
                    size="small"
                    variant="contained"
                    startIcon={<TuneIcon />}
                    onClick={handleSwitchToCustom}
                  >
                    Customize pricing
                  </Button>
                </Box>
              </Box>
              <TableContainer>

                <Table size="small">
                  <TableHead>
                    <TableRow>
                      <TableCell>{qtyColumnHeader}</TableCell>
                      {!isBought && <TableCell align="right">Base / unit</TableCell>}
                      <TableCell align="right">Markup %</TableCell>
                      {!isBought && <TableCell align="right">Unit price</TableCell>}
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {rows.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={isBought ? 2 : 4}>
                          <Typography variant="body2" color="text.secondary" sx={{ py: 1 }}>
                            This rate has no breakpoints yet. Edit the rate to add some,
                            or switch to Custom to set tiers just for this part.
                          </Typography>
                        </TableCell>
                      </TableRow>
                    ) : (
                      rows.map((row) => {
                        const markupNum = parseNumber(row.markupPercent);
                        const unitPriceNum = parseNumber(row.unitPrice);
                        return (
                          <TableRow key={row.id}>
                            <TableCell>{row.quantity || '—'}</TableCell>
                            {!isBought && (
                              <TableCell align="right">
                                {formatCurrency(row.baseCostPerUnit)}
                              </TableCell>
                            )}
                            <TableCell align="right">
                              {markupNum !== null ? `${markupNum}%` : '—'}
                            </TableCell>
                            {!isBought && (
                              <TableCell align="right">
                                {formatCurrency(unitPriceNum)}
                              </TableCell>
                            )}
                          </TableRow>
                        );
                      })
                    )}
                  </TableBody>
                </Table>
              </TableContainer>
            </>
          )}

          {/* (2) CUSTOM with tiers — editable. */}
          {showEditable && (
            <>
              <TableContainer>
                <Table size="small">
                  <TableHead>
                    <TableRow>
                      <TableCell>{qtyColumnHeader}</TableCell>
                      {!isBought && <TableCell align="right">Base / unit</TableCell>}
                      <TableCell align="right">Markup %</TableCell>
                      {!isBought && <TableCell align="right">Unit price</TableCell>}
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
                          {!isBought && (
                            <TableCell align="right">
                              {formatCurrency(row.baseCostPerUnit)}
                            </TableCell>
                          )}
                          <TableCell align="right" sx={{ minWidth: 120 }}>
                            <TextField
                              size="small"
                              value={row.markupPercent}
                              onChange={(e) => handleMarkupChange(idx, e.target.value)}
                              inputMode="decimal"
                              sx={{ width: 100 }}
                            />
                          </TableCell>
                          {!isBought && (
                            <TableCell align="right" sx={{ minWidth: 130 }}>
                              <TextField
                                size="small"
                                value={row.unitPrice}
                                onChange={(e) => handleUnitPriceChange(idx, e.target.value)}
                                inputMode="decimal"
                                sx={{ width: 120 }}
                              />
                            </TableCell>
                          )}
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

          {/* (3) CUSTOM with no tiers — explicit choice prompt. */}
          {showEmptyState && (
            <Box
              sx={{
                py: 4,
                px: 2,
                textAlign: 'center',
                border: (theme) => `1px dashed ${theme.palette.divider}`,
                borderRadius: 1,
              }}
            >
              <Typography variant="subtitle1" sx={{ fontWeight: 600, mb: 0.5 }}>
                {isBought ? 'How should this part be marked up?' : 'How should this part be priced?'}
              </Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
                Pick a markup rate to follow company-wide pricing rules, or set custom
                tiers just for this part.
              </Typography>
              <Box
                sx={{
                  display: 'flex',
                  gap: 2,
                  justifyContent: 'center',
                  flexWrap: 'wrap',
                }}
              >
                <Button
                  variant="contained"
                  startIcon={<PercentIcon />}
                  endIcon={<KeyboardArrowDownIcon />}
                  onClick={(e) => setRateMenuAnchor(e.currentTarget)}
                  disabled={applyingRateName !== null}
                >
                  {userRates.length > 0 ? 'Pick a markup rate' : 'Create a markup rate'}
                </Button>
                <Button
                  variant="outlined"
                  startIcon={<TuneIcon />}
                  onClick={handleStartCustomFromEmpty}
                >
                  Set custom tiers
                </Button>
              </Box>
            </Box>
          )}
        </>
      )}

      {/* Mode picker menu — Custom + every rate, plus a tail link to the
          rates management page. */}
      <Menu
        anchorEl={rateMenuAnchor}
        open={Boolean(rateMenuAnchor)}
        onClose={() => setRateMenuAnchor(null)}
        slotProps={{ paper: { sx: { minWidth: 320, maxWidth: 420 } } }}
      >
        <MenuItem
          onClick={handleSwitchToCustom}
          selected={isCustom}
          disabled={isCustom}
        >
          <ListItemIcon sx={{ minWidth: 32 }}>
            {isCustom ? <CheckIcon fontSize="small" color="primary" /> : <TuneIcon fontSize="small" />}
          </ListItemIcon>
          <ListItemText
            primary="Custom"
            secondary="Set tier values just for this part"
            slotProps={{
              primary: { sx: { fontWeight: 500 } },
              secondary: { sx: { fontSize: '0.75rem' } },
            }}
          />
        </MenuItem>

        <Divider sx={{ my: 0.5 }} />

        {userRates.length === 0 && (
          <MenuItem disabled>
            <ListItemText
              primary="No rates yet"
              secondary="Create one to apply it here"
              slotProps={{
                primary: { sx: { fontStyle: 'italic' } },
                secondary: { sx: { fontSize: '0.75rem' } },
              }}
            />
          </MenuItem>
        )}
        {userRates.map((rate) => {
          const isApplied = linkedRateId === rate.id;
          return (
            <MenuItem key={rate.id} onClick={() => handleApplyRate(rate)} selected={isApplied}>
              <ListItemIcon sx={{ minWidth: 32 }}>
                {isApplied ? <CheckIcon fontSize="small" color="primary" /> : null}
              </ListItemIcon>
              <ListItemText
                primary={rate.name}
                secondary={
                  isApplied
                    ? `Currently applied · ${summarizeBreakpoints(rate.breakpoints)}`
                    : summarizeBreakpoints(rate.breakpoints)
                }
                slotProps={{
                  primary: { sx: { fontWeight: 500 } },
                  secondary: { sx: { fontSize: '0.75rem' } },
                }}
              />
            </MenuItem>
          );
        })}

        <Divider sx={{ my: 0.5 }} />

        <MenuItem
          component={Link}
          href={`/dashboard/${companyId}/markup-rates`}
          onClick={() => setRateMenuAnchor(null)}
          sx={{ color: 'primary.main' }}
        >
          <ListItemIcon sx={{ minWidth: 32 }}>
            <SettingsOutlinedIcon fontSize="small" color="primary" />
          </ListItemIcon>
          <ListItemText primary="Manage rates…" />
        </MenuItem>
      </Menu>

      <Snackbar
        open={appliedRateName !== null}
        autoHideDuration={3000}
        onClose={() => setAppliedRateName(null)}
        message={appliedRateName ? `Applied "${appliedRateName}"` : ''}
      />
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
