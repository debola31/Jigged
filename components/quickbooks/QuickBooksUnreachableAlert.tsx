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
  onRetry,
  busy,
  sx,
}: {
  /** Conductor's own userFacingMessage when we have one — it names the shop PC
   *  and the Web Connector better than we would. */
  message?: string | null;
  onRetry?: () => void;
  busy?: boolean;
  sx?: object;
}) {
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
      <AlertTitle>QuickBooks isn&apos;t answering right now</AlertTitle>
      {message ??
        'Open QuickBooks Desktop on the shop computer, make sure that computer is on and online, then try again.'}{' '}
      Nothing is broken — your connection is still set up.
    </Alert>
  );
}
