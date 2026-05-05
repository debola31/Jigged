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
import NextLink from 'next/link';
import MuiLink from '@mui/material/Link';

import {
  getVendorWithDerivedRoles,
  deleteVendor,
  getPartsByPreferredVendor,
  getWorkCentersByVendor,
} from '@/utils/vendorsAccess';
import type { VendorWithDerivedRoles } from '@/types/vendor';

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

export default function VendorDetailPage() {
  const params = useParams();
  const router = useRouter();
  const companyId = params.companyId as string;
  const vendorId = params.vendorId as string;

  const [vendor, setVendor] = useState<VendorWithDerivedRoles | null>(null);
  const [linkedParts, setLinkedParts] = useState<LinkedPart[]>([]);
  const [linkedWorkCenters, setLinkedWorkCenters] = useState<LinkedWorkCenter[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);

  const fetchAll = useCallback(async () => {
    try {
      setLoading(true);
      // One round of fan-out queries — vendor with counts, then linked parts
      // and work centers in parallel. The counts on the vendor row are the
      // canonical source for the role chips and delete-gating; the linked
      // lists below are for display.
      const v = await getVendorWithDerivedRoles(vendorId);
      setVendor(v);
      if (v) {
        const [parts, wcs] = await Promise.all([
          getPartsByPreferredVendor(vendorId),
          getWorkCentersByVendor(vendorId),
        ]);
        setLinkedParts(parts);
        setLinkedWorkCenters(wcs);
      }
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load vendor');
    } finally {
      setLoading(false);
    }
  }, [vendorId]);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  const handleDelete = async () => {
    setActionLoading(true);
    try {
      await deleteVendor(vendorId);
      router.push(`/dashboard/${companyId}/vendors`);
    } catch (err) {
      // No silent fallback — surface the constraint failure with the clear
      // message thrown by deleteVendor (vendorsAccess.ts maps 23503 to a
      // human-readable explanation of which references block the delete).
      setError(err instanceof Error ? err.message : 'Failed to delete vendor');
      setActionLoading(false);
      setDeleteDialogOpen(false);
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

  const supplies = vendor.supplies_materials_count > 0;
  const outside = vendor.performs_outside_ops_count > 0;
  // Delete is gated by either reference type — DB will reject via FK anyway,
  // but disabling up front + showing a clear constraint message beats waiting
  // for a raw Postgres error.
  const hasReferences = supplies || outside;

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

      {/* Header card with name + derived role chips */}
      <Card elevation={2} sx={{ mb: 3 }}>
        <CardContent>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap' }}>
            <Typography variant="h5" sx={{ fontWeight: 600 }}>
              {vendor.name}
            </Typography>
            {!supplies && !outside ? (
              <Chip
                size="small"
                label="No references yet"
                sx={{ fontWeight: 500 }}
                variant="outlined"
              />
            ) : (
              <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap' }}>
                {supplies && (
                  <Chip
                    label={`Supplies materials · ${vendor.supplies_materials_count} part${vendor.supplies_materials_count === 1 ? '' : 's'}`}
                    sx={{
                      fontWeight: 500,
                      bgcolor: 'success.dark',
                      color: 'common.white',
                    }}
                  />
                )}
                {outside && (
                  <Chip
                    label={`Performs outside ops · ${vendor.performs_outside_ops_count} routing${vendor.performs_outside_ops_count === 1 ? '' : 's'}`}
                    sx={{
                      fontWeight: 500,
                      bgcolor: 'warning.dark',
                      color: 'common.white',
                    }}
                  />
                )}
              </Stack>
            )}
          </Box>
        </CardContent>
      </Card>

      <Grid container spacing={3}>
        {/* Contact card */}
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
                    {vendor.contact_name || '—'}
                  </Typography>
                </Box>
                <Box>
                  <Typography variant="body2" color="text.secondary">
                    Phone
                  </Typography>
                  {vendor.contact_phone ? (
                    <MuiLink href={`tel:${vendor.contact_phone}`} sx={{ fontWeight: 500 }}>
                      {vendor.contact_phone}
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
                  {vendor.contact_email ? (
                    <MuiLink href={`mailto:${vendor.contact_email}`} sx={{ fontWeight: 500 }}>
                      {vendor.contact_email}
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

        {/* Notes card — render only when set so the page doesn't grow blank
            cards on lean vendor records. */}
        {vendor.notes && (
          <Grid size={{ xs: 12 }}>
            <Card elevation={2}>
              <CardContent>
                <Typography variant="h6" gutterBottom sx={{ fontWeight: 600 }}>
                  Notes
                </Typography>
                <Divider sx={{ mb: 2 }} />
                <Typography variant="body1" sx={{ whiteSpace: 'pre-line' }}>
                  {vendor.notes}
                </Typography>
              </CardContent>
            </Card>
          </Grid>
        )}

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
                    {vendor.supplies_materials_count})
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
                    {vendor.performs_outside_ops_count})
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

        {/* Metadata — non-prominent. legacy_id is the import-only identifier
            for re-import idempotency; useful for support, not for daily use. */}
        <Grid size={{ xs: 12 }}>
          <Card elevation={1} sx={{ bgcolor: 'background.default' }}>
            <CardContent>
              <Typography
                variant="caption"
                color="text.secondary"
                sx={{ textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: 600 }}
              >
                Metadata
              </Typography>
              <Box sx={{ mt: 1, display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                <Box>
                  <Typography variant="body2" color="text.secondary">
                    Legacy ID
                  </Typography>
                  <Typography variant="body2" fontFamily="monospace">
                    {vendor.legacy_id || '—'}
                  </Typography>
                </Box>
                <Box>
                  <Typography variant="body2" color="text.secondary">
                    Created
                  </Typography>
                  <Typography variant="body2">{formatDate(vendor.created_at)}</Typography>
                </Box>
                <Box>
                  <Typography variant="body2" color="text.secondary">
                    Updated
                  </Typography>
                  <Typography variant="body2">{formatDate(vendor.updated_at)}</Typography>
                </Box>
              </Box>
            </CardContent>
          </Card>
        </Grid>
      </Grid>

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
                ? `${vendor.supplies_materials_count} part${vendor.supplies_materials_count === 1 ? '' : 's'} (preferred supplier)`
                : null}
              {supplies && outside ? ' and ' : ''}
              {outside
                ? `${vendor.performs_outside_ops_count} work center${vendor.performs_outside_ops_count === 1 ? '' : 's'}`
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
