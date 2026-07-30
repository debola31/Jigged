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
import Chip from '@mui/material/Chip';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import EditIcon from '@mui/icons-material/Edit';
import DeleteIcon from '@mui/icons-material/Delete';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import FactoryIcon from '@mui/icons-material/Factory';
import LocalShippingIcon from '@mui/icons-material/LocalShipping';
import NextLink from 'next/link';
import MuiLink from '@mui/material/Link';

import { getWorkCenterWithRelations, deleteWorkCenter } from '@/utils/workCentersAccess';
import { useCompanyFeatures } from '@/hooks/useCompanyFeatures';
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

  const { features } = useCompanyFeatures();
  const maintenanceEnabled = Boolean(features.machine_maintenance);

  // useLoad keeps every setState inside the async callback, so the load effect
  // can't trip set-state-in-effect.
  const { data: workCenter, loading } = useLoad(
    () => getWorkCenterWithRelations(workCenterId),
    [workCenterId],
    {
      onError: (err) =>
        setError(err instanceof Error ? err.message : 'Failed to load work center'),
    },
  );

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

  if (!workCenter) {
    return (
      <Box>
        <Alert severity="error">Work center not found</Alert>
      </Box>
    );
  }

  const isInternal = workCenter.kind === 'internal';

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
            <Chip
              icon={isInternal ? <FactoryIcon /> : <LocalShippingIcon />}
              label={isInternal ? 'Internal' : 'External'}
              sx={{
                fontWeight: 600,
                bgcolor: isInternal ? 'info.dark' : 'warning.dark',
                color: 'common.white',
                '& .MuiChip-icon': { color: 'common.white' },
              }}
            />
            {!isInternal && workCenter.vendor && (
              <Typography variant="body1" color="text.secondary">
                via{' '}
                <MuiLink
                  component={NextLink}
                  href={`/dashboard/${companyId}/vendors/${workCenter.vendor.id}`}
                  sx={{ fontWeight: 500 }}
                >
                  {workCenter.vendor.name}
                </MuiLink>
              </Typography>
            )}
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
            {/* Kind-conditional fields mirror the form so the displayed data is consistent.
                Internal: labor rate. External: vendor link + a hint that pricing
                lives on the routing operations, not on the work center. */}
            {isInternal && (
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
            )}
            {!isInternal && (
              <Box>
                <Typography variant="body2" color="text.secondary">
                  Vendor
                </Typography>
                {workCenter.vendor ? (
                  <MuiLink
                    component={NextLink}
                    href={`/dashboard/${companyId}/vendors/${workCenter.vendor.id}`}
                    sx={{ fontWeight: 500 }}
                  >
                    {workCenter.vendor.name}
                  </MuiLink>
                ) : (
                  <Typography variant="body1" color="text.secondary">
                    —
                  </Typography>
                )}
              </Box>
            )}
            {!isInternal && (
              <Box>
                <Typography variant="body2" color="text.secondary">
                  Pricing per routing operation
                </Typography>
                <Typography variant="body2" sx={{ mt: 0.5 }}>
                  External work centers price per routing operation. Each
                  routing op sets its own{' '}
                  <strong>vendor unit price</strong> for this vendor — external
                  work bills once per part, so there is no setup cost.
                </Typography>
              </Box>
            )}
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

      {/* Maintenance, for internal machines only — an outside vendor's process is
          not a machine anyone stands at. Read-only by design: there is no
          composer here, because the pilot's bar counts NON-FOUNDER authors and
          the most convenient place to write must not be the one seat that would
          invalidate the result. Manuals and machine details are the office's job;
          the log is the floor's. */}
      {maintenanceEnabled && workCenter.kind === 'internal' && (
        <Card elevation={2} sx={{ mt: 3 }}>
          <CardContent>
            <Typography variant="h6" sx={{ mb: 2 }}>
              Maintenance
            </Typography>
            <MachineManualsManager companyId={companyId} workCenterId={workCenterId} />
            <Divider sx={{ my: 2 }} />
            <MachineLogPanel workCenterId={workCenterId} companyId={companyId} readOnly />
          </CardContent>
        </Card>
      )}

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
