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
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import IconButton from '@mui/material/IconButton';
import Snackbar from '@mui/material/Snackbar';
import AddIcon from '@mui/icons-material/Add';
import DeleteIcon from '@mui/icons-material/Delete';
import type { Part, PartFormData } from '@/types/part';
import { validatePricingTiers } from '@/types/part';
import { createPart, updatePart, deletePart, checkPartNumberExists } from '@/utils/partsAccess';

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
  const [pricingWarnings, setPricingWarnings] = useState<string[]>([]);
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
      // Clear field error when user starts typing
      if (fieldErrors[field]) {
        setFieldErrors((prev) => ({ ...prev, [field]: '' }));
      }
    };

  // Pricing tier handlers
  const handleAddTier = () => {
    const maxQty = formData.pricing.length > 0 ? Math.max(...formData.pricing.map((t) => t.qty)) : 0;
    setFormData((prev) => ({
      ...prev,
      pricing: [...prev.pricing, { qty: maxQty + 10, price: 0 }],
    }));
  };

  const handleRemoveTier = (index: number) => {
    // Cannot remove if only one tier
    if (formData.pricing.length <= 1) return;
    setFormData((prev) => ({
      ...prev,
      pricing: prev.pricing.filter((_, i) => i !== index),
    }));
  };

  const handleTierChange = (index: number, field: 'qty' | 'price', value: string) => {
    const numValue = field === 'qty' ? parseInt(value) || 0 : parseFloat(value) || 0;
    setFormData((prev) => ({
      ...prev,
      pricing: prev.pricing.map((tier, i) => (i === index ? { ...tier, [field]: numValue } : tier)),
    }));
  };

  const validateForm = async (): Promise<boolean> => {
    const errors: Record<string, string> = {};

    // Part number required
    if (!formData.part_number.trim()) {
      errors.part_number = 'Part number is required';
    }

    // Check uniqueness of part number
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

    // Validate pricing tiers
    const { errors: pricingErrors, warnings } = validatePricingTiers(formData.pricing);
    if (pricingErrors.length > 0) {
      errors.pricing = pricingErrors.join('; ');
    }
    setPricingWarnings(warnings);

    setFieldErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    e.stopPropagation(); // Prevent bubbling to parent forms (e.g., QuoteForm)
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
      // Show snackbar with error message
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

      {/* Pricing Tiers */}
      <Card elevation={2} sx={{ mb: 3 }}>
        <CardContent>
          <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2 }}>
            <Typography variant="h6" sx={{ fontWeight: 600 }}>
              Pricing Tiers
            </Typography>
            <Button startIcon={<AddIcon />} onClick={handleAddTier} disabled={loading} size="small">
              Add Tier
            </Button>
          </Box>

          {fieldErrors.pricing && (
            <Alert severity="error" sx={{ mb: 2 }}>
              {fieldErrors.pricing}
            </Alert>
          )}

          {pricingWarnings.length > 0 && (
            <Alert severity="warning" sx={{ mb: 2 }}>
              {pricingWarnings.join('; ')}
            </Alert>
          )}

          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell sx={{ fontWeight: 600 }}>Min Quantity</TableCell>
                <TableCell sx={{ fontWeight: 600 }}>Unit Price ($)</TableCell>
                <TableCell width={60}></TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {formData.pricing.map((tier, index) => (
                <TableRow key={index}>
                  <TableCell>
                    <TextField
                      type="number"
                      size="small"
                      value={tier.qty || ''}
                      onChange={(e) => handleTierChange(index, 'qty', e.target.value)}
                      disabled={loading}
                      inputProps={{ min: 1, step: 1 }}
                      sx={{ width: 120 }}
                    />
                  </TableCell>
                  <TableCell>
                    <TextField
                      type="number"
                      size="small"
                      value={tier.price || ''}
                      onChange={(e) => handleTierChange(index, 'price', e.target.value)}
                      disabled={loading}
                      inputProps={{ min: 0, step: 0.01 }}
                      sx={{ width: 140 }}
                    />
                  </TableCell>
                  <TableCell>
                    <IconButton
                      size="small"
                      onClick={() => handleRemoveTier(index)}
                      disabled={loading || formData.pricing.length <= 1}
                      color="error"
                    >
                      <DeleteIcon fontSize="small" />
                    </IconButton>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>

          {formData.pricing.length === 0 && (
            <Typography variant="body2" color="text.secondary" sx={{ textAlign: 'center', py: 2 }}>
              {`No pricing tiers defined. Click "Add Tier" to add one.`}
            </Typography>
          )}
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
