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
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Link from 'next/link';
import MuiLink from '@mui/material/Link';
import EditIcon from '@mui/icons-material/Edit';
import DeleteIcon from '@mui/icons-material/Delete';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';

import { getPartWithRelations, deletePart } from '@/utils/partsAccess';
import type { Part } from '@/types/part';

export default function PartDetailPage() {
  const params = useParams();
  const router = useRouter();
  const companyId = params.companyId as string;
  const partId = params.partId as string;

  const [part, setPart] = useState<Part | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);

  useEffect(() => {
    fetchPart();
  }, [partId]);

  const fetchPart = async () => {
    try {
      setLoading(true);
      const data = await getPartWithRelations(partId);
      setPart(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load part');
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async () => {
    setActionLoading(true);
    try {
      await deletePart(partId);
      router.push(`/dashboard/${companyId}/parts`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete part');
      setActionLoading(false);
      setDeleteDialogOpen(false);
    }
  };

  const formatCurrency = (value: number | null): string => {
    if (value === null) return '—';
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value);
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

  if (!part) {
    return (
      <Box>
        <Alert severity="error">Part not found</Alert>
      </Box>
    );
  }

  const quotesCount = part.quotes_count ?? 0;
  const jobsCount = part.jobs_count ?? 0;
  const hasRelatedRecords = quotesCount > 0 || jobsCount > 0;

  return (
    <Box>
      {/* Back Button and Actions */}
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
          onClick={() => router.push(`/dashboard/${companyId}/parts`)}
          sx={{ color: 'text.secondary' }}
        >
          Back to Parts
        </Button>

        <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
          <Button
            variant="outlined"
            startIcon={<EditIcon />}
            onClick={() => router.push(`/dashboard/${companyId}/parts/${partId}/edit`)}
            disabled={actionLoading}
          >
            Edit
          </Button>

          <Tooltip title="Delete Part">
            <span>
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
            </span>
          </Tooltip>
        </Box>
      </Box>

      {error && (
        <Alert severity="error" sx={{ mb: 3 }} onClose={() => setError(null)}>
          {error}
        </Alert>
      )}

      <Grid container spacing={3}>
        {/* Basic Information Card */}
        <Grid size={{ xs: 12, md: 6 }}>
          <Card elevation={2} sx={{ height: '100%' }}>
            <CardContent>
              <Typography variant="h6" gutterBottom sx={{ fontWeight: 600 }}>
                Basic Information
              </Typography>
              <Divider sx={{ mb: 2 }} />
              <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <Box>
                  <Typography variant="body2" color="text.secondary">
                    Part Number
                  </Typography>
                  <Typography variant="body1" fontWeight={500}>
                    {part.part_number}
                  </Typography>
                </Box>
                <Box>
                  <Typography variant="body2" color="text.secondary">
                    Description
                  </Typography>
                  <Typography variant="body1" fontWeight={500}>
                    {part.description || '—'}
                  </Typography>
                </Box>
              </Box>
            </CardContent>
          </Card>
        </Grid>

        {/* Customer Card */}
        <Grid size={{ xs: 12, md: 6 }}>
          <Card elevation={2} sx={{ height: '100%' }}>
            <CardContent>
              <Typography variant="h6" gutterBottom sx={{ fontWeight: 600 }}>
                Customer
              </Typography>
              <Divider sx={{ mb: 2 }} />
              {part.customer ? (
                <Box>
                  <MuiLink
                    component={Link}
                    href={`/dashboard/${companyId}/customers/${part.customer.id}`}
                    sx={{ fontWeight: 500 }}
                  >
                    {part.customer.name}
                  </MuiLink>
                </Box>
              ) : (
                <Typography variant="body1" color="text.secondary">
                  Generic Part (no customer assigned)
                </Typography>
              )}
            </CardContent>
          </Card>
        </Grid>

        {/* Pricing Tiers Card */}
        <Grid size={{ xs: 12, md: 6 }}>
          <Card elevation={2} sx={{ height: '100%' }}>
            <CardContent>
              <Typography variant="h6" gutterBottom sx={{ fontWeight: 600 }}>
                Pricing Tiers
              </Typography>
              <Divider sx={{ mb: 2 }} />
              {part.pricing && part.pricing.length > 0 ? (
                <Table size="small">
                  <TableHead>
                    <TableRow>
                      <TableCell>Min Quantity</TableCell>
                      <TableCell align="right">Unit Price</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {part.pricing
                      .sort((a, b) => a.qty - b.qty)
                      .map((tier, index) => (
                        <TableRow key={index}>
                          <TableCell>{tier.qty}</TableCell>
                          <TableCell align="right">{formatCurrency(tier.price)}</TableCell>
                        </TableRow>
                      ))}
                  </TableBody>
                </Table>
              ) : (
                <Typography variant="body1" color="text.secondary">
                  No pricing tiers defined
                </Typography>
              )}
            </CardContent>
          </Card>
        </Grid>

        {/* Cost & Related Card */}
        <Grid size={{ xs: 12, md: 6 }}>
          <Card elevation={2} sx={{ height: '100%' }}>
            <CardContent>
              <Typography variant="h6" gutterBottom sx={{ fontWeight: 600 }}>
                Related
              </Typography>
              <Divider sx={{ mb: 2 }} />
              <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <Box>
                  <Typography variant="body2" color="text.secondary">
                    Quotes
                  </Typography>
                  <Typography variant="body1" fontWeight={500}>
                    {quotesCount} quote{quotesCount !== 1 ? 's' : ''}
                  </Typography>
                </Box>
                <Box>
                  <Typography variant="body2" color="text.secondary">
                    Jobs
                  </Typography>
                  <Typography variant="body1" fontWeight={500}>
                    {jobsCount} job{jobsCount !== 1 ? 's' : ''}
                  </Typography>
                </Box>
                <Box>
                  <Typography variant="body2" color="text.secondary">
                    Created
                  </Typography>
                  <Typography variant="body1" fontWeight={500}>
                    {formatDate(part.created_at)}
                  </Typography>
                </Box>
              </Box>
            </CardContent>
          </Card>
        </Grid>
      </Grid>

      {/* Delete Confirmation Dialog */}
      <Dialog open={deleteDialogOpen} onClose={() => setDeleteDialogOpen(false)}>
        <DialogTitle>Delete Part?</DialogTitle>
        <DialogContent>
          <Typography>
            Are you sure you want to delete <strong>{part.part_number}</strong>? This action cannot
            be undone.
          </Typography>
          {hasRelatedRecords && (
            <Alert severity="warning" sx={{ mt: 2 }}>
              This part has {quotesCount} quote{quotesCount !== 1 ? 's' : ''} and {jobsCount} job
              {jobsCount !== 1 ? 's' : ''}. These records will be kept but will no longer be linked
              to this part.
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
