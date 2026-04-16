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
import Autocomplete, { createFilterOptions } from '@mui/material/Autocomplete';
import InputAdornment from '@mui/material/InputAdornment';
import type { Part, PartFormData } from '@/types/part';
import { createPart, updatePart, deletePart, checkPartNameExists } from '@/utils/partsAccess';
import { getPartCategoriesForSelect, createPartCategory } from '@/utils/partCategoriesAccess';

type CategoryOption = { id: string; name: string; default_markup_percent: number | null; isNew?: boolean };

const categoryFilter = createFilterOptions<CategoryOption>();

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
  const [pendingNewCategory, setPendingNewCategory] = useState<{ name: string; markup: string } | null>(null);
  const [markupDialogOpen, setMarkupDialogOpen] = useState(false);
  const [pendingCategoryName, setPendingCategoryName] = useState('');
  const [newCategoryMarkup, setNewCategoryMarkup] = useState('');
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

  const validateForm = async (): Promise<boolean> => {
    const errors: Record<string, string> = {};

    if (!formData.part_name.trim()) {
      errors.part_name = 'Part name is required';
    }

    if (formData.part_name.trim() && !errors.part_name) {
      try {
        const exists = await checkPartNameExists(
          companyId,
          formData.part_name,
          mode === 'edit' ? partId : undefined
        );
        if (exists) {
          errors.part_name = 'Part name already exists';
        }
      } catch {
        setError('Error validating part name');
        return false;
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
      // Create new category first if pending
      const submitData = { ...formData };
      if (pendingNewCategory) {
        const newCat = await createPartCategory(companyId, {
          name: pendingNewCategory.name,
          default_markup_percent: pendingNewCategory.markup,
          description: '',
        });
        submitData.category_id = newCat.id;
      }

      if (mode === 'create') {
        const newPart = await createPart(companyId, submitData);
        if (onSuccess) {
          onSuccess(newPart);
        } else {
          router.push(`/dashboard/${companyId}/parts/${newPart.id}`);
        }
      } else if (partId) {
        const updatedPart = await updatePart(partId, submitData);
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

  const canDelete = !part || ((part.quotes_count ?? 0) === 0 && (part.jobs_count ?? 0) === 0);

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
                label="Part Name"
                value={formData.part_name}
                onChange={handleChange('part_name')}
                error={!!fieldErrors.part_name}
                helperText={fieldErrors.part_name || 'Name for this part (must be unique)'}
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
          <Autocomplete<CategoryOption, false, false, true>
            freeSolo
            selectOnFocus
            clearOnBlur
            handleHomeEndKeys
            options={categories}
            getOptionLabel={(option) => {
              if (typeof option === 'string') return option;
              if (option.isNew) return `Add "${option.name}"`;
              const markup = option.default_markup_percent !== null ? ` (${option.default_markup_percent}% markup)` : '';
              return `${option.name}${markup}`;
            }}
            value={
              pendingNewCategory
                ? { id: '', name: pendingNewCategory.name, default_markup_percent: pendingNewCategory.markup ? parseFloat(pendingNewCategory.markup) : null, isNew: true }
                : categories.find((c) => c.id === formData.category_id) || null
            }
            onChange={(_, newValue) => {
              if (typeof newValue === 'string') {
                // User typed and pressed Enter
                setPendingCategoryName(newValue);
                setNewCategoryMarkup('');
                setMarkupDialogOpen(true);
              } else if (newValue && newValue.isNew) {
                // User selected "Add ..." option
                setPendingCategoryName(newValue.name);
                setNewCategoryMarkup('');
                setMarkupDialogOpen(true);
              } else if (newValue) {
                // Selected existing category
                setFormData((prev) => ({ ...prev, category_id: newValue.id }));
                setPendingNewCategory(null);
              } else {
                // Cleared
                setFormData((prev) => ({ ...prev, category_id: '' }));
                setPendingNewCategory(null);
              }
            }}
            filterOptions={(options, params) => {
              const filtered = categoryFilter(options, params);
              const { inputValue } = params;
              const isExisting = options.some((option) => option.name.toLowerCase() === inputValue.toLowerCase());
              if (inputValue !== '' && !isExisting) {
                filtered.push({ id: '', name: inputValue, default_markup_percent: null, isNew: true });
              }
              return filtered;
            }}
            isOptionEqualToValue={(option, value) => option.id === value.id}
            renderInput={(params) => (
              <TextField
                {...params}
                label="Part Category"
                placeholder="Select or type a new category"
                helperText={
                  pendingNewCategory
                    ? `New category "${pendingNewCategory.name}" will be created${pendingNewCategory.markup ? ` with ${pendingNewCategory.markup}% markup` : ''}`
                    : 'Optional — categories set default markup for quoting'
                }
                disabled={loading}
              />
            )}
            disabled={loading}
          />
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

      {/* New Category Markup Dialog */}
      <Dialog open={markupDialogOpen} onClose={() => setMarkupDialogOpen(false)} maxWidth="xs" fullWidth>
        <DialogTitle>New Category: {pendingCategoryName}</DialogTitle>
        <DialogContent>
          <Typography variant="body2" sx={{ mb: 2 }}>
            Set a default markup percentage for this category. This will be used when creating quotes.
          </Typography>
          <TextField
            autoFocus
            fullWidth
            label="Default Markup"
            type="number"
            value={newCategoryMarkup}
            onChange={(e) => setNewCategoryMarkup(e.target.value)}
            slotProps={{
              input: {
                endAdornment: <InputAdornment position="end">%</InputAdornment>,
              },
              htmlInput: { min: -100, max: 1000, step: 0.5 },
            }}
            helperText="Optional — e.g. 25 for 25% markup"
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setMarkupDialogOpen(false)}>Cancel</Button>
          <Button
            variant="contained"
            onClick={() => {
              setPendingNewCategory({ name: pendingCategoryName, markup: newCategoryMarkup });
              setFormData((prev) => ({ ...prev, category_id: '' }));
              setMarkupDialogOpen(false);
            }}
          >
            Confirm
          </Button>
        </DialogActions>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <Dialog open={deleteDialogOpen} onClose={() => setDeleteDialogOpen(false)}>
        <DialogTitle>Delete Part?</DialogTitle>
        <DialogContent>
          <Typography sx={{ mb: 2 }}>
            {`Are you sure you want to delete "${formData.part_name}"?`}
          </Typography>
          {part && ((part.quotes_count ?? 0) > 0 || (part.jobs_count ?? 0) > 0) && (
            <Alert severity="error">
              This part has {part.quotes_count ?? 0} quote{(part.quotes_count ?? 0) !== 1 ? 's' : ''} and{' '}
              {part.jobs_count ?? 0} job{(part.jobs_count ?? 0) !== 1 ? 's' : ''}. You must remove these
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
