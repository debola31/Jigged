'use client';

import { useEffect, useMemo, useState } from 'react';
import Box from '@mui/material/Box';
import TextField from '@mui/material/TextField';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Typography from '@mui/material/Typography';
import MenuItem from '@mui/material/MenuItem';
import InputAdornment from '@mui/material/InputAdornment';
import Link from 'next/link';

import PartAutocomplete, { type PartSelectOption } from '@/components/parts/PartAutocomplete';
import { getPartUnitConversions } from '@/utils/partsAccess';
import MissingFieldsNotice from '@/components/common/MissingFieldsNotice';

export type { PartSelectOption };

export interface MaterialEditorValue {
  childPart: PartSelectOption | null;
  quantity: string;
  unit: string;
}

export interface MaterialRowEditorProps {
  /**
   * Used both by the embedded PartAutocomplete and by the "add a unit
   * conversion on the child part" helper link rendered when the child has
   * only its primary_unit available.
   */
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
 * The Unit field is constrained to the child's primary_unit + every
 * parts_unit_conversions.from_unit row for that child — typing an
 * unconvertible unit would silently break the cost rollup later in
 * compute_part_cost_at_qty. The DB CHECK parts_requires_unit guarantees
 * every part has a primary_unit, so there's no free-text fallback path.
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

  // Conversions for the currently-selected child part. Drives the Unit picker
  // options: primary_unit + every parts_unit_conversions.from_unit row. Empty
  // until a child is picked or the load resolves.
  const [conversionUnits, setConversionUnits] = useState<string[]>([]);
  const [conversionsLoading, setConversionsLoading] = useState(false);

  // Reset when initial changes (e.g. user cancels add then opens edit on a
  // different row in the same panel mount).
  useEffect(() => {
    setValue(initial ?? EMPTY_VALUE);
  }, [initial]);

  // Load the child's secondary units whenever it changes. The Unit picker
  // is constrained to primary_unit + these — entering a unit with no
  // conversion would just blow up later in compute_part_cost_at_qty.
  useEffect(() => {
    const childId = value.childPart?.id;
    if (!childId) {
      setConversionUnits([]);
      return;
    }
    let cancelled = false;
    setConversionsLoading(true);
    getPartUnitConversions(childId)
      .then((rows) => {
        if (cancelled) return;
        setConversionUnits(rows.map((r) => r.from_unit));
      })
      .catch((err) => {
        if (cancelled) return;
        console.error('Failed to load unit conversions for child:', err);
        setConversionUnits([]);
      })
      .finally(() => {
        if (!cancelled) setConversionsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [value.childPart?.id]);

  // Build the constrained option list: primary_unit first, then every
  // conversion `from_unit`, de-duped, preserving order. parts_requires_unit
  // guarantees every child has a primary_unit, so the list is never empty
  // once a child is picked.
  const unitOptions = useMemo<string[]>(() => {
    const child = value.childPart;
    if (!child) return [];
    const list: string[] = [];
    if (child.primary_unit) list.push(child.primary_unit);
    for (const u of conversionUnits) {
      if (!list.includes(u)) list.push(u);
    }
    return list;
  }, [value.childPart, conversionUnits]);

  const onlyPrimaryAvailable =
    !!value.childPart && !!value.childPart.primary_unit && conversionUnits.length === 0;

  // Auto-correct the unit when the child changes and the previously-typed
  // unit isn't valid for the new child. Snap to primary_unit (the canonical
  // default) so the user starts from a working state. We only run this once
  // the conversions load completes for the current child to avoid clobbering
  // an in-flight selection.
  useEffect(() => {
    if (conversionsLoading) return;
    const child = value.childPart;
    if (!child) return;
    if (unitOptions.includes(value.unit)) return;
    setValue((prev) => ({ ...prev, unit: child.primary_unit ?? '' }));
    // value.unit and value.childPart are read; updating value here is fine.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unitOptions, conversionsLoading]);

  const handlePartChange = (option: PartSelectOption | null) => {
    setValue((prev) => ({
      ...prev,
      childPart: option,
      // Default the BOM unit to the child's primary unit on first selection
      // (one-click for the common case). The conversions-load effect will
      // re-snap to primary_unit if the previous typed value is invalid.
      unit: option?.primary_unit ?? '',
    }));
  };

  // What's still blocking the save, surfaced inline so the user knows which
  // field needs attention. Mirrors the canSave checks below.
  const missingItems = useMemo(() => {
    const items: string[] = [];
    if (!value.childPart) items.push('Select a material part');
    const qty = parseFloat(value.quantity);
    if (!Number.isFinite(qty) || qty <= 0) items.push('Enter a quantity greater than zero');
    if (value.childPart && (!value.unit?.trim() || !unitOptions.includes(value.unit))) {
      items.push('Choose a unit');
    }
    return items;
  }, [value, unitOptions]);

  const canSave = missingItems.length === 0;

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
          inputProps={{ min: 0, step: 'any', inputMode: 'decimal' }}
          size="small"
          disabled={saving}
          sx={{ width: 120 }}
        />

        {/* Unit picker: constrained to the child's primary_unit + every
            parts_unit_conversions.from_unit row. Free-text was removed
            because typed-but-unconvertible units silently broke the cost
            rollup later. parts_requires_unit guarantees every child has a
            primary_unit, so the option list is never empty once a child is
            picked. */}
        <TextField
          select
          label="Unit"
          value={value.childPart && unitOptions.includes(value.unit) ? value.unit : ''}
          onChange={(e) => setValue((prev) => ({ ...prev, unit: e.target.value }))}
          required
          size="small"
          disabled={saving || !value.childPart || conversionsLoading || onlyPrimaryAvailable}
          sx={{ width: 130 }}
          slotProps={{
            input: {
              endAdornment: conversionsLoading ? (
                <InputAdornment position="end">
                  <CircularProgress size={14} />
                </InputAdornment>
              ) : undefined,
            },
          }}
        >
          {unitOptions.length === 0 && (
            <MenuItem value="" disabled>
              {value.childPart ? 'No units available' : 'Pick a part first'}
            </MenuItem>
          )}
          {unitOptions.map((u) => (
            <MenuItem key={u} value={u}>
              {u}
              {value.childPart?.primary_unit === u ? ' (primary)' : ''}
            </MenuItem>
          ))}
        </TextField>
      </Box>

      {value.childPart?.primary_unit &&
        value.unit?.trim() &&
        value.unit !== value.childPart.primary_unit && (
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.75, ml: 1 }}>
            Child&apos;s primary unit: {value.childPart.primary_unit}. The cost
            calculation will use the matching conversion to bridge.
          </Typography>
        )}

      {onlyPrimaryAvailable && (
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.75, ml: 1 }}>
          Only the child&apos;s primary unit ({value.childPart?.primary_unit}) is
          available. To use a different unit,{' '}
          <Link
            href={`/dashboard/${companyId}/parts/${value.childPart?.id ?? ''}`}
            target="_blank"
            style={{ textDecoration: 'underline', color: 'inherit' }}
          >
            add a unit conversion on the child part
          </Link>
          .
        </Typography>
      )}

      {error && (
        <Typography variant="caption" color="error" sx={{ display: 'block', mt: 0.75, ml: 1 }}>
          {error}
        </Typography>
      )}

      <MissingFieldsNotice items={missingItems} />

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
