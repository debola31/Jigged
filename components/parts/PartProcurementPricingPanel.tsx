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
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import SaveStatus, { type SaveState } from '@/components/common/SaveStatus';
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
  /**
   * Called after a successful save (cost tiers or preferred-vendor change) so
   * the parent can re-derive priceability — this is what clears the "Needs
   * cost" indicator live, without a page reload.
   */
  onSaved?: () => void;
}

interface EditRow {
  id?: string;
  tempKey?: string;
  quantity: string;
  cost: string;
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
 * sheet — keeping the two concepts unified. Sheets under non-preferred
 * vendors and `vendor_id=NULL` "Internal estimate" rows remain editable for
 * reference but never feed rollup.
 *
 * Cost edits are financial data, so — like the made-part Pricing card — they
 * are committed via an explicit **Save** button (not auto-saved on blur);
 * `dirty` tracks unsaved edits. When the selected vendor has no priced tier
 * yet, the table shows a single empty starter row highlighted red (instead of
 * a separate yellow banner) so the user fills the cost in directly.
 */
export default function PartProcurementPricingPanel({
  partId,
  companyId,
  primaryUnit,
  preferredVendorId,
  onSaved,
}: PartProcurementPricingPanelProps) {
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [groups, setGroups] = useState<ProcurementTierGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [selectedVendorId, setSelectedVendorId] = useState<string | null>(null);
  const [rows, setRows] = useState<EditRow[]>([]);

  // Cost edits commit via an explicit Save (financial data — no silent
  // auto-save). `dirty` tracks unsaved tier edits; `saveState` drives the
  // SaveStatus chip + the Save button's disabled state.
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [dirty, setDirty] = useState(false);
  const saving = saveState === 'saving';

  // Tracks parts.preferred_vendor_id as it currently is in the DB. Distinct
  // from the prop (the value at mount) and from selectedVendorId (the picker's
  // local selection). compute_part_cost_at_qty filters tiers by
  // parts.preferred_vendor_id; saveRow/handleSave re-assert it just before
  // saving so a tier can't end up under a vendor the SQL filter then ignores.
  const [effectivePreferredVendorId, setEffectivePreferredVendorId] = useState<
    string | null
  >(preferredVendorId ?? null);

  const markDirty = () => {
    setDirty(true);
    setSaveState('idle');
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
  // groups change (vendor switch, or a reload after Save). A vendor with no
  // saved tier seeds ONE empty starter row so the user fills the cost in
  // directly (rendered red below). Resets `dirty` — these rows mirror the DB.
  useEffect(() => {
    if (!selectedVendorId) {
      setRows([]);
      setDirty(false);
      return;
    }
    const group = groups.find((g) => g.vendor_id === selectedVendorId);
    const tiers = group?.tiers ?? [];
    if (tiers.length === 0) {
      setRows([{ tempKey: tempId(), quantity: '', cost: '' }]);
    } else {
      setRows(
        tiers.map((t) => ({
          id: t.id,
          quantity: String(t.min_quantity),
          cost: String(t.cost_per_unit),
        })),
      );
    }
    setDirty(false);
  }, [selectedVendorId, groups]);

  const sheetCounts = useMemo(() => {
    const map = new Map<string, number>();
    for (const g of groups) {
      if (g.vendor_id) map.set(g.vendor_id, g.tiers.length);
    }
    return map;
  }, [groups]);

  const selectedVendor = vendors.find((v) => v.id === selectedVendorId) ?? null;

  // True when the selected vendor has no SAVED tier yet → the part can't be
  // priced. Drives the red starter-tier styling + prompt. Recomputes from
  // `groups` (persisted), so it clears the instant a Save reloads the sheet.
  const needsCost = useMemo(() => {
    if (!selectedVendorId) return false;
    const group = groups.find((g) => g.vendor_id === selectedVendorId);
    return (group?.tiers.length ?? 0) === 0;
  }, [selectedVendorId, groups]);

  const vendorOptionLabel = (v: Vendor): string => {
    const count = sheetCounts.get(v.id);
    return count ? `${v.name} (${count} tier${count === 1 ? '' : 's'})` : v.name;
  };

  // Row editing -----------------------------------------------------------

  const setRowsAt = (mapper: (rows: EditRow[]) => EditRow[]) => {
    setRows((prev) => mapper(prev));
  };

  const addRow = () => {
    if (!selectedVendorId) return;
    setRowsAt((prev) => [...prev, { tempKey: tempId(), quantity: '', cost: '' }]);
    markDirty();
  };

  const deleteRow = (idx: number) => {
    // Deletes are deferred to Save (reconciled against the persisted sheet),
    // matching the explicit-save model for the rest of the cost edits.
    setRowsAt((prev) => prev.filter((_, i) => i !== idx));
    markDirty();
  };

  const handleSave = async () => {
    if (!selectedVendorId) return;
    // Fully-empty rows (both fields blank) are "not filled in yet" — drop them
    // rather than erroring, so an extra blank Add-tier row never blocks Save.
    const nonEmpty = rows.filter(
      (r) => r.quantity.trim() !== '' || r.cost.trim() !== '',
    );
    for (const r of nonEmpty) {
      const q = parseNumber(r.quantity);
      const c = parseNumber(r.cost);
      if (q === null || q <= 0 || c === null || c <= 0) {
        setError('Every cost tier needs a quantity and a unit cost greater than 0.');
        return;
      }
    }

    setSaveState('saving');
    setError(null);
    try {
      // Re-assert the preferred vendor if the picked vendor isn't yet the DB's
      // (e.g. auto-selected on mount). Without this, compute_part_cost_at_qty
      // filters on parts.preferred_vendor_id and silently returns NULL.
      if (effectivePreferredVendorId !== selectedVendorId) {
        await updatePartPreferredVendor(partId, selectedVendorId);
        setEffectivePreferredVendorId(selectedVendorId);
      }

      const persisted =
        groups.find((g) => g.vendor_id === selectedVendorId)?.tiers ?? [];
      const keptIds = new Set(
        nonEmpty.map((r) => r.id).filter((id): id is string => Boolean(id)),
      );

      // Deletes first (persisted tiers no longer present in the editor).
      for (const t of persisted) {
        if (!keptIds.has(t.id)) await deleteTierApi(t.id);
      }
      // Upserts.
      for (const r of nonEmpty) {
        if (r.id) {
          const prev = persisted.find((t) => t.id === r.id);
          const changed =
            !prev ||
            String(prev.min_quantity) !== r.quantity ||
            String(prev.cost_per_unit) !== r.cost;
          if (changed) {
            await updateTierApi(r.id, {
              part_id: partId,
              vendor_id: selectedVendorId,
              min_quantity: r.quantity,
              cost_per_unit: r.cost,
              quoted_at: null,
              expires_at: null,
              notes: '',
            });
          }
        } else {
          await addTierApi({
            part_id: partId,
            vendor_id: selectedVendorId,
            min_quantity: r.quantity,
            cost_per_unit: r.cost,
            quoted_at: null,
            expires_at: null,
            notes: '',
          });
        }
      }

      // Reload the sheet — the sync effect re-syncs rows + clears `dirty`, and
      // `needsCost` recomputes from the fresh groups.
      const fresh = await getTiersForPart(partId);
      setGroups(fresh);
      setSaveState('saved');
      // Let the parent re-derive priceability so the "Needs cost" chip clears
      // immediately (no reload).
      onSaved?.();
    } catch (err) {
      setSaveState('error');
      setError(err instanceof Error ? err.message : 'Failed to save costs');
    }
  };

  // Render -----------------------------------------------------------------

  const unit = primaryUnit && primaryUnit.trim() ? primaryUnit : 'unit';

  /**
   * Pick a vendor: switch the displayed tier sheet AND set the picked vendor
   * as preferred. The picker doubles as both setter and selector so users only
   * think about one vendor concept per part. Optimistic local switch; failures
   * revert and surface in the error alert. Unsaved tier edits on the previous
   * sheet are discarded — the sync effect reloads rows for the new vendor.
   */
  const handleVendorPick = async (vendor: Vendor | null) => {
    const nextId = vendor ? vendor.id : null;
    if (nextId === selectedVendorId) return;

    const prevId = selectedVendorId;
    setSelectedVendorId(nextId);
    try {
      await updatePartPreferredVendor(partId, nextId);
      setEffectivePreferredVendorId(nextId);
      // Preferred vendor drives priceability, so refresh the parent's chip.
      onSaved?.();
    } catch (err) {
      setSelectedVendorId(prevId);
      setError(
        err instanceof Error ? err.message : 'Failed to set preferred vendor',
      );
    }
  };

  return (
    <Box>
      {/* Section header: "Cost" h6 + save status. The vendor picker below
          doubles as the preferred-vendor setter and the cost-tier-sheet
          selector. */}
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
        <SaveStatus state={saveState} />
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
        <Alert severity="error">
          No vendors yet — add a vendor first, then set a cost tier so this part
          can be priced and quoted.
        </Alert>
      ) : (
        <>
          {/* Red inline prompt when there's no saved cost yet — replaces the
              old yellow banner. The starter row's empty fields render red too,
              pointing the user straight at what to fill in. */}
          {needsCost && (
            <Box
              sx={{
                display: 'flex',
                alignItems: 'center',
                gap: 0.5,
                mb: 1,
                color: 'error.main',
              }}
            >
              <WarningAmberIcon fontSize="small" />
              <Typography variant="body2" color="error.main">
                Add at least one cost tier so this part can be priced and quoted.
              </Typography>
            </Box>
          )}

          <TableContainer>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Min qty</TableCell>
                  <TableCell align="right">Unit cost</TableCell>
                  <TableCell align="right" sx={{ width: 56 }}></TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {rows.map((row, idx) => {
                  const rowKey = row.id ?? row.tempKey ?? `idx-${idx}`;
                  const qtyError = needsCost && row.quantity.trim() === '';
                  const costError = needsCost && row.cost.trim() === '';
                  return (
                    <TableRow key={rowKey}>
                      <TableCell sx={{ minWidth: 110 }}>
                        <TextField
                          size="small"
                          value={row.quantity}
                          error={qtyError}
                          onChange={(e) => {
                            const v = e.target.value;
                            setRowsAt((prev) =>
                              prev.map((r, i) =>
                                i === idx ? { ...r, quantity: v } : r,
                              ),
                            );
                            markDirty();
                          }}
                          inputMode="decimal"
                          sx={{ width: 110 }}
                        />
                      </TableCell>
                      <TableCell align="right" sx={{ minWidth: 140 }}>
                        <TextField
                          size="small"
                          value={row.cost}
                          error={costError}
                          onChange={(e) => {
                            const v = e.target.value;
                            setRowsAt((prev) =>
                              prev.map((r, i) =>
                                i === idx ? { ...r, cost: v } : r,
                              ),
                            );
                            markDirty();
                          }}
                          inputMode="decimal"
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
                        <Tooltip title="Remove tier">
                          <span>
                            <IconButton
                              size="small"
                              color="error"
                              onClick={() => deleteRow(idx)}
                              aria-label="Remove tier"
                              disabled={rows.length === 1}
                            >
                              <DeleteOutlineIcon fontSize="small" />
                            </IconButton>
                          </span>
                        </Tooltip>
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
              gap: 1,
              mt: 1.5,
              flexWrap: 'wrap',
            }}
          >
            <Button
              size="small"
              variant="outlined"
              startIcon={<AddIcon />}
              onClick={addRow}
            >
              Add tier
            </Button>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
              {dirty && saveState !== 'saving' && (
                <Typography variant="caption" color="text.secondary">
                  Unsaved changes
                </Typography>
              )}
              <Button
                variant="contained"
                size="small"
                onClick={handleSave}
                disabled={!dirty || saving}
                startIcon={
                  saving ? <CircularProgress size={16} color="inherit" /> : undefined
                }
              >
                Save costs
              </Button>
            </Box>
          </Box>

          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
            Costs are per {unit}. Changes are saved when you click <strong>Save
            costs</strong>. Quotes use the cheapest applicable tier under the
            preferred vendor.
          </Typography>
        </>
      )}
    </Box>
  );
}
