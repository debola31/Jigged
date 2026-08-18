'use client';

import { useMemo, useState } from 'react';
import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import {
  formatClockTime,
  formatDuration,
  isoToTimeInput,
  nudgeIso,
  timeInputToIso,
} from '@/lib/duration';

/**
 * Correct the recorded start/end of an interval.
 *
 * A DIALOG AND NOT INLINE EDITING, for the reason NoteEditDialog already
 * records: on a phone the keyboard covers an inline field, and collapsing a row
 * mid-list loses the reader's place.
 *
 * TWO INPUT PATHS, DELIBERATELY, because they fail in opposite directions:
 *
 *   * A native `<input type="time" step="300">`, which is zero bundle, inherits
 *     the OS accessibility settings, and on iOS opens the system wheel rather
 *     than a keyboard. MUI X's pickers were rejected: adding @mui/x-date-pickers
 *     pulls dayjs and a LocalizationProvider onto a route served over cellular
 *     to a phone, and MobileTimePicker defaults to the analogue dial that
 *     Material 3 itself de-prioritises for precise entry.
 *   * ±15 / ±5 nudge buttons, which need no keyboard, no modal, and no
 *     precision — the "I forgot to hit start" case is almost always a small
 *     shift, and each tap is independently undoable.
 *
 * There is no drag-to-scrub timeline. WCAG 2.5.7 would require a non-dragging
 * alternative anyway, that alternative IS these buttons, and a scrub handle is
 * the worst possible control for a gloved thumb.
 *
 * TIME-OF-DAY IS THE STORED TRUTH; the duration below is derived and read-only.
 * Entering a duration instead would mean back-solving an anchor, which silently
 * invents one of the two instants.
 */
export interface AdjustTimesDialogProps {
  open: boolean;
  onClose: () => void;
  onSave: (adjusted: { startedAt: string; endedAt: string | null }) => void | Promise<void>;
  /** The raw recorded values — shown as provenance, never overwritten. */
  rawStartedAt: string;
  rawEndedAt: string | null;
  /** Current effective values (raw, or a previous correction). */
  effectiveStartedAt: string;
  effectiveEndedAt: string | null;
  saving?: boolean;
  /** Set when the operator is being asked about a stale interval at their next tap. */
  prompt?: string;
  /**
   * A failure from the caller's save, rendered inside this dialog.
   *
   * The caller must ALSO keep the dialog open when it sets this. An earlier
   * version closed on failure and wrote the message to a state nothing rendered,
   * so a rejected write looked exactly like a successful one — the operator's
   * correction silently did nothing and their input was thrown away. A write
   * that fails must say so where the person who made it is looking.
   */
  saveError?: string | null;
}

const NUDGES = [-15, -5, 5, 15] as const;

export default function AdjustTimesDialog({
  open,
  onClose,
  onSave,
  rawStartedAt,
  rawEndedAt,
  effectiveStartedAt,
  effectiveEndedAt,
  saving = false,
  prompt,
  saveError = null,
}: AdjustTimesDialogProps) {
  // Seeded once, at mount. THE CALLER MOUNTS THIS ONLY WHILE IT IS OPEN (see the
  // `open && ...` guard at its call sites), which is what makes that correct —
  // reopening is a fresh mount and therefore a fresh seed. The alternative, an
  // effect that re-seeds when `open` flips, is a setState-in-effect and the
  // cascading render it causes is exactly what `react-hooks/set-state-in-effect`
  // is warning about.
  const [startIso, setStartIso] = useState(effectiveStartedAt);
  const [endIso, setEndIso] = useState<string | null>(effectiveEndedAt);
  const [error, setError] = useState<string | null>(null);

  const durationMs = useMemo(() => {
    if (!endIso) return null;
    return new Date(endIso).getTime() - new Date(startIso).getTime();
  }, [startIso, endIso]);

  const invalid = durationMs != null && durationMs <= 0;

  const handleSave = async () => {
    if (invalid) {
      setError('The finish time has to be after the start time.');
      return;
    }
    await onSave({ startedAt: startIso, endedAt: endIso });
  };

  const startChanged = startIso !== rawStartedAt;
  const endChanged = (endIso ?? null) !== (rawEndedAt ?? null);

  return (
    <Dialog open={open} onClose={saving ? undefined : onClose} maxWidth="xs" fullWidth>
      <DialogTitle>Adjust times</DialogTitle>
      <DialogContent>
        <Stack spacing={2.5} sx={{ mt: 1 }}>
          {prompt && (
            <Typography variant="body2" color="text.secondary">
              {prompt}
            </Typography>
          )}

          <TimeField
            label="Started"
            iso={startIso}
            onChange={setStartIso}
            direction="start"
            disabled={saving}
          />

          {endIso !== null && (
            <TimeField
              label="Finished"
              iso={endIso}
              onChange={setEndIso}
              direction="end"
              disabled={saving}
            />
          )}

          {/* Derived, never entered. */}
          <Typography variant="body2" color={invalid ? 'error.light' : 'text.secondary'}>
            {invalid
              ? 'The finish time has to be after the start time.'
              : durationMs != null
                ? `That is ${formatDuration(durationMs)}.`
                : 'Still running.'}
          </Typography>

          {/* PROVENANCE, NEUTRAL AND AGENTLESS. No pencil icon, no amber, no
              name, no count of how many times anyone has edited anything: this
              says what the record holds, it does not accuse. */}
          {(startChanged || endChanged) && (
            <Typography variant="caption" color="text.secondary">
              Recorded {formatClockTime(rawStartedAt)}
              {rawEndedAt ? ` – ${formatClockTime(rawEndedAt)}` : ''}
            </Typography>
          )}

          {(saveError || error) && (
            <Typography variant="body2" color="error.light">
              {saveError || error}
            </Typography>
          )}
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2, gap: 1 }}>
        <Button onClick={onClose} disabled={saving} size="large" sx={{ minHeight: 48 }}>
          Cancel
        </Button>
        <Button
          onClick={handleSave}
          variant="contained"
          color="primary"
          disabled={saving || invalid}
          size="large"
          sx={{ minHeight: 48 }}
        >
          Save
        </Button>
      </DialogActions>
    </Dialog>
  );
}

/** One labelled time, with a native picker and the nudge row beneath it. */
function TimeField({
  label,
  iso,
  onChange,
  direction,
  disabled,
}: {
  label: string;
  iso: string;
  onChange: (iso: string) => void;
  direction: 'start' | 'end';
  disabled: boolean;
}) {
  return (
    <Box>
      <TextField
        label={label}
        type="time"
        value={isoToTimeInput(iso)}
        onChange={(e) => {
          const next = timeInputToIso(e.target.value, iso, direction);
          if (next) onChange(next);
        }}
        disabled={disabled}
        fullWidth
        // Five-minute granularity. `step` is in SECONDS, and any value not
        // divisible by 60 makes the control grow a seconds segment — which is a
        // precision a human tap does not have.
        inputProps={{ step: 300, 'aria-label': label }}
        InputLabelProps={{ shrink: true }}
        sx={{ '& .MuiOutlinedInput-root': { minHeight: 56 } }}
      />
      <Box sx={{ display: 'flex', gap: 1, mt: 1 }}>
        {NUDGES.map((delta) => (
          <Button
            key={delta}
            onClick={() => onChange(nudgeIso(iso, delta))}
            disabled={disabled}
            variant="outlined"
            color="inherit"
            // 56px and full-width-share. These are the controls it is most
            // tempting to shrink, and the ones a gloved thumb needs most.
            sx={{ flex: 1, minHeight: 56, minWidth: 0, fontVariantNumeric: 'tabular-nums' }}
            aria-label={`${delta > 0 ? 'Add' : 'Subtract'} ${Math.abs(delta)} minutes to ${label}`}
          >
            {delta > 0 ? `+${delta}` : delta}
          </Button>
        ))}
      </Box>
    </Box>
  );
}
