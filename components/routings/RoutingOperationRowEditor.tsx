'use client';

import { useState, useEffect } from 'react';
import {
  Box,
  TextField,
  Button,
  Autocomplete,
  Chip,
  Typography,
} from '@mui/material';
import { parseOptionalNumber, numberToInputString } from '@/lib/validators';

/**
 * Picker option shape — one list holding both kinds of thing a step can target.
 *
 * `target` is the discriminator, and it is what the editor branches on. It is
 * derived by the list builder from which access function supplied the row
 * (`getWorkCentersForRouting` vs `getVendorServicesForRouting`), never guessed
 * from a name or a null.
 */
export interface StepTargetOption {
  id: string;
  name: string;
  target: 'station' | 'service';
  /** Stations only — the hourly rate the labour field pre-fills from. */
  labor_rate: number | null;
  /** Services only — the price per piece the price field pre-fills from. */
  unit_price: number | null;
  /** Services only — who performs it. */
  vendor_name: string | null;
}

export interface OperationEditorValue {
  workCenter: StepTargetOption | null;
  /** Internal: setup minutes per batch. */
  setupMinutes: number | null;
  /** Internal: cycle minutes per unit. */
  cycleMinutesPerUnit: number | null;
  /** Internal: optional override for the work center's labor rate ($/hr). */
  laborRateOverride: number | null;
  /** External: per-unit price ($). External work bills once per part — no setup. */
  externalUnitPrice: number | null;
  instructions: string | null;
}

interface RoutingOperationRowEditorProps {
  workCenters: StepTargetOption[];
  /** When provided, the editor is in edit mode (work center picker is locked). */
  initial?: OperationEditorValue;
  onSave: (value: OperationEditorValue) => void;
  onCancel: () => void;
  /** Sequence number to render at the left, matching display row layout (1-based, optional). */
  index?: number;
}

const numToStr = numberToInputString;

/**
 * Seed value for the labor-rate field. The field always shows the work center's
 * rate as the default and only persists an override when the user changes it —
 * so when there's no saved override, fall back to the (internal) work center's
 * current rate instead of leaving the field blank.
 */
function initialLaborStr(initial: OperationEditorValue | undefined): string {
  if (!initial) return '';
  if (initial.laborRateOverride !== null) return numToStr(initial.laborRateOverride);
  const wc = initial.workCenter;
  if (wc && wc.target === 'station' && wc.labor_rate !== null) {
    return String(wc.labor_rate);
  }
  return '';
}

/**
 * Seed value for the price-per-piece field, the exact mirror of
 * `initialLaborStr` above.
 *
 * The field shows the SERVICE's price and only persists an override when the
 * user changes it, so a step that agrees with the vendor's price stores null
 * and follows that price when it moves. Copying the number down instead would
 * mean raising a vendor's price moved nothing — the opposite of what the
 * adjacent labour field does, on a screen where both are visible.
 */
function initialPriceStr(initial: OperationEditorValue | undefined): string {
  if (!initial) return '';
  if (initial.externalUnitPrice !== null) return numToStr(initial.externalUnitPrice);
  const wc = initial.workCenter;
  if (wc && wc.target === 'service' && wc.unit_price !== null) {
    return String(wc.unit_price);
  }
  return '';
}

export default function RoutingOperationRowEditor({
  workCenters,
  initial,
  onSave,
  onCancel,
  index,
}: RoutingOperationRowEditorProps) {
  const isEdit = !!initial;
  const [workCenter, setWorkCenter] = useState<StepTargetOption | null>(
    initial?.workCenter ?? null,
  );
  const [setupStr, setSetupStr] = useState(numToStr(initial?.setupMinutes));
  const [cycleStr, setCycleStr] = useState(numToStr(initial?.cycleMinutesPerUnit));
  const [laborOverrideStr, setLaborOverrideStr] = useState(initialLaborStr(initial));
  const [externalUnitPriceStr, setExternalUnitPriceStr] = useState(
    initialPriceStr(initial),
  );
  const [instructions, setInstructions] = useState(initial?.instructions ?? '');
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    setWorkCenter(initial?.workCenter ?? null);
    setSetupStr(numToStr(initial?.setupMinutes));
    setCycleStr(numToStr(initial?.cycleMinutesPerUnit));
    setLaborOverrideStr(initialLaborStr(initial));
    setExternalUnitPriceStr(initialPriceStr(initial));
    setInstructions(initial?.instructions ?? '');
    setTouched(false);
  }, [initial]);

  /**
   * Add-mode only: picking a target pre-populates whichever money field applies
   * — a station's hourly rate, or a service's price per piece. Editing that
   * value then means "override for this step"; leaving it alone saves NO
   * override (handleSave compares against the target's own number first), so
   * the step keeps following the station or vendor when their price moves.
   *
   * Done in the picker's onChange rather than an effect on `workCenter`: these
   * are two pieces of state moving together in response to one user action, and
   * an effect for that is a cascading render the lint rule exists to stop.
   * Edit mode leaves both alone — the target is locked there anyway.
   */
  const handleTargetChange = (next: StepTargetOption | null) => {
    setWorkCenter(next);
    if (isEdit) return;
    setLaborOverrideStr(
      next?.target === 'station' && next.labor_rate !== null ? String(next.labor_rate) : '',
    );
    setExternalUnitPriceStr(
      next?.target === 'service' && next.unit_price !== null ? String(next.unit_price) : '',
    );
  };

  const isExternal = workCenter?.target === 'service';

  const wcError = touched && !workCenter;

  const setupParsed = parseOptionalNumber(setupStr);
  const cycleParsed = parseOptionalNumber(cycleStr);
  const setupError =
    touched && setupStr !== '' && (setupParsed === null || setupParsed < 0);
  const cycleError =
    touched && cycleStr !== '' && (cycleParsed === null || cycleParsed < 0);

  const externalUnitPriceParsed = parseOptionalNumber(externalUnitPriceStr);
  const extUnitPriceError =
    touched &&
    externalUnitPriceStr !== '' &&
    (externalUnitPriceParsed === null || externalUnitPriceParsed < 0);

  const internalHasAny =
    (setupParsed !== null && setupParsed > 0) || (cycleParsed !== null && cycleParsed > 0);
  const externalHasAny = externalUnitPriceParsed !== null && externalUnitPriceParsed > 0;
  const hasAnyValue = isExternal ? externalHasAny : internalHasAny;
  const atLeastOneError = touched && !hasAnyValue;

  const handleSave = () => {
    setTouched(true);
    if (!workCenter) return;
    if (isExternal) {
      if (extUnitPriceError || !externalHasAny) return;
      // Mirrors the labour-rate rule below: the field is pre-filled with the
      // service's price, so an "override" only means anything once the user
      // changes it. Matching (or clearing) persists null and the step inherits
      // whatever the vendor's price becomes.
      const servicePrice = workCenter.unit_price;
      const externalUnitPrice =
        externalUnitPriceParsed === null || externalUnitPriceParsed === servicePrice
          ? null
          : externalUnitPriceParsed;
      onSave({
        workCenter,
        setupMinutes: null,
        cycleMinutesPerUnit: null,
        laborRateOverride: null,
        externalUnitPrice,
        instructions: instructions.trim() || null,
      });
    } else {
      if (setupError || cycleError || !internalHasAny) return;
      // The labor-rate field is pre-populated with the work center's rate;
      // an "override" only makes sense when the user actually changed it.
      // If their value matches the work center default (or they cleared
      // it), persist null so the cost calc inherits whatever the work
      // center rate becomes in the future.
      const overrideParsed = parseOptionalNumber(laborOverrideStr);
      const wcRate = workCenter.labor_rate;
      const laborRateOverride =
        overrideParsed === null || overrideParsed === wcRate
          ? null
          : overrideParsed;
      onSave({
        workCenter,
        setupMinutes: setupParsed,
        cycleMinutesPerUnit: cycleParsed,
        laborRateOverride,
        externalUnitPrice: null,
        instructions: instructions.trim() || null,
      });
    }
  };

  return (
    <Box
      sx={{
        display: 'flex',
        flexDirection: 'column',
        gap: 1.5,
        p: 1.5,
        bgcolor: 'background.paper',
        border: '1px solid',
        borderColor: 'primary.main',
        borderRadius: 1,
        mb: 1,
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1 }}>
        {typeof index === 'number' && (
          <Typography
            variant="body2"
            sx={{ minWidth: 24, color: 'text.secondary', fontWeight: 600, mt: 1 }}
          >
            {index + 1}.
          </Typography>
        )}
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Autocomplete
            size="small"
            openOnFocus
            options={workCenters}
            groupBy={(wc) =>
              wc.target === 'service' ? 'Outside — at a vendor' : 'In-house'
            }
            getOptionLabel={(wc) =>
              wc.vendor_name ? `${wc.name} · ${wc.vendor_name}` : wc.name
            }
            value={workCenter}
            onChange={(_, newValue) => handleTargetChange(newValue)}
            isOptionEqualToValue={(option, value) => option.id === value.id}
            disabled={isEdit}
            renderOption={(props, option) => (
              <li {...props} key={option.id}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, width: '100%' }}>
                  <Typography variant="body2" sx={{ flex: 1, minWidth: 0 }}>
                    {option.name}
                  </Typography>
                  {option.vendor_name && (
                    <Typography variant="caption" color="text.secondary">
                      {option.vendor_name}
                    </Typography>
                  )}
                </Box>
              </li>
            )}
            renderInput={(params) => (
              <TextField
                {...params}
                autoFocus={!isEdit}
                label="Step"
                placeholder="Pick a work center or outside service…"
                error={wcError}
                helperText={wcError ? 'Pick a work center or outside service to continue.' : ' '}
              />
            )}
          />
        </Box>
      </Box>

      {isExternal ? (
        <Box sx={{ display: 'flex', gap: 1.5, flexWrap: 'wrap' }}>
          {/* Outside work bills once per part — a price per piece only, no
              setup cost (setup is an in-house concept). */}
          <TextField
            size="small"
            label="Price per piece ($)"
            type="text"
            inputMode="decimal"
            value={externalUnitPriceStr}
            autoFocus={isEdit}
            onChange={(e) => {
              const v = e.target.value;
              if (v === '' || /^\d*\.?\d*$/.test(v)) setExternalUnitPriceStr(v);
            }}
            error={!!extUnitPriceError}
            helperText={
              extUnitPriceError
                ? 'Enter a non-negative number.'
                : workCenter?.unit_price !== null && workCenter?.unit_price !== undefined
                  ? `${workCenter.vendor_name ?? 'This vendor'} charges $${workCenter.unit_price}. Change it only for this step.`
                  : ' '
            }
            sx={{ flex: 1, minWidth: 180 }}
          />
        </Box>
      ) : (
        <Box sx={{ display: 'flex', gap: 1.5, flexWrap: 'wrap' }}>
          <TextField
            size="small"
            label="Cycle minutes per unit"
            type="text"
            inputMode="decimal"
            value={cycleStr}
            autoFocus={isEdit}
            onChange={(e) => {
              const v = e.target.value;
              if (v === '' || /^\d*\.?\d*$/.test(v)) setCycleStr(v);
            }}
            error={!!cycleError}
            helperText={cycleError ? 'Enter a non-negative number.' : ' '}
            sx={{ flex: 1, minWidth: 180 }}
          />
          <TextField
            size="small"
            label="Setup minutes"
            type="text"
            inputMode="decimal"
            value={setupStr}
            onChange={(e) => {
              const v = e.target.value;
              if (v === '' || /^\d*\.?\d*$/.test(v)) setSetupStr(v);
            }}
            error={!!setupError}
            helperText={setupError ? 'Enter a non-negative number.' : ' '}
            sx={{ flex: 1, minWidth: 180 }}
          />
          {workCenter && (
            <TextField
              size="small"
              label="Labor rate ($/hr)"
              type="text"
              inputMode="decimal"
              value={laborOverrideStr}
              onChange={(e) => {
                const v = e.target.value;
                if (v === '' || /^\d*\.?\d*$/.test(v)) setLaborOverrideStr(v);
              }}
              helperText=" "
              sx={{ flex: 1, minWidth: 180 }}
            />
          )}
        </Box>
      )}

      <TextField
        size="small"
        label="Instructions (optional)"
        value={instructions}
        onChange={(e) => setInstructions(e.target.value)}
        multiline
        minRows={1}
        maxRows={4}
        placeholder="Operator-facing notes for this step"
      />

      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 1,
          flexWrap: 'wrap',
        }}
      >
        <Typography
          variant="caption"
          sx={{ color: atLeastOneError ? 'error.main' : 'text.secondary' }}
        >
          {isExternal
            ? 'Enter a unit price, a setup cost, or both.'
            : 'Enter a cycle time, a setup time, or both.'}
        </Typography>
        <Box sx={{ display: 'flex', gap: 1 }}>
          <Button size="small" onClick={onCancel}>
            Cancel
          </Button>
          <Button size="small" variant="contained" onClick={handleSave}>
            {isEdit ? 'Save changes' : 'Add to routing'}
          </Button>
        </Box>
      </Box>
    </Box>
  );
}
