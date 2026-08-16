'use client';

import Box from '@mui/material/Box';
import Button, { type ButtonProps } from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Typography from '@mui/material/Typography';

/**
 * A button that says what it is waiting for.
 *
 * WHY THIS EXISTS. Three separate bug reports from a live shop, all the same
 * shape: a button that only greys out during a multi-second round trip reads as
 * a dropped click. `disabled` alone is not feedback — docs/interaction-standards
 * §4 already said a disabled control needs a visible reason, and a busy button is
 * exactly a disabled control with no reason given.
 *
 * WHEN TO USE IT. Only above ~1 second. Below that a spinner is noise, not help:
 * Nielsen's limits put 0.1s at "instantaneous" and 1s at "flow of thought
 * uninterrupted", with no feedback warranted under either. In this codebase that
 * means Supabase CRUD stays a plain <Button>, and anything crossing to a third
 * party — Conductor's Web Connector, Intuit, Stripe, Anthropic, FedEx — uses this.
 * The full rule, including the >10s case, is docs/interaction-standards.md §5.
 *
 * WHAT IT GUARANTEES, each learned from one of those bugs:
 *
 *   ONLY THE PRESSED CONTROL SPEAKS. `pending` is per-button, never a shared
 *   `busy`. A neighbour that greys out AND claims to be working is a worse lie
 *   than silence, so callers pass `disabled={busy} pending={which === 'mine'}`.
 *
 *   THE LABEL NAMES THE WAIT. `pendingLabel` is required, not optional, because
 *   "Loading…" hides the only fact that makes a long pause make sense — what is
 *   being waited on. "Creating setup link…" and "Reading accounts…" are the
 *   shipped examples.
 *
 *   ASSISTIVE TECH IS TOLD. `aria-busy` marks the control, and `pendingDetail`
 *   renders in a role="status" live region. WCAG 2.2 SC 4.1.3 (Level AA) covers
 *   exactly this — status messages "on the waiting state of an application, on
 *   the progress of a process" must be programmatically determinable without
 *   taking focus. A silent spinner is an AA gap, not a style choice.
 *
 * Not handled here, because it is a caller's judgment: whether to clear `pending`
 * on success. A hand-off that navigates away should KEEP spinning (an idle button
 * mid-redirect looks like the click was lost); everything else clears. Both must
 * clear on failure, or retrying becomes impossible.
 */
export default function BusyButton({
  pending,
  pendingLabel,
  pendingDetail,
  children,
  disabled,
  startIcon,
  ...rest
}: Omit<ButtonProps, 'startIcon'> & {
  /** True only for the control the user actually pressed. */
  pending?: boolean;
  /** What this button is waiting for — shown in place of the label. */
  pendingLabel: string;
  /** Optional line under the button for waits that can exceed ~10s: say WHERE
   *  the wait is and that it may run long. Announced politely. */
  pendingDetail?: string;
  startIcon?: ButtonProps['startIcon'];
}) {
  const button = (
    <Button
      {...rest}
      disabled={disabled}
      aria-busy={pending || undefined}
      startIcon={pending ? <CircularProgress size={16} color="inherit" /> : startIcon}
    >
      {pending ? pendingLabel : children}
    </Button>
  );

  if (!pendingDetail) return button;

  return (
    <Box>
      {button}
      {/* Rendered only while pending, inside a live region, so it is announced
          when it appears rather than read on focus the user does not have. */}
      {pending && (
        <Typography
          role="status"
          variant="caption"
          color="text.secondary"
          display="block"
          sx={{ mt: 1 }}
        >
          {pendingDetail}
        </Typography>
      )}
    </Box>
  );
}
