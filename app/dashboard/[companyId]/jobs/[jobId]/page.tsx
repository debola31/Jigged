'use client';

import { useState, useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import Alert from '@mui/material/Alert';
import CircularProgress from '@mui/material/CircularProgress';
import Divider from '@mui/material/Divider';
import Grid from '@mui/material/Grid';
import Chip from '@mui/material/Chip';
import Link from 'next/link';
import MuiLink from '@mui/material/Link';
import LocalShippingIcon from '@mui/icons-material/LocalShipping';
import CancelIcon from '@mui/icons-material/Cancel';
import DeleteIcon from '@mui/icons-material/Delete';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';

import {
  getJobWithRelations,
  deleteJob,
  shipJob,
  cancelJob,
} from '@/utils/jobsAccess';
import type { JobWithRelations, JobPartWithRelations } from '@/types/job';
import { JobStatusChip, OperationsPanel, JobQRCode } from '@/components/jobs';
import JobOverdueBadge from '@/components/jobs/JobOverdueBadge';

export default function JobDetailPage() {
  const params = useParams();
  const router = useRouter();
  const companyId = params.companyId as string;
  const jobId = params.jobId as string;

  const [job, setJob] = useState<JobWithRelations | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [cancelDialogOpen, setCancelDialogOpen] = useState(false);

  useEffect(() => {
    fetchJob();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId]);

  const fetchJob = async () => {
    try {
      setLoading(true);
      const data = await getJobWithRelations(jobId, companyId);
      setJob(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load job');
    } finally {
      setLoading(false);
    }
  };

  const handleAction = async (action: () => Promise<unknown>) => {
    setActionLoading(true);
    setError(null);
    try {
      await action();
      await fetchJob();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Action failed');
    } finally {
      setActionLoading(false);
    }
  };

  const handleDelete = async () => {
    setActionLoading(true);
    try {
      await deleteJob(jobId, companyId);
      router.push(`/dashboard/${companyId}/jobs`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete job');
      setActionLoading(false);
      setDeleteDialogOpen(false);
    }
  };

  const handleCancel = async () => {
    setActionLoading(true);
    try {
      await cancelJob(jobId);
      await fetchJob();
      setCancelDialogOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to cancel job');
    } finally {
      setActionLoading(false);
    }
  };

  const formatDate = (dateStr: string | null): string => {
    if (!dateStr) return '—';
    return new Date(dateStr).toLocaleDateString();
  };

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: 400 }}>
        <CircularProgress />
      </Box>
    );
  }

  if (!job) {
    return (
      <Box>
        <Alert severity="error">Job not found</Alert>
      </Box>
    );
  }

  const parts: JobPartWithRelations[] = job.job_parts ?? [];
  const canShip = job.status === 'completed';
  const canCancel = job.status !== 'shipped' && job.status !== 'cancelled';

  return (
    <Box>
      <Button
        startIcon={<ArrowBackIcon />}
        onClick={() => router.push(`/dashboard/${companyId}/jobs`)}
        sx={{ color: 'text.secondary', mb: 2 }}
      >
        Back to Jobs
      </Button>

      {/* Header with Actions */}
      <Box
        sx={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          mb: 3,
          flexWrap: 'wrap',
          gap: 2,
        }}
      >
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap' }}>
          <Typography variant="h4" component="h1" sx={{ fontSize: { xs: '1.5rem', md: '2.125rem' } }}>
            {job.job_number}
          </Typography>
          <JobStatusChip status={job.status} size="medium" />
          <JobOverdueBadge job={job} size="medium" />
        </Box>

        <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', alignItems: 'center' }}>
          {canShip && (
            <Button
              variant="contained"
              color="primary"
              startIcon={<LocalShippingIcon />}
              onClick={() => handleAction(() => shipJob(jobId))}
              disabled={actionLoading}
            >
              Mark Shipped
            </Button>
          )}

          {canCancel && (
            <Button
              variant="outlined"
              color="error"
              startIcon={<CancelIcon />}
              onClick={() => setCancelDialogOpen(true)}
              disabled={actionLoading}
            >
              Cancel
            </Button>
          )}

          <Box sx={{ flex: 1 }} />

          <Tooltip title="Delete Job">
            <IconButton
              onClick={() => setDeleteDialogOpen(true)}
              disabled={actionLoading}
              sx={{
                color: 'text.secondary',
                '&:hover': {
                  color: 'error.main',
                  bgcolor: 'rgba(239, 68, 68, 0.1)',
                },
              }}
            >
              <DeleteIcon />
            </IconButton>
          </Tooltip>
        </Box>
      </Box>

      {error && (
        <Alert severity="error" sx={{ mb: 3 }} onClose={() => setError(null)}>
          {error}
        </Alert>
      )}

      {/* Quote Link Banner */}
      {job.quote_id && job.quotes && (
        <Alert severity="info" sx={{ mb: 3 }}>
          Created from{' '}
          <MuiLink
            component={Link}
            href={`/dashboard/${companyId}/quotes/${job.quote_id}`}
            sx={{ fontWeight: 600 }}
          >
            Quote {job.quotes.quote_number}
          </MuiLink>
        </Alert>
      )}

      <Grid container spacing={3}>
        {/* Job Details — customer, dates, expandable QR code */}
        <Grid size={{ xs: 12, md: 6 }}>
          <Card elevation={2} sx={{ height: '100%' }}>
            <CardContent>
              <Typography variant="h6" gutterBottom sx={{ fontWeight: 600 }}>
                Job Details
              </Typography>
              <Divider sx={{ mb: 2 }} />
              <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <Box>
                  <Typography variant="body2" color="text.secondary">
                    Customer
                  </Typography>
                  {job.customers ? (
                    <MuiLink
                      component={Link}
                      href={`/dashboard/${companyId}/customers/${job.customer_id}`}
                      sx={{ fontWeight: 500 }}
                    >
                      {job.customers.name}
                    </MuiLink>
                  ) : (
                    <Typography variant="body1" color="text.secondary">
                      —
                    </Typography>
                  )}
                </Box>
                <Box>
                  <Typography variant="body2" color="text.secondary">
                    Created
                  </Typography>
                  <Typography variant="body1" fontWeight={500}>
                    {formatDate(job.created_at)}
                  </Typography>
                </Box>
                {job.due_date && (
                  <Box>
                    <Typography variant="body2" color="text.secondary">
                      Due
                    </Typography>
                    <Typography variant="body1" fontWeight={500}>
                      {formatDate(job.due_date)}
                    </Typography>
                  </Box>
                )}
              </Box>
            </CardContent>
          </Card>
        </Grid>

        <Grid size={{ xs: 12, md: 6 }}>
          <Card elevation={2} sx={{ height: '100%' }}>
            <CardContent>
              <Typography variant="h6" gutterBottom sx={{ fontWeight: 600 }}>
                Job QR Code
              </Typography>
              <Divider sx={{ mb: 2 }} />
              <JobQRCode jobId={jobId} jobNumber={job.job_number} companyId={companyId} />
            </CardContent>
          </Card>
        </Grid>

        {/* Parts list — one card per job_part with its own OperationsPanel */}
        <Grid size={{ xs: 12 }}>
          <Card elevation={2}>
            <CardContent>
              <Typography variant="h6" sx={{ fontWeight: 600, mb: 2 }}>
                Parts ({parts.length})
              </Typography>
              <Divider sx={{ mb: 2 }} />
              {parts.length === 0 ? (
                <Typography color="text.secondary">No parts on this job.</Typography>
              ) : (
                <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                  {parts.map((part) => (
                    <Box key={part.id}>
                      <Box
                        sx={{
                          display: 'flex',
                          alignItems: 'baseline',
                          justifyContent: 'space-between',
                          flexWrap: 'wrap',
                          gap: 1,
                          mb: 1,
                        }}
                      >
                        <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1.5, flexWrap: 'wrap' }}>
                          <MuiLink
                            component={Link}
                            href={`/dashboard/${companyId}/parts/${part.part_id}`}
                            sx={{ fontWeight: 600, fontSize: '1.05rem' }}
                          >
                            {part.parts?.part_name ?? 'Part'}
                          </MuiLink>
                          {part.parts?.description && (
                            <Typography variant="body2" color="text.secondary">
                              {part.parts.description}
                            </Typography>
                          )}
                          <Chip size="small" label={`Order qty ${part.quantity}`} variant="outlined" />
                        </Box>
                        <JobStatusChip status={part.status} size="small" />
                      </Box>
                      {part.job_operations && part.job_operations.length > 0 ? (
                        <OperationsPanel
                          job={job}
                          operations={part.job_operations}
                          onOperationUpdate={fetchJob}
                          disabled={actionLoading}
                        />
                      ) : (
                        <Typography variant="body2" color="text.secondary" sx={{ pl: 1 }}>
                          No operations on this part.
                        </Typography>
                      )}
                    </Box>
                  ))}
                </Box>
              )}
            </CardContent>
          </Card>
        </Grid>
      </Grid>

      {/* Cancel Confirmation Dialog */}
      <Dialog open={cancelDialogOpen} onClose={() => setCancelDialogOpen(false)}>
        <DialogTitle>Cancel Job?</DialogTitle>
        <DialogContent>
          <Typography>
            Are you sure you want to cancel <strong>{job.job_number}</strong>? Every part on the
            job will be marked cancelled. This action can be reversed by editing each part&apos;s
            status individually.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setCancelDialogOpen(false)} disabled={actionLoading}>
            Keep Job
          </Button>
          <Button
            onClick={handleCancel}
            color="error"
            variant="contained"
            disabled={actionLoading}
            startIcon={actionLoading ? <CircularProgress size={16} color="inherit" /> : <CancelIcon />}
          >
            {actionLoading ? 'Cancelling...' : 'Cancel Job'}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <Dialog open={deleteDialogOpen} onClose={() => setDeleteDialogOpen(false)}>
        <DialogTitle>Delete Job?</DialogTitle>
        <DialogContent>
          <Typography>
            Are you sure you want to delete <strong>{job.job_number}</strong>? This will also
            delete every part, every operation, and every material on the job. This action cannot
            be undone.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteDialogOpen(false)} disabled={actionLoading}>
            Cancel
          </Button>
          <Button
            onClick={handleDelete}
            color="error"
            variant="contained"
            disabled={actionLoading}
            startIcon={actionLoading ? <CircularProgress size={16} color="inherit" /> : <DeleteIcon />}
          >
            {actionLoading ? 'Deleting...' : 'Delete'}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
