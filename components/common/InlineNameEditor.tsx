'use client';

import { useState } from 'react';
import Box from '@mui/material/Box';
import IconButton from '@mui/material/IconButton';
import TextField from '@mui/material/TextField';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import EditIcon from '@mui/icons-material/Edit';

import SaveStatus, { type SaveState } from '@/components/common/SaveStatus';

/**
 * A record's NAME in a detail-page header, edited in place.
 *
 * Reads as a HEADING until you ask to change it. A name is the one field on
 * these pages that is read constantly and edited almost never — an always-live
 * input in the title position makes the page look like a form and puts a
 * caret-sized target where a heading belongs. The pencil is the exception to
 * the otherwise auto-save-everywhere model on these pages, and it earns it:
 * the other fields are things you come here to set, the name is the thing you
 * came here to confirm.
 *
 * Still auto-save once open — commits on blur or Enter, so the pencil reveals
 * an editor rather than starting a staged form. Escape reverts and closes.
 *
 * ── Why the input WRAPS ─────────────────────────────────────────────────────
 *
 * It is `multiline`, and that is the fix for a real bug rather than a
 * stylistic choice. The editor renders at heading size (the theme's `h5`) so it
 * looks like the thing it replaced — but a single-line input at that size fits
 * only ~30 characters before it scrolls, and an input scrolled to the caret
 * hides its own beginning. "BlueRidge Medical Devices" opened for editing and
 * showed "eRidge Medical Devices", with no indication anything was cut off.
 *
 * The heading it replaces wraps. The editor now wraps too, so what you see
 * while editing is what you saw before you clicked — which is the whole point
 * of editing in place.
 *
 * Enter still commits (never inserts a newline — the keydown preventDefaults),
 * and pasted newlines are flattened to spaces, so `multiline` buys the wrap
 * without letting a name become multi-line data.
 */

interface Props {
  /**
   * The last SAVED value. Shown as the heading, and used to seed the draft each
   * time the editor opens — so cancelling, or reopening after a failed save,
   * always starts from what is actually stored.
   */
  displayName: string;
  label: string;
  /** Tooltip on the pencil, e.g. "Rename this vendor". */
  editTooltip: string;
  error?: string;
  saveState: SaveState;
  readOnly?: boolean;
  /**
   * Every keystroke. Optional: only callers that mirror the value into a larger
   * snapshot need it — the customer page does, because `updateCustomer` writes
   * a full column set and a stale mirror would silently revert other fields.
   */
  onChange?: (value: string) => void;
  /**
   * Commit (blur or Enter), with the trimmed value. Resolve TRUE when the value
   * is saved (or unchanged), FALSE when it was refused.
   *
   * The boolean is what keeps a refused save visible. This used to be `void`,
   * and the editor decided whether to close by reading the `saveState` PROP
   * right after calling it — which is stale, because the save is async and
   * nothing had re-rendered yet. So a duplicate name closed the editor and
   * threw its own error away: the heading snapped back to the old value with no
   * indication the rename had been refused. Reporting the outcome removes the
   * race rather than papering over it with a timeout.
   */
  onCommit: (value: string) => boolean | Promise<boolean>;
  /** Escape. Lets a mirroring parent revert its own copy. */
  onCancel?: () => void;
}

export default function InlineNameEditor({
  displayName,
  label,
  editTooltip,
  error,
  saveState,
  readOnly = false,
  onChange,
  onCommit,
  onCancel,
}: Props) {
  const [editing, setEditing] = useState(false);
  // The editor owns the draft. Seeding it on OPEN rather than syncing it from a
  // prop is what keeps this effect-free: there is no "prop changed, patch the
  // state" moment to write an effect for, and no window where the two disagree.
  const [draft, setDraft] = useState(displayName);

  const open = () => {
    setDraft(displayName);
    setEditing(true);
  };

  const [committing, setCommitting] = useState(false);

  /**
   * Commit, and close ONLY if the parent says it saved.
   *
   * A failed save keeps the editor open, because closing it would hide the
   * error next to the value that caused it — and would silently discard what
   * the user typed.
   */
  const commit = async () => {
    if (committing) return; // blur can fire twice: Enter blurs, then focus moves
    setCommitting(true);
    try {
      if (await onCommit(draft.trim())) setEditing(false);
    } finally {
      setCommitting(false);
    }
  };

  if (readOnly || !editing) {
    return (
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <Typography variant="h5" sx={{ fontWeight: 600 }}>
          {displayName}
        </Typography>
        {!readOnly && (
          <Tooltip title={editTooltip}>
            <IconButton size="small" onClick={open} aria-label="Edit name">
              <EditIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        )}
      </Box>
    );
  }

  return (
    <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1, width: '100%' }}>
      <TextField
        autoFocus
        multiline
        label={label}
        value={draft}
        onChange={(e) => {
          const next = e.target.value.replace(/[\r\n]+/g, ' ');
          setDraft(next);
          onChange?.(next);
        }}
        onBlur={() => void commit()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            // Commit, never a newline — the field is multiline only so it wraps.
            e.preventDefault();
            (e.target as HTMLTextAreaElement).blur();  // blur commits
          } else if (e.key === 'Escape') {
            onCancel?.();
            setEditing(false);
          }
        }}
        error={!!error}
        helperText={error || 'Enter to save, Escape to cancel'}
        required
        fullWidth
        // Wear the heading's OWN typography rather than a hand-copied
        // approximation of it. The `fontSize: '1.5rem'` this replaces was MUI's
        // DEFAULT h5; this theme's h5 is 1.25rem, so the name grew 20% the
        // moment you clicked the pencil. It also clipped: MUI gives the input
        // `line-height: 1.4375em` resolved against the ROOT font size, i.e. a
        // fixed 23px, and a 24px font in a 23px line box loses its descenders —
        // "FastenRight Hardware" was missing the tail of its "g". Spreading the
        // variant brings the right line-height with it, and keeps the editor in
        // step with the heading if the theme ever moves.
        sx={(theme) => ({ '& .MuiInputBase-input': theme.typography.h5 })}
      />
      <Box sx={{ pt: 2 }}>
        <SaveStatus state={saveState} />
      </Box>
    </Box>
  );
}
