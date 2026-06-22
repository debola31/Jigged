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
import type { WorkCenterKind } from '@/types/workCenter';
import { parseOptionalNumber, numberToInputString } from '@/lib/validators';

/**
 * Picker option shape supplied to the editor — matches the shape returned by
 * `getWorkCentersForRouting` (work_center + flattened vendor name).
 */
export interface WorkCenterOption {
  id: string;
  name: string;
  kind: WorkCenterKind;
  labor_rate: number | null;
  vendor_name: string | null;
}

export interface OperationEditorValue {
  workCenter: WorkCenterOption | null;
  /** Internal: setup minutes per batch. */
  setupMinutes: number | null;
  /** Internal: cycle minutes per unit. */
  cycleMinutesPerUnit: number | null;
  /** Internal: optional override for the work center's labor rate ($/hr). */
  laborRateOverride: number | null;
  /** External: per-unit price ($). */
  externalUnitPrice: number | null;
  /** External: flat per-batch setup cost ($). */
  externalSetupCost: number | null;
  instructions: string | null;
}

interface RoutingOperationRowEditorProps {
  workCenters: WorkCenterOption[];
  /** When provided, the editor is in edit mode (work center picker is locked). */
  initial?: OperationEditorValue;
  onSave: (value: OperationEditorValue) => void;
  onCancel: () => void;
  /** Sequence number to render at the left, matching display row layout (1-based, optional). */
  index?: number;
}

const numToStr = numberToInputString;

export default function RoutingOperationRowEditor({
  workCenters,
  initial,
  onSave,
  onCancel,
  index,
}: RoutingOperationRowEditorProps) {
  const isEdit = !!initial;
  const [workCenter, setWorkCenter] = useState<WorkCenterOption | null>(
    initial?.workCenter ?? null,
  );
  const [setupStr, setSetupStr] = useState(numToStr(initial?.setupMinutes));
  const [cycleStr, setCycleStr] = useState(numToStr(initial?.cycleMinutesPerUnit));
  const [laborOverrideStr, setLaborOverrideStr] = useState(
    numToStr(initial?.laborRateOverride),
  );
  const [externalUnitPriceStr, setExternalUnitPriceStr] = useState(
    numToStr(initial?.externalUnitPrice),
  );
  const [externalSetupCostStr, setExternalSetupCostStr] = useState(
    numToStr(initial?.externalSetupCost),
  );
  const [instructions, setInstructions] = useState(initial?.instructions ?? '');
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    setWorkCenter(initial?.workCenter ?? null);
    setSetupStr(numToStr(initial?.setupMinutes));
    setCycleStr(numToStr(initial?.cycleMinutesPerUnit));
    setLaborOverrideStr(numToStr(initial?.laborRateOverride));
    setExternalUnitPriceStr(numToStr(initial?.externalUnitPrice));
    setExternalSetupCostStr(numToStr(initial?.externalSetupCost));
    setInstructions(initial?.instructions ?? '');
    setTouched(false);
  }, [initial]);

  // Add-mode only: when the user picks a work center, pre-populate the
  // labor-rate field with the work center's default rate. Editing the
  // field then becomes an "override for this operation"; leaving the
  // populated value alone saves no override (handleSave compares against
  // the work center rate before writing). Edit mode keeps the existing
  // override value untouched — switching work centers isn't allowed in
  // edit mode anyway.
  useEffect(() => {
    if (isEdit) return;
    if (workCenter && workCenter.kind === 'internal' && workCenter.labor_rate !== null) {
      setLaborOverrideStr(String(workCenter.labor_rate));
    } else {
      setLaborOverrideStr('');
    }
  }, [workCenter, isEdit]);

  const isExternal = workCenter?.kind === 'external';

  const wcError = touched && !workCenter;

  const setupParsed = parseOptionalNumber(setupStr);
  const cycleParsed = parseOptionalNumber(cycleStr);
  const setupError =
    touched && setupStr !== '' && (setupParsed === null || setupParsed < 0);
  const cycleError =
    touched && cycleStr !== '' && (cycleParsed === null || cycleParsed < 0);

  const externalUnitPriceParsed = parseOptionalNumber(externalUnitPriceStr);
  const externalSetupCostParsed = parseOptionalNumber(externalSetupCostStr);
  const extUnitPriceError =
    touched &&
    externalUnitPriceStr !== '' &&
    (externalUnitPriceParsed === null || externalUnitPriceParsed < 0);
  const extSetupCostError =
    touched &&
    externalSetupCostStr !== '' &&
    (externalSetupCostParsed === null || externalSetupCostParsed < 0);

  const internalHasAny =
    (setupParsed !== null && setupParsed > 0) || (cycleParsed !== null && cycleParsed > 0);
  const externalHasAny =
    (externalUnitPriceParsed !== null && externalUnitPriceParsed > 0) ||
    (externalSetupCostParsed !== null && externalSetupCostParsed > 0);
  const hasAnyValue = isExternal ? externalHasAny : internalHasAny;
  const atLeastOneError = touched && !hasAnyValue;

  const handleSave = () => {
    setTouched(true);
    if (!workCenter) return;
    if (isExternal) {
      if (extUnitPriceError || extSetupCostError || !externalHasAny) return;
      onSave({
        workCenter,
        setupMinutes: null,
        cycleMinutesPerUnit: null,
        laborRateOverride: null,
        externalUnitPrice: externalUnitPriceParsed,
        externalSetupCost: externalSetupCostParsed,
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
        externalSetupCost: null,
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
            options={workCenters}
            getOptionLabel={(wc) =>
              wc.vendor_name ? `${wc.name} (${wc.vendor_name})` : wc.name
            }
            value={workCenter}
            onChange={(_, newValue) => setWorkCenter(newValue)}
            isOptionEqualToValue={(option, value) => option.id === value.id}
            disabled={isEdit}
            renderOption={(props, option) => (
              <li {...props} key={option.id}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, width: '100%' }}>
                  <Typography variant="body2" sx={{ flex: 1, minWidth: 0 }}>
                    {option.name}
                  </Typography>
                  <Chip
                    label={option.kind}
                    size="small"
                    variant="outlined"
                    color={option.kind === 'external' ? 'secondary' : 'default'}
                    sx={{ height: 18, fontSize: '0.7rem' }}
                  />
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
                label="Work center"
                placeholder="Pick a work center…"
                error={wcError}
                helperText={
                  wcError
                    ? 'Pick a work center to continue.'
                    : isEdit
                    ? 'Work center cannot be changed (delete and re-add to swap).'
                    : ' '
                }
              />
            )}
          />
        </Box>
      </Box>

      {isExternal ? (
        <Box sx={{ display: 'flex', gap: 1.5, flexWrap: 'wrap' }}>
          <TextField
            size="small"
            label="Vendor unit price ($)"
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
                : 'Charged for every unit produced.'
            }
            sx={{ flex: 1, minWidth: 180 }}
          />
          <TextField
            size="small"
            label="Vendor setup cost ($)"
            type="text"
            inputMode="decimal"
            value={externalSetupCostStr}
            onChange={(e) => {
              const v = e.target.value;
              if (v === '' || /^\d*\.?\d*$/.test(v)) setExternalSetupCostStr(v);
            }}
            error={!!extSetupCostError}
            helperText={
              extSetupCostError
                ? 'Enter a non-negative number.'
                : 'One-time cost per batch.'
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
            helperText={
              cycleError ? 'Enter a non-negative number.' : 'Repeated for every unit produced.'
            }
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
            helperText={
              setupError ? 'Enter a non-negative number.' : 'One-time setup/changeover per batch.'
            }
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
              placeholder="optional"
              helperText={
                workCenter.labor_rate !== null
                  ? `Defaults to ${workCenter.name}'s rate ($${workCenter.labor_rate}/hr). Change to override for this operation.`
                  : `${workCenter.name} has no default rate set. Enter a rate for this operation.`
              }
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
