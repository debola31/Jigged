'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import TextField from '@mui/material/TextField';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import Alert from '@mui/material/Alert';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import Grid from '@mui/material/Grid';
import Snackbar from '@mui/material/Snackbar';
import Autocomplete from '@mui/material/Autocomplete';
import InputAdornment from '@mui/material/InputAdornment';
import Chip from '@mui/material/Chip';
import type { Part, PartFormData } from '@/types/part';
import { createPart, updatePart, deletePart, checkPartNumberExists } from '@/utils/partsAccess';
import { getPartCategoriesForSelect } from '@/utils/partCategoriesAccess';

interface PartFormProps {
  mode: 'create' | 'edit';
  companyId: string;
  initialData: PartFormData;
  partId?: string;
  part?: Part; // Full Part with relations for delete dialog
  onSuccess?: (part?: Part) => void;
  onCancel?: () => void;
}

export default function PartForm({
  mode,
  companyId,
  initialData,
  partId,
  part,
  onSuccess,
  onCancel,
}: PartFormProps) {
  const router = useRouter();

  const [formData, setFormData] = useState<PartFormData>(initialData);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [categories, setCategories] = useState<Array<{ id: string; name: string; default_markup_percent: number | null }>>([]);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [snackbar, setSnackbar] = useState<{ open: boolean; message: string; severity: 'error' | 'success' }>({
    open: false,
    message: '',
    severity: 'error',
  });

  // Fetch categories for dropdown
  useEffect(() => {
    getPartCategoriesForSelect(companyId).then(setCategories).catch(console.error);
  }, [companyId]);

  const handleChange =
    (field: keyof PartFormData) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      setFormData((prev) => ({ ...prev, [field]: e.target.value }));
      if (fieldErrors[field]) {
        setFieldErrors((prev) => ({ ...prev, [field]: '' }));
      }
    };

  const hasRouting = part?.routing != null;

  const validateForm = async (): Promise<boolean> => {
    const errors: Record<string, string> = {};

    if (!formData.part_number.trim()) {
      errors.part_number = 'Part number is required';
    }

    if (formData.part_number.trim() && !errors.part_number) {
      try {
        const exists = await checkPartNumberExists(
          companyId,
          formData.part_number,
          mode === 'edit' ? partId : undefined
        );
        if (exists) {
          errors.part_number = 'Part number already exists';
        }
      } catch {
        setError('Error validating part number');
        return false;
      }
    }

    // Validate manual cost if provided
    if (formData.manual_cost.trim()) {
      const cost = parseFloat(formData.manual_cost);
      if (isNaN(cost) || cost < 0) {
        errors.manual_cost = 'Cost must be a positive number';
      }
    }

    setFieldErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setError(null);

    const isValid = await validateForm();
    if (!isValid) return;

    setLoading(true);

    try {
      if (mode === 'create') {
        const newPart = await createPart(companyId, formData);
        if (onSuccess) {
          onSuccess(newPart);
        } else {
          router.push(`/dashboard/${companyId}/parts/${newPart.id}`);
        }
      } else if (partId) {
        const updatedPart = await updatePart(partId, formData);
        if (onSuccess) {
          onSuccess(updatedPart);
        } else {
          router.push(`/dashboard/${companyId}/parts/${partId}`);
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async () => {
    if (!partId) return;

    setLoading(true);
    try {
      await deletePart(partId);
      if (onSuccess) {
        onSuccess();
      } else {
        router.push(`/dashboard/${companyId}/parts`);
      }
    } catch (err) {
      setSnackbar({
        open: true,
        message: err instanceof Error ? err.message : 'An error occurred',
        severity: 'error',
      });
      setDeleteDialogOpen(false);
    } finally {
      setLoading(false);
    }
  };

  const handleCancel = () => {
    if (onCancel) {
      onCancel();
    } else {
      router.push(`/dashboard/${companyId}/parts`);
    }
  };

  const canDelete = !part || (part.quotes_count === 0 && part.jobs_count === 0);

  return (
    <Box component="form" onSubmit={handleSubmit}>
      {error && (
        <Alert severity="error" sx={{ mb: 3 }}>
          {error}
        </Alert>
      )}

      {/* Basic Information */}
      <Card elevation={2} sx={{ mb: 3 }}>
        <CardContent>
          <Typography variant="h6" gutterBottom sx={{ fontWeight: 600, mb: 3 }}>
            Basic Information
          </Typography>
          <Grid container spacing={3}>
            <Grid size={{ xs: 12, sm: 6 }}>
              <TextField
                fullWidth
                required
                label="Part Number"
                value={formData.part_number}
                onChange={handleChange('part_number')}
                error={!!fieldErrors.part_number}
                helperText={fieldErrors.part_number || 'Unique identifier for this part'}
                disabled={loading}
              />
            </Grid>
            <Grid size={{ xs: 12 }}>
              <TextField
                fullWidth
                label="Description"
                value={formData.description}
                onChange={handleChange('description')}
                disabled={loading}
                multiline
                rows={2}
                placeholder="Brief description of this part"
              />
            </Grid>
          </Grid>
        </CardContent>
      </Card>

      {/* Category */}
      <Card elevation={2} sx={{ mb: 3 }}>
        <CardContent>
          <Typography variant="h6" gutterBottom sx={{ fontWeight: 600, mb: 3 }}>
            Category
          </Typography>
          <Autocomplete
            options={categories}
            getOptionLabel={(option) => {
              const markup = option.default_markup_percent !== null ? ` (${option.default_markup_percent}% markup)` : '';
              return `${option.name}${markup}`;
            }}
            value={categories.find((c) => c.id === formData.category_id) || null}
            onChange={(_, newValue) => {
              setFormData((prev) => ({ ...prev, category_id: newValue?.id || '' }));
            }}
            isOptionEqualToValue={(option, value) => option.id === value.id}
            renderInput={(params) => (
              <TextField
                {...params}
                label="Part Category"
                placeholder="Select a category"
                helperText="Optional — categories set default markup for quoting"
                disabled={loading}
              />
            )}
            disabled={loading}
          />
        </CardContent>
      </Card>

      {/* Cost Information */}
      <Card elevation={2} sx={{ mb: 3 }}>
        <CardContent>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mb: 3 }}>
            <Typography variant="h6" sx={{ fontWeight: 600 }}>
              Cost Information
            </Typography>
            {part?.cost_source && (
              <Chip
                label={part.cost_source === 'routing' ? 'From Routing' : part.cost_source === 'manual' ? 'Manual' : 'Estimate'}
                size="small"
                color={part.cost_source === 'routing' ? 'primary' : 'default'}
                variant="outlined"
              />
            )}
          </Box>
          <Grid container spacing={3}>
            <Grid size={{ xs: 12, sm: 6 }}>
              <TextField
                fullWidth
                label="Manual Estimate"
                type="number"
                value={formData.manual_cost}
                onChange={handleChange('manual_cost')}
                error={!!fieldErrors.manual_cost}
                helperText={
                  fieldErrors.manual_cost ||
                  (hasRouting
                    ? 'Manual cost takes priority over routing cost when set'
                    : 'Cost per unit for quoting')
                }
                disabled={loading}
                slotProps={{
                  input: {
                    startAdornment: <InputAdornment position="start">$</InputAdornment>,
                  },
                  htmlInput: { min: 0, step: 0.01 },
                }}
              />
            </Grid>
          </Grid>
        </CardContent>
      </Card>

      {/* Actions */}
      <Box sx={{ display: 'flex', gap: 2, justifyContent: 'flex-end' }}>
        {mode === 'edit' && (
          <Button
            variant="outlined"
            color="error"
            onClick={() => setDeleteDialogOpen(true)}
            disabled={loading}
          >
            Delete
          </Button>
        )}
        <Box sx={{ flex: 1 }} />
        <Button variant="outlined" onClick={handleCancel} disabled={loading}>
          Cancel
        </Button>
        <Button
          type="submit"
          variant="contained"
          disabled={loading}
          startIcon={loading ? <CircularProgress size={20} /> : null}
        >
          {loading ? 'Saving...' : 'Save'}
        </Button>
      </Box>

      {/* Delete Confirmation Dialog */}
      <Dialog open={deleteDialogOpen} onClose={() => setDeleteDialogOpen(false)}>
        <DialogTitle>Delete Part?</DialogTitle>
        <DialogContent>
          <Typography sx={{ mb: 2 }}>
            {`Are you sure you want to delete "${formData.part_number}"?`}
          </Typography>
          {part && (part.quotes_count! > 0 || part.jobs_count! > 0) && (
            <Alert severity="error">
              This part has {part.quotes_count} quote{part.quotes_count !== 1 ? 's' : ''} and{' '}
              {part.jobs_count} job{part.jobs_count !== 1 ? 's' : ''}. You must remove these
              references before deleting.
            </Alert>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteDialogOpen(false)}>Cancel</Button>
          <Button onClick={handleDelete} color="error" variant="contained" disabled={!canDelete}>
            Delete
          </Button>
        </DialogActions>
      </Dialog>

      {/* Error Snackbar */}
      <Snackbar
        open={snackbar.open}
        autoHideDuration={6000}
        onClose={() => setSnackbar((prev) => ({ ...prev, open: false }))}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert
          onClose={() => setSnackbar((prev) => ({ ...prev, open: false }))}
          severity={snackbar.severity}
          sx={{ width: '100%' }}
        >
          {snackbar.message}
        </Alert>
      </Snackbar>
    </Box>
  );
}
