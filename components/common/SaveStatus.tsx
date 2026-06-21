'use client';

import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import CircularProgress from '@mui/material/CircularProgress';
import CloudDoneOutlinedIcon from '@mui/icons-material/CloudDoneOutlined';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutline';

export type SaveState = 'idle' | 'saving' | 'saved' | 'error';

interface SaveStatusProps {
  state: SaveState;
  /** Override the "Saved" label, e.g. "All changes saved". */
  savedLabel?: string;
  size?: 'small' | 'inherit';
}

/**
 * One shared auto-save status indicator, reused across every auto-saving
 * surface so the signal is identical everywhere (the inconsistent per-section
 * badges were the root of "did it save?" confusion).
 *
 * - Lives in an aria-live="polite" region (present-but-empty when idle) so
 *   screen readers announce "Saving…/Saved" without interrupting.
 * - `idle` renders an empty (but reserved) region to avoid layout shift.
 */
export default function SaveStatus({ state, savedLabel = 'Saved', size = 'small' }: SaveStatusProps) {
  const iconSize = size === 'small' ? 16 : undefined;
  return (
    <Box
      role="status"
      aria-live="polite"
      aria-atomic="true"
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 0.5,
        minHeight: 20,
        color: state === 'error' ? 'error.main' : 'text.secondary',
      }}
    >
      {state === 'saving' && (
        <>
          <CircularProgress size={iconSize} color="inherit" />
          <Typography variant="caption">Saving…</Typography>
        </>
      )}
      {state === 'saved' && (
        <>
          <CloudDoneOutlinedIcon fontSize="small" color="success" />
          <Typography variant="caption">{savedLabel}</Typography>
        </>
      )}
      {state === 'error' && (
        <>
          <ErrorOutlineIcon fontSize="small" color="error" />
          <Typography variant="caption">Couldn’t save</Typography>
        </>
      )}
    </Box>
  );
}
