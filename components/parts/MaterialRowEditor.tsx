'use client';

import { useEffect, useMemo, useState } from 'react';
import Box from '@mui/material/Box';
import TextField from '@mui/material/TextField';
import Button from '@mui/material/Button';
import Autocomplete from '@mui/material/Autocomplete';
import CircularProgress from '@mui/material/CircularProgress';
import Typography from '@mui/material/Typography';

/**
 * Lightweight part option used by the material picker. Mirrors the shape
 * returned by `getPartsForSelect`. Defined here (vs imported from
 * partsAccess) to keep the editor's prop surface explicit.
 */
export interface PartOption {
  id: string;
  part_name: string;
  description: string | null;
  is_stocked: boolean;
  source: 'made' | 'bought';
  primary_unit: string | null;
}

export interface MaterialEditorValue {
  childPart: PartOption | null;
  quantity: string;
  unit: string;
}

export interface MaterialRowEditorProps {
  parts: PartOption[];
  partsLoading: boolean;
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
  parts,
  partsLoading,
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

  const handlePartChange = (option: PartOption | null) => {
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
          <Autocomplete
            options={parts}
            loading={partsLoading}
            value={value.childPart}
            onChange={(_, option) => handlePartChange(option)}
            getOptionLabel={(option) => option.part_name}
            isOptionEqualToValue={(option, v) => option.id === v.id}
            disabled={lockChildPart || saving}
            size="small"
            renderOption={(props, option) => {
              const { key, ...rest } = props as React.HTMLAttributes<HTMLLIElement> & {
                key?: React.Key;
              };
              return (
                <Box component="li" {...rest} key={key as React.Key} sx={{ minWidth: 0 }}>
                  <Typography variant="body2" sx={{ fontWeight: 500 }}>
                    {option.part_name}
                  </Typography>
                  {option.description && (
                    <Typography
                      variant="caption"
                      color="text.secondary"
                      sx={{
                        display: 'block',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {option.description}
                    </Typography>
                  )}
                </Box>
              );
            }}
            renderInput={(params) => (
              <TextField
                {...params}
                label="Material part"
                required
                autoFocus={!lockChildPart}
                size="small"
                InputProps={{
                  ...params.InputProps,
                  endAdornment: (
                    <>
                      {partsLoading ? <CircularProgress size={16} /> : null}
                      {params.InputProps.endAdornment}
                    </>
                  ),
                }}
              />
            )}
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
