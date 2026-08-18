'use client';

import { useEffect, useState } from 'react';
import {
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  TextField,
  Typography,
} from '@mui/material';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import NoteCaptureFields from './NoteCaptureFields';
import type { useNoteCapture } from '@/hooks/useNoteCapture';
import { elapsedMs, formatClockTime, formatStopwatch } from '@/lib/duration';

/**
 * The confirm-before-recording sheet: what you finished, how long it took, and
 * one last invitation to say something about it.
 *
 * WHY THIS IS NOT THE PATTERN operator-view.md DELETED. That doc says "the
 * post-completion offer is deleted, not relocated", and it is right to. The
 * deleted flow was record → prompt for a photo → separate Post: three commits,
 * and the middle one had no durability, so attaching a photo showed a thumbnail,
 * read as finished, and was silently discarded by a back tap.
 *
 * This is the mirror image. NOTHING IS WRITTEN UNTIL THE PRIMARY IS TAPPED, so
 * backing out loses only what is still visibly sitting in the composer, and
 * nothing has ever claimed to be saved. It remains one commit — the same
 * completion → interval-close → note sequence, fired from here instead of from
 * the step screen. The app also shipped this shape once before, as
 * `JobCompleteModal` (5a7d0386), and it was removed with the timer rather than
 * for a fault of its own.
 *
 * ONE COMPOSER, NOT TWO. It renders the SAME `useNoteCapture` object the step
 * screen holds, so a note jotted while the work was happening is carried in here
 * rather than abandoned. Because this is a modal overlay only one of the two is
 * ever visible, which keeps B4's "never more than one composer on screen".
 *
 * NO DICTATE BUTTON, on purpose. Both mobile keyboards ship a microphone, so a
 * plain multiline field already gives dictation on every phone, with no
 * permission prompt and no bundle. `webkitSpeechRecognition` does exist in iOS
 * Safari (14.5+), but it requires the user to have Siri enabled and has
 * documented throttling and interim-result bugs in WebKit — worse than what the
 * OS gives free.
 */
export interface CompleteStepSheetProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void | Promise<void>;
  saving: boolean;
  /** What the step is, so the sheet is not a context-free confirm box. */
  operationName: string;
  jobNumber: string;
  /** Quantity, editable here — this is the last chance to correct it. */
  quantity: string;
  onQuantityChange: (value: string) => void;
  quantityHelper: string;
  /** Running interval, if there is one. Absent on the untimed path. */
  startedAt: string | null;
  serverSkewMs: number;
  onAdjust?: () => void;
  adjusted?: boolean;
  capture: ReturnType<typeof useNoteCapture>;
}

export default function CompleteStepSheet({
  open,
  onClose,
  onConfirm,
  saving,
  operationName,
  jobNumber,
  quantity,
  onQuantityChange,
  quantityHelper,
  startedAt,
  serverSkewMs,
  onAdjust,
  adjusted,
  capture,
}: CompleteStepSheetProps) {
  // A repaint tick only — the value is recomputed from the start instant on
  // every render, never accumulated. See lib/duration.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!open || !startedAt) return;
    const id = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [open, startedAt]);

  return (
    <Dialog
      open={open}
      onClose={saving ? undefined : onClose}
      // Full screen: this is a step in a flow rather than a question about the
      // page behind it, and the composer needs room once the keyboard is up.
      fullScreen
    >
      <DialogTitle sx={{ pb: 0 }}>
        <Typography variant="h6" component="div">
          Finishing {operationName}
        </Typography>
        <Typography variant="body2" color="text.secondary">
          {jobNumber}
        </Typography>
      </DialogTitle>

      <DialogContent>
        {startedAt && (
          <Box sx={{ textAlign: 'center', py: 2 }}>
            <Typography
              component="div"
              variant="h3"
              sx={{
                fontFamily: 'monospace',
                fontWeight: 700,
                color: 'primary.main',
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {formatStopwatch(elapsedMs(startedAt, serverSkewMs))}
            </Typography>
            <Box
              sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 1 }}
            >
              {/* "9:12 AM → now", not "started 9:12 AM". Better copy for a
                  sheet headed "Finishing" — the span is the thing being
                  confirmed, not just its start — and it keeps this caption
                  textually distinct from the step screen's, which sits directly
                  behind this dialog and otherwise renders the same words. */}
              <Typography variant="body2" color="text.secondary">
                {formatClockTime(startedAt)} → now
                {adjusted && ' · adjusted'}
              </Typography>
              {onAdjust && (
                <Button onClick={onAdjust} disabled={saving} size="small" sx={{ minHeight: 44 }}>
                  Adjust
                </Button>
              )}
            </Box>
          </Box>
        )}

        <TextField
          label="Pieces finished"
          type="number"
          value={quantity}
          onChange={(e) => onQuantityChange(e.target.value)}
          inputProps={{ min: 0, inputMode: 'numeric', 'aria-label': 'Pieces finished' }}
          helperText={quantityHelper}
          fullWidth
          disabled={saving}
          sx={{ mt: 1, '& .MuiOutlinedInput-root': { minHeight: 56 } }}
        />

        <Box sx={{ mt: 3 }}>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
            Anything worth noting for next time?
          </Typography>
          {/* The SAME capture object the step screen holds, so a note written
              while the work was happening arrives here instead of being lost. */}
          <NoteCaptureFields
            capture={capture}
            placeholder="What you'd want the next person to know…"
            disabled={saving}
          />
        </Box>
      </DialogContent>

      <DialogActions sx={{ flexDirection: 'column', gap: 1, px: 3, pb: 3 }}>
        <Button
          fullWidth
          variant="contained"
          color="primary"
          size="large"
          startIcon={saving ? undefined : <CheckCircleIcon />}
          onClick={onConfirm}
          disabled={saving || !(Number(quantity) > 0)}
          sx={{ minHeight: 64, fontSize: '1.15rem', fontWeight: 600 }}
        >
          {saving ? <CircularProgress size={24} /> : `RECORD ${quantity} FINISHED`}
        </Button>
        <Button fullWidth onClick={onClose} disabled={saving} sx={{ minHeight: 48 }}>
          Back
        </Button>
      </DialogActions>
    </Dialog>
  );
}
