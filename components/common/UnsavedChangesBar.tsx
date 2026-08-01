'use client';

import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import CircularProgress from '@mui/material/CircularProgress';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';

interface UnsavedChangesBarProps {
  /**
   * How many things are staged. Omit (or pass 0) when the surface edits a single
   * value and a count would read oddly — the bar falls back to "Unsaved changes".
   */
  count?: number;
  /** Label for the commit button — name the thing ("Save pricing", "Save costs"). */
  saveLabel: string;
  saving: boolean;
  onSave: () => void;
  onDiscard: () => void;
}

/**
 * The one unsaved-changes affordance for every **staged explicit-Save** surface
 * (interaction-standards.md §2). Shared rather than re-implemented per card, so
 * "you have work pending" cannot drift into looking different on each screen —
 * inconsistency here is what produced the incident this pattern exists to
 * prevent.
 *
 * Design notes worth not re-litigating:
 *
 * - **Sticky, so it survives scrolling.** The caption-sized grey hint this
 *   replaced sat below the fold and went unread.
 * - **Persistent, never auto-dismissing.** §1's audience floor rules out timed
 *   toasts as a recovery path (WCAG 2.2.1, M3, Primer, JMIR 2023).
 * - **Rendered only when dirty** — with nothing staged the action is genuinely
 *   irrelevant, not blocked (§4 rule 3). Its *appearance* is the signal; a
 *   permanently-present Save button carries none.
 * - **Amber, not red.** An unsaved edit is not a mistake and must not read as
 *   one; red stays reserved for broken.
 * - **A pencil, not a warning triangle** — "you have edits", not "you erred".
 *
 * Pair it with a marker at the changed input itself (a `3px warning.main` left
 * accent on a table row, an amber outline on a standalone field) so the user
 * can see *where* the change is, not just that one exists.
 */
export default function UnsavedChangesBar({
  count,
  saveLabel,
  saving,
  onSave,
  onDiscard,
}: UnsavedChangesBarProps) {
  const label =
    !count || count < 1
      ? 'Unsaved changes'
      : count === 1
        ? '1 unsaved change'
        : `${count} unsaved changes`;

  return (
    <Box
      sx={{
        position: 'sticky',
        bottom: 0,
        zIndex: 2,
        mt: 2,
        px: 2,
        py: 1.5,
        display: 'flex',
        alignItems: 'center',
        gap: 1.5,
        flexWrap: 'wrap',
        borderTop: '2px solid',
        borderColor: 'warning.main',
        borderRadius: 1,
        // Matches the sticky Header's frosted treatment — `background.paper` is
        // deliberately translucent, so content would otherwise scroll visibly
        // through this bar.
        bgcolor: 'background.paper',
        backdropFilter: 'blur(8px)',
      }}
    >
      <EditOutlinedIcon fontSize="small" sx={{ color: 'warning.main' }} />
      <Typography variant="body2" sx={{ fontWeight: 600 }}>
        {label}
      </Typography>
      <Box sx={{ flex: 1 }} />
      <Button size="small" onClick={onDiscard} disabled={saving}>
        Discard
      </Button>
      <Button
        variant="contained"
        size="small"
        onClick={onSave}
        disabled={saving}
        startIcon={saving ? <CircularProgress size={16} color="inherit" /> : undefined}
      >
        {saving ? 'Saving…' : saveLabel}
      </Button>
    </Box>
  );
}

/**
 * `sx` fragment marking a standalone input as holding a staged edit — the
 * single-field counterpart to the tier rows' left accent. Spread into the
 * field's own `sx` when dirty.
 */
export const unsavedFieldSx = {
  '& .MuiOutlinedInput-notchedOutline': {
    borderColor: 'warning.main',
    borderWidth: 2,
  },
} as const;
