'use client';

import { useState, useMemo } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useLoad } from '@/hooks/useLoad';
import LoadFailedState from '@/components/common/LoadFailedState';
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
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import ListItemText from '@mui/material/ListItemText';
import ListItemButton from '@mui/material/ListItemButton';
import Stack from '@mui/material/Stack';
import EditIcon from '@mui/icons-material/Edit';
import DeleteIcon from '@mui/icons-material/Delete';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import AddIcon from '@mui/icons-material/Add';
import StarIcon from '@mui/icons-material/Star';
import StarOutlineIcon from '@mui/icons-material/StarOutline';
import NextLink from 'next/link';
import MuiLink from '@mui/material/Link';

import { getVendorServicesForVendor } from '@/utils/vendorServicesAccess';
import { getOutsideOpsForCompany } from '@/utils/operatorAccess';
import VendorServicesCard from '@/components/vendors/VendorServicesCard';
import type { OutsideOperation } from '@/types/operator';
import type { VendorService } from '@/types/vendorService';
import {
  getVendor,
  deleteVendor,
  getPartsByPreferredVendor,
} from '@/utils/vendorsAccess';
import {
  getContactsForVendor,
  deleteVendorContact,
  setPrimaryContact,
} from '@/utils/vendorContactsAccess';
import { roleDisplayLabel } from '@/types/vendorContact';
import type { VendorContact } from '@/types/vendorContact';
import { VendorContactModal } from '@/components/vendors';

interface LinkedPart {
  id: string;
  part_name: string;
  primary_unit: string | null;
}

// Stable empty fallbacks so the derived lists keep a constant identity while
// the first load is in flight (and on a vendor with no linked records).
const EMPTY_CONTACTS: VendorContact[] = [];
const EMPTY_PARTS: LinkedPart[] = [];
const EMPTY_SERVICES: VendorService[] = [];
const EMPTY_OUTSIDE: OutsideOperation[] = [];

/**
 * One read-only row in the vendor's Open jobs card.
 *
 * The whole row is a link, and it carries a visible "Open job →" affordance
 * beside it: a bare clickable row is weak signal for a mouse user on a desktop
 * screen, and this audience should not have to discover that the row is a
 * target. `?op=` lands on the operation card itself rather than the top of the
 * job, so the control is under the cursor when the page settles.
 */
function OutsideJobRow({
  op,
  companyId,
  sentDays,
}: {
  op: OutsideOperation;
  companyId: string;
  /** Days at the vendor, computed in the loader — `Date.now()` in render is
   *  impure and produces a number that shifts on any incidental re-render. */
  sentDays: number | null;
}) {
  return (
    <ListItem
      disablePadding
      secondaryAction={
        <MuiLink
          component={NextLink}
          href={`/dashboard/${companyId}/jobs/${op.job_id}?op=${op.id}`}
          variant="body2"
          sx={{ whiteSpace: 'nowrap', pr: 1 }}
        >
          Open job →
        </MuiLink>
      }
    >
      <ListItemButton
        component={NextLink}
        href={`/dashboard/${companyId}/jobs/${op.job_id}?op=${op.id}`}
      >
        <ListItemText
          primary={
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
              <Typography variant="body2" fontWeight={600}>
                {op.job_number}
              </Typography>
              {op.is_hot && <Chip size="small" color="error" label="HOT" />}
              <Typography variant="body2" color="text.secondary">
                {op.part_name ?? 'Part'}
              </Typography>
            </Box>
          }
          secondary={
            <>
              {op.operation_name}
              {' · '}
              {sentDays !== null ? (
                <Box
                  component="span"
                  // Red past three weeks. A number that only ever counts up is
                  // not an alarm; the threshold is what makes it one.
                  sx={{ color: sentDays > 21 ? 'error.main' : 'inherit', fontWeight: sentDays > 21 ? 600 : 400 }}
                >
                  {`sent ${sentDays} day${sentDays === 1 ? '' : 's'} ago`}
                  {op.sent_by_name ? ` by ${op.sent_by_name}` : ''}
                </Box>
              ) : op.due_date ? (
                `job due ${new Date(op.due_date).toLocaleDateString()}`
              ) : (
                'no due date'
              )}
            </>
          }
        />
      </ListItemButton>
    </ListItem>
  );
}

export default function VendorDetailPage() {
  const params = useParams();
  const router = useRouter();
  const companyId = params.companyId as string;
  const vendorId = params.vendorId as string;

  const [actionLoading, setActionLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);

  // Contact modal state — shared between Add and Edit; `editingContact`
  // distinguishes the two modes.
  const [contactModalOpen, setContactModalOpen] = useState(false);
  const [editingContact, setEditingContact] = useState<VendorContact | undefined>(
    undefined,
  );

  // Per-contact delete confirmation. Keyed by contact id so the prompt
  // wording can include the contact's name without needing extra state.
  const [deleteContactId, setDeleteContactId] = useState<string | null>(null);

  // Load the vendor, then (only if it exists) its linked parts, work centers,
  // and contacts in parallel. useLoad keeps every setState inside the async
  // callback, so the load effect can't trip set-state-in-effect.
  const {
    data,
    loading,
    error: loadError,
    reload: fetchAll,
  } = useLoad(
    async () => {
      const v = await getVendor(vendorId);
      if (!v) {
        return {
          vendor: null,
          parts: EMPTY_PARTS,
          services: EMPTY_SERVICES,
          contacts: EMPTY_CONTACTS,
          outside: EMPTY_OUTSIDE,
          daysOut: [] as (readonly [string, number])[],
        };
      }
      const [parts, services, contacts, allOutside] = await Promise.all([
        getPartsByPreferredVendor(vendorId),
        getVendorServicesForVendor(vendorId),
        getContactsForVendor(vendorId),
        // One company-wide read, filtered here. It returns only OPEN outside ops
        // (pending + sent) — tens of rows for a shop, cheaper than a per-vendor
        // aggregate, and the same call the Jobs list already makes for its
        // At-vendor chip.
        getOutsideOpsForCompany(v.company_id),
      ]);
      const outside = allOutside.filter((o) => o.vendor_id === vendorId);
      // Days-at-vendor is stamped HERE, once, not derived in render: a clock
      // read during render is impure and gives a number that moves on any
      // incidental re-render.
      const now = Date.now();
      const daysOut = outside
        .filter((o) => o.sent_at !== null)
        .map(
          (o) =>
            [o.id, Math.floor((now - new Date(o.sent_at as string).getTime()) / 86_400_000)] as const,
        );
      return { vendor: v, parts, services, contacts, outside, daysOut };
    },
    [vendorId],
    {
      onError: (err) =>
        setError(err instanceof Error ? err.message : 'Failed to load vendor'),
    },
  );
  const vendor = data?.vendor ?? null;
  const contacts = data?.contacts ?? EMPTY_CONTACTS;
  const linkedParts = data?.parts ?? EMPTY_PARTS;
  const services = data?.services ?? EMPTY_SERVICES;
  const outsideOps = data?.outside ?? EMPTY_OUTSIDE;
  const daysOutById = useMemo(() => new Map(data?.daysOut ?? []), [data?.daysOut]);

  // Oldest sent first — chase order. The company-wide queue sorts hot-then-due,
  // which answers "what goes out today"; standing on ONE vendor the question is
  // "what has this vendor had longest", and that is a different sort.
  const atVendor = outsideOps
    .filter((o) => o.status === 'sent')
    .sort((a, b) => (a.sent_at ?? '').localeCompare(b.sent_at ?? ''));
  const notSent = outsideOps.filter((o) => o.status === 'pending');

  // Contact mutations re-run the full loader (reload). Cheap at vendor scale and
  // keeps a single read path rather than a separate contacts-only fetch.
  const refreshContacts = fetchAll;

  const handleDelete = async () => {
    setActionLoading(true);
    try {
      await deleteVendor(vendorId);
      router.push(`/dashboard/${companyId}/vendors`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete vendor');
      setActionLoading(false);
      setDeleteDialogOpen(false);
    }
  };

  const handleAddContact = () => {
    setEditingContact(undefined);
    setContactModalOpen(true);
  };

  const handleEditContact = (contact: VendorContact) => {
    setEditingContact(contact);
    setContactModalOpen(true);
  };

  const handleDeleteContact = async () => {
    if (!deleteContactId) return;
    setActionLoading(true);
    try {
      await deleteVendorContact(deleteContactId);
      setDeleteContactId(null);
      await refreshContacts();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete contact');
    } finally {
      setActionLoading(false);
    }
  };

  const handleSetPrimary = async (contactId: string) => {
    setActionLoading(true);
    try {
      await setPrimaryContact(vendorId, contactId);
      await refreshContacts();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Failed to set primary contact',
      );
    } finally {
      setActionLoading(false);
    }
  };

  const formatDate = (dateStr: string | null): string => {
    if (!dateStr) return '—';
    return new Date(dateStr).toLocaleString();
  };

  const formatAddress = (): string => {
    if (!vendor) return '—';
    const parts = [
      vendor.address_line1,
      vendor.address_line2,
      [vendor.city, vendor.state, vendor.postal_code].filter(Boolean).join(', '),
      vendor.country && vendor.country !== 'USA' ? vendor.country : null,
    ].filter(Boolean);
    return parts.length > 0 ? parts.join('\n') : '—';
  };

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: 400 }}>
        <CircularProgress />
      </Box>
    );
  }

  // A failed load also leaves `vendor` null, and "Vendor not found" would then assert the record
  // is gone when we simply never heard back. Tested first, so only a load that SUCCEEDED and
  // returned nothing reaches the not-found branch.
  if (loadError) {
    return (
      <Box sx={{ textAlign: 'center', py: 6 }}>
        <LoadFailedState error={loadError} entity="this vendor" onRetry={fetchAll} />
      </Box>
    );
  }

  if (!vendor) {
    return (
      <Box>
        <Alert severity="error">Vendor not found</Alert>
      </Box>
    );
  }

  const supplies = linkedParts.length > 0;
  const outside = services.length > 0;
  const hasReferences = supplies || outside;

  const contactBeingDeleted = deleteContactId
    ? contacts.find((c) => c.id === deleteContactId)
    : undefined;

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
          onClick={() => router.push(`/dashboard/${companyId}/vendors`)}
          sx={{ color: 'text.secondary' }}
        >
          Back to Vendors
        </Button>

        <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
          <Button
            variant="outlined"
            startIcon={<EditIcon />}
            onClick={() => router.push(`/dashboard/${companyId}/vendors/${vendorId}/edit`)}
            disabled={actionLoading}
          >
            Edit
          </Button>

          <Tooltip title="Delete Vendor">
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

      {/* Header card with name + created/updated timestamps top-right. */}
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
            <Typography variant="h5" sx={{ fontWeight: 600 }}>
              {vendor.name}
            </Typography>
            <Box sx={{ textAlign: 'right' }}>
              <Typography variant="caption" color="text.secondary" display="block">
                Created {formatDate(vendor.created_at)}
              </Typography>
              <Typography variant="caption" color="text.secondary" display="block">
                Updated {formatDate(vendor.updated_at)}
              </Typography>
            </Box>
          </Box>
        </CardContent>
      </Card>

      <Grid container spacing={3}>
        {/* Contacts card — replaces the single Primary Contact card. Lists
            all contacts, with primary marked by a star and actions for
            edit / set-primary / delete. Empty state ("No contacts yet.") is
            a legitimate post-migration state for vendors that previously
            had only email/phone (see the migration's NOTICE log). */}
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
                  <Typography
                    variant="body2"
                    color="text.secondary"
                    sx={{ mb: 2 }}
                  >
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
                        borderColor: contact.is_primary
                          ? 'primary.main'
                          : 'divider',
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
                                <StarIcon
                                  sx={{
                                    color: 'primary.main',
                                    fontSize: 18,
                                  }}
                                />
                              </Tooltip>
                            )}
                            <Typography
                              variant="body1"
                              sx={{ fontWeight: 600 }}
                            >
                              {contact.name}
                            </Typography>
                            <Chip
                              size="small"
                              label={roleDisplayLabel(contact)}
                              variant="outlined"
                            />
                          </Box>
                          <Stack
                            direction="row"
                            spacing={2}
                            sx={{ flexWrap: 'wrap', mt: 0.5 }}
                          >
                            {contact.email && (
                              <MuiLink
                                href={`mailto:${contact.email}`}
                                variant="body2"
                              >
                                {contact.email}
                              </MuiLink>
                            )}
                            {contact.phone && (
                              <MuiLink
                                href={`tel:${contact.phone}`}
                                variant="body2"
                              >
                                {contact.phone}
                              </MuiLink>
                            )}
                            {!contact.email && !contact.phone && (
                              <Typography
                                variant="body2"
                                color="text.secondary"
                              >
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
                                  onClick={() => handleSetPrimary(contact.id)}
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
                                sx={{
                                  '&:hover': {
                                    color: 'error.main',
                                  },
                                }}
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

        {/* Address card */}
        <Grid size={{ xs: 12, md: 6 }}>
          <Card elevation={2} sx={{ height: '100%' }}>
            <CardContent>
              <Typography variant="h6" gutterBottom sx={{ fontWeight: 600 }}>
                Address
              </Typography>
              <Divider sx={{ mb: 2 }} />
              <Typography variant="body1" sx={{ whiteSpace: 'pre-line' }}>
                {formatAddress()}
              </Typography>
            </CardContent>
          </Card>
        </Grid>

        {/* Services — the processes this vendor performs, edited IN PLACE.
            The columns that were here (Used on, Out now) are gone: each was a
            second query per vendor to decorate a list of three rows, and
            neither answered a question the user had while standing on this
            card. What a service IS — its name and its price — is what stays. */}
        <Grid size={{ xs: 12 }}>
          <VendorServicesCard
            companyId={companyId}
            vendorId={vendorId}
            vendorName={vendor.name}
            services={services}
            onChanged={fetchAll}
          />
        </Grid>

        {/* Parts supplied — today's "Linked Parts" accordion, promoted to a
            plain card with an honest name. */}
        <Grid size={{ xs: 12, md: 6 }}>
          <Card elevation={2} sx={{ height: '100%' }}>
            <CardContent>
              <Typography variant="h6" gutterBottom sx={{ fontWeight: 600 }}>
                Parts supplied ({linkedParts.length})
              </Typography>
              <Divider sx={{ mb: 2 }} />
              {linkedParts.length === 0 ? (
                <Typography variant="body2" color="text.secondary">
                  No parts list {vendor.name} as their preferred supplier.
                </Typography>
              ) : (
                <List dense disablePadding>
                  {linkedParts.map((p) => (
                    <ListItem key={p.id} disablePadding>
                      <ListItemButton
                        component={NextLink}
                        href={`/dashboard/${companyId}/parts/${p.id}`}
                      >
                        <ListItemText
                          primary={p.part_name}
                          secondary={p.primary_unit ? `Unit: ${p.primary_unit}` : null}
                        />
                      </ListItemButton>
                    </ListItem>
                  ))}
                </List>
              )}
            </CardContent>
          </Card>
        </Grid>

        {/* Open jobs — READ-ONLY, per the founder's ask. Nothing here sends or
            receives; the job page owns that. Every row deep-links to the exact
            operation card so "see it here, act there" is one click, not a hunt.
            "At {vendor} now" sorts OLDEST SENT FIRST — chase order, not due-date
            order, because the question this section answers is "who is sitting
            on my parts?". */}
        <Grid size={{ xs: 12, md: 6 }}>
          <Card elevation={2} sx={{ height: '100%' }}>
            <CardContent>
              <Typography variant="h6" gutterBottom sx={{ fontWeight: 600 }}>
                Open jobs ({outsideOps.length})
              </Typography>
              <Divider sx={{ mb: 2 }} />

              <Typography variant="subtitle2" sx={{ fontWeight: 600, mb: 1 }}>
                At {vendor.name} now ({atVendor.length})
              </Typography>
              {atVendor.length === 0 ? (
                <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                  Nothing is out at {vendor.name} right now.
                </Typography>
              ) : (
                <List dense disablePadding sx={{ mb: 2 }}>
                  {atVendor.map((op) => (
                    <OutsideJobRow
                      key={op.id}
                      op={op}
                      companyId={companyId}
                      sentDays={daysOutById.get(op.id) ?? null}
                    />
                  ))}
                </List>
              )}

              <Typography variant="subtitle2" sx={{ fontWeight: 600, mb: 1 }}>
                Waiting to go out ({notSent.length})
              </Typography>
              {notSent.length === 0 ? (
                <Typography variant="body2" color="text.secondary">
                  Nothing is queued for {vendor.name}.
                </Typography>
              ) : (
                <List dense disablePadding>
                  {notSent.map((op) => (
                    <OutsideJobRow key={op.id} op={op} companyId={companyId} sentDays={null} />
                  ))}
                </List>
              )}

              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 2 }}>
                Send and receive parts on the job.
              </Typography>
            </CardContent>
          </Card>
        </Grid>

      </Grid>

      {/* Add / Edit contact modal */}
      <VendorContactModal
        open={contactModalOpen}
        onClose={() => setContactModalOpen(false)}
        vendorId={vendorId}
        existing={editingContact}
        onSaved={refreshContacts}
      />

      {/* Per-contact delete confirmation */}
      <Dialog
        open={deleteContactId !== null}
        onClose={() => !actionLoading && setDeleteContactId(null)}
      >
        <DialogTitle>Delete Contact?</DialogTitle>
        <DialogContent>
          <Typography>
            {contactBeingDeleted ? (
              <>
                Are you sure you want to delete <strong>{contactBeingDeleted.name}</strong>?
                This action cannot be undone.
              </>
            ) : (
              'Delete this contact?'
            )}
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button
            onClick={() => setDeleteContactId(null)}
            disabled={actionLoading}
          >
            Cancel
          </Button>
          <Button
            onClick={handleDeleteContact}
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

      {/* Vendor delete confirmation */}
      <Dialog open={deleteDialogOpen} onClose={() => setDeleteDialogOpen(false)}>
        <DialogTitle>Delete Vendor?</DialogTitle>
        <DialogContent>
          <Typography>
            <strong>{vendor.name}</strong> will be archived — removed from your vendor
            lists, but existing references keep working. Reusing the name later re-creates
            (revives) it.
          </Typography>
          {hasReferences && (
            <Alert severity="info" sx={{ mt: 2 }}>
              Referenced by{' '}
              {supplies
                ? `${linkedParts.length} part${linkedParts.length === 1 ? '' : 's'} (preferred supplier)`
                : null}
              {supplies && outside ? ' and ' : ''}
              {outside
                ? `${services.length} service${services.length === 1 ? '' : 's'}`
                : null}
              {' '}— kept for history.
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
