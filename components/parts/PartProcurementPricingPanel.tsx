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
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
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
  /**
   * Reports whether the tier table is holding staged edits, so the workspace
   * can confirm before a tab switch or page unload throws them away
   * (interaction-standards.md §2, exit guard). Must be referentially stable.
   */
  onDirtyChange?: (dirty: boolean) => void;
}

interface EditRow {
  id?: string;
  tempKey?: string;
  quantity: string;
  cost: string;
}

/**
 * The persisted values a set of rows was seeded from. "Unsaved" is DERIVED by
 * comparing live rows against this, never latched on edit — so typing 1 → 10 → 1
 * settles back to clean instead of nagging for a save that would write nothing.
 */
interface CostSnapshot {
  quantity: string;
  cost: string;
}

function snapshotRows(rows: EditRow[]): CostSnapshot[] {
  return rows.map((r) => ({ quantity: r.quantity.trim(), cost: r.cost.trim() }));
}

function rowDiffersFromBaseline(row: EditRow, base: CostSnapshot | undefined): boolean {
  if (!base) return true; // a row with no counterpart is newly added
  return row.quantity.trim() !== base.quantity || row.cost.trim() !== base.cost;
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
  onDirtyChange,
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
  // The persisted values `rows` was seeded from. Dirty is derived against this
  // rather than latched, so undoing an edit by hand clears it.
  const [baseline, setBaseline] = useState<CostSnapshot[]>([]);
  const saving = saveState === 'saving';
  const dirtyRowFlags = rows.map((r, i) => rowDiffersFromBaseline(r, baseline[i]));
  const dirty = rows.length !== baseline.length || dirtyRowFlags.some(Boolean);
  // The vendor picker auto-saves, so it needs its OWN status. Sharing the tier
  // sheet's `saveState` would announce "Saved" about the wrong thing — the
  // exact "did it save?" ambiguity §2 is trying to prevent.
  const [vendorSaveState, setVendorSaveState] = useState<SaveState>('idle');

  // Only resets the "Saved" chip — dirtiness itself is derived from `baseline`.
  const markDirty = () => {
    setSaveState('idle');
  };

  // Publish staged-edit state to the workspace, which owns the exit guard.
  // Cleared on unmount so a discarded draft can't leave the guard armed.
  useEffect(() => {
    onDirtyChange?.(dirty);
    return () => onDirtyChange?.(false);
  }, [dirty, onDirtyChange]);

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
  const seedRowsFrom = useCallback((list: ProcurementTier[]) => {
    const seeded: EditRow[] =
      list.length === 0
        ? [{ tempKey: tempId(), quantity: '', cost: '' }]
        : list.map((t) => ({
            id: t.id,
            quantity: String(t.min_quantity),
            cost: String(t.cost_per_unit),
          }));
    setRows(seeded);
    // These rows now mirror the database, so they become the clean baseline.
    setBaseline(snapshotRows(seeded));
  }, []);

  useEffect(() => {
    seedRowsFrom(tiers);
  }, [tiers, seedRowsFrom]);

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
    setRowsAt((prev) => [
      ...prev,
      { tempKey: tempId(), quantity: '', cost: '' },
    ]);
    markDirty();
  };

  const deleteRow = (idx: number) => {
    // Deletes are deferred to Save (reconciled against the persisted sheet),
    // matching the explicit-save model for the rest of the cost edits.
    setRowsAt((prev) => prev.filter((_, i) => i !== idx));
    markDirty();
  };

  /**
   * Drop staged cost edits and re-seed from the persisted tiers. The
   * counterpart to Save in the unsaved-changes footer — the user needs a
   * deliberate way to back out that isn't "navigate away and hope".
   */
  const handleDiscard = () => {
    // `tiers` is the persisted sheet — re-seeding from it restores the rows
    // and clears `dirty`.
    seedRowsFrom(tiers);
    setSaveState('idle');
    setError(null);
  };

  // "2 unsaved changes" tells the user how much is at stake. Removing a row
  // leaves no dirty row to count, so fall back to the generic phrasing.
  const dirtyRowCount = dirtyRowFlags.filter(Boolean).length;
  const unsavedLabel =
    dirtyRowCount === 0
      ? 'Unsaved changes'
      : dirtyRowCount === 1
        ? '1 unsaved change'
        : `${dirtyRowCount} unsaved changes`;

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
    setVendorSaveState('saving');
    try {
      await updatePartPreferredVendor(partId, nextId);
      setVendorSaveState('saved');
      // The supplier role on the Vendors page is derived from this, so refresh
      // the parent. Safe for staged edits in sibling cards: the refresh they
      // receive invalidates derived cost only, never their draft rows
      // (interaction-standards.md §2, section isolation).
      onSaved?.();
    } catch (err) {
      setSelectedVendorId(prevId);
      setVendorSaveState('error');
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

      {/* Preferred vendor is an AUTO-SAVE control living next to an
          explicit-Save tier table — the one thing interaction-standards.md §2
          says never to mix inside a single section. It stays auto-save (it's a
          single, non-financial label, the right mode for it), so the fix is to
          stop it reading as part of the staged sheet: its own bordered block,
          its own save status, and a divider before the tiers. The two Save
          models are now visibly two sections, not one ambiguous card. */}
      <Box
        sx={{
          mb: 2,
          p: 1.5,
          border: '1px solid',
          borderColor: 'divider',
          borderRadius: 1,
          display: 'flex',
          alignItems: 'flex-start',
          gap: 1.5,
          flexWrap: 'wrap',
        }}
      >
        <Autocomplete<Vendor>
          options={vendors}
          value={selectedVendor}
          onChange={(_e, next) => handleVendorPick(next)}
          getOptionLabel={(v) => v.name}
          isOptionEqualToValue={(opt, val) => opt.id === val.id}
          size="small"
          sx={{ flex: 1, minWidth: 260, maxWidth: 480 }}
          renderInput={(params) => (
            <TextField
              {...params}
              label="Preferred vendor"
              placeholder="Pick a supplier (optional)"
              helperText="Saved as soon as you pick it. Cost tiers below apply regardless of vendor."
            />
          )}
        />
        <Box sx={{ pt: 1 }}>
          <SaveStatus state={vendorSaveState} />
        </Box>
      </Box>

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
                    <TableRow
                      key={rowKey}
                      sx={{
                        // Same 3px left accent as the incomplete BOM/routing
                        // rows, one rung down: error.main = broken,
                        // warning.main = wants attention, transparent = fine.
                        // An unsaved edit is the middle rung — not a mistake.
                        '& > td:first-of-type': {
                          borderLeft: '3px solid',
                          borderLeftColor: dirtyRowFlags[idx] ? 'warning.main' : 'transparent',
                        },
                      }}
                    >
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
          </Box>

          {/* Unsaved-changes footer — same treatment as the Pricing card, so
              "staged, needs Save" looks identical on both tier tables. Sticky
              and persistent: the caption-sized grey hint this replaces sat
              below the fold and went unread, which is how a staged edit got
              silently discarded. */}
          {dirty && (
            <Box
              sx={{
                position: 'sticky',
                bottom: 0,
                zIndex: 2,
                mt: 2,
                px: 2,
                py: 1.5,
                display: 'flex',
                alignItems: 'center',
                gap: 1.5,
                flexWrap: 'wrap',
                borderTop: '2px solid',
                borderColor: 'warning.main',
                borderRadius: 1,
                bgcolor: 'background.paper',
                backdropFilter: 'blur(8px)',
              }}
            >
              <EditOutlinedIcon fontSize="small" sx={{ color: 'warning.main' }} />
              <Typography variant="body2" sx={{ fontWeight: 600 }}>
                {unsavedLabel}
              </Typography>
              <Box sx={{ flex: 1 }} />
              <Button size="small" onClick={handleDiscard} disabled={saving}>
                Discard
              </Button>
              <Button
                variant="contained"
                size="small"
                onClick={handleSave}
                disabled={saving}
                startIcon={
                  saving ? <CircularProgress size={16} color="inherit" /> : undefined
                }
              >
                {saving ? 'Saving…' : 'Save costs'}
              </Button>
            </Box>
          )}
        </>
      )}
    </Box>
  );
}
