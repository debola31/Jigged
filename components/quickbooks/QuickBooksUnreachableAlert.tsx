'use client';

import Alert from '@mui/material/Alert';
import AlertTitle from '@mui/material/AlertTitle';
import Button from '@mui/material/Button';

/**
 * QuickBooks Desktop is not answering right now.
 *
 * severity="warning", never "error", and the closing sentence matters as much as
 * the severity: the shop's PC being off or QuickBooks being closed is the
 * EXPECTED path, not a fault, and nothing about their setup has broken. Rendering
 * it as an error teaches people to distrust a connection that is fine.
 *
 * Shared by the settings card, the push dialog and the customer-matching screen so
 * the three cannot drift into describing the same condition three ways.
 */
export default function QuickBooksUnreachableAlert({
  message,
  code,
  onRetry,
  busy,
  sx,
}: {
  /** Conductor's own userFacingMessage when we have one — it names the shop PC
   *  and the Web Connector better than we would. */
  message?: string | null;
  /** Distinguishes "the PC isn't answering" from "setup was never finished".
   *  Both are warnings with a retry, but they ask for different actions, and a
   *  heading that contradicts its own body teaches people to ignore the heading. */
  code?: string | null;
  onRetry?: () => void;
  busy?: boolean;
  sx?: object;
}) {
  const notSetUp = code === 'qbd_not_connected';
  return (
    <Alert
      severity="warning"
      sx={{ mb: 2, ...sx }}
      action={
        onRetry ? (
          <Button color="inherit" size="small" onClick={onRetry} disabled={busy}>
            Try again
          </Button>
        ) : undefined
      }
    >
      <AlertTitle>
        {notSetUp
          ? "Setup isn't finished yet"
          : "QuickBooks isn't answering right now"}
      </AlertTitle>
      {message ??
        'Open QuickBooks Desktop on the shop computer, make sure that computer is on and online, then try again.'}{' '}
      {notSetUp
        ? 'Finish the steps on the setup page, then check again.'
        : 'Nothing is broken — your connection is still set up.'}
    </Alert>
  );
}
