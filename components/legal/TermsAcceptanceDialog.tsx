'use client';

import { useState } from 'react';
import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import posthog from 'posthog-js';

import MissingFieldsNotice from '@/components/common/MissingFieldsNotice';
import TermsConsentCheckbox from '@/components/legal/TermsConsentCheckbox';
import { useAuth } from '@/components/providers/AuthProvider';
import { recordTermsAcceptance } from '@/lib/legal/acceptClient';
import { CURRENT_LEGAL_VERSIONS, LEGAL_LABELS, type LegalDocumentType } from '@/lib/legal/manifest';

interface Props {
  needs: LegalDocumentType[];
  /** Which screen is presenting this. Recorded as accepted_via and sent as the
   *  `surface` property, so the row and the event always agree. */
  surface: 'reacceptance_dashboard' | 'reacceptance_operator';
  onAccepted: () => void;
}

/**
 * The re-acceptance prompt.
 *
 * NO onClose HANDLER AT ALL, rather than a guarded one. MUI's Modal only closes
 * on backdrop click or Escape by calling onClose, so omitting it makes the block
 * structural — there is no condition for someone to loosen later. MUI still sets
 * aria-modal, aria-hides the rest of the app and traps focus, so the block is
 * real for keyboard and screen-reader users too and not merely visual.
 *
 * WHAT IT SHOWS: the version and links, NOT the document. 154 KB of policy on a
 * 390px screen is hostile, nobody reads it, and a wall of text nobody reads is
 * WORSE for defensibility than a clear link they chose to open.
 *
 * EXACTLY TWO ACTIONS, ALWAYS. "I agree" plus EITHER "Remind me later" OR
 * "Sign out" — they swap, never both. Two reasons: the screen must never trap
 * someone who will not agree, and a mis-tapped Sign out costs an operator their
 * session AND their station (AuthProvider.signOut clears the stored station),
 * so it must not sit next to the button they are reaching for every time.
 */
export default function TermsAcceptanceDialog({ needs, surface, onAccepted }: Props) {
  const { signOut } = useAuth();
  const [accepted, setAccepted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const labels = needs.map((n) => LEGAL_LABELS[n]).join(' and ');
  const version = CURRENT_LEGAL_VERSIONS[needs[0] ?? 'tos'];

  async function handleAccept() {
    setSaving(true);
    setError(null);
    try {
      await recordTermsAcceptance({ acceptedVia: surface, documentTypes: needs });
      posthog.capture('terms accepted', { surface, is_reacceptance: true });
      onAccepted();
    } catch (err) {
      // Leave the dialog open with the box still ticked, so a retry is one tap.
      setError(err instanceof Error ? err.message : 'Could not record your agreement');
      setSaving(false);
    }
  }

  return (
    <Dialog
      open
      disableEscapeKeyDown
      maxWidth="sm"
      fullWidth
      aria-labelledby="terms-dialog-title"
      // Full-bleed on a phone via breakpoints rather than useMediaQuery: jsdom
      // has no matchMedia, and this dialog needs to stay exercisable in a test.
      slotProps={{
        paper: {
          sx: {
            m: { xs: 0, sm: 4 },
            width: { xs: '100%', sm: 'auto' },
            maxHeight: { xs: '100%', sm: 'calc(100% - 64px)' },
            borderRadius: { xs: 0, sm: 3 },
          },
        },
      }}
    >
      <DialogTitle id="terms-dialog-title">Our terms have been updated</DialogTitle>

      <DialogContent>
        <Stack spacing={2}>
          <Typography variant="body2" color="text.secondary">
            We have published a new version of the {labels}. Please review and agree to continue
            using Jigged.
          </Typography>
          <Typography variant="caption" color="text.secondary">
            Version {version.version} · effective {version.effective_date}
          </Typography>

          {error && <Alert severity="error">{error}</Alert>}

          <TermsConsentCheckbox
            checked={accepted}
            onChange={setAccepted}
            disabled={saving}
            touch
            surface={surface}
          />

          <MissingFieldsNotice
            items={accepted ? [] : ['Agree to the updated documents']}
            title="Before you can continue:"
          />
        </Stack>
      </DialogContent>

      <DialogActions sx={{ flexDirection: 'column', gap: 2, p: 2, pt: 0 }}>
        <Button
          variant="contained"
          fullWidth
          disabled={!accepted || saving}
          onClick={handleAccept}
          sx={{ minHeight: 56 }}
        >
          {saving ? <CircularProgress size={22} color="inherit" /> : 'I agree — continue'}
        </Button>

        {/*
          The only way out for someone who will not agree, so it must exist --
          but it is deliberately small, low-contrast and set apart from the
          full-width button above rather than stacked flush against it. A
          mis-tap here costs an operator their SESSION and their STATION:
          AuthProvider.signOut() clears the stored station on the way out, on
          purpose, so that the next person to sign in on a shared shop phone
          does not inherit the machine the last one was standing at and file
          their notes against it. Preserving the station here would remove a
          mis-tap's sting by reintroducing that mis-attribution hazard; making
          the button hard to hit by accident costs nothing and keeps both.
        */}
        <Button
          size="small"
          color="inherit"
          disabled={saving}
          onClick={() => signOut()}
          sx={{ textTransform: 'none', opacity: 0.7, minHeight: 36, mt: 1 }}
        >
          Sign out instead
        </Button>
      </DialogActions>

    </Dialog>
  );
}
