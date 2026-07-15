'use client';

import { useCallback, useEffect, useState } from 'react';
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
import type { ProcurementTier } from '@/types/procurementTier';
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
 * Renders a "Cost" header + a vendor picker + a single **part-level** tier
 * table. Cost tiers are a property of the part, independent of vendor — the
 * cost engine (`compute_part_cost_at_qty` / `get_procurement_cost`) reads them
 * directly. The vendor picker sets `parts.preferred_vendor_id`, a supplier
 * ("who we PO from") label that drives the Vendors-page role but never gates
 * cost, so switching vendor does NOT swap or discard the tier sheet.
 *
 * (Multi-vendor cost sheets / RFQ / POs are deferred to a future purchasing
 * module — see the drop-per-vendor-tiers migration.)
 *
 * Cost edits are financial data, so — like the made-part Pricing card — they
 * are committed via an explicit **Save** button (not auto-saved on blur);
 * `dirty` tracks unsaved edits. When the part has no priced tier yet, the table
 * shows a single empty starter row highlighted red (instead of a separate
 * yellow banner) so the user fills the cost in directly.
 */
export default function PartProcurementPricingPanel({
  partId,
  companyId,
  preferredVendorId,
  onSaved,
}: PartProcurementPricingPanelProps) {
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [tiers, setTiers] = useState<ProcurementTier[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // The vendor is a pure supplier label now (parts.preferred_vendor_id); it no
  // longer selects a tier sheet. Seed from the prop at mount.
  const [selectedVendorId, setSelectedVendorId] = useState<string | null>(
    preferredVendorId ?? null,
  );
  const [rows, setRows] = useState<EditRow[]>([]);

  // Cost edits commit via an explicit Save (financial data — no silent
  // auto-save). `dirty` tracks unsaved tier edits; `saveState` drives the
  // SaveStatus chip + the Save button's disabled state.
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [dirty, setDirty] = useState(false);
  const saving = saveState === 'saving';

  const markDirty = () => {
    setDirty(true);
    setSaveState('idle');
  };

  const initialLoad = useCallback(async () => {
    try {
      setLoading(true);
      const [tierList, vendorList] = await Promise.all([
        getTiersForPart(partId),
        getAllVendors(companyId),
      ]);
      setVendors(vendorList);
      setTiers(tierList);
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
    // Data-fetch-on-mount false positive: initialLoad's setState all runs
    // post-await (documented class in eslint.config.mjs). It seeds the EDITABLE
    // tier rows, so useLoad (immutable data) doesn't fit — kept as-is.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    initialLoad();
  }, [initialLoad]);

  // Sync the working-copy rows whenever the persisted part-level tiers change
  // (initial load, or a reload after Save). No saved tier seeds ONE empty
  // starter row so the user fills the cost in directly (rendered red below).
  // Resets `dirty` — these rows mirror the DB.
  useEffect(() => {
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
  }, [tiers]);

  const selectedVendor = vendors.find((v) => v.id === selectedVendorId) ?? null;

  // True when the part has no SAVED tier yet → it can't be priced. Drives the
  // red starter-tier styling + prompt. Recomputes from `tiers` (persisted), so
  // it clears the instant a Save reloads the sheet.
  const needsCost = tiers.length === 0;

  // Row editing -----------------------------------------------------------

  const setRowsAt = (mapper: (rows: EditRow[]) => EditRow[]) => {
    setRows((prev) => mapper(prev));
  };

  const addRow = () => {
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
      const persisted = tiers;
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
            min_quantity: r.quantity,
            cost_per_unit: r.cost,
            quoted_at: null,
            expires_at: null,
            notes: '',
          });
        }
      }

      // Reload the sheet — the sync effect re-syncs rows + clears `dirty`, and
      // `needsCost` recomputes from the fresh tiers.
      const fresh = await getTiersForPart(partId);
      setTiers(fresh);
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

  /**
   * Pick the preferred vendor: sets `parts.preferred_vendor_id` (the supplier
   * label). Decoupled from the tier sheet — the part-level cost tiers are
   * untouched, so unsaved tier edits are preserved. Optimistic local switch;
   * failures revert and surface in the error alert.
   */
  const handleVendorPick = async (vendor: Vendor | null) => {
    const nextId = vendor ? vendor.id : null;
    if (nextId === selectedVendorId) return;

    const prevId = selectedVendorId;
    setSelectedVendorId(nextId);
    try {
      await updatePartPreferredVendor(partId, nextId);
      // The supplier role on the Vendors page is derived from this, so refresh
      // the parent.
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
      {/* Section header: "Cost" h6 + save status. The vendor picker below sets
          the preferred supplier; the tier table is part-level and independent
          of it. */}
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
        getOptionLabel={(v) => v.name}
        isOptionEqualToValue={(opt, val) => opt.id === val.id}
        size="small"
        sx={{ mb: 2, maxWidth: 480 }}
        renderInput={(params) => (
          <TextField
            {...params}
            label="Preferred vendor"
            placeholder="Pick a supplier (optional)"
            helperText="The default supplier for this part. Cost tiers below apply regardless of vendor."
          />
        )}
      />

      {loading ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }}>
          <CircularProgress size={24} />
        </Box>
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
        </>
      )}
    </Box>
  );
}
