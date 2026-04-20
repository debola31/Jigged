'use client';

import { useCallback, useEffect, useState } from 'react';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Divider from '@mui/material/Divider';
import Button from '@mui/material/Button';
import TextField from '@mui/material/TextField';
import IconButton from '@mui/material/IconButton';
import Chip from '@mui/material/Chip';
import Alert from '@mui/material/Alert';
import CircularProgress from '@mui/material/CircularProgress';
import Table from '@mui/material/Table';
import TableHead from '@mui/material/TableHead';
import TableBody from '@mui/material/TableBody';
import TableRow from '@mui/material/TableRow';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import AddIcon from '@mui/icons-material/Add';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import RefreshIcon from '@mui/icons-material/Refresh';
import {
  calculateRoutingCost,
  calculateTierPricing,
  type RoutingCostBreakdown,
} from '@/utils/routingCostCalculation';
import {
  getTiersForPart,
  replaceTiersForPart,
} from '@/utils/partPricingTiersAccess';
import { calculateMarkupFromUnitPrice } from '@/types/quote';
import type { Part } from '@/types/part';

interface PartPricingTiersProps {
  companyId: string;
  part: Part;
  /** Increments whenever the routing changes so we recompute base costs. */
  refreshKey?: number;
}

interface EditRow {
  id?: string;
  sequence: number;
  quantity: string;
  markupPercent: string;
  unitPrice: string;
  isPriceOverride: boolean;
  baseCostPerUnit: number;
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

function computeRow(
  row: EditRow,
  breakdown: RoutingCostBreakdown | null,
): EditRow {
  const qty = parseNumber(row.quantity);
  if (!breakdown || qty === null || qty <= 0) {
    return { ...row, baseCostPerUnit: 0 };
  }
  const markup = parseNumber(row.markupPercent);
  const { baseCostPerUnit, unitPrice } = calculateTierPricing(breakdown, qty, markup);
  if (!row.isPriceOverride) {
    return {
      ...row,
      baseCostPerUnit,
      unitPrice: unitPrice !== null ? String(unitPrice) : '',
    };
  }
  return { ...row, baseCostPerUnit };
}

export default function PartPricingTiers({ companyId, part, refreshKey = 0 }: PartPricingTiersProps) {
  const partId = part.id;
  const defaultMarkup = part.part_category?.default_markup_percent ?? null;

  const [rows, setRows] = useState<EditRow[]>([]);
  const [breakdown, setBreakdown] = useState<RoutingCostBreakdown | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [tiers, routingBreakdown] = await Promise.all([
        getTiersForPart(partId),
        calculateRoutingCost(partId),
      ]);
      setBreakdown(routingBreakdown);
      const asRows: EditRow[] = tiers.map((t) => ({
        id: t.id,
        sequence: t.sequence,
        quantity: String(t.quantity),
        markupPercent: t.markup_percent !== null ? String(t.markup_percent) : '',
        unitPrice: t.unit_price !== null ? String(t.unit_price) : '',
        isPriceOverride: t.is_price_override,
        baseCostPerUnit: t.base_cost_per_unit ?? 0,
      }));
      setRows(asRows.map((r) => computeRow(r, routingBreakdown)));
      setDirty(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load pricing tiers');
    } finally {
      setLoading(false);
    }
  }, [partId]);

  useEffect(() => {
    loadAll();
  }, [loadAll, refreshKey]);

  const updateRow = (idx: number, patch: Partial<EditRow>): void => {
    setRows((prev) => {
      const next = [...prev];
      next[idx] = computeRow({ ...next[idx], ...patch }, breakdown);
      return next;
    });
    setDirty(true);
    setMessage(null);
  };

  const handleQuantityChange = (idx: number, value: string): void => {
    if (!/^\d*$/.test(value)) return;
    updateRow(idx, { quantity: value });
  };

  const handleMarkupChange = (idx: number, value: string): void => {
    if (value !== '' && !/^\d*\.?\d*$/.test(value)) return;
    updateRow(idx, { markupPercent: value, isPriceOverride: false });
  };

  const handleUnitPriceChange = (idx: number, value: string): void => {
    if (value !== '' && !/^\d*\.?\d*$/.test(value)) return;
    setRows((prev) => {
      const next = [...prev];
      const row = next[idx];
      const unitPrice = parseNumber(value);
      const base = row.baseCostPerUnit;
      let markupStr = row.markupPercent;
      if (unitPrice !== null && base > 0) {
        const backCalc = calculateMarkupFromUnitPrice(base, unitPrice);
        if (backCalc !== null) markupStr = String(backCalc);
      }
      next[idx] = {
        ...row,
        unitPrice: value,
        markupPercent: markupStr,
        isPriceOverride: true,
      };
      return next;
    });
    setDirty(true);
    setMessage(null);
  };

  const addTier = (): void => {
    setRows((prev) => {
      const nextSequence = prev.length > 0 ? Math.max(...prev.map((r) => r.sequence)) + 10 : 10;
      const markupDefault = defaultMarkup !== null ? String(defaultMarkup) : '';
      const row: EditRow = {
        sequence: nextSequence,
        quantity: '',
        markupPercent: markupDefault,
        unitPrice: '',
        isPriceOverride: false,
        baseCostPerUnit: 0,
      };
      return [...prev, computeRow(row, breakdown)];
    });
    setDirty(true);
    setMessage(null);
  };

  const removeRow = (idx: number): void => {
    setRows((prev) => prev.filter((_, i) => i !== idx));
    setDirty(true);
    setMessage(null);
  };

  const recalculate = async (): Promise<void> => {
    const fresh = await calculateRoutingCost(partId);
    setBreakdown(fresh);
    setRows((prev) => prev.map((r) => computeRow(r, fresh)));
    setMessage('Refreshed base costs from the current routing.');
  };

  const handleSave = async (): Promise<void> => {
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      for (const r of rows) {
        const qty = parseNumber(r.quantity);
        if (qty === null || qty <= 0) {
          throw new Error('Every tier needs a quantity greater than zero.');
        }
      }
      const sortedRows = [...rows].sort((a, b) => a.sequence - b.sequence);
      const payload = sortedRows.map((r, i) => ({
        id: r.id,
        sequence: (i + 1) * 10,
        quantity: parseNumber(r.quantity) as number,
        markup_percent: parseNumber(r.markupPercent),
        unit_price: parseNumber(r.unitPrice),
        is_price_override: r.isPriceOverride,
      }));
      await replaceTiersForPart(companyId, partId, payload);
      setMessage('Pricing tiers saved.');
      await loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save pricing tiers');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card elevation={2}>
      <CardContent>
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
          <Typography variant="h6" sx={{ fontWeight: 600 }}>
            Pricing Tiers
          </Typography>
          <Box sx={{ display: 'flex', gap: 1 }}>
            <Button
              size="small"
              onClick={recalculate}
              startIcon={<RefreshIcon />}
              disabled={loading || saving}
            >
              Recalculate
            </Button>
            <Button
              size="small"
              variant="outlined"
              onClick={addTier}
              startIcon={<AddIcon />}
              disabled={loading || saving}
            >
              Add tier
            </Button>
          </Box>
        </Box>
        <Divider sx={{ mb: 2 }} />

        {defaultMarkup !== null && (
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 2 }}>
            New tiers seed from category markup: {defaultMarkup}%. Edit markup to recompute price;
            edit unit price to lock an override.
          </Typography>
        )}

        {error && (
          <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>
            {error}
          </Alert>
        )}
        {message && (
          <Alert severity="success" sx={{ mb: 2 }} onClose={() => setMessage(null)}>
            {message}
          </Alert>
        )}

        {loading && (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }}>
            <CircularProgress size={24} />
          </Box>
        )}

        {!loading && rows.length === 0 && (
          <Typography variant="body2" color="text.secondary" sx={{ py: 2 }}>
            No pricing tiers yet. Add a tier to make this part quotable.
          </Typography>
        )}

        {!loading && rows.length > 0 && (
          <TableContainer>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Qty</TableCell>
                  <TableCell align="right">Base / unit</TableCell>
                  <TableCell align="right">Markup %</TableCell>
                  <TableCell align="right">Unit price</TableCell>
                  <TableCell align="right">Line total</TableCell>
                  <TableCell align="right">State</TableCell>
                  <TableCell align="right"></TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {rows.map((row, idx) => {
                  const qty = parseNumber(row.quantity) ?? 0;
                  const unitPrice = parseNumber(row.unitPrice);
                  const total = unitPrice !== null ? Math.round(unitPrice * qty * 100) / 100 : null;
                  return (
                    <TableRow key={row.id ?? `new-${idx}`}>
                      <TableCell sx={{ minWidth: 90 }}>
                        <TextField
                          size="small"
                          value={row.quantity}
                          onChange={(e) => handleQuantityChange(idx, e.target.value)}
                          inputMode="numeric"
                          placeholder="1"
                          disabled={saving}
                        />
                      </TableCell>
                      <TableCell align="right">{formatCurrency(row.baseCostPerUnit)}</TableCell>
                      <TableCell align="right" sx={{ minWidth: 120 }}>
                        <TextField
                          size="small"
                          value={row.markupPercent}
                          onChange={(e) => handleMarkupChange(idx, e.target.value)}
                          inputMode="decimal"
                          placeholder="0"
                          disabled={saving}
                          sx={{ width: 100 }}
                        />
                      </TableCell>
                      <TableCell align="right" sx={{ minWidth: 130 }}>
                        <TextField
                          size="small"
                          value={row.unitPrice}
                          onChange={(e) => handleUnitPriceChange(idx, e.target.value)}
                          inputMode="decimal"
                          placeholder="0.00"
                          disabled={saving}
                          sx={{ width: 120 }}
                        />
                      </TableCell>
                      <TableCell align="right">{formatCurrency(total)}</TableCell>
                      <TableCell align="right">
                        {row.isPriceOverride ? (
                          <Chip size="small" label="override" color="warning" variant="outlined" />
                        ) : (
                          <Chip size="small" label="from markup" variant="outlined" />
                        )}
                      </TableCell>
                      <TableCell align="right">
                        <IconButton
                          size="small"
                          color="error"
                          onClick={() => removeRow(idx)}
                          disabled={saving}
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
        )}

        {dirty && (
          <Box sx={{ display: 'flex', justifyContent: 'flex-end', mt: 2 }}>
            <Button
              variant="contained"
              onClick={handleSave}
              disabled={saving}
              startIcon={saving ? <CircularProgress size={14} color="inherit" /> : null}
            >
              {saving ? 'Saving…' : 'Save pricing tiers'}
            </Button>
          </Box>
        )}
      </CardContent>
    </Card>
  );
}
