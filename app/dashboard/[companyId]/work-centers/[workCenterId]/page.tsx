'use client';

import { useState, useEffect, useCallback } from 'react';
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
import { getCompany } from '@/utils/companyAccess';
import StationQRCode from '@/components/operations/StationQRCode';
import type { WorkCenterWithRelations } from '@/types/workCenter';

export default function WorkCenterDetailPage() {
  const params = useParams();
  const router = useRouter();
  const companyId = params.companyId as string;
  const workCenterId = params.workCenterId as string;

  const [workCenter, setWorkCenter] = useState<WorkCenterWithRelations | null>(null);
  const [companyName, setCompanyName] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);

  const fetchWorkCenter = useCallback(async () => {
    try {
      setLoading(true);
      const [data, company] = await Promise.all([
        getWorkCenterWithRelations(workCenterId),
        getCompany(companyId),
      ]);
      setWorkCenter(data);
      setCompanyName(company?.name);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load work center');
    } finally {
      setLoading(false);
    }
  }, [workCenterId, companyId]);

  useEffect(() => {
    fetchWorkCenter();
  }, [fetchWorkCenter]);

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
  // Delete is gated by the routing_operations FK — the DB will reject the delete
  // anyway, but checking up front lets us disable the button and explain why.
  const hasReferences = workCenter.routing_operations_count > 0;
  const metadataCode =
    typeof workCenter.metadata?.code === 'string' ? (workCenter.metadata.code as string) : null;

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

          <Tooltip
            title={
              hasReferences
                ? 'Cannot delete — this work center is used by routing operations'
                : 'Delete Work Center'
            }
          >
            <span>
              <IconButton
                onClick={() => setDeleteDialogOpen(true)}
                disabled={actionLoading || hasReferences}
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

      <Grid container spacing={3}>
        <Grid size={{ xs: 12, md: 6 }}>
          <Card elevation={2} sx={{ height: '100%' }}>
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
                      <strong>external_unit_price</strong> and{' '}
                      <strong>external_setup_cost</strong> for this vendor.
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
        </Grid>

        {isInternal && (
          <Grid size={{ xs: 12, md: 6 }}>
            <Card elevation={2} sx={{ height: '100%' }}>
              <CardContent>
                <Typography variant="h6" gutterBottom sx={{ fontWeight: 600 }}>
                  Station QR Code
                </Typography>
                <Divider sx={{ mb: 2 }} />
                <StationQRCode
                  operationTypeId={workCenter.id}
                  operationName={workCenter.name}
                  operationCode={metadataCode}
                  companyId={companyId}
                  companyName={companyName}
                />
              </CardContent>
            </Card>
          </Grid>
        )}
      </Grid>

      <Dialog open={deleteDialogOpen} onClose={() => setDeleteDialogOpen(false)}>
        <DialogTitle>Delete Work Center?</DialogTitle>
        <DialogContent>
          <Typography>
            Are you sure you want to delete <strong>{workCenter.name}</strong>? This action cannot
            be undone.
          </Typography>
          {hasReferences && (
            <Alert severity="warning" sx={{ mt: 2 }}>
              This work center is used by {workCenter.routing_operations_count} routing operation
              {workCenter.routing_operations_count !== 1 ? 's' : ''}. Remove those references
              before deleting.
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
            disabled={actionLoading || hasReferences}
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
