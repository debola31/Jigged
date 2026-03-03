'use client';

import { useState, useEffect } from 'react';
import { useRouter, useParams } from 'next/navigation';
import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import TextField from '@mui/material/TextField';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import CircularProgress from '@mui/material/CircularProgress';
import Alert from '@mui/material/Alert';
import Snackbar from '@mui/material/Snackbar';
import FormControl from '@mui/material/FormControl';
import InputLabel from '@mui/material/InputLabel';
import Select from '@mui/material/Select';
import MenuItem from '@mui/material/MenuItem';
import Divider from '@mui/material/Divider';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import DeleteIcon from '@mui/icons-material/Delete';
import ArrowForwardIcon from '@mui/icons-material/ArrowForward';
import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutline';

import {
  createJob,
  updateJob,
  deleteJob,
  getCustomersForSelect,
} from '@/utils/jobsAccess';
import { getPartsForSelect } from '@/utils/partsAccess';
import type { JobFormData } from '@/types/job';
import { EMPTY_JOB_FORM } from '@/types/job';

interface JobFormProps {
  mode: 'create' | 'edit';
  initialData?: JobFormData;
  jobId?: string;
  jobNumber?: string;
  onCancel?: () => void;
  onSave?: () => void;
}

export default function JobForm({
  mode,
  initialData = EMPTY_JOB_FORM,
  jobId,
  jobNumber,
  onCancel,
  onSave,
}: JobFormProps) {
  const router = useRouter();
  const params = useParams();
  const companyId = params.companyId as string;

  const [formData, setFormData] = useState<JobFormData>(initialData);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const [customers, setCustomers] = useState<Array<{ id: string; name: string }>>([]);
  const [parts, setParts] = useState<Array<{ id: string; part_number: string; description: string | null; has_routing: boolean }>>([]);
  const [loadingCustomers, setLoadingCustomers] = useState(true);
  const [loadingParts, setLoadingParts] = useState(true);

  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const [snackbar, setSnackbar] = useState<{ open: boolean; message: string; severity: 'error' | 'success' }>({
    open: false,
    message: '',
    severity: 'error',
  });

  // Fetch customers on mount
  useEffect(() => {
    const fetchCustomers = async () => {
      try {
        const data = await getCustomersForSelect(companyId);
        setCustomers(data);
      } catch (err) {
        console.error('Error fetching customers:', err);
      } finally {
        setLoadingCustomers(false);
      }
    };
    fetchCustomers();
  }, [companyId]);

  // Fetch all parts on mount (parts are independent of customer)
  useEffect(() => {
    const fetchParts = async () => {
      setLoadingParts(true);
      try {
        const data = await getPartsForSelect(companyId);
        setParts(data);
      } catch (err) {
        console.error('Error fetching parts:', err);
      } finally {
        setLoadingParts(false);
      }
    };
    fetchParts();
  }, [companyId]);

  // Get the selected part object for routing status display
  const selectedPart = formData.part_id
    ? parts.find((p) => p.id === formData.part_id)
    : null;

  const handleChange = (field: keyof JobFormData, value: string) => {
    setFormData(prev => ({ ...prev, [field]: value }));
    setFieldErrors(prev => ({ ...prev, [field]: '' }));
  };

  const validate = (): boolean => {
    const errors: Record<string, string> = {};

    if (!formData.customer_id) {
      errors.customer_id = 'Customer is required';
    }

    if (!formData.part_id) {
      errors.part_id = 'Part is required';
    }

    setFieldErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const handleSubmit = async () => {
    if (!validate()) return;

    setLoading(true);
    setError(null);

    try {
      if (mode === 'create') {
        const job = await createJob(companyId, formData);
        if (onSave) {
          onSave();
        } else {
          router.push(`/dashboard/${companyId}/jobs/${job.id}`);
        }
      } else if (jobId) {
        await updateJob(jobId, formData);
        if (onSave) {
          onSave();
        } else {
          router.push(`/dashboard/${companyId}/jobs/${jobId}`);
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async () => {
    if (!jobId) return;

    setDeleting(true);
    try {
      await deleteJob(jobId, companyId);
      router.push(`/dashboard/${companyId}/jobs`);
    } catch (err) {
      setSnackbar({
        open: true,
        message: err instanceof Error ? err.message : 'Failed to delete job',
        severity: 'error',
      });
      setDeleteDialogOpen(false);
    } finally {
      setDeleting(false);
    }
  };

  const handleBack = () => {
    if (onCancel) {
      onCancel();
    } else if (mode === 'edit' && jobId) {
      router.push(`/dashboard/${companyId}/jobs/${jobId}`);
    } else {
      router.push(`/dashboard/${companyId}/jobs`);
    }
  };

  return (
    <Box>
      {/* Back Button */}
      <Button
        startIcon={<ArrowBackIcon />}
        onClick={handleBack}
        sx={{ color: 'text.secondary', mb: 2 }}
      >
        {mode === 'edit' ? 'Back to Job' : 'Back to Jobs'}
      </Button>

      <Card elevation={2}>
        <CardContent sx={{ p: 4 }}>
          {error && (
            <Alert severity="error" sx={{ mb: 3 }} onClose={() => setError(null)}>
              {error}
            </Alert>
          )}

          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            {/* Customer Selection */}
            <FormControl fullWidth error={!!fieldErrors.customer_id}>
              <InputLabel>Customer *</InputLabel>
              <Select
                value={formData.customer_id}
                label="Customer *"
                onChange={(e) => handleChange('customer_id', e.target.value)}
                disabled={loading || loadingCustomers}
              >
                {customers.map((c) => (
                  <MenuItem key={c.id} value={c.id}>
                    {c.name}
                  </MenuItem>
                ))}
              </Select>
              {fieldErrors.customer_id && (
                <Typography variant="caption" color="error" sx={{ mt: 0.5, ml: 1.5 }}>
                  {fieldErrors.customer_id}
                </Typography>
              )}
            </FormControl>

            {/* Part Selection */}
            <FormControl fullWidth disabled={loadingParts} error={!!fieldErrors.part_id}>
              <InputLabel>Part *</InputLabel>
              <Select
                value={formData.part_id}
                label="Part *"
                onChange={(e) => handleChange('part_id', e.target.value)}
              >
                {parts.map((p) => (
                  <MenuItem key={p.id} value={p.id}>
                    {p.part_number}
                    {p.description && ` - ${p.description}`}
                  </MenuItem>
                ))}
              </Select>
              {fieldErrors.part_id && (
                <Typography variant="caption" color="error" sx={{ mt: 0.5, ml: 1.5 }}>
                  {fieldErrors.part_id}
                </Typography>
              )}
            </FormControl>

            {/* Routing Status Display */}
            {formData.part_id && selectedPart && (
              selectedPart.has_routing ? (
                <Alert
                  severity="success"
                  icon={<CheckCircleOutlineIcon />}
                >
                  This part has a routing defined. Operations will be copied to the job.
                </Alert>
              ) : (
                <Alert severity="warning">
                  <Typography variant="body2" gutterBottom>
                    No routing defined for this part. A routing is required to create a job.
                  </Typography>
                  <Button
                    variant="outlined"
                    size="small"
                    href={(() => {
                      const returnParams = new URLSearchParams();
                      if (formData.customer_id) returnParams.set('customer_id', formData.customer_id);
                      if (formData.part_id) returnParams.set('part_id', formData.part_id);
                      if (formData.description) returnParams.set('description', formData.description);
                      const returnTo = `/dashboard/${companyId}/jobs/new?${returnParams.toString()}`;
                      return `/dashboard/${companyId}/parts/${formData.part_id}/routing/new?returnTo=${encodeURIComponent(returnTo)}`;
                    })()}
                    startIcon={<ArrowForwardIcon />}
                    sx={{ mt: 1 }}
                  >
                    Create Routing
                  </Button>
                </Alert>
              )
            )}

            <Divider />

            {/* Description */}
            <TextField
              label="Description"
              value={formData.description}
              onChange={(e) => handleChange('description', e.target.value)}
              multiline
              rows={3}
              disabled={loading}
              placeholder="Optional job description or special instructions"
            />

            <Divider />

            {/* Actions */}
            <Box sx={{ display: 'flex', gap: 2, justifyContent: 'flex-end', alignItems: 'center' }}>
              {mode === 'edit' && jobId && (
                <Button
                  variant="outlined"
                  color="error"
                  startIcon={<DeleteIcon />}
                  onClick={() => setDeleteDialogOpen(true)}
                  disabled={loading}
                  sx={{ mr: 'auto' }}
                >
                  Delete
                </Button>
              )}

              <Button
                variant="outlined"
                onClick={handleBack}
                disabled={loading}
              >
                Cancel
              </Button>

              <Button
                variant="contained"
                onClick={handleSubmit}
                disabled={loading || (!!selectedPart && !selectedPart.has_routing)}
                startIcon={loading ? <CircularProgress size={20} /> : null}
              >
                {loading ? 'Saving...' : mode === 'create' ? 'Create Job' : 'Save Changes'}
              </Button>
            </Box>
          </Box>
        </CardContent>
      </Card>

      {/* Delete Confirmation Dialog */}
      <Dialog open={deleteDialogOpen} onClose={() => setDeleteDialogOpen(false)}>
        <DialogTitle>Delete Job?</DialogTitle>
        <DialogContent>
          <Typography>
            Are you sure you want to delete <strong>{jobNumber || 'this job'}</strong>?
            This will also delete all operations and attachments. This action cannot be undone.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteDialogOpen(false)} disabled={deleting}>
            Cancel
          </Button>
          <Button
            onClick={handleDelete}
            color="error"
            variant="contained"
            disabled={deleting}
            startIcon={deleting ? <CircularProgress size={16} color="inherit" /> : <DeleteIcon />}
          >
            {deleting ? 'Deleting...' : 'Delete'}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Error Snackbar */}
      <Snackbar
        open={snackbar.open}
        autoHideDuration={6000}
        onClose={() => setSnackbar(prev => ({ ...prev, open: false }))}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert
          onClose={() => setSnackbar(prev => ({ ...prev, open: false }))}
          severity={snackbar.severity}
          sx={{ width: '100%' }}
        >
          {snackbar.message}
        </Alert>
      </Snackbar>
    </Box>
  );
}
