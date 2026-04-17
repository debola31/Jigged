'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Typography from '@mui/material/Typography';
import TextField from '@mui/material/TextField';
import Button from '@mui/material/Button';
import Grid from '@mui/material/Grid';
import Alert from '@mui/material/Alert';
import InputAdornment from '@mui/material/InputAdornment';
import CircularProgress from '@mui/material/CircularProgress';
import {
  createOperation,
  updateOperation,
  deleteOperation,
  checkOperationNameExists,
  getOperationWithRelations,
} from '@/utils/operationsAccess';
import type { OperationFormData } from '@/types/operations';

interface OperationFormProps {
  companyId: string;
  operationId?: string;
  initialData: OperationFormData;
  onCancel: () => void;
  onSaved: (operationId: string) => void;
}

export default function OperationForm({
  companyId,
  operationId,
  initialData,
  onCancel,
  onSaved,
}: OperationFormProps) {
  const router = useRouter();
  const isEdit = !!operationId;

  const [formData, setFormData] = useState<OperationFormData>(initialData);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleChange =
    (field: keyof OperationFormData) => (e: React.ChangeEvent<HTMLInputElement>) => {
      setFormData((prev) => ({ ...prev, [field]: e.target.value }));
      if (fieldErrors[field]) {
        setFieldErrors((prev) => ({ ...prev, [field]: '' }));
      }
    };

  const validate = async (): Promise<boolean> => {
    const errors: Record<string, string> = {};

    if (!formData.name.trim()) {
      errors.name = 'Name is required';
    } else {
      const exists = await checkOperationNameExists(
        companyId,
        formData.name.trim(),
        operationId
      );
      if (exists) {
        errors.name = 'An operation with this name already exists';
      }
    }

    if (formData.labor_rate) {
      const rate = parseFloat(formData.labor_rate);
      if (isNaN(rate)) {
        errors.labor_rate = 'Invalid number';
      } else if (rate < 0) {
        errors.labor_rate = 'Rate cannot be negative';
      }
    }

    setFieldErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    const isValid = await validate();
    if (!isValid) return;

    setLoading(true);

    try {
      let savedId: string;
      if (isEdit && operationId) {
        const updated = await updateOperation(operationId, formData);
        savedId = updated.id;
      } else {
        const created = await createOperation(companyId, formData);
        savedId = created.id;
      }
      onSaved(savedId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save operation');
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async () => {
    if (!operationId) return;

    const operationWithRelations = await getOperationWithRelations(operationId);
    if (operationWithRelations && operationWithRelations.routing_operations_count > 0) {
      setError(
        `Cannot delete: This operation is used in ${operationWithRelations.routing_operations_count} routing operation(s).`
      );
      return;
    }

    if (!confirm('Are you sure you want to delete this operation?')) return;

    setLoading(true);
    try {
      await deleteOperation(operationId);
      router.push(`/dashboard/${companyId}/operations`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete operation');
      setLoading(false);
    }
  };

  return (
    <Box component="form" onSubmit={handleSubmit}>
      {error && (
        <Alert severity="error" sx={{ mb: 3 }} onClose={() => setError(null)}>
          {error}
        </Alert>
      )}

      <Card elevation={2} sx={{ mb: 3 }}>
        <CardContent>
          <Typography variant="h6" sx={{ fontWeight: 600, mb: 3 }}>
            Basic Information
          </Typography>
          <Grid container spacing={3}>
            <Grid size={{ xs: 12, sm: 6 }}>
              <TextField
                label="Name"
                value={formData.name}
                onChange={handleChange('name')}
                required
                fullWidth
                disabled={loading}
                error={!!fieldErrors.name}
                helperText={fieldErrors.name || 'e.g., HURCO Mill, Mazak Lathe'}
              />
            </Grid>
            <Grid size={{ xs: 12, sm: 6 }}>
              <TextField
                label="Labor Rate"
                value={formData.labor_rate}
                onChange={handleChange('labor_rate')}
                fullWidth
                disabled={loading}
                error={!!fieldErrors.labor_rate}
                helperText={fieldErrors.labor_rate || 'Hourly rate in dollars'}
                slotProps={{
                  input: {
                    startAdornment: <InputAdornment position="start">$</InputAdornment>,
                    endAdornment: <InputAdornment position="end">/hr</InputAdornment>,
                  },
                }}
              />
            </Grid>
          </Grid>
        </CardContent>
      </Card>

      <Card elevation={2} sx={{ mb: 3 }}>
        <CardContent>
          <Typography variant="h6" sx={{ fontWeight: 600, mb: 3 }}>
            Description
          </Typography>
          <TextField
            label="Description"
            value={formData.description}
            onChange={handleChange('description')}
            fullWidth
            multiline
            rows={3}
            disabled={loading}
            helperText="Additional notes about this operation"
          />
        </CardContent>
      </Card>

      <Box sx={{ display: 'flex', gap: 2, justifyContent: 'flex-end' }}>
        {isEdit && (
          <Button variant="outlined" color="error" onClick={handleDelete} disabled={loading}>
            Delete
          </Button>
        )}
        <Box flex={1} />
        <Button variant="outlined" onClick={onCancel} disabled={loading}>
          Cancel
        </Button>
        <Button
          type="submit"
          variant="contained"
          disabled={loading}
          startIcon={loading ? <CircularProgress size={16} /> : null}
        >
          {loading ? 'Saving...' : isEdit ? 'Save Changes' : 'Create Operation'}
        </Button>
      </Box>
    </Box>
  );
}
