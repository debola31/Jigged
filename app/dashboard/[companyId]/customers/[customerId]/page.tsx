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
import Stack from '@mui/material/Stack';
import MuiLink from '@mui/material/Link';
import EditIcon from '@mui/icons-material/Edit';
import DeleteIcon from '@mui/icons-material/Delete';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import AddIcon from '@mui/icons-material/Add';
import StarIcon from '@mui/icons-material/Star';
import StarOutlineIcon from '@mui/icons-material/StarOutline';

import {
  getCustomerWithRelations,
  softDeleteCustomer,
} from '@/utils/customerAccess';
import {
  getContactsForCustomer,
  deleteCustomerContact,
  setPrimaryContact,
} from '@/utils/customerContactsAccess';
import {
  getAddressesForCustomer,
  deleteCustomerAddress,
} from '@/utils/customerAddressesAccess';
import { roleDisplayLabel } from '@/types/customerContact';
import type { CustomerContact } from '@/types/customerContact';
import type { CustomerAddress, CustomerWithRelations } from '@/types/customer';
import { CustomerContactModal, CustomerAddressModal } from '@/components/customers';
import CustomerShippingDefaultsCard from '@/components/customers/CustomerShippingDefaultsCard';

function formatAddressLines(a: CustomerAddress): string {
  const parts = [
    a.address_line1,
    a.address_line2,
    [a.city, a.state, a.postal_code].filter(Boolean).join(', ').trim(),
    a.country && a.country.toUpperCase() !== 'USA' ? a.country : null,
  ].filter((p) => p && p.toString().trim().length > 0);
  return parts.length > 0 ? parts.join('\n') : '—';
}

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString();
}

export default function CustomerDetailPage() {
  const params = useParams();
  const router = useRouter();
  const companyId = params.companyId as string;
  const customerId = params.customerId as string;

  const [customer, setCustomer] = useState<CustomerWithRelations | null>(null);
  const [contacts, setContacts] = useState<CustomerContact[]>([]);
  const [addresses, setAddresses] = useState<CustomerAddress[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);

  // Contact modal state.
  const [contactModalOpen, setContactModalOpen] = useState(false);
  const [editingContact, setEditingContact] = useState<CustomerContact | undefined>(
    undefined,
  );
  const [deleteContactId, setDeleteContactId] = useState<string | null>(null);

  // Address modal state.
  const [addressModalOpen, setAddressModalOpen] = useState(false);
  const [editingAddress, setEditingAddress] = useState<CustomerAddress | undefined>(
    undefined,
  );
  const [deleteAddressId, setDeleteAddressId] = useState<string | null>(null);

  const fetchAll = useCallback(async () => {
    try {
      setLoading(true);
      const c = await getCustomerWithRelations(customerId);
      setCustomer(c);
      if (c) {
        const [contactList, addrList] = await Promise.all([
          getContactsForCustomer(customerId),
          getAddressesForCustomer(customerId),
        ]);
        setContacts(contactList);
        setAddresses(addrList);
      }
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load customer');
    } finally {
      setLoading(false);
    }
  }, [customerId]);

  const refreshContacts = useCallback(async () => {
    try {
      const contactList = await getContactsForCustomer(customerId);
      setContacts(contactList);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to refresh contacts');
    }
  }, [customerId]);

  const refreshAddresses = useCallback(async () => {
    try {
      const addrList = await getAddressesForCustomer(customerId);
      setAddresses(addrList);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to refresh addresses');
    }
  }, [customerId]);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

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

  const handleAddContact = () => {
    setEditingContact(undefined);
    setContactModalOpen(true);
  };
  const handleEditContact = (c: CustomerContact) => {
    setEditingContact(c);
    setContactModalOpen(true);
  };
  const handleDeleteContact = async () => {
    if (!deleteContactId) return;
    setActionLoading(true);
    try {
      await deleteCustomerContact(deleteContactId);
      setDeleteContactId(null);
      await refreshContacts();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete contact');
    } finally {
      setActionLoading(false);
    }
  };
  const handleSetPrimaryContact = async (contactId: string) => {
    setActionLoading(true);
    try {
      await setPrimaryContact(customerId, contactId);
      await refreshContacts();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to set primary');
    } finally {
      setActionLoading(false);
    }
  };

  const handleAddAddress = () => {
    setEditingAddress(undefined);
    setAddressModalOpen(true);
  };
  const handleEditAddress = (a: CustomerAddress) => {
    setEditingAddress(a);
    setAddressModalOpen(true);
  };
  const handleDeleteAddress = async () => {
    if (!deleteAddressId) return;
    setActionLoading(true);
    try {
      await deleteCustomerAddress(deleteAddressId);
      setDeleteAddressId(null);
      await refreshAddresses();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete address');
    } finally {
      setActionLoading(false);
    }
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
  const contactBeingDeleted = deleteContactId
    ? contacts.find((c) => c.id === deleteContactId)
    : undefined;
  const addressBeingDeleted = deleteAddressId
    ? addresses.find((a) => a.id === deleteAddressId)
    : undefined;

  return (
    <Box>
      {/* Top toolbar */}
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
          <Tooltip
            title={
              hasRelatedRecords
                ? 'Cannot delete — customer is referenced by quotes or jobs'
                : 'Delete Customer'
            }
          >
            <span>
              <IconButton
                onClick={() => setDeleteDialogOpen(true)}
                disabled={actionLoading || hasRelatedRecords}
                sx={{
                  color: 'text.secondary',
                  '&:hover': { color: 'error.main', bgcolor: 'rgba(239, 68, 68, 0.1)' },
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

      {/* Header card: name + website + timestamps */}
      <Card elevation={2} sx={{ mb: 3 }}>
        <CardContent>
          <Box
            sx={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'flex-start',
              gap: 2,
              flexWrap: 'wrap',
            }}
          >
            <Box>
              <Typography variant="h5" sx={{ fontWeight: 600 }}>
                {customer.name}
              </Typography>
              {customer.website && (
                <MuiLink
                  href={
                    customer.website.startsWith('http')
                      ? customer.website
                      : `https://${customer.website}`
                  }
                  target="_blank"
                  rel="noopener noreferrer"
                  sx={{ fontWeight: 500 }}
                >
                  {customer.website}
                </MuiLink>
              )}
            </Box>
            <Box sx={{ textAlign: 'right' }}>
              <Typography variant="caption" color="text.secondary" display="block">
                Created {formatDate(customer.created_at)}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                Updated {formatDate(customer.updated_at)}
              </Typography>
            </Box>
          </Box>
        </CardContent>
      </Card>

      <Grid container spacing={3}>
        {/* Contacts card */}
        <Grid size={{ xs: 12, md: 6 }}>
          <Card elevation={2} sx={{ height: '100%' }}>
            <CardContent>
              <Box
                sx={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  mb: 2,
                }}
              >
                <Typography variant="h6" sx={{ fontWeight: 600 }}>
                  Contacts ({contacts.length})
                </Typography>
                {contacts.length > 0 && (
                  <Button
                    size="small"
                    variant="outlined"
                    startIcon={<AddIcon />}
                    onClick={handleAddContact}
                    disabled={actionLoading}
                  >
                    Add Contact
                  </Button>
                )}
              </Box>
              <Divider sx={{ mb: 2 }} />

              {contacts.length === 0 ? (
                <Box sx={{ textAlign: 'center', py: 4 }}>
                  <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                    No contacts yet.
                  </Typography>
                  <Button
                    variant="contained"
                    startIcon={<AddIcon />}
                    onClick={handleAddContact}
                    disabled={actionLoading}
                  >
                    Add Contact
                  </Button>
                </Box>
              ) : (
                <Stack spacing={2}>
                  {contacts.map((contact) => (
                    <Box
                      key={contact.id}
                      sx={{
                        p: 2,
                        borderRadius: 1,
                        bgcolor: 'background.default',
                        border: 1,
                        borderColor: contact.is_primary ? 'primary.main' : 'divider',
                      }}
                    >
                      <Box
                        sx={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'flex-start',
                          gap: 1,
                        }}
                      >
                        <Box sx={{ flex: 1, minWidth: 0 }}>
                          <Box
                            sx={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: 1,
                              mb: 0.5,
                              flexWrap: 'wrap',
                            }}
                          >
                            {contact.is_primary && (
                              <Tooltip title="Primary contact">
                                <StarIcon sx={{ color: 'primary.main', fontSize: 18 }} />
                              </Tooltip>
                            )}
                            <Typography variant="body1" sx={{ fontWeight: 600 }}>
                              {contact.name}
                            </Typography>
                            <Chip size="small" label={roleDisplayLabel(contact)} variant="outlined" />
                          </Box>
                          <Stack direction="row" spacing={2} sx={{ flexWrap: 'wrap', mt: 0.5 }}>
                            {contact.email && (
                              <MuiLink href={`mailto:${contact.email}`} variant="body2">
                                {contact.email}
                              </MuiLink>
                            )}
                            {contact.phone && (
                              <MuiLink href={`tel:${contact.phone}`} variant="body2">
                                {contact.phone}
                              </MuiLink>
                            )}
                            {!contact.email && !contact.phone && (
                              <Typography variant="body2" color="text.secondary">
                                No email or phone
                              </Typography>
                            )}
                          </Stack>
                        </Box>
                        <Stack direction="row" spacing={0.5}>
                          {!contact.is_primary && (
                            <Tooltip title="Set as primary">
                              <span>
                                <IconButton
                                  size="small"
                                  onClick={() => handleSetPrimaryContact(contact.id)}
                                  disabled={actionLoading}
                                >
                                  <StarOutlineIcon fontSize="small" />
                                </IconButton>
                              </span>
                            </Tooltip>
                          )}
                          <Tooltip title="Edit contact">
                            <span>
                              <IconButton
                                size="small"
                                onClick={() => handleEditContact(contact)}
                                disabled={actionLoading}
                              >
                                <EditIcon fontSize="small" />
                              </IconButton>
                            </span>
                          </Tooltip>
                          <Tooltip title="Delete contact">
                            <span>
                              <IconButton
                                size="small"
                                onClick={() => setDeleteContactId(contact.id)}
                                disabled={actionLoading}
                                sx={{ '&:hover': { color: 'error.main' } }}
                              >
                                <DeleteIcon fontSize="small" />
                              </IconButton>
                            </span>
                          </Tooltip>
                        </Stack>
                      </Box>
                    </Box>
                  ))}
                </Stack>
              )}
            </CardContent>
          </Card>
        </Grid>

        {/* Addresses card */}
        <Grid size={{ xs: 12, md: 6 }}>
          <Card elevation={2} sx={{ height: '100%' }}>
            <CardContent>
              <Box
                sx={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  mb: 2,
                }}
              >
                <Typography variant="h6" sx={{ fontWeight: 600 }}>
                  Addresses ({addresses.length})
                </Typography>
                {addresses.length > 0 && (
                  <Button
                    size="small"
                    variant="outlined"
                    startIcon={<AddIcon />}
                    onClick={handleAddAddress}
                    disabled={actionLoading}
                  >
                    Add Address
                  </Button>
                )}
              </Box>
              <Divider sx={{ mb: 2 }} />

              {addresses.length === 0 ? (
                <Box sx={{ textAlign: 'center', py: 4 }}>
                  <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                    No addresses yet.
                  </Typography>
                  <Button
                    variant="contained"
                    startIcon={<AddIcon />}
                    onClick={handleAddAddress}
                    disabled={actionLoading}
                  >
                    Add Address
                  </Button>
                </Box>
              ) : (
                <Stack spacing={2}>
                  {addresses.map((a) => (
                    <Box
                      key={a.id}
                      sx={{
                        p: 2,
                        borderRadius: 1,
                        bgcolor: 'background.default',
                        border: 1,
                        borderColor: a.default_billing || a.default_shipping ? 'primary.main' : 'divider',
                      }}
                    >
                      <Box
                        sx={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'flex-start',
                          gap: 1,
                        }}
                      >
                        <Box sx={{ flex: 1, minWidth: 0 }}>
                          <Box
                            sx={{
                              display: 'flex',
                              flexWrap: 'wrap',
                              gap: 0.5,
                              alignItems: 'center',
                              mb: 0.5,
                            }}
                          >
                            {a.default_billing && (
                              <Chip size="small" color="primary" label="Billing" />
                            )}
                            {a.default_shipping && (
                              <Chip size="small" color="primary" label="Shipping" />
                            )}
                            {!a.default_billing && !a.default_shipping && (
                              <Chip size="small" variant="outlined" label="Not assigned" />
                            )}
                          </Box>
                          <Typography variant="body1" sx={{ whiteSpace: 'pre-line' }}>
                            {formatAddressLines(a)}
                          </Typography>
                        </Box>
                        <Stack direction="row" spacing={0.5}>
                          <Tooltip title="Edit address">
                            <span>
                              <IconButton
                                size="small"
                                onClick={() => handleEditAddress(a)}
                                disabled={actionLoading}
                              >
                                <EditIcon fontSize="small" />
                              </IconButton>
                            </span>
                          </Tooltip>
                          <Tooltip title="Delete address">
                            <span>
                              <IconButton
                                size="small"
                                onClick={() => setDeleteAddressId(a.id)}
                                disabled={actionLoading}
                                sx={{ '&:hover': { color: 'error.main' } }}
                              >
                                <DeleteIcon fontSize="small" />
                              </IconButton>
                            </span>
                          </Tooltip>
                        </Stack>
                      </Box>
                    </Box>
                  ))}
                </Stack>
              )}
            </CardContent>
          </Card>
        </Grid>

        {/* Shipping defaults — prefill packing-slip fields on new shipments. */}
        <Grid size={{ xs: 12 }}>
          <CustomerShippingDefaultsCard customer={customer} onSaved={fetchAll} />
        </Grid>

        {/* Related entities */}
        <Grid size={{ xs: 12 }}>
          <Card elevation={2}>
            <CardContent>
              <Typography variant="h6" gutterBottom sx={{ fontWeight: 600 }}>
                Related
              </Typography>
              <Divider sx={{ mb: 2 }} />
              <Stack direction="row" spacing={3} flexWrap="wrap">
                <Box>
                  <Typography variant="body2" color="text.secondary">
                    Quotes
                  </Typography>
                  <Typography variant="h6">{customer.quotes_count}</Typography>
                </Box>
                <Box>
                  <Typography variant="body2" color="text.secondary">
                    Jobs
                  </Typography>
                  <Typography variant="h6">{customer.jobs_count}</Typography>
                </Box>
              </Stack>
            </CardContent>
          </Card>
        </Grid>
      </Grid>

      {/* Contact modal */}
      <CustomerContactModal
        open={contactModalOpen}
        onClose={() => setContactModalOpen(false)}
        customerId={customerId}
        existing={editingContact}
        onSaved={refreshContacts}
      />

      {/* Address modal */}
      <CustomerAddressModal
        open={addressModalOpen}
        onClose={() => setAddressModalOpen(false)}
        customerId={customerId}
        existing={editingAddress}
        onSaved={refreshAddresses}
      />

      {/* Delete contact confirmation */}
      <Dialog
        open={!!deleteContactId}
        onClose={() => !actionLoading && setDeleteContactId(null)}
      >
        <DialogTitle>Delete contact?</DialogTitle>
        <DialogContent>
          <Typography>
            Delete <strong>{contactBeingDeleted?.name ?? 'this contact'}</strong>?
            This can&apos;t be undone.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteContactId(null)} disabled={actionLoading}>
            Cancel
          </Button>
          <Button
            onClick={handleDeleteContact}
            color="error"
            variant="contained"
            disabled={actionLoading}
          >
            Delete
          </Button>
        </DialogActions>
      </Dialog>

      {/* Delete address confirmation */}
      <Dialog
        open={!!deleteAddressId}
        onClose={() => !actionLoading && setDeleteAddressId(null)}
      >
        <DialogTitle>Delete address?</DialogTitle>
        <DialogContent>
          <Typography>
            Delete this address?
            {addressBeingDeleted && (addressBeingDeleted.default_billing || addressBeingDeleted.default_shipping) && (
              <>
                {' '}
                The customer will be left without a default{' '}
                {addressBeingDeleted.default_billing ? 'billing' : ''}
                {addressBeingDeleted.default_billing && addressBeingDeleted.default_shipping ? ' and ' : ''}
                {addressBeingDeleted.default_shipping ? 'shipping' : ''} address until you tag another row.
              </>
            )}
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteAddressId(null)} disabled={actionLoading}>
            Cancel
          </Button>
          <Button
            onClick={handleDeleteAddress}
            color="error"
            variant="contained"
            disabled={actionLoading}
          >
            Delete
          </Button>
        </DialogActions>
      </Dialog>

      {/* Delete customer confirmation */}
      <Dialog open={deleteDialogOpen} onClose={() => setDeleteDialogOpen(false)}>
        <DialogTitle>Delete Customer?</DialogTitle>
        <DialogContent>
          <Typography>
            Permanently delete <strong>{customer.name}</strong>? Their contacts
            and addresses will be deleted too. This can&apos;t be undone.
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
