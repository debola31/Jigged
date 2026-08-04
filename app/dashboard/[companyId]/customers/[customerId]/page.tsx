'use client';

import { useState } from 'react';
import Link from 'next/link';
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
import DeleteIcon from '@mui/icons-material/Delete';
import EditIcon from '@mui/icons-material/Edit';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import AddIcon from '@mui/icons-material/Add';
import StarIcon from '@mui/icons-material/Star';
import StarOutlineIcon from '@mui/icons-material/StarOutline';
import ReceiptLongIcon from '@mui/icons-material/ReceiptLong';
import ArchiveOutlinedIcon from '@mui/icons-material/ArchiveOutlined';

import {
  getCustomerWithRelations,
  softDeleteCustomer,
  updateCustomer,
  checkCustomerNameExists,
} from '@/utils/customerAccess';
import { type SaveState } from '@/components/common/SaveStatus';
import CustomerIdentityFields from '@/components/customers/CustomerIdentityFields';
import CustomerTermsCard from '@/components/customers/CustomerTermsCard';
import CustomerCreditCard from '@/components/customers/CustomerCreditCard';
import {
  hasChanged,
  normalizeSnapshot,
  type EditableCustomerField,
} from '@/components/customers/customerFieldEditing';
import {
  getContactsForCustomer,
  archiveCustomerContact,
  setPrimaryContact,
  setBillingDefaultContact,
} from '@/utils/customerContactsAccess';
import {
  getAddressesForCustomer,
  deleteCustomerAddress,
} from '@/utils/customerAddressesAccess';
import {
  getCarrierAccountsForCustomer,
  archiveCarrierAccount,
} from '@/utils/customerCarrierAccountsAccess';
import { roleDisplayLabel } from '@/types/customerContact';
import type { CustomerContact } from '@/types/customerContact';
import { JOB_LIFECYCLE_STAGE_CONFIG, type JobLifecycleStage } from '@/types/job';
import type { CustomerAddress, CustomerFormData } from '@/types/customer';
import { EMPTY_CUSTOMER_FORM, customerToFormData } from '@/types/customer';
import { BILL_TO_PARTY_LABELS } from '@/types/customerCarrierAccount';
import type { CustomerCarrierAccount } from '@/types/customerCarrierAccount';
import {
  CustomerContactModal,
  CustomerAddressForm,
  CarrierAccountModal,
} from '@/components/customers';

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

// Stable empty fallbacks so the derived lists keep a constant identity while
// the first load is in flight.
const EMPTY_CONTACTS: CustomerContact[] = [];
const EMPTY_ADDRESSES: CustomerAddress[] = [];
const EMPTY_CARRIER_ACCOUNTS: CustomerCarrierAccount[] = [];

/**
 * Every lifecycle stage, for the Jobs deep link. The jobs list defaults to the
 * OPEN stages only, so a link that didn't say otherwise would show fewer rows
 * than the count promised — and the page also restores a device-local saved
 * selection whenever ?status= is absent, which would make the same link behave
 * differently on different machines.
 */
const ALL_JOB_STAGES = (Object.keys(JOB_LIFECYCLE_STAGE_CONFIG) as JobLifecycleStage[]).join(',');

export default function CustomerDetailPage() {
  const params = useParams();
  const router = useRouter();
  const companyId = params.companyId as string;
  const customerId = params.customerId as string;

  const [actionLoading, setActionLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);

  // Contact modal state.
  const [contactModalOpen, setContactModalOpen] = useState(false);
  const [editingContact, setEditingContact] = useState<CustomerContact | undefined>(
    undefined,
  );
  const [deleteContactId, setDeleteContactId] = useState<string | null>(null);

  // Inline address add/edit form state (rendered in place, not a modal).
  const [addressFormOpen, setAddressFormOpen] = useState(false);
  const [editingAddress, setEditingAddress] = useState<CustomerAddress | undefined>(
    undefined,
  );
  const [deleteAddressId, setDeleteAddressId] = useState<string | null>(null);

  const [carrierModalOpen, setCarrierModalOpen] = useState(false);
  const [editingCarrierAccount, setEditingCarrierAccount] = useState<
    CustomerCarrierAccount | undefined
  >(undefined);
  const [deleteCarrierAccountId, setDeleteCarrierAccountId] = useState<string | null>(null);

  // Load the customer, then (only if it exists) its contacts and addresses in
  // parallel. useLoad keeps every setState inside the async callback, so the
  // load effect can't trip set-state-in-effect.
  const {
    data,
    loading,
    reload: fetchAll,
  } = useLoad(
    async () => {
      const c = await getCustomerWithRelations(customerId);
      if (!c) {
        return {
          customer: null,
          contacts: EMPTY_CONTACTS,
          addresses: EMPTY_ADDRESSES,
          carrierAccounts: EMPTY_CARRIER_ACCOUNTS,
        };
      }
      const [contacts, addresses, carrierAccounts] = await Promise.all([
        getContactsForCustomer(customerId),
        getAddressesForCustomer(customerId),
        getCarrierAccountsForCustomer(customerId),
      ]);
      return { customer: c, contacts, addresses, carrierAccounts };
    },
    [customerId],
    {
      onError: (err) =>
        setError(err instanceof Error ? err.message : 'Failed to load customer'),
    },
  );
  const customer = data?.customer ?? null;

  // ---------------------------------------------------------------------------
  // In-place editing of the customer's OWN fields.
  // ---------------------------------------------------------------------------
  // ONE snapshot for the whole page, deliberately. updateCustomer writes the
  // FULL column set every time (formDataToColumns emits all seven, '' -> null),
  // so a card holding its own copy would persist STALE siblings: set a credit
  // hold, then edit Website in the header, and the header's snapshot — still
  // carrying credit_status 'open' — silently lifts the hold. One state means
  // that cannot happen. See components/customers/customerFieldEditing.ts.
  const [form, setForm] = useState<CustomerFormData>(EMPTY_CUSTOMER_FORM);
  const [savedForm, setSavedForm] = useState<CustomerFormData>(EMPTY_CUSTOMER_FORM);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [fieldErrors, setFieldErrors] = useState<
    Partial<Record<EditableCustomerField, string>>
  >({});

  const isArchived = !!customer?.deleted_at;

  // Seed from the loaded row. Keyed on the customer's updated_at so a reload
  // after an external change re-seeds, while ordinary re-renders don't stomp
  // what the user is typing.
  const seedKey = customer ? `${customer.id}:${customer.updated_at ?? ''}` : null;
  const [seededKey, setSeededKey] = useState<string | null>(null);
  if (customer && seedKey !== seededKey) {
    const seeded = customerToFormData(customer);
    setForm(seeded);
    setSavedForm(seeded);
    setSeededKey(seedKey);
  }

  const onTextChange = (field: EditableCustomerField, value: string) => {
    setForm((prev) => ({ ...prev, [field]: value }));
    if (fieldErrors[field]) setFieldErrors((p) => ({ ...p, [field]: '' }));
    if (saveState === 'saved') setSaveState('idle');
  };

  /**
   * Persist a full next-snapshot.
   *
   * The name is checked for uniqueness BEFORE the write, and the three outcomes
   * are deliberately different:
   *   unique     -> write
   *   duplicate  -> field error, no write, the typed value stays put
   *   check THREW -> "couldn't check", no write
   * That last one matters: per CLAUDE.md a failed check is never a definitive
   * negative, so a dropped request must not be reported to the user as "that
   * name is taken".
   */
  const persist = async (next: CustomerFormData) => {
    if (!customer || isArchived) return;
    const normalized = normalizeSnapshot(next);
    if (!hasChanged(normalized, savedForm)) return;

    if (!normalized.name) {
      setFieldErrors((p) => ({ ...p, name: 'Company name is required' }));
      setSaveState('error');
      return;
    }
    if (normalized.name !== savedForm.name) {
      try {
        const exists = await checkCustomerNameExists(companyId, normalized.name, customer.id);
        if (exists) {
          setFieldErrors((p) => ({ ...p, name: 'A customer with this name already exists' }));
          setSaveState('error');
          return;
        }
      } catch {
        setFieldErrors((p) => ({ ...p, name: 'Could not check the name — try again' }));
        setSaveState('error');
        return;
      }
    }

    setSaveState('saving');
    setError(null);
    try {
      const updated = await updateCustomer(customer.id, normalized);
      const reseeded = customerToFormData(updated);
      setForm(reseeded);
      setSavedForm(reseeded);
      setFieldErrors({});
      setSaveState('saved');
      // Refresh so the counts, chips and header reflect the new row without a
      // second source of truth for what the customer currently says.
      await fetchAll();
    } catch (err) {
      setSaveState('error');
      setError(err instanceof Error ? err.message : 'Failed to save');
    }
  };

  const onTextBlur = () => void persist(form);
  const onSelectChange = (patch: Partial<CustomerFormData>) => {
    const next = { ...form, ...patch };
    setForm(next);
    void persist(next);
  };

  const contacts = data?.contacts ?? EMPTY_CONTACTS;
  const addresses = data?.addresses ?? EMPTY_ADDRESSES;
  const carrierAccounts = data?.carrierAccounts ?? EMPTY_CARRIER_ACCOUNTS;

  // Contact/address mutations re-run the full loader (reload). Cheap at customer
  // scale and keeps a single read path rather than separate per-list fetches.
  const refreshContacts = fetchAll;
  const refreshAddresses = fetchAll;

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
  /**
   * "Delete" a carrier account archives it, matching the archive standard: a
   * shipment already billed to this account keeps resolving it for history,
   * while the account stops being offered on new ones.
   */
  const handleDeleteCarrierAccount = async () => {
    if (!deleteCarrierAccountId) return;
    setActionLoading(true);
    try {
      await archiveCarrierAccount(deleteCarrierAccountId);
      setDeleteCarrierAccountId(null);
      await fetchAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete carrier account');
    } finally {
      setActionLoading(false);
    }
  };

  const handleDeleteContact = async () => {
    if (!deleteContactId) return;
    setActionLoading(true);
    try {
      await archiveCustomerContact(deleteContactId);
      setDeleteContactId(null);
      await refreshContacts();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove contact');
    } finally {
      setActionLoading(false);
    }
  };
  /**
   * Toggle who invoices go to. Clicking the current billing contact clears it —
   * a customer is allowed to have none, and forcing one would make the office
   * name a person they haven't agreed on.
   */
  const handleToggleBillingDefault = async (contactId: string, isCurrent: boolean) => {
    setActionLoading(true);
    try {
      await setBillingDefaultContact(customerId, isCurrent ? null : contactId);
      await refreshContacts();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to set billing contact');
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
    setAddressFormOpen(true);
  };
  const handleEditAddress = (a: CustomerAddress) => {
    setEditingAddress(a);
    setAddressFormOpen(true);
  };
  const handleAddressSaved = async () => {
    setAddressFormOpen(false);
    setEditingAddress(undefined);
    await refreshAddresses();
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
          {/* No Edit button. Everything on this page is edited in place — the
              button used to route to /customers/{id}/edit for the customer's
              own fields while contacts, addresses and carrier accounts were
              already editable here, which is the inconsistency it removes. */}
          <Tooltip title="Delete (archive) this customer">
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
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, flexWrap: 'wrap' }}>
                {/* Credit hold sits beside the name because it changes how you
                    treat everything else on the page. Informational only —
                    nothing here or downstream blocks on it. */}
                {form.credit_status === 'hold' && (
                  <Chip label="On credit hold" color="warning" size="small" />
                )}
                {/* This page is reachable for an ARCHIVED customer by an
                    ordinary click, not just a hand-typed URL — every quote and
                    job links straight here, and the by-id read deliberately
                    doesn't filter deleted_at so those links keep resolving.
                    Without this the page looks completely live, Edit and Delete
                    included. */}
                {customer.deleted_at && (
                  <Chip
                    label="Archived"
                    size="small"
                    variant="outlined"
                    icon={<ArchiveOutlinedIcon />}
                  />
                )}
              </Box>
              {customer.deleted_at && (
                <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                  Removed from your lists. Quotes and jobs that reference it still
                  work. Re-creating or re-importing the same name brings it back.
                </Typography>
              )}
              {isArchived && form.credit_status === 'hold' && form.credit_hold_note && (
                <Typography variant="body2" color="warning.main" sx={{ mt: 0.5 }}>
                  {form.credit_hold_note}
                </Typography>
              )}
              {/* The name reads as a heading with a pencil beside it — it is
                  read constantly and renamed almost never, so an always-live
                  input in the title position would make the page look like a
                  form. Everything else on this page (terms, credit) auto-saves
                  in place; there is no Edit route any more. */}
              <Box sx={{ mt: isArchived ? 0 : 1 }}>
                <CustomerIdentityFields
                  form={form}
                  fieldErrors={fieldErrors}
                  onTextChange={onTextChange}
                  onTextBlur={onTextBlur}
                  onSelectChange={onSelectChange}
                  readOnly={isArchived}
                  saveState={saveState}
                  displayName={savedForm.name || customer.name}
                  onCancelEdit={() => setForm(savedForm)}
                />
              </Box>
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
                            {/* Named separately from the role chip: a contact's
                                role is who they ARE at the customer, this is a
                                job we've given them. The AP clerk is usually the
                                billing contact, but not always — a buyer at a
                                small shop often is too. */}
                            {contact.is_billing_default && (
                              <Chip
                                size="small"
                                color="primary"
                                variant="outlined"
                                icon={<ReceiptLongIcon />}
                                label="Invoices"
                              />
                            )}
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
                          <Tooltip
                            title={
                              contact.is_billing_default
                                ? 'Stop sending invoices here'
                                : 'Send invoices to this contact'
                            }
                          >
                            <span>
                              <IconButton
                                size="small"
                                onClick={() =>
                                  handleToggleBillingDefault(
                                    contact.id,
                                    contact.is_billing_default,
                                  )
                                }
                                disabled={actionLoading}
                                color={contact.is_billing_default ? 'primary' : 'default'}
                              >
                                <ReceiptLongIcon fontSize="small" />
                              </IconButton>
                            </span>
                          </Tooltip>
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
                {addresses.length > 0 && !addressFormOpen && (
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

              {addressFormOpen ? (
                <CustomerAddressForm
                  customerId={customerId}
                  existing={editingAddress}
                  onSaved={handleAddressSaved}
                  onCancel={() => {
                    setAddressFormOpen(false);
                    setEditingAddress(undefined);
                  }}
                />
              ) : addresses.length === 0 ? (
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

        {/* Standing terms — read-only here, edited on the customer form.
            These were previously enterable but invisible: you could save terms
            and never see them again, which is the opposite of the "somewhere to
            save it so I don't keep it in my head" the field exists for.
            Values are prose, so body1 rather than the h6 the Related counts use. */}
        <Grid size={{ xs: 12, md: 6 }}>
          <CustomerTermsCard
            companyId={companyId}
            form={form}
            fieldErrors={fieldErrors}
            onTextChange={onTextChange}
            onTextBlur={onTextBlur}
            onSelectChange={onSelectChange}
            readOnly={isArchived}
            saveState={saveState}
          />
        </Grid>

        {/* Credit sits BESIDE Terms, not inside it: what we agreed vs whether
            we'll ship to them right now are different decisions. It also has no
            other home — CustomerForm was the only writer until the edit route
            went away. */}
        <Grid size={{ xs: 12, md: 6 }}>
          <CustomerCreditCard
            form={form}
            fieldErrors={fieldErrors}
            onTextChange={onTextChange}
            onTextBlur={onTextBlur}
            onSelectChange={onSelectChange}
            readOnly={isArchived}
            saveState={saveState}
          />
        </Grid>

        {/* Shipping — the customer's own carrier accounts, so their freight
            bills to them instead of to us. Called "Shipping", not "Freight":
            to a machinist "freight" means all shipping cost, so a tab by that
            name reads as the wrong thing. */}
        <Grid size={{ xs: 12 }}>
          <Card elevation={2}>
            <CardContent>
              <Box
                sx={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  gap: 2,
                  flexWrap: 'wrap',
                }}
              >
                <Typography variant="h6" sx={{ fontWeight: 600 }}>
                  Shipping ({carrierAccounts.length})
                </Typography>
                <Button
                  size="small"
                  startIcon={<AddIcon />}
                  onClick={() => {
                    setEditingCarrierAccount(undefined);
                    setCarrierModalOpen(true);
                  }}
                  disabled={actionLoading}
                >
                  Add account
                </Button>
              </Box>
              <Divider sx={{ my: 2 }} />
              {carrierAccounts.length === 0 ? (
                <Typography variant="body2" color="text.secondary">
                  No carrier accounts. Add one if this customer wants their
                  shipments billed to their own UPS or FedEx account.
                </Typography>
              ) : (
                <Stack spacing={2}>
                  {carrierAccounts.map((acct) => (
                    <Box
                      key={acct.id}
                      sx={{
                        border: '1px solid',
                        borderColor: 'divider',
                        borderRadius: 1,
                        p: 2,
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'flex-start',
                        gap: 2,
                        flexWrap: 'wrap',
                      }}
                    >
                      <Box sx={{ minWidth: 0 }}>
                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
                          <Typography variant="body1" sx={{ fontWeight: 600 }}>
                            {acct.carrier}
                          </Typography>
                          <Chip
                            label={BILL_TO_PARTY_LABELS[acct.bill_to_party]}
                            size="small"
                            variant="outlined"
                          />
                        </Box>
                        {/* Shown in full: this page is behind auth, and the whole
                            point is that whoever ships can read the number. The
                            printed slip redacts it — see maskAccountNumber. */}
                        <Typography variant="body2" color="text.secondary">
                          {acct.account_number
                            ? `Account ${acct.account_number}`
                            : 'No account number (billed on the BOL)'}
                          {acct.account_postal_code && ` · ZIP ${acct.account_postal_code}`}
                        </Typography>
                        {acct.notes && (
                          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                            {acct.notes}
                          </Typography>
                        )}
                      </Box>
                      <Box sx={{ display: 'flex', gap: 0.5 }}>
                        <Button
                          size="small"
                          onClick={() => {
                            setEditingCarrierAccount(acct);
                            setCarrierModalOpen(true);
                          }}
                          disabled={actionLoading}
                        >
                          Edit
                        </Button>
                        <Button
                          size="small"
                          color="error"
                          onClick={() => setDeleteCarrierAccountId(acct.id)}
                          disabled={actionLoading}
                        >
                          Delete
                        </Button>
                      </Box>
                    </Box>
                  ))}
                </Stack>
              )}
            </CardContent>
          </Card>
        </Grid>

        {/* Related entities */}
        <Grid size={{ xs: 12 }}>
          <Card elevation={2}>
            <CardContent>
              <Typography variant="h6" gutterBottom sx={{ fontWeight: 600 }}>
                Related
              </Typography>
              <Divider sx={{ mb: 2 }} />
              {/* Each count opens its list filtered to THIS customer.
                  The link carries the customer's UUID, never its name: both
                  destinations filter on customer_id, so the list cannot pick up
                  a similarly-named company and the number always agrees.

                  The Jobs link also pins every lifecycle stage. Two reasons,
                  both of which would otherwise break the promise the number
                  makes: the jobs list hides closed jobs by default (so a
                  customer with shipped work would show fewer rows than the
                  count), and it restores a DEVICE-LOCAL saved status selection
                  when ?status= is absent (so the same link would give the
                  salesperson a different list from the owner). */}
              <Stack direction="row" spacing={3} flexWrap="wrap">
                <Box>
                  <MuiLink
                    component={Link}
                    href={`/dashboard/${companyId}/quotes?customer=${customerId}`}
                    underline="hover"
                    variant="body2"
                  >
                    Quotes
                  </MuiLink>
                  <Typography variant="h6">{customer.quotes_count}</Typography>
                </Box>
                <Box>
                  <MuiLink
                    component={Link}
                    href={`/dashboard/${companyId}/jobs?customer=${customerId}&status=${ALL_JOB_STAGES}`}
                    underline="hover"
                    variant="body2"
                  >
                    Jobs
                  </MuiLink>
                  <Typography variant="h6">{customer.jobs_count}</Typography>
                </Box>
              </Stack>
            </CardContent>
          </Card>
        </Grid>
      </Grid>

      {/* Carrier account modal */}
      <CarrierAccountModal
        open={carrierModalOpen}
        onClose={() => setCarrierModalOpen(false)}
        companyId={companyId}
        customerId={customerId}
        existing={editingCarrierAccount}
        onSaved={fetchAll}
      />

      {/* Delete carrier account confirmation (archives — see the handler) */}
      <Dialog
        open={!!deleteCarrierAccountId}
        onClose={() => !actionLoading && setDeleteCarrierAccountId(null)}
      >
        <DialogTitle>Delete carrier account?</DialogTitle>
        <DialogContent>
          <Typography variant="body2">
            Shipments already billed to this account keep their record. It just
            stops being offered on new ones.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteCarrierAccountId(null)} disabled={actionLoading}>
            Cancel
          </Button>
          <Button color="error" onClick={handleDeleteCarrierAccount} disabled={actionLoading}>
            Delete
          </Button>
        </DialogActions>
      </Dialog>

      {/* Contact modal */}
      <CustomerContactModal
        open={contactModalOpen}
        onClose={() => setContactModalOpen(false)}
        customerId={customerId}
        existing={editingContact}
        onSaved={refreshContacts}
      />

      {/* Delete contact confirmation */}
      <Dialog
        open={!!deleteContactId}
        onClose={() => !actionLoading && setDeleteContactId(null)}
      >
        <DialogTitle>Remove contact?</DialogTitle>
        <DialogContent>
          <Typography>
            <strong>{contactBeingDeleted?.name ?? 'This contact'}</strong> will stop
            being offered on new quotes and jobs. Quotes and jobs that already name
            them keep working, and you can add them again with the same details.
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
            Remove
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
            <strong>{customer.name}</strong> will be removed from your lists.
            Quotes and jobs that reference it keep working, and you can bring it
            back by re-creating or re-importing the same name.
          </Typography>
          {(customer.quotes_count > 0 || customer.jobs_count > 0) && (
            <Typography variant="body2" color="text.secondary" sx={{ mt: 2 }}>
              Used on {customer.quotes_count} quote
              {customer.quotes_count === 1 ? '' : 's'}, {customer.jobs_count} job
              {customer.jobs_count === 1 ? '' : 's'} — kept for history.
            </Typography>
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
            startIcon={actionLoading ? <CircularProgress size={16} color="inherit" /> : <DeleteIcon />}
          >
            {actionLoading ? 'Deleting...' : 'Delete'}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
