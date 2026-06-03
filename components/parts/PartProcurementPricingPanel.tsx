'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import TextField from '@mui/material/TextField';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import Alert from '@mui/material/Alert';
import AlertTitle from '@mui/material/AlertTitle';
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
import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutline';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
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
 * Cost source contract: only the part's preferred vendor's sheet drives
 * cost (in `compute_part_cost_at_qty` and `get_procurement_cost`). Picking
 * a vendor in this panel sets it as preferred AND switches the displayed
 * sheet — keeping the two concepts unified. The first tier save under a
 * freshly-picked vendor also re-asserts the preferred vendor in the DB,
 * so legacy parts that loaded with a NULL preferred_vendor_id can't end
 * up with tiers that the SQL filter then ignores. Sheets under
 * non-preferred vendors and `vendor_id=NULL` "Internal estimate" rows
 * remain editable for reference but never feed rollup.
 *
 * Saves are optimistic, per-row, and triggered on field blur. Each row
 * shows a "Saving…" / "Saved ✓" badge so the auto-save isn't invisible
 * (users were looking for a Save button before this).
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

  // Tracks parts.preferred_vendor_id as it currently is in the DB. Distinct
  // from the prop (which is the value at mount) and from selectedVendorId
  // (which is the picker's local selection — the auto-select effect below
  // can set this without persisting). compute_part_cost_at_qty filters tiers
  // by parts.preferred_vendor_id; if the panel saves a tier under
  // selectedVendorId but the DB's preferred_vendor_id is still NULL (or a
  // stale other vendor), the cost rollup silently returns NULL. saveRow
  // syncs this just before saving the tier.
  const [effectivePreferredVendorId, setEffectivePreferredVendorId] = useState<
    string | null
  >(preferredVendorId ?? null);

  // Per-row save status: "saving" while the API call is in flight, "saved"
  // for ~2 s after success so the user sees a confirmation tick. Keyed by
  // row id (or tempKey for unsaved rows). Auto-save with no Save button is
  // confusing without this — multiple users have asked "did it save?".
  const [rowStatus, setRowStatus] = useState<Map<string, 'saving' | 'saved'>>(
    new Map(),
  );
  const setRowStatusFor = (key: string, status: 'saving' | 'saved' | null) => {
    setRowStatus((prev) => {
      const next = new Map(prev);
      if (status === null) next.delete(key);
      else next.set(key, status);
      return next;
    });
  };

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

    // Skip save if the persisted values match what the user typed —
    // tab-out on an unchanged row shouldn't cause a network round-trip
    // or a "Saved" flash.
    if (row.id) {
      const persisted = rows[idx];
      // We compare against the current rows snapshot's source-of-truth in
      // `groups` rather than itself; the editor mirrors groups, so if
      // values match, the row hasn't been touched. Cheap string compare.
      const group = groups.find((g) => g.vendor_id === selectedVendorId);
      const tier = group?.tiers.find((t) => t.id === row.id);
      if (
        tier &&
        String(tier.min_quantity) === persisted.quantity &&
        String(tier.cost_per_unit) === persisted.cost
      ) {
        return;
      }
    }

    const rowKey = row.id ?? row.tempKey ?? `idx-${idx}`;
    setRowStatusFor(rowKey, 'saving');
    setSavingCount((c) => c + 1);
    try {
      // First save under a freshly-picked vendor whose preferred-vendor-id
      // never made it to the DB (auto-select on mount doesn't persist).
      // Without this, compute_part_cost_at_qty silently returns NULL because
      // it filters on parts.preferred_vendor_id and finds no match.
      if (effectivePreferredVendorId !== selectedVendorId) {
        await updatePartPreferredVendor(partId, selectedVendorId);
        setEffectivePreferredVendorId(selectedVendorId);
      }

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
        // Mirror into groups so the next computed snapshot matches.
        setGroups((prev) =>
          prev.map((g) =>
            g.vendor_id === selectedVendorId
              ? {
                  ...g,
                  tiers: g.tiers.map((t) => (t.id === updated.id ? updated : t)),
                }
              : g,
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
        // The new row is now persisted under `created.id`; route the
        // "saved" flash to that key rather than the stale tempKey.
        const newKey = created.id;
        setRowStatusFor(rowKey, null);
        setRowStatusFor(newKey, 'saved');
        window.setTimeout(() => setRowStatusFor(newKey, null), 2000);
        return; // skip the default flash path below; we already routed it
      }
      setRowStatusFor(rowKey, 'saved');
      window.setTimeout(() => setRowStatusFor(rowKey, null), 2000);
    } catch (err) {
      setRowStatusFor(rowKey, null);
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
      // Drop any in-flight save state for the deleted row.
      setRowStatusFor(row.id, null);
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
      // Track DB-side preferred vendor so saveRow knows whether it needs
      // to re-persist on the next tier write.
      setEffectivePreferredVendorId(nextId);
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
            helperText="Sets the default supplier and drives the BOM cost from this sheet."
          />
        )}
      />

      {loading ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }}>
          <CircularProgress size={24} />
        </Box>
      ) : !selectedVendorId ? (
        <Alert severity="warning" icon={<WarningAmberIcon fontSize="inherit" />}>
          <AlertTitle sx={{ fontWeight: 700, mb: 0.5 }}>
            No cost on file
          </AlertTitle>
          Pick a preferred vendor above and add at least one qty-break tier.
          Quotes can&apos;t price this part until a cost is on file.
        </Alert>
      ) : rows.length === 0 ? (
        <Alert
          severity="warning"
          icon={<WarningAmberIcon fontSize="inherit" />}
          action={
            <Button
              color="warning"
              size="small"
              variant="contained"
              startIcon={<AddIcon />}
              onClick={addRow}
              sx={{ alignSelf: 'center', whiteSpace: 'nowrap' }}
            >
              Add first tier
            </Button>
          }
          sx={{ alignItems: 'center' }}
        >
          <AlertTitle sx={{ fontWeight: 700, mb: 0.5 }}>
            No cost tiers set for {selectedVendor?.name ?? 'this vendor'}
          </AlertTitle>
          Quotes can&apos;t price this part until you add at least one
          qty-break tier.
        </Alert>
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
                {rows.map((row, idx) => {
                    const costNum = parseNumber(row.cost);
                    const rowKey = row.id ?? row.tempKey ?? `idx-${idx}`;
                    const status = rowStatus.get(rowKey);
                    return (
                      <TableRow key={rowKey}>
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
                        <TableCell align="right" sx={{ whiteSpace: 'nowrap' }}>
                          {/* Per-row save state. Inline in the actions cell so
                              the user sees the auto-save take effect right next
                              to the field they just left. Renders nothing while
                              idle to keep the row visually quiet. */}
                          {status === 'saving' && (
                            <Tooltip title="Saving…">
                              <CircularProgress
                                size={14}
                                sx={{ mr: 1, verticalAlign: 'middle', color: 'text.secondary' }}
                              />
                            </Tooltip>
                          )}
                          {status === 'saved' && (
                            <Tooltip title="Saved">
                              <CheckCircleOutlineIcon
                                fontSize="small"
                                sx={{ mr: 1, verticalAlign: 'middle', color: 'success.main' }}
                              />
                            </Tooltip>
                          )}
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
                  })}
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
            Costs are per {unit}. Tiers save automatically when you click
            out of a field — there&apos;s no Save button. Quotes use the
            cheapest applicable tier under the preferred vendor.
          </Typography>
        </>
      )}
    </Box>
  );
}
