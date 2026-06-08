'use client';

import { useEffect, useMemo, useState } from 'react';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import IconButton from '@mui/material/IconButton';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import Alert from '@mui/material/Alert';
import CircularProgress from '@mui/material/CircularProgress';
import Stack from '@mui/material/Stack';
import Switch from '@mui/material/Switch';
import FormControlLabel from '@mui/material/FormControlLabel';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import CloseIcon from '@mui/icons-material/Close';
import BuildIcon from '@mui/icons-material/Build';
import LocalMallIcon from '@mui/icons-material/LocalMall';
import { EMPTY_PART_FORM } from '@/types/part';
import type { Part, PartFormData } from '@/types/part';
import type { Vendor } from '@/types/vendor';
import { createPart, checkPartNameExists } from '@/utils/partsAccess';
import VendorAutocomplete from '@/components/vendors/VendorAutocomplete';
import { highContrastToggleSx } from '@/lib/highContrastToggleSx';
import UnitOfMeasurementSelect from './UnitOfMeasurementSelect';
import MissingFieldsNotice from '@/components/common/MissingFieldsNotice';

interface PartFormModalProps {
  open: boolean;
  onClose: () => void;
  /**
   * Called once a new part has been created. Receives the resulting Part so
   * the caller (parts list, inventory list, quote builder) can route to the
   * detail page or pick the part into a parent form.
   */
  onCreated: (part: Part) => void;
  companyId: string;
  /**
   * Partial defaults merged into EMPTY_PART_FORM for the form's initial
   * state. The Parts page leaves this undefined (source='made' is already
   * the EMPTY default); the Inventory page passes
   * `{ source: 'bought', is_stocked: true }` so "Add Item" lands the user
   * on a stocked-bought starting point.
   */
  createDefaults?: Partial<PartFormData>;
}

/**
 * Minimal create-only part modal.
 *
 * Collects what's needed to land a row without violating any DB CHECKs:
 * Made-vs-Bought toggle, Stocked toggle, Part Name, Description, and
 * Unit of measurement (only when Stocked is on, since
 * parts_stocked_requires_unit forbids a stocked part with no unit).
 * Everything else (on-hand quantity, reorder point, procurement cost,
 * preferred vendor, unit conversions, BOM, routing) lives on the detail
 * page. List pages are finders, the detail page is the workspace.
 *
 * The earlier search-first flow (autocomplete suggesting existing parts to
 * edit) and the procurement/vendor sections were removed from this modal
 * deliberately. Editing an existing part happens from its detail page; the
 * trim keeps the modal a single-screen one-job surface.
 */
export default function PartFormModal({
  open,
  onClose,
  onCreated,
  companyId,
  createDefaults,
}: PartFormModalProps) {
  const baseCreate: PartFormData = useMemo(
    () => ({ ...EMPTY_PART_FORM, ...createDefaults }),
    [createDefaults],
  );

  const [formData, setFormData] = useState<PartFormData>(baseCreate);
  const [selectedVendor, setSelectedVendor] = useState<Vendor | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<{
    part_name?: string;
    primary_unit?: string;
  }>({});

  // Reset whenever the modal closes/reopens, or when defaults change (e.g.
  // user navigates from Parts to Inventory and reopens).
  useEffect(() => {
    if (open) {
      setFormData(baseCreate);
      setSelectedVendor(null);
      setError(null);
      setFieldErrors({});
    }
  }, [open, baseCreate]);

  const handleSourceChange = (_e: unknown, next: 'made' | 'bought' | null) => {
    if (next === null) return;
    setFormData((prev) => ({
      ...prev,
      source: next,
      // Preferred vendor is procurement-only — clear it when switching to
      // Made so the field doesn't carry a stale value into the new shape.
      preferred_vendor_id: next === 'made' ? null : prev.preferred_vendor_id,
    }));
    if (next === 'made') setSelectedVendor(null);
  };

  const handleStockedChange = (_e: unknown, checked: boolean) => {
    setFormData((prev) => ({ ...prev, is_stocked: checked }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setError(null);

    const errors: { part_name?: string; primary_unit?: string } = {};

    const trimmedName = formData.part_name.trim();
    if (!trimmedName) {
      errors.part_name = 'Part name is required';
    }

    // Mirror parts_requires_unit so the user sees an inline field error rather
    // than a Postgres exception bubbling up after the round-trip.
    if (!formData.primary_unit?.trim()) {
      errors.primary_unit = 'Unit of measurement is required';
    }

    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      return;
    }

    setSubmitting(true);
    try {
      const exists = await checkPartNameExists(companyId, trimmedName);
      if (exists) {
        setFieldErrors({ part_name: 'A part with this name already exists' });
        setSubmitting(false);
        return;
      }

      const payload: PartFormData = {
        ...formData,
        part_name: trimmedName,
        primary_unit: formData.primary_unit?.trim() ?? null,
      };

      const newPart = await createPart(companyId, payload);
      onCreated(newPart);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create part');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={submitting ? undefined : onClose}
      maxWidth="sm"
      fullWidth
      scroll="paper"
      PaperProps={{ sx: { maxHeight: '90vh' } }}
    >
      <DialogTitle
        sx={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          pb: 1,
        }}
      >
        Add Part
        <IconButton
          onClick={onClose}
          size="small"
          sx={{ color: 'text.secondary' }}
          disabled={submitting}
        >
          <CloseIcon />
        </IconButton>
      </DialogTitle>

      <Box component="form" onSubmit={handleSubmit}>
        <DialogContent sx={{ pt: 2 }}>
          {error && (
            <Alert severity="error" sx={{ mb: 3 }}>
              {error}
            </Alert>
          )}

          <Typography
            variant="body2"
            color="text.secondary"
            sx={{ mb: 1.5, fontWeight: 500 }}
          >
            Category
          </Typography>
          <Stack
            direction={{ xs: 'column', sm: 'row' }}
            spacing={2}
            alignItems={{ xs: 'flex-start', sm: 'center' }}
            sx={{ mb: 3 }}
          >
            <ToggleButtonGroup
              value={formData.source}
              exclusive
              onChange={handleSourceChange}
              disabled={submitting}
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
                  onChange={handleStockedChange}
                  disabled={submitting}
                  color="primary"
                />
              }
              label="Stocked"
            />
          </Stack>

          <TextField
            fullWidth
            required
            autoFocus
            label="Part Name"
            value={formData.part_name}
            onChange={(e) => {
              setFormData((prev) => ({ ...prev, part_name: e.target.value }));
              if (fieldErrors.part_name) {
                setFieldErrors((prev) => ({ ...prev, part_name: undefined }));
              }
            }}
            error={!!fieldErrors.part_name}
            helperText={fieldErrors.part_name || 'Must be unique within this company'}
            disabled={submitting}
            sx={{ mb: 3 }}
          />

          <TextField
            fullWidth
            label="Description"
            value={formData.description}
            onChange={(e) =>
              setFormData((prev) => ({ ...prev, description: e.target.value }))
            }
            disabled={submitting}
            multiline
            rows={2}
            placeholder="Brief description of this part"
            helperText="Optional"
            sx={{ mb: 3 }}
          />

          {/* Unit of measurement — required for every part (DB CHECK
              parts_requires_unit). Costs and quantities are denominated in
              this unit; without it, downstream BOM and cost rollups break. */}
          <UnitOfMeasurementSelect
            value={formData.primary_unit}
            onChange={(next) => {
              setFormData((prev) => ({ ...prev, primary_unit: next }));
              if (fieldErrors.primary_unit) {
                setFieldErrors((prev) => ({ ...prev, primary_unit: undefined }));
              }
            }}
            companyId={companyId}
            required
            disabled={submitting}
            error={!!fieldErrors.primary_unit}
            helperText={
              fieldErrors.primary_unit ||
              'How quantities of this part are measured (each, lbs, sq in, …).'
            }
          />

          {/* Preferred vendor — bought parts only. Optional; the user can
              also leave it blank and pick a vendor later from the part
              detail page. Made parts have no vendor concept, so the field
              hides entirely when source='made'. */}
          {formData.source === 'bought' && (
            <Box sx={{ mt: 3 }}>
              <VendorAutocomplete
                companyId={companyId}
                value={selectedVendor}
                onChange={(vendor) => {
                  setSelectedVendor(vendor);
                  setFormData((prev) => ({
                    ...prev,
                    preferred_vendor_id: vendor ? vendor.id : null,
                  }));
                }}
                disabled={submitting}
                label="Preferred vendor"
                helperText="Optional. The default supplier for this part."
              />
            </Box>
          )}
          <MissingFieldsNotice
            items={!formData.part_name.trim() ? ['Enter a part name'] : []}
          />
        </DialogContent>

        <DialogActions sx={{ px: 3, pb: 2.5 }}>
          <Button onClick={onClose} disabled={submitting} color="inherit">
            Cancel
          </Button>
          <Button
            type="submit"
            variant="contained"
            disabled={submitting || !formData.part_name.trim()}
            startIcon={submitting ? <CircularProgress size={16} color="inherit" /> : null}
          >
            {submitting ? 'Creating...' : 'Create'}
          </Button>
        </DialogActions>
      </Box>
    </Dialog>
  );
}
