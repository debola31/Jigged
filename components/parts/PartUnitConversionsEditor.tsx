'use client';

import { useEffect, useState, useRef } from 'react';
import { useLoad } from '@/hooks/useLoad';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import TextField from '@mui/material/TextField';
import CircularProgress from '@mui/material/CircularProgress';
import Alert from '@mui/material/Alert';
import Stack from '@mui/material/Stack';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import EditIcon from '@mui/icons-material/Edit';
import AddIcon from '@mui/icons-material/Add';
import SwapHorizIcon from '@mui/icons-material/SwapHoriz';

import DeleteIconButton from '@/components/common/DeleteIconButton';

import {
  getPartUnitConversions,
  replacePartUnitConversions,
} from '@/utils/partsAccess';
import type {
  PartUnitConversion,
  PartUnitConversionFormData,
} from '@/types/part';

interface PartUnitConversionsEditorProps {
  partId: string;
  primaryUnit: string;
  /**
   * Optional callback fired after a successful save/delete. The part detail
   * page uses this to refresh its own conversions cache (used by the stock
   * transaction modal) so that newly-added conversions are usable
   * immediately without a page reload.
   */
  onChanged?: (next: PartUnitConversion[]) => void;
}

interface DraftConversion {
  id?: string;
  from_unit: string;
  to_primary_factor: string; // string while editing so partial input ("0.") works
}

const emptyDraft: DraftConversion = { from_unit: '', to_primary_factor: '' };

// Stable empty fallback so the derived list doesn't churn while the first
// load runs.
const EMPTY_CONVERSIONS: PartUnitConversion[] = [];

/**
 * Inline editor for part unit conversions. Lives in the Inventory panel of
 * the part detail page (chunk 14 moved unit-conversion editing out of the
 * Part create/edit form — they're a property of an existing part).
 *
 * Each conversion answers: "1 of {from_unit} equals how many {primary_unit}?"
 * Used by the importer + transaction modal to translate between purchase
 * units (e.g. 12-foot bars) and tracking units (e.g. inches).
 *
 * Saves use `replacePartUnitConversions` (delete-then-insert) so the row
 * order/uniqueness invariants are simple to enforce — there's no per-row
 * patch endpoint to keep in sync.
 */
export default function PartUnitConversionsEditor({
  partId,
  primaryUnit,
  onChanged,
}: PartUnitConversionsEditorProps) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Draft state for the inline add/edit modal. `editingId` distinguishes
  // edit-existing (matches an existing row's id) from add-new (undefined).
  const [draftOpen, setDraftOpen] = useState(false);
  const [draft, setDraft] = useState<DraftConversion>(emptyDraft);
  const [editingId, setEditingId] = useState<string | undefined>(undefined);
  const [draftError, setDraftError] = useState<string | null>(null);

  // Hold the latest onChanged in a ref so reload's identity stays stable
  // across renders. If we depended on `onChanged` directly, every parent
  // re-render (which creates a new `onChanged` closure) would invalidate
  // reload, refire the mount effect, and cause a fetch loop.
  const onChangedRef = useRef(onChanged);
  useEffect(() => {
    onChangedRef.current = onChanged;
  }, [onChanged]);

  // When a persist/delete triggers a reload, the next successful load notifies
  // the parent with the fresh conversions (the old `reload(true)` path). The
  // initial mount load and partId-change loads leave it unset, so they don't
  // notify — matching the previous `notifyParent` default of false.
  const notifyParentRef = useRef(false);

  const {
    data: conversionsData,
    loading,
    reload,
  } = useLoad(
    async () => {
      const data = await getPartUnitConversions(partId);
      setError(null);
      if (notifyParentRef.current) {
        notifyParentRef.current = false;
        onChangedRef.current?.(data);
      }
      return data;
    },
    [partId],
    {
      onError: (err) => {
        setError(
          err instanceof Error ? err.message : 'Failed to load unit conversions',
        );
      },
    },
  );
  const conversions = conversionsData ?? EMPTY_CONVERSIONS;

  const openAdd = () => {
    setDraft(emptyDraft);
    setEditingId(undefined);
    setDraftError(null);
    setDraftOpen(true);
  };

  const openEdit = (uc: PartUnitConversion) => {
    setDraft({
      id: uc.id,
      from_unit: uc.from_unit,
      to_primary_factor: String(uc.to_primary_factor),
    });
    setEditingId(uc.id);
    setDraftError(null);
    setDraftOpen(true);
  };

  const closeDraft = () => {
    if (saving) return;
    setDraftOpen(false);
    setDraft(emptyDraft);
    setEditingId(undefined);
    setDraftError(null);
  };

  const validateDraft = (): { ok: true; value: PartUnitConversionFormData } | { ok: false; message: string } => {
    const fromUnit = draft.from_unit.trim();
    if (!fromUnit) return { ok: false, message: 'From-unit is required' };
    if (fromUnit === primaryUnit) {
      return {
        ok: false,
        message:
          'From-unit cannot match the primary unit (1:1 conversion is implicit).',
      };
    }
    const factor = Number(draft.to_primary_factor);
    if (!Number.isFinite(factor) || factor <= 0) {
      return { ok: false, message: 'Conversion factor must be greater than 0' };
    }
    // Duplicate check against other conversions (excluding the row being edited).
    const dup = conversions.find(
      (c) => c.from_unit === fromUnit && c.id !== editingId,
    );
    if (dup) {
      return {
        ok: false,
        message: `A conversion from "${fromUnit}" already exists. Edit that row instead.`,
      };
    }
    return {
      ok: true,
      value: { id: draft.id, from_unit: fromUnit, to_primary_factor: factor },
    };
  };

  const persist = async (next: PartUnitConversionFormData[]) => {
    setSaving(true);
    try {
      await replacePartUnitConversions(partId, next);
      notifyParentRef.current = true;
      await reload();
      setDraftOpen(false);
      setDraft(emptyDraft);
      setEditingId(undefined);
    } catch (err) {
      setDraftError(
        err instanceof Error ? err.message : 'Failed to save conversion',
      );
    } finally {
      setSaving(false);
    }
  };

  const handleSaveDraft = async () => {
    const validated = validateDraft();
    if (!validated.ok) {
      setDraftError(validated.message);
      return;
    }
    // Build the next list: replace if editing, append if adding.
    const next: PartUnitConversionFormData[] = editingId
      ? conversions.map((c) =>
          c.id === editingId
            ? { id: c.id, from_unit: validated.value.from_unit, to_primary_factor: validated.value.to_primary_factor }
            : { id: c.id, from_unit: c.from_unit, to_primary_factor: c.to_primary_factor },
        )
      : [
          ...conversions.map((c) => ({
            id: c.id,
            from_unit: c.from_unit,
            to_primary_factor: c.to_primary_factor,
          })),
          { from_unit: validated.value.from_unit, to_primary_factor: validated.value.to_primary_factor },
        ];

    await persist(next);
  };

  const handleDelete = async (id: string) => {
    const next: PartUnitConversionFormData[] = conversions
      .filter((c) => c.id !== id)
      .map((c) => ({
        id: c.id,
        from_unit: c.from_unit,
        to_primary_factor: c.to_primary_factor,
      }));
    setSaving(true);
    setError(null);
    try {
      await replacePartUnitConversions(partId, next);
      notifyParentRef.current = true;
      await reload();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Failed to delete conversion',
      );
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 2 }}>
        <CircularProgress size={20} />
      </Box>
    );
  }

  return (
    <Box>
      {error && (
        <Alert severity="error" sx={{ mb: 1 }} onClose={() => setError(null)}>
          {error}
        </Alert>
      )}

      {conversions.length === 0 ? (
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
          No unit conversions defined. Add one if this item is purchased in a
          different unit than it&apos;s tracked in (e.g. buy in 12-foot bars,
          track per inch).
        </Typography>
      ) : (
        <Stack spacing={0.5} sx={{ mb: 1 }}>
          {conversions.map((uc) => (
            <Box
              key={uc.id}
              sx={{
                display: 'flex',
                alignItems: 'center',
                gap: 1,
                py: 0.5,
                borderRadius: 1,
                '&:hover': { bgcolor: 'action.hover' },
              }}
            >
              <SwapHorizIcon fontSize="small" sx={{ color: 'text.secondary' }} />
              <Typography
                variant="body2"
                fontFamily="monospace"
                sx={{ flex: 1 }}
              >
                1 {uc.from_unit} = {uc.to_primary_factor} {primaryUnit}
              </Typography>
              <IconButton
                size="small"
                onClick={() => openEdit(uc)}
                disabled={saving}
                aria-label="Edit conversion"
              >
                <EditIcon fontSize="small" />
              </IconButton>
              <DeleteIconButton
                ariaLabel="Delete conversion"
                onClick={() => handleDelete(uc.id)}
                disabled={saving}
              />
            </Box>
          ))}
        </Stack>
      )}

      <Button
        size="small"
        startIcon={<AddIcon />}
        onClick={openAdd}
        disabled={saving}
      >
        Add conversion
      </Button>

      <Dialog open={draftOpen} onClose={closeDraft} maxWidth="xs" fullWidth>
        <DialogTitle>
          {editingId ? 'Edit conversion' : 'Add conversion'}
        </DialogTitle>
        <DialogContent>
          {draftError && (
            <Alert severity="error" sx={{ mb: 2 }}>
              {draftError}
            </Alert>
          )}
          <Stack spacing={2} sx={{ mt: 1 }}>
            <TextField
              autoFocus
              label="From unit"
              value={draft.from_unit}
              onChange={(e) =>
                setDraft((prev) => ({ ...prev, from_unit: e.target.value }))
              }
              disabled={saving}
              placeholder="e.g. ft, bar, sheet"
              helperText="The unit you buy or receive this part in."
              fullWidth
            />
            <TextField
              label={`Equals (in ${primaryUnit})`}
              type="number"
              value={draft.to_primary_factor}
              onChange={(e) =>
                setDraft((prev) => ({
                  ...prev,
                  to_primary_factor: e.target.value,
                }))
              }
              disabled={saving}
              InputLabelProps={{ shrink: true }}
              inputProps={{ min: 0, step: 'any' }}
              helperText={`How many ${primaryUnit} are in 1 of the from-unit (e.g. 12 if 1 ft = 12 in).`}
              fullWidth
            />
            {draft.from_unit && draft.to_primary_factor && (
              <Box
                sx={{
                  p: 1.5,
                  borderRadius: 1,
                  bgcolor: 'action.hover',
                  fontFamily: 'monospace',
                }}
              >
                <Typography variant="body2">
                  1 {draft.from_unit.trim() || '?'} ={' '}
                  {draft.to_primary_factor || '?'} {primaryUnit}
                </Typography>
              </Box>
            )}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={closeDraft} disabled={saving}>
            Cancel
          </Button>
          <Button
            onClick={handleSaveDraft}
            variant="contained"
            disabled={saving}
            startIcon={
              saving ? <CircularProgress size={16} color="inherit" /> : null
            }
          >
            {saving ? 'Saving...' : 'Save'}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
