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
import DeleteIcon from '@mui/icons-material/Delete';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import Chip from '@mui/material/Chip';
import Stack from '@mui/material/Stack';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';

import { getCustomerWithRelations, softDeleteCustomer } from '@/utils/customerAccess';
import type { CustomerAddress, CustomerWithRelations } from '@/types/customer';

export default function CustomerDetailPage() {
  const params = useParams();
  const router = useRouter();
  const companyId = params.companyId as string;
  const customerId = params.customerId as string;

  const [customer, setCustomer] = useState<CustomerWithRelations | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);

  useEffect(() => {
    fetchCustomer();
  }, [customerId]);

  const fetchCustomer = async () => {
    try {
      setLoading(true);
      const data = await getCustomerWithRelations(customerId);
      setCustomer(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load customer');
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async () => {
    setActionLoading(true);
    try {
      await softDeleteCustomer(customerId);
      router.push(`/dashboard/${companyId}/customers`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete customer');
      setActionLoading(false);
      setDeleteDialogOpen(false);
    }
  };

  const formatDate = (dateStr: string | null): string => {
    if (!dateStr) return '—';
    return new Date(dateStr).toLocaleDateString();
  };

  const formatAddressLines = (a: CustomerAddress): string => {
    const parts = [
      a.address_line1,
      a.address_line2,
      [a.city, a.state, a.postal_code].filter(Boolean).join(', ').trim(),
      a.country && a.country.toUpperCase() !== 'USA' ? a.country : null,
    ].filter((p) => p && p.toString().trim().length > 0);
    return parts.length > 0 ? parts.join('\n') : '—';
  };

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: 400 }}>
        <CircularProgress />
      </Box>
    );
  }

  if (!customer) {
    return (
      <Box>
        <Alert severity="error">Customer not found</Alert>
      </Box>
    );
  }

  const hasRelatedRecords = customer.quotes_count > 0 || customer.jobs_count > 0;

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
          onClick={() => router.push(`/dashboard/${companyId}/customers`)}
          sx={{ color: 'text.secondary' }}
        >
          Back to Customers
        </Button>

        <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
          <Button
            variant="outlined"
            startIcon={<EditIcon />}
            onClick={() => router.push(`/dashboard/${companyId}/customers/${customerId}/edit`)}
            disabled={actionLoading}
          >
            Edit
          </Button>

          <Tooltip title="Delete Customer">
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
                    Company Name
                  </Typography>
                  <Typography variant="body1" fontWeight={500}>
                    {customer.name}
                  </Typography>
                </Box>
                <Box>
                  <Typography variant="body2" color="text.secondary">
                    Website
                  </Typography>
                  {customer.website ? (
                    <MuiLink
                      href={customer.website.startsWith('http') ? customer.website : `https://${customer.website}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      sx={{ fontWeight: 500 }}
                    >
                      {customer.website}
                    </MuiLink>
                  ) : (
                    <Typography variant="body1" color="text.secondary">
                      —
                    </Typography>
                  )}
                </Box>
              </Box>
            </CardContent>
          </Card>
        </Grid>

        {/* Primary Contact Card */}
        <Grid size={{ xs: 12, md: 6 }}>
          <Card elevation={2} sx={{ height: '100%' }}>
            <CardContent>
              <Typography variant="h6" gutterBottom sx={{ fontWeight: 600 }}>
                Primary Contact
              </Typography>
              <Divider sx={{ mb: 2 }} />
              <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <Box>
                  <Typography variant="body2" color="text.secondary">
                    Contact Name
                  </Typography>
                  <Typography variant="body1" fontWeight={500}>
                    {customer.contact_name || '—'}
                  </Typography>
                </Box>
                <Box>
                  <Typography variant="body2" color="text.secondary">
                    Phone
                  </Typography>
                  {customer.contact_phone ? (
                    <MuiLink href={`tel:${customer.contact_phone}`} sx={{ fontWeight: 500 }}>
                      {customer.contact_phone}
                    </MuiLink>
                  ) : (
                    <Typography variant="body1" color="text.secondary">
                      —
                    </Typography>
                  )}
                </Box>
                <Box>
                  <Typography variant="body2" color="text.secondary">
                    Email
                  </Typography>
                  {customer.contact_email ? (
                    <MuiLink href={`mailto:${customer.contact_email}`} sx={{ fontWeight: 500 }}>
                      {customer.contact_email}
                    </MuiLink>
                  ) : (
                    <Typography variant="body1" color="text.secondary">
                      —
                    </Typography>
                  )}
                </Box>
              </Box>
            </CardContent>
          </Card>
        </Grid>

        {/* Addresses Card */}
        <Grid size={{ xs: 12, md: 6 }}>
          <Card elevation={2} sx={{ height: '100%' }}>
            <CardContent>
              <Typography variant="h6" gutterBottom sx={{ fontWeight: 600 }}>
                Addresses
              </Typography>
              <Divider sx={{ mb: 2 }} />
              {customer.addresses.length === 0 ? (
                <Typography variant="body1" color="text.secondary">
                  No addresses on file
                </Typography>
              ) : (
                <Stack spacing={2}>
                  {customer.addresses.map((a) => (
                    <Box key={a.id}>
                      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, alignItems: 'center', mb: 0.5 }}>
                        {a.label && (
                          <Typography variant="body2" fontWeight={600} sx={{ mr: 1 }}>
                            {a.label}
                          </Typography>
                        )}
                        {a.is_billing && (
                          <Chip size="small" color="primary" label="Billing" />
                        )}
                        {a.is_shipping && (
                          <Chip size="small" color="primary" label="Shipping" />
                        )}
                      </Box>
                      <Typography variant="body1" sx={{ whiteSpace: 'pre-line' }}>
                        {formatAddressLines(a)}
                      </Typography>
                    </Box>
                  ))}
                </Stack>
              )}
            </CardContent>
          </Card>
        </Grid>

        {/* Related Entities Card */}
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
                    {customer.quotes_count} quote{customer.quotes_count !== 1 ? 's' : ''}
                  </Typography>
                </Box>
                <Box>
                  <Typography variant="body2" color="text.secondary">
                    Jobs
                  </Typography>
                  <Typography variant="body1" fontWeight={500}>
                    {customer.jobs_count} job{customer.jobs_count !== 1 ? 's' : ''}
                  </Typography>
                </Box>
                <Box>
                  <Typography variant="body2" color="text.secondary">
                    Created
                  </Typography>
                  <Typography variant="body1" fontWeight={500}>
                    {formatDate(customer.created_at)}
                  </Typography>
                </Box>
              </Box>
            </CardContent>
          </Card>
        </Grid>
      </Grid>

      {/* Delete Confirmation Dialog */}
      <Dialog open={deleteDialogOpen} onClose={() => setDeleteDialogOpen(false)}>
        <DialogTitle>Delete Customer?</DialogTitle>
        <DialogContent>
          <Typography>
            Are you sure you want to delete <strong>{customer.name}</strong>? This action cannot be
            undone.
          </Typography>
          {hasRelatedRecords && (
            <Alert severity="warning" sx={{ mt: 2 }}>
              This customer has {customer.quotes_count} quote{customer.quotes_count !== 1 ? 's' : ''} and{' '}
              {customer.jobs_count} job{customer.jobs_count !== 1 ? 's' : ''}. These records will be
              kept but will no longer be linked to this customer.
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
