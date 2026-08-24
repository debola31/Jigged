'use client';

import { useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useLoad } from '@/hooks/useLoad';
import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import Alert from '@mui/material/Alert';
import CircularProgress from '@mui/material/CircularProgress';
import Divider from '@mui/material/Divider';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import EditIcon from '@mui/icons-material/Edit';
import DeleteIcon from '@mui/icons-material/Delete';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';

import { getWorkCenterWithRelations, deleteWorkCenter } from '@/utils/workCentersAccess';
import { getVendorService } from '@/utils/vendorServicesAccess';
import MachineLogPanel from '@/components/maintenance/MachineLogPanel';
import MachineManualsManager from '@/components/maintenance/MachineManualsManager';

export default function WorkCenterDetailPage() {
  const params = useParams();
  const router = useRouter();
  const companyId = params.companyId as string;
  const workCenterId = params.workCenterId as string;

  const [actionLoading, setActionLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);

  // useLoad keeps every setState inside the async callback, so the load effect
  // can't trip set-state-in-effect.
  //
  // The second read is the migration affordance. Every outsourced process kept
  // its uuid when it moved to vendor_services, so an old
  // /work-centers/{id} bookmark, or a link in someone's email, still names a
  // real thing — it is just no longer a work centre. Resolving that id against
  // the new table lets the page forward rather than saying "not found", which
  // for a shop owner reads as data loss.
  const { data, loading } = useLoad(
    async () => {
      const wc = await getWorkCenterWithRelations(workCenterId);
      if (wc) return { workCenter: wc, movedService: null };
      const service = await getVendorService(workCenterId);
      return { workCenter: null, movedService: service };
    },
    [workCenterId],
    {
      onError: (err) =>
        setError(err instanceof Error ? err.message : 'Failed to load work center'),
    },
  );
  const workCenter = data?.workCenter ?? null;
  const movedService = data?.movedService ?? null;

  const handleDelete = async () => {
    setActionLoading(true);
    try {
      await deleteWorkCenter(workCenterId);
      router.push(`/dashboard/${companyId}/work-centers`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete work center');
      setActionLoading(false);
      setDeleteDialogOpen(false);
    }
  };

  const formatDate = (dateStr: string | null): string => {
    if (!dateStr) return '—';
    return new Date(dateStr).toLocaleString();
  };

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: 400 }}>
        <CircularProgress />
      </Box>
    );
  }

  // This id is a vendor service now. Say so and hand over the link, rather than
  // bouncing silently — someone who bookmarked "PerformCoat Anodize" as a work
  // centre should learn where it went, not just arrive somewhere else.
  if (!workCenter && movedService) {
    return (
      <Box>
        <Alert severity="info" sx={{ mb: 2 }}>
          <Typography variant="body2" sx={{ mb: 1 }}>
            <strong>{movedService.name}</strong> is an outside process, not a work center. It
            now lives on the vendor that performs it.
          </Typography>
          <Button
            size="small"
            variant="contained"
            onClick={() =>
              router.push(
                `/dashboard/${companyId}/vendors/${movedService.vendor_id}`,
              )
            }
          >
            Go to the vendor
          </Button>
        </Alert>
      </Box>
    );
  }

  if (!workCenter) {
    return (
      <Box>
        <Alert severity="error">Work center not found</Alert>
      </Box>
    );
  }

  return (
    <Box>
      <Box
        sx={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          mb: 3,
        }}
      >
        <Button
          startIcon={<ArrowBackIcon />}
          onClick={() => router.push(`/dashboard/${companyId}/work-centers`)}
          sx={{ color: 'text.secondary' }}
        >
          Back to Work Centers
        </Button>

        <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
          <Button
            variant="outlined"
            startIcon={<EditIcon />}
            onClick={() =>
              router.push(`/dashboard/${companyId}/work-centers/${workCenterId}/edit`)
            }
            disabled={actionLoading}
          >
            Edit
          </Button>

          <Tooltip title="Delete Work Center">
            <span>
              <IconButton
                onClick={() => setDeleteDialogOpen(true)}
                disabled={actionLoading}
                sx={{
                  color: 'error.main',
                  '&:hover': { bgcolor: 'rgba(239, 68, 68, 0.1)' },
                }}
              >
                <DeleteIcon />
              </IconButton>
            </span>
          </Tooltip>
        </Box>
      </Box>

      {error && (
        <Alert severity="error" sx={{ mb: 3 }} onClose={() => setError(null)}>
          {error}
        </Alert>
      )}

      <Card elevation={2} sx={{ mb: 3 }}>
        <CardContent>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap' }}>
            <Typography variant="h5" sx={{ fontWeight: 600 }}>
              {workCenter.name}
            </Typography>
            {/* The Internal/External chip is gone with the kind column: every
                row on this page is an in-house station now, so a badge saying so
                on all of them carries no information. */}
          </Box>
        </CardContent>
      </Card>

      <Card elevation={2}>
        <CardContent>
          <Typography variant="h6" gutterBottom sx={{ fontWeight: 600 }}>
            Details
          </Typography>
          <Divider sx={{ mb: 2 }} />
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <Box>
              <Typography variant="body2" color="text.secondary">
                Labor Rate
              </Typography>
              <Typography variant="body1" fontWeight={500}>
                {workCenter.labor_rate !== null
                  ? `$${Number(workCenter.labor_rate).toLocaleString(undefined, {
                      minimumFractionDigits: 2,
                      maximumFractionDigits: 2,
                    })}/hr`
                  : '—'}
              </Typography>
            </Box>
            <Box>
              <Typography variant="body2" color="text.secondary">
                Description
              </Typography>
              <Typography variant="body1" sx={{ whiteSpace: 'pre-line' }}>
                {workCenter.description || '—'}
              </Typography>
            </Box>
            <Box>
              <Typography variant="body2" color="text.secondary">
                Used in routing operations
              </Typography>
              <Typography variant="body1" fontWeight={500}>
                {workCenter.routing_operations_count} operation
                {workCenter.routing_operations_count !== 1 ? 's' : ''}
              </Typography>
            </Box>
            <Box>
              <Typography variant="body2" color="text.secondary">
                Created
              </Typography>
              <Typography variant="body1" fontWeight={500}>
                {formatDate(workCenter.created_at)}
              </Typography>
            </Box>
            <Box>
              <Typography variant="body2" color="text.secondary">
                Updated
              </Typography>
              <Typography variant="body1" fontWeight={500}>
                {formatDate(workCenter.updated_at)}
              </Typography>
            </Box>
          </Box>
        </CardContent>
      </Card>

      {/* Read-only by design: there is no composer here. Manuals and machine details are the
          office's job; the log is the floor's, written at the machine by whoever is standing at it.

          Withdrawn: "for internal machines only" — `work_centers.kind` was dropped in the
          vendor-services split, and this card never checked it in the first place. Withdrawn: the
          composer was omitted because the pilot's bar counted NON-FOUNDER authors and the most
          convenient place to write must not be the seat that invalidated the result. The pilot is
          over (the flag was retired Aug 2026); the office/floor split is why it stays read-only. */}
      <Card elevation={2} sx={{ mt: 3 }}>
        <CardContent>
          <Typography variant="h6" sx={{ mb: 2 }}>
            Maintenance log
          </Typography>
          {/* Sub-labelled, because the card is titled "Maintenance log" and an
              upload button is not a log entry. Two named things beat one
              heading that covers only half of what sits under it. */}
          <Typography variant="overline" color="text.secondary" sx={{ display: 'block' }}>
            Manuals
          </Typography>
          <MachineManualsManager companyId={companyId} workCenterId={workCenterId} />
          <Divider sx={{ my: 2 }} />
          <MachineLogPanel workCenterId={workCenterId} companyId={companyId} readOnly />
        </CardContent>
      </Card>

      <Dialog open={deleteDialogOpen} onClose={() => setDeleteDialogOpen(false)}>
        <DialogTitle>Delete Work Center?</DialogTitle>
        <DialogContent>
          <Typography>
            Delete <strong>{workCenter.name}</strong>? It will be removed from your
            work centers list. Routings that already use it keep working, and creating
            a work center with the same name later brings it back.
          </Typography>
          {workCenter.routing_operations_count > 0 && (
            <Alert severity="info" sx={{ mt: 2 }}>
              Used by {workCenter.routing_operations_count} routing operation
              {workCenter.routing_operations_count !== 1 ? 's' : ''} — kept.
            </Alert>
          )}
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
            startIcon={
              actionLoading ? <CircularProgress size={16} color="inherit" /> : <DeleteIcon />
            }
          >
            {actionLoading ? 'Deleting...' : 'Delete'}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
