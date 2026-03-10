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
import Link from 'next/link';
import MuiLink from '@mui/material/Link';
import EditIcon from '@mui/icons-material/Edit';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import CheckIcon from '@mui/icons-material/Check';
import LocalShippingIcon from '@mui/icons-material/LocalShipping';
import PauseIcon from '@mui/icons-material/Pause';
import CancelIcon from '@mui/icons-material/Cancel';
import DeleteIcon from '@mui/icons-material/Delete';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import PictureAsPdfIcon from '@mui/icons-material/PictureAsPdf';
import DownloadIcon from '@mui/icons-material/Download';
import AccountTreeIcon from '@mui/icons-material/AccountTree';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';

import {
  getJobWithRelations,
  deleteJob,
  startJob,
  completeJob,
  shipJob,
  cancelJob,
  putJobOnHold,
  resumeJob,
  getJobAttachmentUrl,
} from '@/utils/jobsAccess';
import { getRoutingSummaryForPart } from '@/utils/routingsAccess';
import type { JobWithRelations, JobOperation, JobAttachment } from '@/types/job';
import { JobStatusChip, OperationsPanel, ViewRoutingModal } from '@/components/jobs';

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
  const [workflowModalOpen, setWorkflowModalOpen] = useState(false);
  const [routingInfo, setRoutingInfo] = useState<{
    id: string;
    nodeCount: number;
    totalRunTime: number | null;
  } | null>(null);

  useEffect(() => {
    fetchJob();
  }, [jobId]);

  // Fetch routing info through the part (1:1 relationship)
  useEffect(() => {
    const fetchRoutingInfo = async () => {
      if (!job?.part_id) {
        setRoutingInfo(null);
        return;
      }
      try {
        const summary = await getRoutingSummaryForPart(job.part_id);
        setRoutingInfo(summary);
      } catch (err) {
        console.error('Error fetching routing info:', err);
      }
    };
    fetchRoutingInfo();
  }, [job?.part_id]);

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

  const formatDateTime = (dateStr: string | null): string => {
    if (!dateStr) return '—';
    return new Date(dateStr).toLocaleString();
  };

  const formatFileSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const handleDownloadAttachment = async (attachment: JobAttachment) => {
    try {
      const url = await getJobAttachmentUrl(attachment.file_path);
      window.open(url, '_blank');
    } catch (err) {
      setError('Failed to download attachment');
    }
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

  const canEdit = job.status === 'pending' || job.status === 'on_hold';
  const hasOperations = job.job_operations && job.job_operations.length > 0;
  // Hide manual Start/Complete buttons when operations exist (auto-progression handles these)
  const canStart = job.status === 'pending' && !hasOperations;
  const canComplete = job.status === 'in_progress' && !hasOperations;
  const canShip = job.status === 'completed';
  const canPause = job.status === 'in_progress';
  const canResume = job.status === 'on_hold';
  const canCancel = job.status !== 'shipped' && job.status !== 'cancelled';

  return (
    <Box>
      {/* Back Button */}
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
        <Box>
          <Typography variant="h4" component="h1" gutterBottom>
            {job.job_number}
          </Typography>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap' }}>
            <JobStatusChip status={job.status} size="medium" />
            <Typography variant="body2" color="text.secondary">
              Created {formatDate(job.created_at)}
            </Typography>
          </Box>
        </Box>

        {/* Action Buttons */}
        <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', alignItems: 'center' }}>
          {canEdit && (
            <Button
              variant="outlined"
              startIcon={<EditIcon />}
              onClick={() => router.push(`/dashboard/${companyId}/jobs/${jobId}/edit`)}
              disabled={actionLoading}
            >
              Edit
            </Button>
          )}

          {canStart && (
            <Button
              variant="contained"
              color="primary"
              startIcon={<PlayArrowIcon />}
              onClick={() => handleAction(() => startJob(jobId))}
              disabled={actionLoading}
            >
              Start Job
            </Button>
          )}

          {canPause && (
            <Button
              variant="outlined"
              color="warning"
              startIcon={<PauseIcon />}
              onClick={() => handleAction(() => putJobOnHold(jobId))}
              disabled={actionLoading}
            >
              Put On Hold
            </Button>
          )}

          {canResume && (
            <Button
              variant="contained"
              color="primary"
              startIcon={<PlayArrowIcon />}
              onClick={() => handleAction(() => resumeJob(jobId))}
              disabled={actionLoading}
            >
              Resume
            </Button>
          )}

          {canComplete && (
            <Button
              variant="contained"
              color="success"
              startIcon={<CheckIcon />}
              onClick={() => handleAction(() => completeJob(jobId))}
              disabled={actionLoading}
            >
              Mark Complete
            </Button>
          )}

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
        {/* Job Summary */}
        <Grid size={{ xs: 12, md: 6 }}>
          <Card elevation={2} sx={{ height: '100%' }}>
            <CardContent>
              <Typography variant="h6" gutterBottom sx={{ fontWeight: 600 }}>
                Job Summary
              </Typography>
              <Divider sx={{ mb: 2 }} />

              <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 2 }}>
                <Box>
                  <Typography variant="body2" color="text.secondary">Customer</Typography>
                  {job.customers ? (
                    <MuiLink
                      component={Link}
                      href={`/dashboard/${companyId}/customers/${job.customer_id}`}
                      sx={{ fontWeight: 500 }}
                    >
                      {job.customers.name}
                    </MuiLink>
                  ) : (
                    <Typography>—</Typography>
                  )}
                </Box>

                <Box>
                  <Typography variant="body2" color="text.secondary">Part</Typography>
                  {job.parts ? (
                    <MuiLink
                      component={Link}
                      href={`/dashboard/${companyId}/parts/${job.part_id}`}
                      sx={{ fontWeight: 500 }}
                    >
                      {job.parts.part_number}
                    </MuiLink>
                  ) : (
                    <Typography>—</Typography>
                  )}
                </Box>

                <Box>
                  <Typography variant="body2" color="text.secondary">Routing</Typography>
                  {routingInfo ? (
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                      <MuiLink
                        component={Link}
                        href={`/dashboard/${companyId}/parts/${job.part_id}/routing/edit`}
                        sx={{ fontWeight: 500 }}
                      >
                        {routingInfo.nodeCount} operation{routingInfo.nodeCount !== 1 ? 's' : ''}
                      </MuiLink>
                      <Tooltip title="View Workflow">
                        <IconButton
                          size="small"
                          onClick={() => setWorkflowModalOpen(true)}
                          sx={{
                            color: 'text.secondary',
                            p: 0.5,
                            '&:hover': { color: 'primary.main' },
                          }}
                        >
                          <AccountTreeIcon fontSize="small" />
                        </IconButton>
                      </Tooltip>
                    </Box>
                  ) : (
                    <Typography>{'\u2014'}</Typography>
                  )}
                </Box>
              </Box>

              {job.description && (
                <Box sx={{ mt: 2 }}>
                  <Typography variant="body2" color="text.secondary">Description</Typography>
                  <Typography sx={{ whiteSpace: 'pre-wrap' }}>{job.description}</Typography>
                </Box>
              )}
            </CardContent>
          </Card>
        </Grid>

        {/* Timeline */}
        <Grid size={{ xs: 12, md: 6 }}>
          <Card elevation={2}>
            <CardContent>
              <Typography variant="h6" gutterBottom sx={{ fontWeight: 600 }}>
                Timeline
              </Typography>
              <Divider sx={{ mb: 2 }} />

              <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
                <Box sx={{ display: 'flex', justifyContent: 'space-between' }}>
                  <Typography variant="body2" color="text.secondary">Created</Typography>
                  <Typography variant="body2">{formatDateTime(job.created_at)}</Typography>
                </Box>
                {job.started_at && (
                  <Box sx={{ display: 'flex', justifyContent: 'space-between' }}>
                    <Typography variant="body2" color="text.secondary">Started</Typography>
                    <Typography variant="body2">{formatDateTime(job.started_at)}</Typography>
                  </Box>
                )}
                {job.completed_at && (
                  <Box sx={{ display: 'flex', justifyContent: 'space-between' }}>
                    <Typography variant="body2" color="text.secondary">Completed</Typography>
                    <Typography variant="body2">{formatDateTime(job.completed_at)}</Typography>
                  </Box>
                )}
                {job.shipped_at && (
                  <Box sx={{ display: 'flex', justifyContent: 'space-between' }}>
                    <Typography variant="body2" color="text.secondary">Shipped</Typography>
                    <Typography variant="body2">{formatDateTime(job.shipped_at)}</Typography>
                  </Box>
                )}
              </Box>
            </CardContent>
          </Card>
        </Grid>

        {/* Operations */}
        {hasOperations && (
          <Grid size={{ xs: 12 }}>
            <OperationsPanel
              job={job}
              operations={job.job_operations!}
              onOperationUpdate={fetchJob}
              disabled={actionLoading}
            />
          </Grid>
        )}

        {/* Attachments */}
        {job.job_attachments && job.job_attachments.length > 0 && (
          <Grid size={{ xs: 12 }}>
            <Card elevation={2}>
              <CardContent>
                <Typography variant="h6" gutterBottom sx={{ fontWeight: 600 }}>
                  Attachments
                </Typography>
                <Divider sx={{ mb: 2 }} />
                {job.job_attachments.map((attachment) => (
                  <Box
                    key={attachment.id}
                    sx={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 2,
                      p: 2,
                      bgcolor: 'rgba(255, 255, 255, 0.05)',
                      borderRadius: 1,
                      border: '1px solid rgba(255, 255, 255, 0.1)',
                      mb: 1,
                      '&:last-child': { mb: 0 },
                    }}
                  >
                    <PictureAsPdfIcon sx={{ fontSize: 40, color: 'error.main' }} />
                    <Box sx={{ flex: 1 }}>
                      <Typography variant="body1" fontWeight={500}>
                        {attachment.file_name}
                      </Typography>
                      <Typography variant="caption" color="text.secondary">
                        {formatFileSize(attachment.file_size)} • Uploaded {formatDate(attachment.uploaded_at)}
                      </Typography>
                    </Box>
                    <Button
                      variant="outlined"
                      startIcon={<DownloadIcon />}
                      onClick={() => handleDownloadAttachment(attachment)}
                      disabled={actionLoading}
                    >
                      Download
                    </Button>
                  </Box>
                ))}
              </CardContent>
            </Card>
          </Grid>
        )}
      </Grid>

      {/* Cancel Confirmation Dialog */}
      <Dialog open={cancelDialogOpen} onClose={() => setCancelDialogOpen(false)}>
        <DialogTitle>Cancel Job?</DialogTitle>
        <DialogContent>
          <Typography>
            Are you sure you want to cancel <strong>{job.job_number}</strong>? This action can be undone by an admin.
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
            Are you sure you want to delete <strong>{job.job_number}</strong>? This will also delete all operations and attachments. This action cannot be undone.
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

      {/* View Routing Workflow Modal */}
      {routingInfo && (
        <ViewRoutingModal
          open={workflowModalOpen}
          onClose={() => setWorkflowModalOpen(false)}
          routingId={routingInfo.id}
          routingName={`Routing (${routingInfo.nodeCount} operation${routingInfo.nodeCount !== 1 ? 's' : ''})`}
          companyId={companyId}
          partId={job.part_id || ''}
        />
      )}
    </Box>
  );
}
