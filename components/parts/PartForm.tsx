'use client';

import { useState } from 'react';
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
import type { Part, PartFormData } from '@/types/part';
import { createPart, updatePart, deletePart, checkPartNameExists } from '@/utils/partsAccess';

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
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [snackbar, setSnackbar] = useState<{ open: boolean; message: string; severity: 'error' | 'success' }>({
    open: false,
    message: '',
    severity: 'error',
  });

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
          mode === 'edit' ? partId : undefined,
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
      if (mode === 'create') {
        const newPart = await createPart(companyId, formData);
        if (onSuccess) onSuccess(newPart);
        else router.push(`/dashboard/${companyId}/parts/${newPart.id}`);
      } else if (partId) {
        const updatedPart = await updatePart(partId, formData);
        if (onSuccess) onSuccess(updatedPart);
        else router.push(`/dashboard/${companyId}/parts/${partId}`);
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
      if (onSuccess) onSuccess();
      else router.push(`/dashboard/${companyId}/parts`);
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
    if (onCancel) onCancel();
    else router.push(`/dashboard/${companyId}/parts`);
  };

  const canDelete = !part || ((part.quotes_count ?? 0) === 0 && (part.jobs_count ?? 0) === 0);

  return (
    <Box component="form" onSubmit={handleSubmit}>
      {error && (
        <Alert severity="error" sx={{ mb: 3 }}>
          {error}
        </Alert>
      )}

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
