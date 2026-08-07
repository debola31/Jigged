'use client';

import { useState } from 'react';
import posthog from 'posthog-js';
import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import TextField from '@mui/material/TextField';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import ErrorAlert from '@/components/common/ErrorAlert';
import CircularProgress from '@mui/material/CircularProgress';
import Grid from '@mui/material/Grid';
import Stack from '@mui/material/Stack';
import Switch from '@mui/material/Switch';
import FormControlLabel from '@mui/material/FormControlLabel';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import BuildIcon from '@mui/icons-material/Build';
import LocalMallIcon from '@mui/icons-material/LocalMall';

import SaveStatus, { type SaveState } from '@/components/common/SaveStatus';
import type { Part, PartFormData } from '@/types/part';
import { EMPTY_PART_FORM, partToFormData } from '@/types/part';
import { createPart, updatePart, checkPartNameExists } from '@/utils/partsAccess';
import VendorAutocomplete from '@/components/vendors/VendorAutocomplete';
import UnitOfMeasurementSelect from '@/components/parts/UnitOfMeasurementSelect';
import { highContrastToggleSx } from '@/lib/highContrastToggleSx';
import { parseOptionalNumber } from '@/lib/validators';

interface PartIdentitySectionProps {
  mode: 'create' | 'existing';
  companyId: string;
  /** Existing-mode: the part being edited (auto-save on change/blur). */
  part?: Part;
  /** Create-mode: seed defaults (e.g. from ?source=bought&stocked=1). */
  initialDefaults?: Partial<PartFormData>;
  /** Create-mode: called with the new part so the workspace can redirect. */
  onCreated?: (created: Part) => void;
  /** Existing-mode: called after an auto-save so the parent can refresh. */
  onSaved?: (updated: Part) => void;
}

/**
 * The part identity surface, shared by both the create flow (/parts/new) and
 * the live workspace (/parts/[partId]) so the create view IS the saved view.
 *
 * - create mode: name + classification + unit (+ vendor/reorder) gate the row;
 *   a "Create part" button validates and creates, then hands the new part back
 *   to the workspace to redirect into the live page.
 * - existing mode: the same fields auto-save (text on blur, toggles/selects on
 *   change) via updatePart — replacing the old /edit route. A small status
 *   indicator confirms the save.
 *
 * Validation mirrors the retired PartForm: name required + unique (excluding
 * self on edit), unit required (DB CHECK parts_requires_unit), reorder >= 0.
 */
export default function PartIdentitySection({
  mode,
  companyId,
  part,
  initialDefaults,
  onCreated,
  onSaved,
}: PartIdentitySectionProps) {
  const [formData, setFormData] = useState<PartFormData>(
    mode === 'existing' && part ? partToFormData(part) : { ...EMPTY_PART_FORM, ...initialDefaults },
  );
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  // Holds the caught error itself, not a pre-formatted string — ErrorAlert needs the object to
  // tell a billing block from an ordinary failure.
  const [error, setError] = useState<unknown>(null);
  const [creating, setCreating] = useState(false);
  const [saveStatus, setSaveStatus] = useState<SaveState>('idle');

  const showReorder = formData.is_stocked;
  // Preferred vendor lives on the Cost card (PartProcurementPricingPanel) for an
  // existing bought part — so we only surface it here in the CREATE flow, where
  // the Cost card doesn't exist yet. This avoids the two-controls-for-one-value
  // duplication on the live part page.
  const showVendor = formData.source === 'bought' && mode === 'create';

  const collectErrors = async (data: PartFormData): Promise<Record<string, string>> => {
    const errors: Record<string, string> = {};
    const name = data.part_name.trim();
    if (!name) {
      errors.part_name = 'Part name is required';
    } else {
      try {
        const exists = await checkPartNameExists(
          companyId,
          name,
          mode === 'existing' ? part?.id : undefined,
        );
        if (exists) errors.part_name = 'A part with this name already exists';
      } catch {
        errors.part_name = 'Could not validate the name — try again';
      }
    }
    if (!data.primary_unit?.trim()) errors.primary_unit = 'Unit of measurement is required';
    if (data.reorder_point !== null && data.reorder_point < 0) {
      errors.reorder_point = 'Reorder point cannot be negative';
    }
    return errors;
  };

  // Existing-mode auto-save: validate then updatePart with the given snapshot.
  const persist = async (next: PartFormData) => {
    if (mode !== 'existing' || !part) return;
    const errors = await collectErrors(next);
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) {
      setSaveStatus('error');
      return;
    }
    setSaveStatus('saving');
    setError(null);
    try {
      const updated = await updatePart(part.id, {
        ...next,
        part_name: next.part_name.trim(),
        primary_unit: next.primary_unit?.trim() || null,
      });
      setSaveStatus('saved');
      onSaved?.(updated);
    } catch (err) {
      setSaveStatus('error');
      setError(err);
    }
  };

  // Discrete controls (toggle/switch/select/vendor) save immediately.
  const updateAndPersist = (patch: Partial<PartFormData>) => {
    const next = { ...formData, ...patch };
    setFormData(next);
    if (mode === 'existing') void persist(next);
  };

  // Text fields: change updates state only; blur persists (existing mode).
  const onTextChange =
    (field: 'part_name' | 'description') =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      const value = e.target.value;
      setFormData((prev) => ({ ...prev, [field]: value }));
      if (fieldErrors[field]) setFieldErrors((p) => ({ ...p, [field]: '' }));
      if (saveStatus === 'saved') setSaveStatus('idle');
    };

  const onReorderChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const parsed = parseOptionalNumber(e.target.value);
    setFormData((prev) => ({ ...prev, reorder_point: parsed }));
    if (fieldErrors.reorder_point) setFieldErrors((p) => ({ ...p, reorder_point: '' }));
    if (saveStatus === 'saved') setSaveStatus('idle');
  };

  const handleBlur = () => {
    if (mode === 'existing') void persist(formData);
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setError(null);
    const errors = await collectErrors(formData);
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) return;
    setCreating(true);
    try {
      const created = await createPart(companyId, {
        ...formData,
        part_name: formData.part_name.trim(),
        primary_unit: formData.primary_unit?.trim() || null,
      });
      // Captured here rather than in the workspace shell: this is the only place that
      // calls createPart, so it's the one point where "a part was created" is true.
      // Properties are the shape choices that drive later journeys (a stocked bought
      // part implies inventory + procurement; a made part implies a routing) — never
      // the part name, which is customer-identifying.
      posthog.capture('part_created', {
        source: formData.source,
        is_stocked: formData.is_stocked,
        has_reorder_point: formData.reorder_point !== null,
        has_preferred_vendor: formData.preferred_vendor_id !== null,
      });
      onCreated?.(created);
    } catch (err) {
      setError(err);
      setCreating(false);
    }
  };

  const busy = creating || saveStatus === 'saving';

  const fields = (
    <>
      {/* Classification: Made/Bought + Stocked. Drives the fields below. */}
      <Box sx={{ mb: 3 }}>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5, fontWeight: 500 }}>
          Classification
        </Typography>
        <Stack
          direction={{ xs: 'column', sm: 'row' }}
          spacing={2}
          alignItems={{ xs: 'flex-start', sm: 'center' }}
        >
          <ToggleButtonGroup
            value={formData.source}
            exclusive
            onChange={(_e, next: 'made' | 'bought' | null) => {
              if (next === null) return;
              updateAndPersist({
                source: next,
                preferred_vendor_id: next === 'made' ? null : formData.preferred_vendor_id,
              });
            }}
            disabled={busy}
            aria-label="Source"
            color="primary"
            sx={highContrastToggleSx}
          >
            <ToggleButton value="made" aria-label="Made in-house">
              <BuildIcon fontSize="small" sx={{ mr: 1 }} />
              Made
            </ToggleButton>
            <ToggleButton value="bought" aria-label="Bought from vendor">
              <LocalMallIcon fontSize="small" sx={{ mr: 1 }} />
              Bought
            </ToggleButton>
          </ToggleButtonGroup>

          <FormControlLabel
            control={
              <Switch
                checked={formData.is_stocked}
                onChange={(_e, checked) => updateAndPersist({ is_stocked: checked })}
                disabled={busy}
                color="primary"
              />
            }
            label="Stocked"
          />
        </Stack>
      </Box>

      <Grid container spacing={3}>
        <Grid size={{ xs: 12, sm: 6 }}>
          <TextField
            fullWidth
            required
            label="Part Name"
            value={formData.part_name}
            onChange={onTextChange('part_name')}
            onBlur={handleBlur}
            error={!!fieldErrors.part_name}
            helperText={fieldErrors.part_name || ' '}
            disabled={busy}
          />
        </Grid>
        <Grid size={{ xs: 12, sm: 6 }}>
          <UnitOfMeasurementSelect
            value={formData.primary_unit}
            onChange={(next) => updateAndPersist({ primary_unit: next })}
            companyId={companyId}
            required
            disabled={busy}
            error={!!fieldErrors.primary_unit}
            helperText={fieldErrors.primary_unit || ' '}
          />
        </Grid>
        <Grid size={{ xs: 12 }}>
          <TextField
            fullWidth
            label="Description"
            value={formData.description}
            onChange={onTextChange('description')}
            onBlur={handleBlur}
            disabled={busy}
            multiline
            rows={2}
            placeholder="Brief description of this part"
          />
        </Grid>
        {showReorder && (
          <Grid size={{ xs: 12, sm: 6 }}>
            <TextField
              fullWidth
              label="Reorder Point"
              type="number"
              value={formData.reorder_point ?? ''}
              onChange={onReorderChange}
              onBlur={handleBlur}
              error={!!fieldErrors.reorder_point}
              helperText={fieldErrors.reorder_point || 'Optional. Triggers low-stock alerts.'}
              disabled={busy}
              InputLabelProps={{ shrink: true }}
              inputProps={{ min: 0, step: 'any', inputMode: 'decimal' }}
            />
          </Grid>
        )}
        {showVendor && (
          <Grid size={{ xs: 12, sm: 6 }}>
            <VendorAutocomplete
              companyId={companyId}
              valueId={formData.preferred_vendor_id}
              onChange={(vendor) => updateAndPersist({ preferred_vendor_id: vendor ? vendor.id : null })}
              disabled={busy}
              label="Preferred Vendor"
              helperText="Optional. The default supplier for this part."
            />
          </Grid>
        )}
      </Grid>
    </>
  );

  return (
    <Card elevation={2} sx={{ mb: mode === 'existing' ? 3 : 0 }}>
      <CardContent>
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 2 }}>
          <Typography variant="h6" sx={{ fontWeight: 600 }}>
            {mode === 'create' ? 'New part' : 'Part details'}
          </Typography>
          {mode === 'existing' && <SaveStatus state={saveStatus} />}
        </Box>

        {error != null && (
          <ErrorAlert
            error={error}
            entity="part"
            fallback="Couldn't save this part. Please try again."
            sx={{ mb: 3 }}
          />
        )}

        {mode === 'create' ? (
          <Box component="form" onSubmit={handleCreate}>
            {fields}
            <Box sx={{ display: 'flex', justifyContent: 'flex-end', mt: 3 }}>
              <Button
                type="submit"
                variant="contained"
                disabled={creating || !formData.part_name.trim()}
                startIcon={creating ? <CircularProgress size={16} color="inherit" /> : null}
              >
                {creating ? 'Creating…' : 'Create part'}
              </Button>
            </Box>
          </Box>
        ) : (
          fields
        )}
      </CardContent>
    </Card>
  );
}
