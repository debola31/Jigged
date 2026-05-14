'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Divider from '@mui/material/Divider';
import Button from '@mui/material/Button';
import TextField from '@mui/material/TextField';
import IconButton from '@mui/material/IconButton';
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
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import CheckIcon from '@mui/icons-material/Check';
import CloudSyncOutlinedIcon from '@mui/icons-material/CloudSyncOutlined';
import PercentIcon from '@mui/icons-material/Percent';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import SettingsOutlinedIcon from '@mui/icons-material/SettingsOutlined';
import TuneIcon from '@mui/icons-material/Tune';
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
import { getAllMarkupRates, applyRateToPart } from '@/utils/markupRatesAccess';
import {
  type MarkupRate,
  summarizeBreakpoints,
} from '@/types/markupRates';
import { calculateMarkupFromUnitPrice } from '@/types/quote';
import type { Part } from '@/types/part';
import PartProcurementPricingPanel from '@/components/parts/PartProcurementPricingPanel';

interface PartPricingProps {
  companyId: string;
  part: Part;
  /** Bumped by the parent whenever the routing changes — triggers a reload + recompute. */
  refreshKey?: number;
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
  baseCostPerUnit: number;
}

const AUTOSAVE_DEBOUNCE_MS = 600;
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
    return { ...row, baseCostPerUnit: 0 };
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
 *     - Cost source subsection at top: per-vendor tier sheets
 *       (PartProcurementPricingPanel embedded inline)
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
export default function PartPricing({ companyId, part, refreshKey = 0 }: PartPricingProps) {
  const partId = part.id;
  const isBought = part.source === 'bought';

  const [rows, setRows] = useState<EditRow[]>([]);
  const [breakdown, setBreakdown] = useState<RoutingCostBreakdown | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Local mirror of part.markup_rate_id so the UI flips instantly between
  // rate-linked (read-only) and Custom (editable) without waiting for the
  // parent to refetch the part.
  const [linkedRateId, setLinkedRateId] = useState<string | null>(part.markup_rate_id);
  useEffect(() => {
    setLinkedRateId(part.markup_rate_id);
  }, [part.markup_rate_id]);

  const [rateMenuAnchor, setRateMenuAnchor] = useState<HTMLElement | null>(null);
  const [userRates, setUserRates] = useState<MarkupRate[]>([]);
  const [applyingRateName, setApplyingRateName] = useState<string | null>(null);
  const [appliedRateName, setAppliedRateName] = useState<string | null>(null);

  const queueRef = useRef<Promise<void>>(Promise.resolve());
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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

      const asRows: EditRow[] = tiers.map((t) => ({
        id: t.id,
        sequence: t.sequence,
        quantity: String(t.quantity),
        markupPercent: t.markup_percent !== null ? String(t.markup_percent) : '',
        unitPrice: t.unit_price !== null ? String(t.unit_price) : '',
        baseCostPerUnit: t.base_cost_per_unit ?? 0,
      }));
      setRows(asRows.map((r) => recomputeRow(r, routingBreakdown)));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load pricing');
    } finally {
      setLoading(false);
    }
  }, [partId, isBought]);

  useEffect(() => {
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

  const scheduleSave = useCallback(
    (next: EditRow[]) => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        const job = queueRef.current.then(async () => {
          // Skip if any row has an invalid qty (markup might still be in flight).
          const allValid = next.every((r) => {
            const q = parseNumber(r.quantity);
            return q !== null && q > 0;
          });
          if (!allValid) return;

          setSaving(true);
          setError(null);
          try {
            const sortedRows = [...next].sort((a, b) => a.sequence - b.sequence);
            const payload = sortedRows.map((r, i) => ({
              id: r.id,
              sequence: (i + 1) * 10,
              quantity: parseNumber(r.quantity) as number,
              markup_percent: parseNumber(r.markupPercent),
            }));
            // No rateId arg → manual edit path; replaceTiersForPart will set
            // markup_rate_id to null, flipping the part to Custom.
            await replaceTiersForPart(companyId, partId, payload);
            setLinkedRateId(null);

            // Reload so newly-inserted rows pick up real ids; preserve user's
            // typed strings where possible.
            const fresh = await getTiersForPart(partId);
            setRows((prev) => {
              const byId = new Map(prev.filter((r) => r.id).map((r) => [r.id, r]));
              return fresh.map((t) => {
                const existing = t.id ? byId.get(t.id) : undefined;
                return existing
                  ? { ...existing, id: t.id, baseCostPerUnit: t.base_cost_per_unit ?? 0 }
                  : {
                      id: t.id,
                      sequence: t.sequence,
                      quantity: String(t.quantity),
                      markupPercent: t.markup_percent !== null ? String(t.markup_percent) : '',
                      unitPrice: t.unit_price !== null ? String(t.unit_price) : '',
                      baseCostPerUnit: t.base_cost_per_unit ?? 0,
                    };
              });
            });
          } catch (err) {
            console.error('Failed to save pricing tiers:', err);
            setError(err instanceof Error ? err.message : 'Failed to save pricing tiers');
          } finally {
            setSaving(false);
          }
        });
        queueRef.current = job.catch(() => undefined);
      }, AUTOSAVE_DEBOUNCE_MS);
    },
    [companyId, partId],
  );

  const updateRows = (mapper: (prev: EditRow[]) => EditRow[]) => {
    setRows((prev) => {
      const next = mapper(prev);
      scheduleSave(next);
      return next;
    });
  };

  const handleQuantityChange = (idx: number, value: string): void => {
    if (!/^\d*$/.test(value)) return;
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
      if (unitPrice !== null && base > 0) {
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
  const materialPerUnit = breakdown ? Math.round(breakdown.total_material_cost * 100) / 100 : 0;

  // Three states drive what renders in the markup section:
  //   1. linked to a rate                → read-only tier table + switch/edit bar
  //   2. Custom with at least one tier   → editable table + Add tier
  //   3. Custom with zero tiers          → empty-state cards prompting a choice
  const showReadOnly = linkedRateId !== null;
  const showEmptyState = isCustom && rows.length === 0;
  const showEditable = isCustom && rows.length > 0;

  /** Header row for the Pricing section: h6 + saving indicator + Markup
      chip. Used as-is for made parts (top of the card) and after the
      divider for bought parts (below the embedded Cost section). */
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
        {saving && (
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, color: 'text.secondary' }}>
            <CloudSyncOutlinedIcon fontSize="small" />
            <Typography variant="caption">Saving…</Typography>
          </Box>
        )}
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
      {/* Bought parts: Cost section (vendor tier sheets, with their own h6
          header + vendor switcher) renders first; divider; then the
          Pricing section header + markup table. Mirrors the
          Operations/Materials pattern in the made-part right-column card
          where each subsection has its own h6 rather than a joint card
          header. */}
      {isBought && (
        <>
          <PartProcurementPricingPanel
            partId={partId}
            companyId={companyId}
            primaryUnit={part.primary_unit}
            preferredVendorId={part.preferred_vendor_id}
          />
          <Divider sx={{ my: 3 }} />
        </>
      )}

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
          {breakdown.warnings.map((w, i) => (
            <Typography key={i} variant="body2">
              • {w.message}
              {w.child_part_id && (
                <>
                  {' '}
                  <Link
                    href={`/dashboard/${companyId}/parts/${w.child_part_id}`}
                    style={{ color: 'inherit', textDecoration: 'underline' }}
                  >
                    Open child →
                  </Link>
                </>
              )}
            </Typography>
          ))}
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
            {materialPerUnit > 0 && (
              <SummaryRow label="Materials / unit" value={formatCurrency(materialPerUnit)} />
            )}
          </Box>

          <Divider sx={{ mb: 2 }} />
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
              <TableContainer>

                <Table size="small">
                  <TableHead>
                    <TableRow>
                      <TableCell>Min qty</TableCell>
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

              <Box
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  mt: 2,
                  flexWrap: 'wrap',
                  gap: 1,
                }}
              >
                <Button
                  size="small"
                  variant="outlined"
                  startIcon={<TuneIcon />}
                  onClick={handleSwitchToCustom}
                >
                  Switch to Custom to edit
                </Button>
                {linkedRate && (
                  <Button
                    size="small"
                    component={Link}
                    href={`/dashboard/${companyId}/markup-rates/${linkedRate.id}/edit`}
                    endIcon={<OpenInNewIcon fontSize="small" />}
                  >
                    Edit the {linkedRate.name} rate
                  </Button>
                )}
              </Box>
            </>
          )}

          {/* (2) CUSTOM with tiers — editable. */}
          {showEditable && (
            <>
              <TableContainer>
                <Table size="small">
                  <TableHead>
                    <TableRow>
                      <TableCell>Min qty</TableCell>
                      {!isBought && <TableCell align="right">Base / unit</TableCell>}
                      <TableCell align="right">Markup %</TableCell>
                      {!isBought && <TableCell align="right">Unit price</TableCell>}
                      <TableCell align="right"></TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {rows.map((row, idx) => {
                      const markupNum = parseNumber(row.markupPercent);
                      const suggestedUnitPrice =
                        row.baseCostPerUnit > 0 && markupNum !== null
                          ? (Math.round(row.baseCostPerUnit * (1 + markupNum / 100) * 100) / 100).toFixed(2)
                          : '0.00';
                      return (
                        <TableRow key={row.id ?? `tier-${idx}`}>
                          <TableCell sx={{ minWidth: 90 }}>
                            <TextField
                              size="small"
                              value={row.quantity}
                              onChange={(e) => handleQuantityChange(idx, e.target.value)}
                              inputMode="numeric"
                              placeholder="1"
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
                              placeholder="25"
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
                                placeholder={suggestedUnitPrice}
                                sx={{ width: 120 }}
                              />
                            </TableCell>
                          )}
                          <TableCell align="right">
                            <IconButton
                              size="small"
                              color="error"
                              onClick={() => removeRow(idx)}
                              aria-label="Remove tier"
                            >
                              <DeleteOutlineIcon fontSize="small" />
                            </IconButton>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </TableContainer>

              <Box sx={{ display: 'flex', justifyContent: 'flex-end', mt: 2 }}>
                <Button size="small" variant="outlined" onClick={addTier} startIcon={<AddIcon />}>
                  Add tier
                </Button>
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
