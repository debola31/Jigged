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
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import Autocomplete from '@mui/material/Autocomplete';
import AddIcon from '@mui/icons-material/Add';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import CloudSyncOutlinedIcon from '@mui/icons-material/CloudSyncOutlined';
import {
  calculateRoutingCost,
  calculateTierPricing,
  type RoutingCostBreakdown,
} from '@/utils/routingCostCalculation';
import {
  getTiersForPart,
  replaceTiersForPart,
  copyTiersFromPart,
} from '@/utils/partPricingTiersAccess';
import { getPartsForSelect } from '@/utils/partsAccess';
import { calculateMarkupFromUnitPrice } from '@/types/quote';
import type { Part } from '@/types/part';

interface PartPricingProps {
  companyId: string;
  part: Part;
  /** Bumped by the parent whenever the routing changes — triggers a reload + recompute. */
  refreshKey?: number;
}

/**
 * Working-copy of a tier inside the editor.
 *
 * Markup % is the source of truth — `unit_price` is always derived from
 * `base_cost × (1 + markup/100)`. Typing a unit price back-calculates markup
 * before the next save.
 *
 * `phantom: true` rows are UI-only seeds — they show users what a tier looks
 * like for parts that have no tiers yet, but they don't write to the database
 * until the user demonstrates intent (types markup, types a unit price, or
 * edits the seeded qty). If the user navigates away without touching them,
 * no DB rows are created.
 */
interface EditRow {
  id?: string;
  phantom?: boolean;
  sequence: number;
  quantity: string;
  markupPercent: string;
  unitPrice: string;
  baseCostPerUnit: number;
}

const AUTOSAVE_DEBOUNCE_MS = 600;

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
  // Phantom rows leave unitPrice empty so the input renders the suggested price
  // as a placeholder rather than a committed value — typing in either Markup
  // or Unit price flips the row out of phantom and the value becomes real.
  if (row.phantom) {
    return { ...row, baseCostPerUnit };
  }
  return {
    ...row,
    baseCostPerUnit,
    unitPrice: unitPrice !== null ? String(unitPrice) : '',
  };
}

function makePhantomRows(breakdown: RoutingCostBreakdown | null): EditRow[] {
  // Single phantom row — qty 1 with a suggested 25% markup. Multi-quantity
  // exploration lives behind a separate UX (TBD).
  const rows: EditRow[] = [
    { phantom: true, sequence: 10, quantity: '1', markupPercent: '25', unitPrice: '', baseCostPerUnit: 0 },
  ];
  return rows.map((r) => recomputeRow(r, breakdown));
}

export default function PartPricing({ companyId, part, refreshKey = 0 }: PartPricingProps) {
  const partId = part.id;

  const [rows, setRows] = useState<EditRow[]>([]);
  const [breakdown, setBreakdown] = useState<RoutingCostBreakdown | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [copyDialogOpen, setCopyDialogOpen] = useState(false);
  const [copyOptions, setCopyOptions] = useState<Array<{ id: string; label: string }>>([]);
  const [copyTarget, setCopyTarget] = useState<{ id: string; label: string } | null>(null);
  const [copying, setCopying] = useState(false);

  const queueRef = useRef<Promise<void>>(Promise.resolve());
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [tiers, routingBreakdown] = await Promise.all([
        getTiersForPart(partId),
        calculateRoutingCost(partId),
      ]);
      setBreakdown(routingBreakdown);

      if (tiers.length === 0) {
        // Pre-seed phantom example rows so the user immediately sees what a tier
        // looks like. Phantoms are UI-only — they don't hit the database until
        // the user types something to demonstrate intent.
        setRows(makePhantomRows(routingBreakdown));
      } else {
        const asRows: EditRow[] = tiers.map((t) => ({
          id: t.id,
          sequence: t.sequence,
          quantity: String(t.quantity),
          markupPercent: t.markup_percent !== null ? String(t.markup_percent) : '',
          unitPrice: t.unit_price !== null ? String(t.unit_price) : '',
          baseCostPerUnit: t.base_cost_per_unit ?? 0,
        }));
        setRows(asRows.map((r) => recomputeRow(r, routingBreakdown)));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load pricing');
    } finally {
      setLoading(false);
    }
  }, [partId]);

  useEffect(() => {
    loadAll();
  }, [loadAll, refreshKey]);

  const scheduleSave = useCallback(
    (next: EditRow[]) => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        const job = queueRef.current.then(async () => {
          // Skip phantoms — they exist only as UI hints until the user touches them.
          const persisted = next.filter((r) => !r.phantom);
          // Skip if any persisted row has an invalid qty (markup might still be in flight).
          const allValid = persisted.every((r) => {
            const q = parseNumber(r.quantity);
            return q !== null && q > 0;
          });
          if (!allValid) return;

          setSaving(true);
          setError(null);
          try {
            const sortedRows = [...persisted].sort((a, b) => a.sequence - b.sequence);
            const payload = sortedRows.map((r, i) => ({
              id: r.id,
              sequence: (i + 1) * 10,
              quantity: parseNumber(r.quantity) as number,
              markup_percent: parseNumber(r.markupPercent),
            }));
            await replaceTiersForPart(companyId, partId, payload);

            // Reload so newly-inserted rows pick up real ids; preserve user's
            // typed strings where possible.
            const fresh = await getTiersForPart(partId);
            setRows((prev) => {
              const byId = new Map(prev.filter((r) => r.id).map((r) => [r.id, r]));
              const mergedReal: EditRow[] = fresh.map((t) => {
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
              // Re-seed phantoms only if the persisted set is empty after a save
              // (e.g., the user deleted everything).
              if (mergedReal.length === 0) return makePhantomRows(breakdown);
              return mergedReal;
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
    [companyId, partId, breakdown],
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
      next[idx] = recomputeRow(
        { ...next[idx], quantity: value, phantom: false },
        breakdown,
      );
      return next;
    });
  };

  const handleMarkupChange = (idx: number, value: string): void => {
    if (value !== '' && !/^\d*\.?\d*$/.test(value)) return;
    updateRows((prev) => {
      const next = [...prev];
      next[idx] = recomputeRow(
        { ...next[idx], markupPercent: value, phantom: false },
        breakdown,
      );
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
      next[idx] = { ...row, unitPrice: value, markupPercent: markupStr, phantom: false };
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
    updateRows((prev) => {
      const next = prev.filter((_, i) => i !== idx);
      // If user deletes everything, fall back to phantoms so the editor isn't blank.
      return next.length === 0 ? makePhantomRows(breakdown) : next;
    });
  };

  const openCopyDialog = async (): Promise<void> => {
    setCopyTarget(null);
    setCopyDialogOpen(true);
    try {
      const options = await getPartsForSelect(companyId);
      setCopyOptions(
        options
          .filter((p) => p.id !== partId)
          .map((p) => ({ id: p.id, label: p.part_name + (p.description ? ` — ${p.description}` : '') })),
      );
    } catch (err) {
      console.error('Failed to load parts for copy:', err);
      setCopyOptions([]);
    }
  };

  const handleCopyConfirm = async (): Promise<void> => {
    if (!copyTarget) return;
    setCopying(true);
    setError(null);
    try {
      await copyTiersFromPart(companyId, copyTarget.id, partId);
      setCopyDialogOpen(false);
      await loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to copy markup');
    } finally {
      setCopying(false);
    }
  };

  const runPerUnit = breakdown ? Math.round(breakdown.total_labor_cost * 100) / 100 : 0;
  const setupBatch = breakdown ? Math.round(breakdown.total_setup_cost * 100) / 100 : 0;
  const materialPerUnit = breakdown ? Math.round(breakdown.total_material_cost * 100) / 100 : 0;

  return (
    <Box>
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
      </Box>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>
          {error}
        </Alert>
      )}

      {!loading && breakdown && breakdown.warnings.length > 0 && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          <Typography variant="body2" sx={{ fontWeight: 600, mb: 0.5 }}>
            Heads up:
          </Typography>
          {breakdown.warnings.map((w, i) => (
            <Typography key={i} variant="body2">
              • {w.message}
            </Typography>
          ))}
        </Alert>
      )}

      {loading && (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }}>
          <CircularProgress size={24} />
        </Box>
      )}

      {!loading && breakdown && (
        <>
          {/* Compact cost build-up — context for the tier rows below.
              The full per-op / per-material breakdown lives in the routing
              side panel, so this card stays focused on the per-unit totals. */}
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

          {/* Tier table */}
          <TableContainer>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Qty</TableCell>
                  <TableCell align="right">Base / unit</TableCell>
                  <TableCell align="right">Markup %</TableCell>
                  <TableCell align="right">Unit price</TableCell>
                  <TableCell align="right"></TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {rows.map((row, idx) => {
                  // Suggested unit price = base × (1 + markup/100). Used as the
                  // placeholder in the unit price input — phantom rows show this
                  // as a hint instead of a committed value.
                  const markupNum = parseNumber(row.markupPercent);
                  const suggestedUnitPrice =
                    row.baseCostPerUnit > 0 && markupNum !== null
                      ? (Math.round(row.baseCostPerUnit * (1 + markupNum / 100) * 100) / 100).toFixed(2)
                      : '0.00';
                  return (
                    <TableRow
                      key={row.id ?? `tier-${idx}`}
                      sx={row.phantom ? { opacity: 0.7 } : undefined}
                    >
                      <TableCell sx={{ minWidth: 90 }}>
                        <TextField
                          size="small"
                          value={row.quantity}
                          onChange={(e) => handleQuantityChange(idx, e.target.value)}
                          inputMode="numeric"
                          placeholder="1"
                        />
                      </TableCell>
                      <TableCell align="right">{formatCurrency(row.baseCostPerUnit)}</TableCell>
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

          <Box sx={{ display: 'flex', gap: 1, mt: 2, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
            <Button
              size="small"
              startIcon={<ContentCopyIcon />}
              onClick={openCopyDialog}
            >
              Copy markup from another part
            </Button>
            <Button size="small" variant="outlined" onClick={addTier} startIcon={<AddIcon />}>
              Add tier
            </Button>
          </Box>
        </>
      )}

      <Dialog open={copyDialogOpen} onClose={() => !copying && setCopyDialogOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>Copy markup from another part</DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            Copies the source part&apos;s tier quantities and markup percentages onto this part.
            Unit prices are recomputed against this part&apos;s own routing.
          </Typography>
          <Autocomplete
            options={copyOptions}
            value={copyTarget}
            onChange={(_, v) => setCopyTarget(v)}
            isOptionEqualToValue={(o, v) => o.id === v.id}
            renderInput={(params) => <TextField {...params} label="Source part" autoFocus />}
            disabled={copying}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setCopyDialogOpen(false)} disabled={copying}>
            Cancel
          </Button>
          <Button
            variant="contained"
            onClick={handleCopyConfirm}
            disabled={!copyTarget || copying}
            startIcon={copying ? <CircularProgress size={14} color="inherit" /> : null}
          >
            {copying ? 'Copying…' : 'Copy markup'}
          </Button>
        </DialogActions>
      </Dialog>
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
