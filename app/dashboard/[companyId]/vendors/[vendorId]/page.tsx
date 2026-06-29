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
import Grid from '@mui/material/Grid';
import Chip from '@mui/material/Chip';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import Accordion from '@mui/material/Accordion';
import AccordionSummary from '@mui/material/AccordionSummary';
import AccordionDetails from '@mui/material/AccordionDetails';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import ListItemText from '@mui/material/ListItemText';
import ListItemButton from '@mui/material/ListItemButton';
import Stack from '@mui/material/Stack';
import EditIcon from '@mui/icons-material/Edit';
import DeleteIcon from '@mui/icons-material/Delete';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import AddIcon from '@mui/icons-material/Add';
import StarIcon from '@mui/icons-material/Star';
import StarOutlineIcon from '@mui/icons-material/StarOutline';
import NextLink from 'next/link';
import MuiLink from '@mui/material/Link';

import {
  getVendor,
  deleteVendor,
  getPartsByPreferredVendor,
  getWorkCentersByVendor,
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

interface LinkedWorkCenter {
  id: string;
  name: string;
  kind: 'internal' | 'external';
}

// Stable empty fallbacks so the derived lists keep a constant identity while
// the first load is in flight (and on a vendor with no linked records).
const EMPTY_CONTACTS: VendorContact[] = [];
const EMPTY_PARTS: LinkedPart[] = [];
const EMPTY_WORK_CENTERS: LinkedWorkCenter[] = [];

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
    reload: fetchAll,
  } = useLoad(
    async () => {
      const v = await getVendor(vendorId);
      if (!v) {
        return { vendor: null, parts: EMPTY_PARTS, wcs: EMPTY_WORK_CENTERS, contacts: EMPTY_CONTACTS };
      }
      const [parts, wcs, contacts] = await Promise.all([
        getPartsByPreferredVendor(vendorId),
        getWorkCentersByVendor(vendorId),
        getContactsForVendor(vendorId),
      ]);
      return { vendor: v, parts, wcs, contacts };
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
  const linkedWorkCenters = data?.wcs ?? EMPTY_WORK_CENTERS;

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

  if (!vendor) {
    return (
      <Box>
        <Alert severity="error">Vendor not found</Alert>
      </Box>
    );
  }

  const supplies = linkedParts.length > 0;
  const outside = linkedWorkCenters.length > 0;
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

          <Tooltip
            title={
              hasReferences
                ? 'Cannot delete — this vendor is referenced by parts or work centers'
                : 'Delete Vendor'
            }
          >
            <span>
              <IconButton
                onClick={() => setDeleteDialogOpen(true)}
                disabled={actionLoading || hasReferences}
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

        {/* Linked items — collapsible per role. Empty cases say so explicitly
            so the user can tell "no parts" from "didn't load." */}
        <Grid size={{ xs: 12 }}>
          <Card elevation={2}>
            <CardContent>
              <Typography variant="h6" gutterBottom sx={{ fontWeight: 600 }}>
                Linked Items
              </Typography>
              <Divider sx={{ mb: 2 }} />

              <Accordion disableGutters elevation={0} defaultExpanded={supplies}>
                <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                  <Typography variant="subtitle1" fontWeight={500}>
                    Parts using this vendor as preferred supplier (
                    {linkedParts.length})
                  </Typography>
                </AccordionSummary>
                <AccordionDetails sx={{ pt: 0 }}>
                  {linkedParts.length === 0 ? (
                    <Typography variant="body2" color="text.secondary">
                      No parts list this vendor as their preferred supplier.
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
                </AccordionDetails>
              </Accordion>

              <Accordion disableGutters elevation={0} defaultExpanded={outside}>
                <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                  <Typography variant="subtitle1" fontWeight={500}>
                    Work centers performing outside ops at this vendor (
                    {linkedWorkCenters.length})
                  </Typography>
                </AccordionSummary>
                <AccordionDetails sx={{ pt: 0 }}>
                  {linkedWorkCenters.length === 0 ? (
                    <Typography variant="body2" color="text.secondary">
                      No work centers reference this vendor.
                    </Typography>
                  ) : (
                    <List dense disablePadding>
                      {linkedWorkCenters.map((wc) => (
                        <ListItem key={wc.id} disablePadding>
                          <ListItemButton
                            component={NextLink}
                            href={`/dashboard/${companyId}/work-centers/${wc.id}`}
                          >
                            <ListItemText
                              primary={wc.name}
                              secondary={wc.kind === 'external' ? 'External' : 'Internal'}
                            />
                          </ListItemButton>
                        </ListItem>
                      ))}
                    </List>
                  )}
                </AccordionDetails>
              </Accordion>
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
            Are you sure you want to delete <strong>{vendor.name}</strong>? This action cannot be
            undone.
          </Typography>
          {hasReferences && (
            <Alert severity="warning" sx={{ mt: 2 }}>
              This vendor is referenced by{' '}
              {supplies
                ? `${linkedParts.length} part${linkedParts.length === 1 ? '' : 's'} (preferred supplier)`
                : null}
              {supplies && outside ? ' and ' : ''}
              {outside
                ? `${linkedWorkCenters.length} work center${linkedWorkCenters.length === 1 ? '' : 's'}`
                : null}
              . Remove those references before deleting.
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
