'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { addJobNote } from '@/utils/operatorAccess';
import { addJobNoteMedia } from '@/utils/jobNoteMediaAccess';
import { compressPhoto } from '@/utils/imageCompression';
import { logOperatorEvent } from '@/utils/operatorEventsAccess';
import { friendlyErrorMessage } from '@/lib/supabaseErrors';
import type { JobNote, JobNoteMedia } from '@/types/operator';

/**
 * Text + photos for one step, and the write that lands them.
 *
 * EXTRACTED FROM JobFeed so completion can own it. Capture used to live only in
 * the feed, behind its own Post button — which made saving a note a SECOND,
 * separate commit after RECORD COMPLETION. Attaching a photo showed a thumbnail
 * and the flow read as finished, but nothing was written until Post; a back tap
 * discarded it silently. There was no beforeunload guard and no draft
 * persistence, so the only real fix was to stop having two commits.
 *
 * The hook owns the draft, so the same fields can be rendered inside the
 * completion block (submitted WITH the completion, one button) and inside the
 * feed (its own Post button) without duplicating the photo pipeline, the
 * iOS-unreadable-file mitigation, or the funnel instrumentation.
 *
 * WHAT IT DOES NOT DO: decide when to write. The caller does, because ordering
 * is load-bearing — completion must be durable before a note is attempted, so a
 * failed photo upload can never un-complete a finished step.
 */

const MIC_HINT_KEY = 'jigged:composer-mic-hint';
const MIC_HINT_MAX_SHOWS = 5;

interface MicHintState {
  shows: number;
  dismissed: boolean;
}

function readMicHint(): MicHintState {
  if (typeof window === 'undefined') return { shows: 0, dismissed: true };
  try {
    const raw = window.localStorage.getItem(MIC_HINT_KEY);
    if (!raw) return { shows: 0, dismissed: false };
    const parsed = JSON.parse(raw) as Partial<MicHintState>;
    return { shows: Number(parsed.shows) || 0, dismissed: !!parsed.dismissed };
  } catch {
    return { shows: 0, dismissed: false };
  }
}

function writeMicHint(state: MicHintState): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(MIC_HINT_KEY, JSON.stringify(state));
  } catch {
    /* private mode / quota — the hint is best-effort, never block on it */
  }
}

export interface PendingPhoto {
  id: string;
  file: File;
  previewUrl: string;
}

export interface NoteCaptureContext {
  jobPartId: string;
  jobOperationId: string;
}

export interface NoteCapture {
  draft: string;
  setDraft: (v: string) => void;
  pending: PendingPhoto[];
  saving: boolean;
  error: string | null;
  clearError: () => void;
  /** True when there is something worth writing. */
  hasContent: boolean;
  showMicHint: boolean;
  dismissMicHint: () => void;
  /** Records composer_focused exactly once per mount. */
  noteFocused: () => void;
  pickPhotos: (e: React.ChangeEvent<HTMLInputElement>) => Promise<void>;
  removePending: (id: string) => void;
  /**
   * Write the note and its media. Returns the note (with media) so an optimistic
   * list can prepend it, or null when there was nothing to write.
   *
   * THROWS on failure, deliberately: the caller decides what a partial failure
   * means. On the completion path the completion has already landed and must
   * stand, so the error is surfaced on its own rather than rolled back.
   */
  submit: () => Promise<JobNote | null>;
}

export function useNoteCapture(opts: {
  companyId: string;
  jobId: string;
  operatorId: string | null;
  context: NoteCaptureContext | null;
  /** Off when there is no capture surface mounted (e.g. a read-only feed). */
  enabled: boolean;
}): NoteCapture {
  const { companyId, jobId, operatorId, context, enabled } = opts;

  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState<PendingPhoto[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Decided once from storage at mount — DERIVED, not synchronised, so there is
  // no setState-in-effect cascade. `enabled` is effectively static per mount in
  // both consumers; if it ever flipped false→true the hint would not re-appear,
  // which is the harmless direction (no re-nagging).
  const [showMicHint, setShowMicHint] = useState(() => {
    if (!enabled) return false;
    const state = readMicHint();
    return !(state.dismissed || state.shows >= MIC_HINT_MAX_SHOWS);
  });

  const pendingIdRef = useRef(0);
  // Funnel state as refs, not state: read once at unmount, and putting them in
  // state would re-render on every keystroke to record something never shown.
  const focusedRef = useRef(false);
  const capturedRef = useRef(false);
  const draftRef = useRef({ bodyLength: 0, photoCount: 0 });

  const hasContent = draft.trim().length > 0 || pending.length > 0;

  // Count the show. A write to localStorage IS the external-system update an
  // effect is for; only the setState above had to move out of one.
  const countedRef = useRef(false);
  useEffect(() => {
    if (!showMicHint || countedRef.current) return;
    countedRef.current = true;
    writeMicHint({ shows: readMicHint().shows + 1, dismissed: false });
  }, [showMicHint]);

  // Keep the unmount snapshot current. In an effect, not during render: mutating
  // a ref while rendering is unsafe under concurrent rendering.
  useEffect(() => {
    draftRef.current = { bodyLength: draft.trim().length, photoCount: pending.length };
  }, [draft, pending]);

  // Revoke preview URLs on unmount.
  useEffect(() => {
    return () => {
      pending.forEach((p) => URL.revokeObjectURL(p.previewUrl));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Abandonment: they reached for capture and left without saving. The funnel
  // step that separates "capture friction" from "container fit" — a high focus
  // rate with a low save rate means they tried and gave up, a very different
  // problem from never reaching for it at all.
  useEffect(() => {
    return () => {
      if (!enabled) return;
      if (!focusedRef.current || capturedRef.current) return;
      logOperatorEvent(companyId, 'composer_abandoned', draftRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const noteFocused = useCallback(() => {
    if (focusedRef.current) return;
    focusedRef.current = true;
    logOperatorEvent(companyId, 'composer_focused');
  }, [companyId]);

  const dismissMicHint = useCallback(() => {
    setShowMicHint(false);
    writeMicHint({ ...readMicHint(), dismissed: true });
  }, []);

  const pickPhotos = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const input = e.target;
      const files = Array.from(input.files ?? []);
      input.value = '';
      if (files.length === 0) return;
      setError(null);

      // iOS "new photo → nothing attached" mitigation. A camera-origin File can
      // become unreadable by the time it is compressed/uploaded, yielding a
      // zero-byte blob. Copy the bytes into a stable File now, while the
      // reference is fresh, and drop any pick that reads back empty rather than
      // silently posting nothing.
      const prepared: PendingPhoto[] = [];
      let unreadable = 0;
      for (const file of files) {
        let stable = file;
        try {
          const buf = await file.arrayBuffer();
          stable = new File([buf], file.name || 'photo.jpg', {
            type: file.type || 'image/jpeg',
            lastModified: file.lastModified,
          });
        } catch {
          // Copy failed — fall through and let the size guard decide.
        }
        if (stable.size === 0) {
          unreadable += 1;
          continue;
        }
        prepared.push({
          id: `pp-${pendingIdRef.current++}`,
          file: stable,
          previewUrl: URL.createObjectURL(stable),
        });
      }

      if (prepared.length === 0) {
        setError('That photo could not be read. Please try taking or picking it again.');
        return;
      }
      // Per-file reporting: the old behaviour dropped unreadable picks silently
      // unless EVERY one failed, so picking three and getting one thumbnail came
      // with no explanation.
      if (unreadable > 0) {
        setError(
          `${unreadable} of ${files.length} photos couldn't be read — the rest are attached.`,
        );
      }
      setPending((prev) => [...prev, ...prepared]);
      logOperatorEvent(companyId, 'photo_attached', { count: prepared.length });
    },
    [companyId],
  );

  const removePending = useCallback((id: string) => {
    setPending((prev) => {
      const target = prev.find((p) => p.id === id);
      if (target) URL.revokeObjectURL(target.previewUrl);
      return prev.filter((p) => p.id !== id);
    });
  }, []);

  const submit = useCallback(async (): Promise<JobNote | null> => {
    if (!context) return null;
    const body = draft.trim();
    const photos = pending;
    if (!body && photos.length === 0) return null;
    if (!operatorId) {
      const message = 'Could not identify your account — reload and try again.';
      setError(message);
      throw new Error(message);
    }

    setSaving(true);
    setError(null);
    try {
      const note = await addJobNote(jobId, companyId, operatorId, body || null, {
        jobPartId: context.jobPartId,
        jobOperationId: context.jobOperationId,
      });

      const media: JobNoteMedia[] = [];
      for (const p of photos) {
        const prepared = await compressPhoto(p.file);
        media.push(
          await addJobNoteMedia(companyId, jobId, note.id, prepared.file, {
            dims: prepared.dims,
          }),
        );
      }

      photos.forEach((p) => URL.revokeObjectURL(p.previewUrl));
      setPending([]);
      setDraft('');
      // After the write resolves, so a failed save is never counted as one —
      // the funnel's whole job is separating "tried" from "succeeded".
      capturedRef.current = true;
      logOperatorEvent(companyId, media.length > 0 ? 'note_saved_with_photo' : 'note_saved', {
        jobOperationId: context.jobOperationId,
        bodyLength: body.length,
        photoCount: media.length,
      });
      return { ...note, media };
    } catch (err) {
      setError(friendlyErrorMessage(err, { entity: 'note', fallback: 'Could not save that.' }));
      throw err;
    } finally {
      setSaving(false);
    }
  }, [context, draft, pending, operatorId, jobId, companyId]);

  return {
    draft,
    setDraft,
    pending,
    saving,
    error,
    clearError: () => setError(null),
    hasContent,
    showMicHint,
    dismissMicHint,
    noteFocused,
    pickPhotos,
    removePending,
    submit,
  };
}
