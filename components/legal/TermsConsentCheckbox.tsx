'use client';

import { useId } from 'react';

import posthog from 'posthog-js';

import Box from '@mui/material/Box';
import Checkbox from '@mui/material/Checkbox';
import MuiLink from '@mui/material/Link';
import Typography from '@mui/material/Typography';

import { LEGAL_ROUTES, LEGAL_LABELS } from '@/lib/legal/manifest';

interface Props {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  /** Larger hit area for the shop floor — a phone, one-handed, in a bright room. */
  touch?: boolean;
  /** Which screen is presenting the documents. Matches the DB CHECK on
   *  terms_acceptances.accepted_via, one spelling for both. */
  surface: 'invite_accept' | 'signup' | 'reacceptance_dashboard' | 'reacceptance_operator';
}

/**
 * The clickwrap control: one unchecked box, both documents linked inline beside
 * the words it is asking you to agree to.
 *
 * UNCHECKED ON EVERY MOUNT. No `defaultChecked`, no persistence, no "remember my
 * choice". A pre-ticked box is not assent, and it is the most common reason a
 * clickwrap is held unenforceable.
 *
 * THE TEXT IS DELIBERATELY NOT A <label>, and this is the whole design.
 *
 * The obvious build — MUI `FormControlLabel` with the links inside its label —
 * has a defect that is fatal here, and it is not theoretical: MEASURED in this
 * repo's own test run, clicking "Terms of Service" inside the label TICKED THE
 * BOX. Label activation is native browser behaviour, not a bubbling listener, so
 * `stopPropagation` on the anchor does not stop it, and `preventDefault` would
 * kill the navigation the link exists for. The HTML "interactive content"
 * carve-out that is supposed to spare a real `<a href>` did not apply.
 *
 * The failure mode that produces is the worst one available in this feature: a
 * user clicks through to READ the terms, comes back, and finds themselves
 * already recorded as having agreed to them. That is a forged act of assent, on
 * the one screen whose entire purpose is to make assent provable.
 *
 * So the sentence sits beside the box as ordinary text and is bound to it with
 * `aria-labelledby`, NOT as a `<label>`. The checkbox's accessible name is still
 * the full sentence, and the two links stay in the reading order and the tab
 * order — a screen-reader user must be able to reach the documents they are
 * being asked to agree to, which `aria-hidden` on the text would have taken
 * away. Clicking the words does nothing; the ONLY way to consent is to hit the
 * box. For a consent control that is a feature rather than a cost: it cannot be
 * triggered incidentally.
 *
 * PLAIN ANCHORS, NOT next/link. `next/link` prefetches on hover and in the
 * viewport, and the privacy policy is 154 KB. Prefetching that onto every
 * operator's phone over cellular is the cost the device model forbids.
 *
 * target="_blank" is load-bearing for a different reason on each surface: on
 * /accept-invite the form holds a typed password and the page has already
 * consumed the URL hash, so a same-tab navigation destroys both; inside the
 * re-acceptance modal, navigating away dismisses the thing you are being asked
 * to read.
 */
export default function TermsConsentCheckbox({
  checked,
  onChange,
  disabled,
  touch,
  surface,
}: Props) {
  const labelId = useId();

  // Whether anyone actually opens the documents is the legally interesting fact
  // -- it goes to conspicuousness -- and nothing else in the product records it.
  const opened = (documentType: 'tos' | 'privacy') => () =>
    posthog.capture('terms document opened', { surface, document_type: documentType });

  return (
    <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 0.5 }}>
      <Checkbox
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        disabled={disabled}
        // lib/theme.ts's 48px floor does not cover Checkbox — design-system.md
        // says so explicitly — so the touch target is set here.
        sx={{ p: touch ? 1.5 : 1, mt: touch ? 0 : -0.25 }}
        inputProps={{ 'aria-labelledby': labelId }}
      />
      <Typography
        id={labelId}
        variant="body2"
        sx={{ mt: touch ? 1.5 : 1, color: 'text.primary', lineHeight: 1.5 }}
      >
        I agree to the{' '}
        <MuiLink
          href={LEGAL_ROUTES.tos}
          target="_blank"
          rel="noopener noreferrer"
          onClick={opened('tos')}
          underline="always"
        >
          {LEGAL_LABELS.tos}
        </MuiLink>{' '}
        and{' '}
        <MuiLink
          href={LEGAL_ROUTES.privacy}
          target="_blank"
          rel="noopener noreferrer"
          onClick={opened('privacy')}
          underline="always"
        >
          {LEGAL_LABELS.privacy}
        </MuiLink>
      </Typography>
    </Box>
  );
}
