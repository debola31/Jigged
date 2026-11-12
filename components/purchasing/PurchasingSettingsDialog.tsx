'use client';

import { useState } from 'react';
import posthog from 'posthog-js';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Divider from '@mui/material/Divider';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';

import ErrorAlert from '@/components/common/ErrorAlert';
import LoadFailedState from '@/components/common/LoadFailedState';
import MissingFieldsNotice from '@/components/common/MissingFieldsNotice';
import { useLoad } from '@/hooks/useLoad';
import {
  MIN_DIGITS_RANGE,
  PURCHASING_PREFIX_MAX_LENGTH,
  VENDOR_PO_NUMBER_MAX_LENGTH,
  previewPurchasingDocumentNumber,
} from '@/lib/purchasing/numbering';
import {
  getPurchasingSeries,
  savePurchasingSettings,
  type PurchasingSeries,
} from '@/utils/purchasingSettingsAccess';

/** `purchasing_document_series.terms_and_conditions` holds at most this much. */
const TERMS_MAX_LENGTH = 10_000;

export interface PurchasingSettingsDialogProps {
  open: boolean;
  companyId: string;
  onClose: () => void;
  /** After a save lands. */
  onSaved?: () => void;
}

/**
 * Purchase order numbering and the printed terms & conditions (plan §3.13, criterion N2).
 *
 * ANY OFFICE USER, not only admins: continuing a shop's QuickBooks numbers is the buyer's job, so
 * this sits on the Purchasing hub rather than in admin-only Settings. The database is the
 * authority — it refuses a next number at or below one already issued — and this dialog previews
 * it and refuses, before any request, what the database would: the prefix shape and QuickBooks
 * Desktop's 11-character limit.
 *
 * Mounted fresh on each open, so what it edits is always what is saved now.
 */
export default function PurchasingSettingsDialog({ open, companyId, onClose, onSaved }: PurchasingSettingsDialogProps) {
  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth aria-labelledby="purchasing-settings-title">
      <DialogTitle id="purchasing-settings-title">Purchasing settings</DialogTitle>
      {open && <SettingsBody companyId={companyId} onClose={onClose} onSaved={onSaved} />}
    </Dialog>
  );
}

function SettingsBody({ companyId, onClose, onSaved }: Omit<PurchasingSettingsDialogProps, 'open'>) {
  const { data, loading, error, reload } = useLoad(() => getPurchasingSeries(companyId), [companyId]);

  if (loading && !data) {
    return (
      <DialogContent sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
        <CircularProgress />
      </DialogContent>
    );
  }
  if (!data) {
    return (
      <>
        <DialogContent>
          <LoadFailedState error={error} entity="purchasing settings" onRetry={() => void reload()} />
        </DialogContent>
        <DialogActions>
          <Button onClick={onClose}>Close</Button>
        </DialogActions>
      </>
    );
  }
  return <SettingsForm companyId={companyId} saved={data} onClose={onClose} onSaved={onSaved} />;
}

const WHOLE = /^\d+$/;

function SettingsForm({
  companyId,
  saved,
  onClose,
  onSaved,
}: {
  companyId: string;
  saved: PurchasingSeries;
  onClose: () => void;
  onSaved?: () => void;
}) {
  const po = saved.vendor_purchase_order;
  const rfq = saved.vendor_rfq;
  const [prefix, setPrefix] = useState(po.prefix);
  const [nextText, setNextText] = useState(String(po.nextNumber));
  const [digitsText, setDigitsText] = useState(String(po.minDigits));
  const [poTerms, setPoTerms] = useState(po.termsAndConditions ?? '');
  const [rfqTerms, setRfqTerms] = useState(rfq.termsAndConditions ?? '');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<unknown>(null);

  const nextNumber = WHOLE.test(nextText.trim()) ? Number(nextText.trim()) : Number.NaN;
  const minDigits = WHOLE.test(digitsText.trim()) ? Number(digitsText.trim()) : Number.NaN;
  const preview = previewPurchasingDocumentNumber({
    kind: 'vendor_purchase_order',
    prefix,
    nextNumber,
    minDigits,
  });

  // What moved, against what was loaded — derived every render, never latched, so changing a field
  // and changing it back is no change (interaction-standards.md "Dirty state is derived").
  const prefixChanged = prefix !== po.prefix;
  const nextChanged = nextNumber !== po.nextNumber;
  const digitsChanged = minDigits !== po.minDigits;
  const numberingChanged = prefixChanged || nextChanged || digitsChanged;
  const poTermsChanged = poTerms.trim() !== (po.termsAndConditions ?? '').trim();
  const rfqTermsChanged = rfqTerms.trim() !== (rfq.termsAndConditions ?? '').trim();
  const dirty = numberingChanged || poTermsChanged || rfqTermsChanged;

  const blocking: string[] = [];
  if (preview.errors.prefix) blocking.push(preview.errors.prefix);
  if (preview.errors.nextNumber) blocking.push(preview.errors.nextNumber);
  if (preview.errors.minDigits) blocking.push(preview.errors.minDigits);
  if (poTerms.length > TERMS_MAX_LENGTH || rfqTerms.length > TERMS_MAX_LENGTH) {
    blocking.push(`Terms and conditions can be at most ${TERMS_MAX_LENGTH.toLocaleString('en-US')} characters.`);
  }
  const canSave = dirty && blocking.length === 0 && !saving;

  const handleSave = async () => {
    if (!canSave) return;
    setSaving(true);
    setSaveError(null);
    try {
      if (numberingChanged || poTermsChanged) {
        await savePurchasingSettings(companyId, 'vendor_purchase_order', {
          ...(numberingChanged ? { numbering: { prefix, nextNumber, minDigits } } : {}),
          ...(poTermsChanged ? { termsAndConditions: poTerms.trim() || null } : {}),
        });
      }
      if (rfqTermsChanged) {
        await savePurchasingSettings(companyId, 'vendor_rfq', { termsAndConditions: rfqTerms.trim() || null });
      }
      posthog.capture('purchasing settings saved', {
        prefix_changed: prefixChanged,
        next_number_changed: nextChanged,
        digits_changed: digitsChanged,
        po_terms_changed: poTermsChanged,
        rfq_terms_changed: rfqTermsChanged,
      });
      onSaved?.();
      onClose();
    } catch (err) {
      setSaveError(err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <DialogContent dividers>
        <Stack spacing={2.5}>
          <Box>
            <Typography variant="subtitle1" sx={{ fontWeight: 600, mb: 0.5 }}>
              Purchase order numbers
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
              Continuing your QuickBooks numbers? Start above the last PO you wrote there — or use a
              prefix QuickBooks never uses, so the two never collide.
            </Typography>
            <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr 1fr' }, gap: 2 }}>
              <TextField
                label="Prefix"
                value={prefix}
                onChange={(e) => setPrefix(e.target.value)}
                error={Boolean(preview.errors.prefix)}
                helperText={preview.errors.prefix ?? `Up to ${PURCHASING_PREFIX_MAX_LENGTH} letters, numbers or hyphens. Can be empty.`}
                slotProps={{ htmlInput: { maxLength: PURCHASING_PREFIX_MAX_LENGTH + 4, autoCapitalize: 'characters' } }}
              />
              <TextField
                label="Next number"
                value={nextText}
                onChange={(e) => setNextText(e.target.value)}
                error={Boolean(preview.errors.nextNumber)}
                helperText={preview.errors.nextNumber ?? 'The number the next PO gets.'}
                slotProps={{ htmlInput: { inputMode: 'numeric' } }}
              />
              <TextField
                label="Digits"
                value={digitsText}
                onChange={(e) => setDigitsText(e.target.value)}
                error={Boolean(preview.errors.minDigits)}
                helperText={preview.errors.minDigits ?? `Padded with zeros, ${MIN_DIGITS_RANGE.min} to ${MIN_DIGITS_RANGE.max}.`}
                slotProps={{ htmlInput: { inputMode: 'numeric' } }}
              />
            </Box>
            <Box sx={{ mt: 1.5, minHeight: (theme) => theme.spacing(3) }}>
              {preview.caption ? (
                <Typography variant="body1" sx={{ fontWeight: 600 }}>
                  {preview.caption}
                </Typography>
              ) : (
                <Typography variant="body2" color="text.secondary">
                  A PO number can have at most {VENDOR_PO_NUMBER_MAX_LENGTH} characters, the limit QuickBooks Desktop
                  accepts.
                </Typography>
              )}
            </Box>
          </Box>

          <TextField
            label="Purchase order terms and conditions"
            value={poTerms}
            onChange={(e) => setPoTerms(e.target.value)}
            multiline
            minRows={4}
            maxRows={12}
            helperText="Printed at the end of every new purchase order. A PO already made keeps the terms it was made with."
            slotProps={{ htmlInput: { maxLength: TERMS_MAX_LENGTH } }}
          />

          <Divider />

          <Box>
            <Typography variant="subtitle1" sx={{ fontWeight: 600, mb: 0.5 }}>
              Requests for quote
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
              RFQs are always numbered RFQ-0001, RFQ-0002 and on. Next: {rfq.nextNumberPreview}.
            </Typography>
            <TextField
              label="RFQ terms and conditions"
              value={rfqTerms}
              onChange={(e) => setRfqTerms(e.target.value)}
              multiline
              minRows={3}
              maxRows={10}
              fullWidth
              helperText="Printed on every new request for quote."
              slotProps={{ htmlInput: { maxLength: TERMS_MAX_LENGTH } }}
            />
          </Box>

          {saveError != null && (
            <ErrorAlert error={saveError} entity="purchasing settings" onClose={() => setSaveError(null)} />
          )}
          {saved.vendor_purchase_order.isDefault && !dirty && (
            <Alert severity="info">These are the starting settings. Nothing is saved until you change one.</Alert>
          )}
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 3, py: 2, flexDirection: 'column', alignItems: 'stretch', gap: 1 }}>
        <MissingFieldsNotice items={blocking} />
        <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 1 }}>
          <Button onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button
            variant="contained"
            onClick={() => void handleSave()}
            disabled={!canSave}
            startIcon={saving ? <CircularProgress size={16} color="inherit" /> : undefined}
          >
            Save
          </Button>
        </Box>
      </DialogActions>
    </>
  );
}
