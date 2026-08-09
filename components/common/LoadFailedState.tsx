'use client';

import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import CloudOffIcon from '@mui/icons-material/CloudOff';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutline';
import RefreshIcon from '@mui/icons-material/Refresh';
import { friendlyErrorMessage, isNetworkFailureError } from '@/lib/supabaseErrors';

interface LoadFailedStateProps {
  /** Whatever the loader rejected with. */
  error: unknown;
  /** What failed to load, for the copy: "parts", "this vendor", "this customer". */
  entity: string;
  /** Re-runs the load. Wire `useLoad`'s `reload` straight to this. */
  onRetry: () => void;
}

/**
 * "We couldn't load this" — the state a failed READ needs, and the one this app was missing.
 *
 * WHY THIS EXISTS. `useLoad` keeps its previous `data` when a load rejects, so the FIRST load
 * failing leaves `data` null and the page falls through to its empty state. On the parts page
 * that rendered *"No parts yet. Add your first part"* with Import CSV and Add Part buttons — a
 * shop with three hundred parts, on a dropped connection, told its shop was empty and invited to
 * start over. A failure that renders as a successful empty result is the worst shape an error can
 * take, because nothing about it looks wrong.
 *
 * NOT `ErrorAlert`, which is for WRITE failures: its job is to explain why a save was refused
 * (chiefly the billing write-gate) and it offers no way to try again. A failed read needs the
 * opposite — little explanation, and a button.
 *
 * The copy splits on cause because the two have different remedies:
 *   - a network failure is the user's connection, and "try again" is genuinely the fix;
 *   - anything else came back from Postgres, so `friendlyErrorMessage` has something specific to
 *     say and we say it rather than guessing.
 *
 * `friendlyErrorMessage` rather than `error.message`: the access layer rejects with Supabase's
 * raw `{ code, details, hint, message }` object, so an `instanceof Error` check — which is what
 * these pages did — always misses and degrades to a generic string.
 */
export default function LoadFailedState({ error, entity, onRetry }: LoadFailedStateProps) {
  const isNetwork = isNetworkFailureError(error);
  const Icon = isNetwork ? CloudOffIcon : ErrorOutlineIcon;

  const detail = isNetwork
    ? 'Check your connection and try again. Nothing has been lost.'
    : friendlyErrorMessage(error, { fallback: `Something went wrong loading ${entity}.` });

  return (
    <>
      <Icon sx={{ fontSize: 64, color: 'text.secondary', mb: 2 }} />
      <Typography variant="h6" color="text.secondary" gutterBottom>
        Couldn&apos;t load {entity}.
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
        {detail}
      </Typography>
      <Box sx={{ display: 'flex', justifyContent: 'center' }}>
        <Button variant="contained" startIcon={<RefreshIcon />} onClick={onRetry}>
          Try Again
        </Button>
      </Box>
    </>
  );
}
