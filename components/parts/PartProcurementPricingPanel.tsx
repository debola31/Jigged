'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import TextField from '@mui/material/TextField';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import Alert from '@mui/material/Alert';
import CircularProgress from '@mui/material/CircularProgress';
import Table from '@mui/material/Table';
import TableHead from '@mui/material/TableHead';
import TableBody from '@mui/material/TableBody';
import TableRow from '@mui/material/TableRow';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import Autocomplete from '@mui/material/Autocomplete';
import AddIcon from '@mui/icons-material/Add';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import CloudSyncOutlinedIcon from '@mui/icons-material/CloudSyncOutlined';
import {
  getTiersForPart,
  addTier as addTierApi,
  updateTier as updateTierApi,
  deleteTier as deleteTierApi,
} from '@/utils/procurementTiersAccess';
import { getAllVendors } from '@/utils/vendorsAccess';
import { updatePartPreferredVendor } from '@/utils/partsAccess';
import type { ProcurementTierGroup } from '@/types/procurementTier';
import type { Vendor } from '@/types/vendor';

interface PartProcurementPricingPanelProps {
  partId: string;
  companyId: string;
  /** Optional unit label ("$X.XX/lb"). */
  primaryUnit?: string | null;
  /**
   * parts.preferred_vendor_id. Used to pre-select the matching vendor on
   * first mount and to surface a "Preferred" badge in the picker.
   */
  preferredVendorId?: string | null;
}

interface EditRow {
  id?: string;
  tempKey?: string;
  quantity: string;
  cost: string;
}

function formatCurrency(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return value.toLocaleString(undefined, {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  });
}

function parseNumber(s: string): number | null {
  if (s.trim() === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function tempId(): string {
  return `tmp-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Cost section of the bought-part Pricing card.
 *
 * Renders a "Cost" header + a vendor picker + a single tier table for the
 * selected vendor's tier sheet. The picker lists every vendor; ones with
 * an existing sheet on this part are flagged with a tier-count caption,
 * so the user sees at a glance who they already have rates from.
 *
 * Multi-vendor data still works — the user can have sheets from any
 * number of vendors, but only one is shown/edited at a time. Quote-time
 * pricing (`get_procurement_cost`) still picks the cheapest applicable
 * tier across every sheet regardless of which one is currently visible.
 *
 * Saves are optimistic and in-place — adding/editing/removing a tier
 * never triggers a panel-wide reload or a page-level refetch.
 */
export default function PartProcurementPricingPanel({
  partId,
  companyId,
  primaryUnit,
  preferredVendorId,
}: PartProcurementPricingPanelProps) {
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [groups, setGroups] = useState<ProcurementTierGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [savingCount, setSavingCount] = useState(0);

  const [selectedVendorId, setSelectedVendorId] = useState<string | null>(null);
  const [rows, setRows] = useState<EditRow[]>([]);

  const initialLoad = useCallback(async () => {
    try {
      setLoading(true);
      const [tierGroups, vendorList] = await Promise.all([
        getTiersForPart(partId),
        getAllVendors(companyId),
      ]);
      setVendors(vendorList);
      setGroups(tierGroups);
      setError(null);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Failed to load procurement data',
      );
    } finally {
      setLoading(false);
    }
  }, [partId, companyId]);

  useEffect(() => {
    initialLoad();
  }, [initialLoad]);

  // Pick an initial vendor on first load: preferred vendor first (whether
  // or not it has a sheet yet), then the first vendor that does have one,
  // else the first vendor period. The user can always switch.
  useEffect(() => {
    if (selectedVendorId) return;
    if (loading) return;
    if (preferredVendorId) {
      setSelectedVendorId(preferredVendorId);
      return;
    }
    const firstWithSheet = groups.find((g) => g.vendor_id !== null);
    if (firstWithSheet?.vendor_id) {
      setSelectedVendorId(firstWithSheet.vendor_id);
      return;
    }
    if (vendors[0]) {
      setSelectedVendorId(vendors[0].id);
    }
  }, [loading, groups, preferredVendorId, selectedVendorId, vendors]);

  // Sync the working-copy rows whenever the selected vendor or persisted
  // groups change. An empty vendor (no sheet yet) shows zero rows.
  useEffect(() => {
    if (!selectedVendorId) {
      setRows([]);
      return;
    }
    const group = groups.find((g) => g.vendor_id === selectedVendorId);
    if (!group) {
      setRows([]);
      return;
    }
    setRows(
      group.tiers.map((t) => ({
        id: t.id,
        quantity: String(t.min_quantity),
        cost: String(t.cost_per_unit),
      })),
    );
  }, [selectedVendorId, groups]);

  const sheetCounts = useMemo(() => {
    const map = new Map<string, number>();
    for (const g of groups) {
      if (g.vendor_id) map.set(g.vendor_id, g.tiers.length);
    }
    return map;
  }, [groups]);

  const selectedVendor = vendors.find((v) => v.id === selectedVendorId) ?? null;

  const vendorOptionLabel = (v: Vendor): string => {
    const count = sheetCounts.get(v.id);
    return count ? `${v.name} (${count} tier${count === 1 ? '' : 's'})` : v.name;
  };

  // Per-row save handlers --------------------------------------------------

  const setRowsAt = (mapper: (rows: EditRow[]) => EditRow[]) => {
    setRows((prev) => mapper(prev));
  };

  const saveRow = async (idx: number) => {
    if (!selectedVendorId) return;
    const row = rows[idx];
    if (!row) return;
    const qty = parseNumber(row.quantity);
    const cost = parseNumber(row.cost);
    if (qty === null || qty <= 0) return;
    if (cost === null || cost <= 0) return;

    setSavingCount((c) => c + 1);
    try {
      if (row.id) {
        const updated = await updateTierApi(row.id, {
          part_id: partId,
          vendor_id: selectedVendorId,
          min_quantity: row.quantity,
          cost_per_unit: row.cost,
          quoted_at: null,
          expires_at: null,
          notes: '',
        });
        setRowsAt((prev) =>
          prev.map((r, i) =>
            i === idx
              ? { id: updated.id, quantity: String(updated.min_quantity), cost: String(updated.cost_per_unit) }
              : r,
          ),
        );
      } else {
        const created = await addTierApi({
          part_id: partId,
          vendor_id: selectedVendorId,
          min_quantity: row.quantity,
          cost_per_unit: row.cost,
          quoted_at: null,
          expires_at: null,
          notes: '',
        });
        setRowsAt((prev) =>
          prev.map((r, i) =>
            i === idx
              ? { id: created.id, quantity: String(created.min_quantity), cost: String(created.cost_per_unit) }
              : r,
          ),
        );
        // Update the in-memory groups so sheet count caption stays current.
        setGroups((prev) => {
          const existingIdx = prev.findIndex((g) => g.vendor_id === selectedVendorId);
          if (existingIdx >= 0) {
            const next = [...prev];
            const g = next[existingIdx];
            next[existingIdx] = { ...g, tiers: [...g.tiers, created] };
            return next;
          }
          // First tier ever for this vendor — synthesize a minimal group.
          const vendor = vendors.find((v) => v.id === selectedVendorId);
          return [
            ...prev,
            {
              vendor_id: selectedVendorId,
              vendor_name: vendor?.name ?? '(unknown)',
              quoted_at: null,
              expires_at: null,
              is_expiring: false,
              is_expired: false,
              tiers: [created],
            },
          ];
        });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save tier');
    } finally {
      setSavingCount((c) => c - 1);
    }
  };

  const addRow = () => {
    if (!selectedVendorId) return;
    setRowsAt((prev) => [...prev, { tempKey: tempId(), quantity: '', cost: '' }]);
  };

  const deleteRow = async (idx: number) => {
    const row = rows[idx];
    if (!row) return;
    if (!row.id) {
      setRowsAt((prev) => prev.filter((_, i) => i !== idx));
      return;
    }
    setSavingCount((c) => c + 1);
    try {
      await deleteTierApi(row.id);
      setRowsAt((prev) => prev.filter((_, i) => i !== idx));
      // Keep groups in sync so the picker caption updates.
      setGroups((prev) =>
        prev.map((g) =>
          g.vendor_id === selectedVendorId
            ? { ...g, tiers: g.tiers.filter((t) => t.id !== row.id) }
            : g,
        ),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete tier');
    } finally {
      setSavingCount((c) => c - 1);
    }
  };

  // Render -----------------------------------------------------------------

  const unit = primaryUnit && primaryUnit.trim() ? primaryUnit : 'unit';
  const saving = savingCount > 0;

  /**
   * Pick a vendor: switch the displayed tier sheet AND set the picked
   * vendor as preferred. The picker doubles as both setter and selector
   * so users only think about one vendor concept per part. Optimistic
   * local switch; failures revert and surface in the error alert.
   */
  const handleVendorPick = async (vendor: Vendor | null) => {
    const nextId = vendor ? vendor.id : null;
    if (nextId === selectedVendorId) return;

    const prevId = selectedVendorId;
    setSelectedVendorId(nextId);
    try {
      await updatePartPreferredVendor(partId, nextId);
    } catch (err) {
      setSelectedVendorId(prevId);
      setError(
        err instanceof Error ? err.message : 'Failed to set preferred vendor',
      );
    }
  };

  return (
    <Box>
      {/* Section header: just "Cost" h6 + saving indicator. The vendor
          picker lives below as a labeled "Preferred vendor" field — it
          doubles as the preferred-vendor setter and the cost-tier-sheet
          selector. Picking a vendor sets it as preferred AND switches
          the displayed sheet. */}
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 1.5,
          mb: 1.5,
          flexWrap: 'wrap',
        }}
      >
        <Typography variant="h6" sx={{ fontWeight: 600 }}>
          Cost
        </Typography>
        {saving && (
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, color: 'text.secondary' }}>
            <CloudSyncOutlinedIcon fontSize="small" />
            <Typography variant="caption">Saving…</Typography>
          </Box>
        )}
      </Box>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>
          {error}
        </Alert>
      )}

      <Autocomplete<Vendor>
        options={vendors}
        value={selectedVendor}
        onChange={(_e, next) => handleVendorPick(next)}
        getOptionLabel={vendorOptionLabel}
        renderOption={(props, option) => {
          const count = sheetCounts.get(option.id);
          const { key, ...rest } = props as React.HTMLAttributes<HTMLLIElement> & {
            key?: React.Key;
          };
          return (
            <Box
              component="li"
              {...rest}
              key={key as React.Key}
              sx={{ display: 'flex', justifyContent: 'space-between', gap: 2 }}
            >
              <Typography variant="body2" sx={{ fontWeight: count ? 500 : 400 }}>
                {option.name}
              </Typography>
              {count !== undefined && (
                <Typography variant="caption" color="text.secondary">
                  {count} tier{count === 1 ? '' : 's'} on file
                </Typography>
              )}
            </Box>
          );
        }}
        isOptionEqualToValue={(opt, val) => opt.id === val.id}
        size="small"
        sx={{ mb: 2, maxWidth: 480 }}
        renderInput={(params) => (
          <TextField
            {...params}
            label="Preferred vendor"
            placeholder="Pick a vendor"
            helperText="Sets the default supplier and shows their qty-break pricing below."
          />
        )}
      />

      {loading ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }}>
          <CircularProgress size={24} />
        </Box>
      ) : !selectedVendorId ? (
        <Box
          sx={{
            py: 3,
            px: 2,
            textAlign: 'center',
            border: (theme) => `1px dashed ${theme.palette.divider}`,
            borderRadius: 1,
          }}
        >
          <Typography variant="body2" color="text.secondary">
            Pick a vendor above to set qty-break pricing.
          </Typography>
        </Box>
      ) : (
        <>
          <TableContainer>

            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Min qty</TableCell>
                  <TableCell align="right">Unit cost</TableCell>
                  <TableCell align="right" sx={{ width: 64 }}></TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {rows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={3}>
                      <Typography variant="body2" color="text.secondary" sx={{ py: 1 }}>
                        No tiers yet for {selectedVendor?.name ?? 'this vendor'}. Click
                        Add tier to set the first qty break.
                      </Typography>
                    </TableCell>
                  </TableRow>
                ) : (
                  rows.map((row, idx) => {
                    const costNum = parseNumber(row.cost);
                    return (
                      <TableRow key={row.id ?? row.tempKey ?? idx}>
                        <TableCell sx={{ minWidth: 110 }}>
                          <TextField
                            size="small"
                            value={row.quantity}
                            onChange={(e) =>
                              setRowsAt((prev) =>
                                prev.map((r, i) =>
                                  i === idx ? { ...r, quantity: e.target.value } : r,
                                ),
                              )
                            }
                            onBlur={() => saveRow(idx)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                e.preventDefault();
                                (e.currentTarget as HTMLElement).blur();
                              }
                            }}
                            inputMode="decimal"
                            placeholder="1"
                            sx={{ width: 110 }}
                          />
                        </TableCell>
                        <TableCell align="right" sx={{ minWidth: 140 }}>
                          <TextField
                            size="small"
                            value={row.cost}
                            onChange={(e) =>
                              setRowsAt((prev) =>
                                prev.map((r, i) =>
                                  i === idx ? { ...r, cost: e.target.value } : r,
                                ),
                              )
                            }
                            onBlur={() => saveRow(idx)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                e.preventDefault();
                                (e.currentTarget as HTMLElement).blur();
                              }
                            }}
                            inputMode="decimal"
                            placeholder={costNum !== null ? formatCurrency(costNum) : '0.00'}
                            sx={{ width: 130 }}
                            slotProps={{
                              input: {
                                startAdornment: (
                                  <Typography
                                    variant="body2"
                                    color="text.secondary"
                                    sx={{ mr: 0.5 }}
                                  >
                                    $
                                  </Typography>
                                ),
                              },
                            }}
                          />
                        </TableCell>
                        <TableCell align="right">
                          <Tooltip title="Delete tier">
                            <IconButton
                              size="small"
                              color="error"
                              onClick={() => deleteRow(idx)}
                              aria-label="Remove tier"
                            >
                              <DeleteOutlineIcon fontSize="small" />
                            </IconButton>
                          </Tooltip>
                        </TableCell>
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>
          </TableContainer>

          <Box sx={{ display: 'flex', justifyContent: 'flex-end', mt: 1 }}>
            <Button
              size="small"
              variant="outlined"
              startIcon={<AddIcon />}
              onClick={addRow}
            >
              Add tier
            </Button>
          </Box>

          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
            Costs are per {unit}. Quotes use the cheapest applicable tier
            across every vendor sheet on file.
          </Typography>
        </>
      )}
    </Box>
  );
}
