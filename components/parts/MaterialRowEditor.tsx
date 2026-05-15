'use client';

import { useEffect, useMemo, useState } from 'react';
import Box from '@mui/material/Box';
import TextField from '@mui/material/TextField';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Typography from '@mui/material/Typography';

import PartAutocomplete, { type PartSelectOption } from '@/components/parts/PartAutocomplete';

export type { PartSelectOption };

export interface MaterialEditorValue {
  childPart: PartSelectOption | null;
  quantity: string;
  unit: string;
}

export interface MaterialRowEditorProps {
  companyId: string;
  /** Part IDs to hide from the child-part picker (e.g. the parent itself). */
  excludeIds?: string[];
  /** When provided, the editor is in edit mode for an existing material row. */
  initial?: MaterialEditorValue;
  /**
   * When true, the child-part picker is disabled. Used in edit mode —
   * changing the child of an existing line is identical to delete+re-add,
   * so we keep the surface simple by locking it.
   */
  lockChildPart?: boolean;
  saving?: boolean;
  /** Inline error to display under the row (e.g. cycle precheck failure). */
  error?: string | null;
  onSave: (value: MaterialEditorValue) => void;
  onCancel: () => void;
}

const EMPTY_VALUE: MaterialEditorValue = {
  childPart: null,
  quantity: '',
  unit: '',
};

/**
 * Inline editor for a single Materials row on the part detail page. Mirrors
 * the shape of RoutingOperationRowEditor — the operations panel uses an
 * inline-row pattern (no modal) and the materials panel matches it for
 * consistency. The user toggles a row into edit mode in place; "Add
 * Material" appends an editor row at the end of the list.
 *
 * The editor is purely presentational. Cycle pre-check + addBomLine /
 * updateBomLine calls live in PartBomPanel which holds the state machine.
 */
export default function MaterialRowEditor({
  companyId,
  excludeIds,
  initial,
  lockChildPart = false,
  saving = false,
  error,
  onSave,
  onCancel,
}: MaterialRowEditorProps) {
  const [value, setValue] = useState<MaterialEditorValue>(initial ?? EMPTY_VALUE);

  // Reset when initial changes (e.g. user cancels add then opens edit on a
  // different row in the same panel mount).
  useEffect(() => {
    setValue(initial ?? EMPTY_VALUE);
  }, [initial]);

  const handlePartChange = (option: PartSelectOption | null) => {
    setValue((prev) => ({
      ...prev,
      childPart: option,
      // Default the BOM unit to the child's primary unit on first selection
      // (one-click for the common case). Don't clobber if the user already
      // typed a unit — they may have intentionally chosen a different one.
      unit: prev.unit?.trim() ? prev.unit : option?.primary_unit ?? '',
    }));
  };

  const canSave = useMemo(() => {
    if (!value.childPart) return false;
    const qty = parseFloat(value.quantity);
    if (!Number.isFinite(qty) || qty <= 0) return false;
    if (!value.unit?.trim()) return false;
    return true;
  }, [value]);

  return (
    <Box
      sx={{
        py: 1.5,
        px: 1,
        bgcolor: 'action.hover',
        borderRadius: 1,
        my: 0.5,
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1.5, flexWrap: 'wrap' }}>
        <Box sx={{ flex: '1 1 240px', minWidth: 200 }}>
          <PartAutocomplete
            companyId={companyId}
            value={value.childPart}
            onChange={handlePartChange}
            excludeIds={excludeIds}
            disabled={lockChildPart || saving}
            label="Material part"
            required
            autoFocus={!lockChildPart}
          />
        </Box>

        <TextField
          label="Quantity"
          type="number"
          value={value.quantity}
          onChange={(e) => setValue((prev) => ({ ...prev, quantity: e.target.value }))}
          required
          inputProps={{ min: 0, step: 'any' }}
          size="small"
          disabled={saving}
          sx={{ width: 120 }}
        />

        <TextField
          label="Unit"
          value={value.unit}
          onChange={(e) => setValue((prev) => ({ ...prev, unit: e.target.value }))}
          required
          placeholder={value.childPart?.primary_unit ?? ''}
          size="small"
          disabled={saving}
          sx={{ width: 100 }}
        />
      </Box>

      {value.childPart?.primary_unit &&
        value.unit?.trim() &&
        value.unit !== value.childPart.primary_unit && (
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.75, ml: 1 }}>
            Child&apos;s primary unit: {value.childPart.primary_unit}. The cost
            calculation will use unit conversions to bridge.
          </Typography>
        )}

      {error && (
        <Typography variant="caption" color="error" sx={{ display: 'block', mt: 0.75, ml: 1 }}>
          {error}
        </Typography>
      )}

      {/* Footer button row mirrors the operations editor: text buttons at
          the bottom, not icon controls inline with the inputs. Save label
          flips between Add to BOM (create) and Save changes (edit) so the
          user knows what the click commits. */}
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'flex-end',
          gap: 1,
          mt: 1.5,
          flexWrap: 'wrap',
        }}
      >
        <Button size="small" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        <Button
          size="small"
          variant="contained"
          onClick={() => canSave && onSave(value)}
          disabled={!canSave || saving}
          startIcon={saving ? <CircularProgress size={14} color="inherit" /> : null}
        >
          {lockChildPart ? 'Save changes' : 'Add to BOM'}
        </Button>
      </Box>

      {/* Hidden Save button for keyboard users — Enter on any input submits. */}
      <Box sx={{ position: 'absolute', width: 0, height: 0, overflow: 'hidden' }}>
        <Button type="submit" onClick={() => canSave && onSave(value)}>
          Save
        </Button>
      </Box>
    </Box>
  );
}
