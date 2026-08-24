'use client';

import { useState } from 'react';
import posthog from 'posthog-js';
import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Typography from '@mui/material/Typography';
import Divider from '@mui/material/Divider';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import TextField from '@mui/material/TextField';
import InputAdornment from '@mui/material/InputAdornment';
import Tooltip from '@mui/material/Tooltip';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import AddIcon from '@mui/icons-material/Add';
import EditIcon from '@mui/icons-material/Edit';
import DeleteIcon from '@mui/icons-material/Delete';
import CheckIcon from '@mui/icons-material/Check';
import CloseIcon from '@mui/icons-material/Close';
import LocalShippingIcon from '@mui/icons-material/LocalShipping';

import ErrorAlert from '@/components/common/ErrorAlert';
import type { VendorService } from '@/types/vendorService';
import {
  createVendorService,
  updateVendorService,
  deleteVendorService,
  checkVendorServiceNameExists,
} from '@/utils/vendorServicesAccess';
import { parseOptionalNumber } from '@/lib/validators';

/**
 * A vendor's services, edited in place.
 *
 * There is no detail page and no form route, deliberately: a service is a name,
 * a description and a price. A dedicated page for three fields makes the user
 * leave the vendor they are looking at, and gives them a back button to find
 * their way home from — for a shop owner adding three processes in a row, that
 * is the whole interaction.
 *
 * There is also NO vendor field anywhere here, and that absence is the rehome:
 * you no longer pick a supplier from a list, you are standing on one.
 */

interface Props {
  companyId: string;
  vendorId: string;
  vendorName: string;
  services: VendorService[];
  /** Refetch the parent's data after a write. */
  onChanged: () => Promise<void> | void;
}

type EditorState =
  | { mode: 'closed' }
  | { mode: 'add' }
  | { mode: 'edit'; service: VendorService };

function priceLabel(unitPrice: number | null): string {
  return unitPrice !== null ? `$${Number(unitPrice).toFixed(2)} / pc` : 'Not set';
}

export default function VendorServicesCard({
  companyId,
  vendorId,
  vendorName,
  services,
  onChanged,
}: Props) {
  const [editor, setEditor] = useState<EditorState>({ mode: 'closed' });
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [price, setPrice] = useState('');
  const [nameError, setNameError] = useState('');
  const [priceError, setPriceError] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [pendingArchive, setPendingArchive] = useState<VendorService | null>(null);

  const openAdd = () => {
    setName('');
    setDescription('');
    setPrice('');
    setNameError('');
    setPriceError('');
    setEditor({ mode: 'add' });
  };

  const openEdit = (service: VendorService) => {
    setName(service.name);
    setDescription(service.description ?? '');
    setPrice(service.unit_price !== null ? String(service.unit_price) : '');
    setNameError('');
    setPriceError('');
    setEditor({ mode: 'edit', service });
  };

  const close = () => {
    setEditor({ mode: 'closed' });
    setNameError('');
    setPriceError('');
  };

  const save = async () => {
    const trimmed = name.trim();
    let ok = true;

    if (!trimmed) {
      setNameError('Name is required');
      ok = false;
    }
    // Price is OPTIONAL. A shop often adds the process before it has agreed a
    // price, and blocking that would push them back to not naming it at all.
    // An unpriced service reads "Not set" and makes any part routed through it
    // unpriceable, which is the honest state rather than a silent zero.
    if (price.trim()) {
      const parsed = parseOptionalNumber(price);
      if (parsed === null || parsed < 0) {
        setPriceError('Enter a non-negative number');
        ok = false;
      }
    }
    if (!ok) return;

    setSaving(true);
    setError(null);
    try {
      const excludeId = editor.mode === 'edit' ? editor.service.id : undefined;
      if (await checkVendorServiceNameExists(vendorId, trimmed, excludeId)) {
        setNameError(`${vendorName} already has a service called "${trimmed}".`);
        setSaving(false);
        return;
      }

      const formData = { name: trimmed, unit_price: price, description };

      if (editor.mode === 'add') {
        await createVendorService(companyId, vendorId, formData);
        // Shape of the interaction, never the customer's business data: whether
        // a price was set, not what it is. `has_price` is the number this
        // feature exists to move — 89% of outside steps were unpriced.
        posthog.capture('vendor service created', { has_price: price.trim().length > 0 });
      } else if (editor.mode === 'edit') {
        await updateVendorService(editor.service.id, formData);
      }

      close();
      await onChanged();
    } catch (err) {
      setError(err);
    } finally {
      setSaving(false);
    }
  };

  const archive = async () => {
    if (!pendingArchive) return;
    setSaving(true);
    setError(null);
    try {
      await deleteVendorService(pendingArchive.id);
      posthog.capture('vendor service archived');
      setPendingArchive(null);
      await onChanged();
    } catch (err) {
      setError(err);
    } finally {
      setSaving(false);
    }
  };

  const editorRow = (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 1.5,
        py: 1.5,
        flexWrap: 'wrap',
      }}
    >
      <TextField
        size="small"
        required
        autoFocus
        label="Service"
        placeholder="Anodize"
        value={name}
        onChange={(e) => {
          setName(e.target.value);
          if (nameError) setNameError('');
        }}
        error={!!nameError}
        helperText={nameError || 'What this vendor does to your parts.'}
        disabled={saving}
        sx={{ flex: 1, minWidth: 200 }}
      />
      <TextField
        size="small"
        label="Description"
        placeholder="Type II clear, racked"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        disabled={saving}
        helperText="Spec, callout, packaging — whatever the person boxing these needs."
        sx={{ flex: 1.4, minWidth: 220 }}
      />
      <TextField
        size="small"
        label="Price per piece"
        value={price}
        onChange={(e) => {
          const v = e.target.value;
          if (v === '' || /^\d*\.?\d*$/.test(v)) {
            setPrice(v);
            if (priceError) setPriceError('');
          }
        }}
        error={!!priceError}
        helperText={priceError || 'Routing steps use this unless they override it.'}
        disabled={saving}
        slotProps={{
          input: {
            startAdornment: <InputAdornment position="start">$</InputAdornment>,
            endAdornment: <InputAdornment position="end">/pc</InputAdornment>,
          },
        }}
        sx={{ width: 220 }}
      />
      <Box sx={{ display: 'flex', gap: 0.5, pt: 0.5 }}>
        <Tooltip title="Save">
          <span>
            <IconButton color="primary" onClick={save} disabled={saving}>
              {saving ? <CircularProgress size={20} /> : <CheckIcon />}
            </IconButton>
          </span>
        </Tooltip>
        <Tooltip title="Cancel">
          <span>
            <IconButton onClick={close} disabled={saving}>
              <CloseIcon />
            </IconButton>
          </span>
        </Tooltip>
      </Box>
    </Box>
  );

  return (
    <Card elevation={2}>
      <CardContent>
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 2,
            flexWrap: 'wrap',
            mb: 1,
          }}
        >
          <Typography variant="h6" sx={{ fontWeight: 600 }}>
            Services ({services.length})
          </Typography>
          {editor.mode === 'closed' && (
            <Button size="small" startIcon={<AddIcon />} onClick={openAdd}>
              Add service
            </Button>
          )}
        </Box>
        <Divider sx={{ mb: 1 }} />

        {error != null && (
          <Box sx={{ mb: 2 }}>
            <ErrorAlert error={error} entity="service" />
          </Box>
        )}

        {services.length === 0 && editor.mode !== 'add' ? (
          <Box sx={{ py: 3, textAlign: 'center' }}>
            <LocalShippingIcon sx={{ fontSize: 48, color: 'text.secondary', mb: 1 }} />
            <Typography variant="subtitle1" sx={{ fontWeight: 500 }}>
              No outside processes yet.
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
              Add what you send {vendorName} — anodize, heat treat, wire EDM — and what they
              charge.
            </Typography>
            {/* The line that stops a material-only supplier reading this empty
                card as a chore they have not done. */}
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 2 }}>
              If {vendorName} only supplies material, there is nothing to add here.
            </Typography>
          </Box>
        ) : (
          <Box>
            {services.map((svc) => {
              const isEditing = editor.mode === 'edit' && editor.service.id === svc.id;
              return (
                <Box key={svc.id}>
                  {isEditing ? (
                    editorRow
                  ) : (
                    <Box
                      sx={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 2,
                        py: 1.25,
                        flexWrap: 'wrap',
                      }}
                    >
                      <Box sx={{ flex: 1, minWidth: 180 }}>
                        <Typography sx={{ fontWeight: 500 }}>{svc.name}</Typography>
                        {svc.description && (
                          <Typography variant="body2" color="text.secondary">
                            {svc.description}
                          </Typography>
                        )}
                      </Box>
                      <Typography
                        variant="body2"
                        color={svc.unit_price !== null ? 'text.primary' : 'text.secondary'}
                        sx={{ width: 140 }}
                      >
                        {priceLabel(svc.unit_price)}
                      </Typography>
                      <Box sx={{ display: 'flex', gap: 0.5 }}>
                        <Tooltip title="Edit service">
                          <span>
                            <IconButton
                              size="small"
                              onClick={() => openEdit(svc)}
                              disabled={editor.mode !== 'closed'}
                            >
                              <EditIcon fontSize="small" />
                            </IconButton>
                          </span>
                        </Tooltip>
                        <Tooltip title="Archive service">
                          <span>
                            <IconButton
                              size="small"
                              color="error"
                              onClick={() => setPendingArchive(svc)}
                              disabled={editor.mode !== 'closed'}
                            >
                              <DeleteIcon fontSize="small" />
                            </IconButton>
                          </span>
                        </Tooltip>
                      </Box>
                    </Box>
                  )}
                  <Divider />
                </Box>
              );
            })}

            {editor.mode === 'add' && editorRow}
          </Box>
        )}

        {services.length === 0 && editor.mode === 'add' && editorRow}
      </CardContent>

      {/* Archive NEVER blocks, even at routing_operations_count > 0: every
          routing and job already using the service keeps working, and it simply
          leaves the pickers. The copy says that rather than warning about a
          consequence that does not happen. */}
      <Dialog open={pendingArchive !== null} onClose={() => !saving && setPendingArchive(null)}>
        <DialogTitle>Archive service?</DialogTitle>
        <DialogContent>
          <Typography>
            <strong>{pendingArchive?.name}</strong> will be archived — removed from{' '}
            {vendorName}&apos;s services and from the routing picker, but every routing and job
            that already uses it keeps working. Reusing the name later revives it.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setPendingArchive(null)} disabled={saving}>
            Cancel
          </Button>
          <Button
            onClick={archive}
            color="error"
            variant="contained"
            disabled={saving}
            startIcon={saving ? <CircularProgress size={16} color="inherit" /> : <DeleteIcon />}
          >
            Archive
          </Button>
        </DialogActions>
      </Dialog>
    </Card>
  );
}
