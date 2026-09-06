'use client';

import { useState } from 'react';
import posthog from 'posthog-js';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';

import { addJobNote } from '@/utils/operatorAccess';
import { friendlyErrorMessage } from '@/lib/supabaseErrors';
import type { JobNote } from '@/types/operator';

/**
 * Post a note on the job, from the office.
 *
 * NOT hooks/useNoteCapture.ts, and the reason is a boundary rather than taste.
 * `useStepNoteWriter` requires a non-null `jobPartId` and its `analyticsSurface`
 * union is operator-only; widening both would pull office concerns into a hook
 * whose every decision is about a phone on cellular — the dictation hint, the
 * iOS unreadable-File mitigation, `composer_abandoned`, the multi-minute video
 * upload label. None of that describes somebody at a desk.
 *
 * TEXT ONLY, deliberately. The photo pipeline exists to solve a phone-camera
 * problem the office does not have: whoever is posting from here is not standing
 * at the part. `uploadJobNoteMediaFile` is already surface-neutral if that
 * changes, at which point this composer can grow into the shared hook with the
 * union widened on purpose rather than by accident.
 *
 * The note lands as `subject_kind: 'job'` with a null step — `addJobNote` with
 * no `opts` — which is exactly what the operator traveler renders, so this is a
 * real channel to the floor rather than an office-only scratchpad.
 */
export default function JobActivityComposer({
  companyId,
  jobId,
  authorId,
  onPosted,
}: {
  companyId: string;
  jobId: string;
  /** Null until getCurrentMember resolves; the button carries that state. */
  authorId: string | null;
  onPosted: (note: JobNote) => void;
}) {
  const [body, setBody] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmed = body.trim();

  const post = async () => {
    if (!authorId || trimmed.length === 0) return;
    setSaving(true);
    setError(null);
    try {
      const note = await addJobNote(jobId, companyId, authorId, trimmed);

      /**
       * Shape only, matching the operator composer: `has_text` rather than the
       * text, because a note about a job is the customer's business data and
       * must not leave in an analytics property. The counts are zero here and
       * still passed — the registry lists all four properties and the check is
       * exhaustive in both directions.
       */
      posthog.capture('note posted', {
        surface: 'office_job',
        has_text: true,
        photo_count: 0,
        video_count: 0,
      });

      setBody('');
      onPosted(note);
    } catch (err) {
      setError(friendlyErrorMessage(err, { entity: 'note', fallback: 'Could not save that.' }));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Box sx={{ mb: 1.5 }}>
      <TextField
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder="Leave a note on this job…"
        multiline
        minRows={2}
        maxRows={6}
        fullWidth
        size="small"
        disabled={saving}
        inputProps={{ 'aria-label': 'Note on this job' }}
      />
      {error ? (
        <Typography variant="caption" sx={{ color: 'error.light', display: 'block', mt: 0.5 }}>
          {error}
        </Typography>
      ) : null}
      <Box sx={{ display: 'flex', justifyContent: 'flex-end', mt: 0.75 }}>
        {/* A plain Button, not BusyButton: this is Supabase CRUD, and
            interaction-standards.md §5 reserves a spinner for waits over a
            second — a third party, not a single insert. */}
        <Button
          variant="contained"
          size="small"
          // Not-loaded-yet is carried here, where it is visible, rather than by
          // hiding the composer — the same call JobFeed makes.
          disabled={saving || !authorId || trimmed.length === 0}
          onClick={post}
          sx={{ minHeight: 36 }}
        >
          Post
        </Button>
      </Box>
    </Box>
  );
}
