'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import posthog from 'posthog-js';
import { addJobNote } from '@/utils/operatorAccess';
import {
  discardNoteMediaUploads,
  insertNoteMedia,
  uploadJobNoteMediaFile,
} from '@/utils/jobNoteMediaAccess';
import type { UploadedMedia } from '@/utils/jobNoteMediaAccess';
import type { CapturedVideo } from '@/lib/videoCapture';
import { compressPhoto } from '@/utils/imageCompression';
import { logOperatorEvent } from '@/utils/operatorEventsAccess';
import type { OperatorEventContext } from '@/utils/operatorEventsAccess';
import { friendlyErrorMessage } from '@/lib/supabaseErrors';
import type { JobNote, JobNoteMedia } from '@/types/operator';

/**
 * Text, photos and short videos for one step, and the write that lands them.
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
 * feed (its own Post button) without duplicating the media pipeline, the
 * iOS-unreadable-file mitigation, or the funnel instrumentation.
 *
 * A CLIP IS NOT A PHOTO ANYWHERE IN HERE. It skips compression entirely, and it
 * uploads twice — once for the clip, once for the poster that lets a feed draw a
 * thumbnail without fetching the whole file. Both differences live in `submit`.
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

/**
 * Release every object URL a staged item holds. A video holds TWO — the clip and
 * its poster — and the leak from forgetting the second one is invisible, so this
 * exists rather than three call sites each remembering.
 */
function revokePreviews(item: PendingMedia): void {
  URL.revokeObjectURL(item.previewUrl);
  if (item.kind === 'video' && item.posterUrl) URL.revokeObjectURL(item.posterUrl);
}

interface PendingBase {
  id: string;
  file: File;
  /** Object URL of the file itself — an `<img>` src for a photo, a `<video>` src for a clip. */
  previewUrl: string;
}

/**
 * One staged item, before anything has been uploaded.
 *
 * A UNION RATHER THAN OPTIONAL FIELDS: a photo has no duration and a clip has no
 * compressed variant, and `submit` must not be able to reach for the wrong half.
 * The video arm carries its poster as a Blob because it has not been uploaded yet
 * — staging is free, and removing a staged clip must stay free.
 */
export type PendingMedia =
  | (PendingBase & { kind: 'photo' })
  | (PendingBase & {
      kind: 'video';
      poster: Blob | null;
      /** Object URL for the poster, so the strip paints without touching the clip. */
      posterUrl: string | null;
      durationSeconds: number;
      width: number;
      height: number;
    });

export interface NoteCaptureContext {
  jobPartId: string;
  jobOperationId: string;
}

/**
 * WHERE the note goes, injected by the surface that owns the composer.
 *
 * The draft, the photo pipeline, the iOS unreadable-File mitigation, the mic
 * hint and every funnel event are subject-agnostic and must exist exactly once.
 * The WRITE is the only part that differs between a step note and a machine
 * maintenance entry, so it is the only part that is passed in.
 *
 * Generic over the note type so neither caller loses its return type to a union
 * it would then have to narrow.
 */
export interface NoteWriter<TNote> {
  createNote: (body: string | null) => Promise<TNote>;
  /**
   * Put the bytes in the bucket and return where they landed. Takes NO note, because the storage
   * path keys on the job or the machine and never on the note — which is what lets `submit` get
   * every photo up before it commits anything. See the ordering comment there.
   */
  uploadMedia: (file: File) => Promise<string>;
  /** Record an already-uploaded file against the note. A fast local write, not a transfer. */
  linkMedia: (note: TNote, upload: UploadedMedia) => Promise<JobNoteMedia>;
  /** Merge saved media onto the note for the optimistic prepend. */
  withMedia: (note: TNote, media: JobNoteMedia[]) => TNote;
  /** Merged into every funnel event this composer emits. */
  eventContext?: OperatorEventContext;
  /**
   * Which composer this is, for the `note posted` PostHog event.
   *
   * A SURFACE IS A PROPERTY, NOT AN EVENT NAME — docs/telemetry.md is explicit, and
   * a step note and a machine entry are the same act in two containers.
   */
  analyticsSurface: 'operator_step' | 'operator_machine';
}

export type { UploadedMedia } from '@/utils/jobNoteMediaAccess';

/**
 * Everything about a capture that does NOT depend on where the note ends up:
 * the draft, the pending photos, the dictation hint, the focus signal.
 *
 * Split out because it is exactly what NoteCaptureFields renders. That component
 * is shared by the step composer and the machine composer, and typing it against
 * this rather than against a particular note type is what makes the sharing
 * honest rather than a cast.
 */
export interface NoteCaptureFieldsState {
  draft: string;
  setDraft: (v: string) => void;
  pending: PendingMedia[];
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
  /** Stage a clip the in-app recorder just produced. */
  addVideo: (video: CapturedVideo) => void;
  removePending: (id: string) => void;
}

export interface NoteCapture<TNote = JobNote> extends NoteCaptureFieldsState {
  /**
   * Write the note and its media. Returns the note (with media) so an optimistic
   * list can prepend it, or null when there was nothing to write.
   *
   * THROWS on failure, deliberately: the caller decides what a failure means. On
   * the completion path the completion has already landed and must stand, so the
   * error is surfaced on its own rather than rolled back.
   *
   * A throw means NOTHING WAS WRITTEN in the overwhelmingly common case — see the
   * ordering comment in the implementation — so the draft and photos the operator
   * still has are the whole of what is unsaved, and retrying is safe.
   */
  submit: () => Promise<TNote | null>;
}

export function useNoteCapture<TNote = JobNote>(opts: {
  companyId: string;
  operatorId: string | null;
  /** Null when there is nothing to write against yet — the composer stays inert. */
  writer: NoteWriter<TNote> | null;
  /** Off when there is no capture surface mounted (e.g. a read-only feed). */
  enabled: boolean;
}): NoteCapture<TNote> {
  const { companyId, operatorId, writer, enabled } = opts;

  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState<PendingMedia[]>([]);
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
  const draftRef = useRef({ bodyLength: 0, photoCount: 0, videoCount: 0 });
  // The writer's event context, mirrored into a ref so the unmount handler can
  // read it without re-registering the effect (and without a stale closure).
  // Every event from this composer carries it, so a machine capture is
  // distinguishable from a step capture at every step of the funnel rather than
  // only at the save.
  const eventContextRef = useRef<OperatorEventContext>({});

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
    draftRef.current = {
      bodyLength: draft.trim().length,
      photoCount: pending.filter((p) => p.kind === 'photo').length,
      videoCount: pending.filter((p) => p.kind === 'video').length,
    };
  }, [draft, pending]);

  useEffect(() => {
    eventContextRef.current = writer?.eventContext ?? {};
  }, [writer]);

  // Revoke preview URLs on unmount.
  useEffect(() => {
    return () => {
      pending.forEach(revokePreviews);
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
      logOperatorEvent(companyId, 'composer_abandoned', {
        ...eventContextRef.current,
        ...draftRef.current,
      });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const noteFocused = useCallback(() => {
    if (focusedRef.current) return;
    focusedRef.current = true;
    logOperatorEvent(companyId, 'composer_focused', { ...eventContextRef.current });
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
      const prepared: PendingMedia[] = [];
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
          kind: 'photo',
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
      logOperatorEvent(companyId, 'photo_attached', {
        ...eventContextRef.current,
        count: prepared.length,
      });
    },
    [companyId],
  );

  /**
   * Stage a clip the recorder just finished.
   *
   * NOT async and doing no work: the recorder already holds real bytes in memory, so
   * unlike `pickPhotos` there is nothing to stabilise — the iOS unreadable-File
   * problem is a property of a camera-roll handle, not of a Blob we assembled
   * ourselves. Copying 23 MB through `arrayBuffer()` here would double peak memory on
   * a phone to prove something already true.
   */
  const addVideo = useCallback(
    (video: CapturedVideo) => {
      setError(null);
      setPending((prev) => [
        ...prev,
        {
          kind: 'video',
          id: `pv-${pendingIdRef.current++}`,
          file: video.file,
          previewUrl: URL.createObjectURL(video.file),
          poster: video.poster,
          posterUrl: video.poster ? URL.createObjectURL(video.poster) : null,
          durationSeconds: video.durationSeconds,
          width: video.width,
          height: video.height,
        },
      ]);
      logOperatorEvent(companyId, 'video_attached', {
        ...eventContextRef.current,
        durationSeconds: video.durationSeconds,
      });
    },
    [companyId],
  );

  const removePending = useCallback((id: string) => {
    setPending((prev) => {
      const target = prev.find((p) => p.id === id);
      if (target) revokePreviews(target);
      return prev.filter((p) => p.id !== id);
    });
  }, []);

  const submit = useCallback(async (): Promise<TNote | null> => {
    if (!writer) return null;
    const body = draft.trim();
    const staged = pending;
    if (!body && staged.length === 0) return null;
    if (!operatorId) {
      const message = 'Could not identify your account — reload and try again.';
      setError(message);
      throw new Error(message);
    }

    setSaving(true);
    setError(null);
    try {
      /**
       * UPLOAD EVERY FILE FIRST, COMMIT SECOND. The order is the fix for #624, and a
       * clip makes the reasoning bite harder rather than differently — it is ~23 MB
       * where a photo is ~1.5 MB, so the stall this prevents is fifteen times longer.
       *
       * It used to be the other way round: create the note, then upload into it. Uploading is the
       * slow, failure-prone half — a shop-floor phone on dropping wifi can stall on it for minutes
       * — and by the time it stalled the note row was already committed. Backing out left a note
       * that claimed to be saved with the photo it was taken for missing, and nothing said so.
       *
       * Inverted, a failed or timed-out upload leaves NOTHING behind. The catch below then tells
       * the truth with no extra machinery: the draft and the photos are still staged, the error is
       * accurate, and tapping save again is a clean retry rather than a second note.
       *
       * This is the rule OperatorLocationActionModal already states — "upload BEFORE the write,
       * never after" — and the reason it was reachable here is that the storage path keys on the
       * job or the machine, never on the note, so it needs nothing the note provides.
       *
       * The cost is symmetrical and much smaller: if a later step fails, the files already in the
       * bucket are orphans. They are invisible and cheap, and we make a best-effort sweep below.
       */
      const uploads: UploadedMedia[] = [];
      /**
       * Every object key that has reached the bucket, including posters.
       *
       * Tracked SEPARATELY from `uploads` rather than derived from it, because a video
       * contributes two keys and can fail between them — at that moment the clip is up
       * and there is no `UploadedMedia` entry yet to hang the sweep off.
       */
      const landed: string[] = [];
      let note: TNote;
      try {
        for (const p of staged) {
          if (p.kind === 'photo') {
            const prepared = await compressPhoto(p.file);
            const storagePath = await writer.uploadMedia(prepared.file);
            landed.push(storagePath);
            uploads.push({
              kind: 'photo',
              storagePath,
              file: prepared.file,
              dims: prepared.dims,
            });
            continue;
          }

          /**
           * NEVER `compressPhoto` — it is a canvas/JPEG pipeline and a clip is already
           * encoded at the bitrate it was recorded at. The recorder is where a video's
           * size is decided; there is no second pass.
           *
           * CLIP FIRST, POSTER SECOND. The clip is the expensive, failure-prone half, so
           * uploading it first means a failure has not already paid for a poster.
           */
          const storagePath = await writer.uploadMedia(p.file);
          landed.push(storagePath);

          let thumbnailPath: string | null = null;
          if (p.poster) {
            thumbnailPath = await writer.uploadMedia(
              new File([p.poster], 'poster.jpg', { type: 'image/jpeg' }),
            );
            landed.push(thumbnailPath);
          }

          uploads.push({
            kind: 'video',
            storagePath,
            thumbnailPath,
            file: p.file,
            dims: { width: p.width, height: p.height },
            durationSeconds: p.durationSeconds,
          });
        }
        note = await writer.createNote(body || null);
      } catch (err) {
        // Everything up to and including the note write is still reversible, so sweep the bytes
        // that did land rather than leaving them unreferenced.
        await discardNoteMediaUploads(landed);
        throw err;
      }

      const media: JobNoteMedia[] = [];
      for (const u of uploads) {
        media.push(await writer.linkMedia(note, u));
      }

      staged.forEach(revokePreviews);
      setPending([]);
      setDraft('');
      // After the write resolves, so a failed save is never counted as one —
      // the funnel's whole job is separating "tried" from "succeeded".
      capturedRef.current = true;
      /**
       * `note_saved_with_photo` KEEPS ITS NAME even when the media is a clip. It means
       * "saved with something attached", and renaming it would split the funnel it was
       * built to read — the counts below are what tell photo from video.
       */
      const photoCount = media.filter((m) => m.kind === 'photo').length;
      const videoCount = media.filter((m) => m.kind === 'video').length;

      logOperatorEvent(companyId, media.length > 0 ? 'note_saved_with_photo' : 'note_saved', {
        ...(writer.eventContext ?? {}),
        bodyLength: body.length,
        photoCount,
        videoCount,
      });

      /**
       * CLOSES A GAP docs/telemetry.md names outright: the notes-and-photos loop has
       * never sent a PostHog event, and is measured by an autocapture action matched
       * on the text of the Post button — which also blocks turning on `mask_all_text`.
       * Video would have widened that gap rather than being measurable.
       *
       * Shape only. `has_text` rather than the text, counts rather than ids: the body
       * of an operator note is the customer's business data and must not leave in an
       * analytics property.
       */
      posthog.capture('note posted', {
        surface: writer.analyticsSurface,
        has_text: body.length > 0,
        photo_count: photoCount,
        video_count: videoCount,
      });
      return writer.withMedia(note, media);
    } catch (err) {
      setError(friendlyErrorMessage(err, { entity: 'note', fallback: 'Could not save that.' }));
      throw err;
    } finally {
      setSaving(false);
    }
  }, [writer, draft, pending, operatorId, companyId]);

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
    addVideo,
    removePending,
    submit,
  };
}

/**
 * The writer for a note captured at a step, which is what both job surfaces use.
 *
 * `addJobNote` chooses the SUBJECT itself — durable (part, routing step) when the
 * step has a routing link, this-job-only when it doesn't — so that decision stays
 * where it was and the operator is still never asked to classify anything.
 *
 * Memoized on its inputs: `submit` closes over the writer, so a fresh object each
 * render would rebuild the callback every keystroke.
 */
export function useStepNoteWriter(args: {
  companyId: string;
  jobId: string;
  operatorId: string | null;
  context: NoteCaptureContext | null;
}): NoteWriter<JobNote> | null {
  const { companyId, jobId, operatorId, context } = args;
  return useMemo(() => {
    if (!context || !operatorId) return null;
    return {
      createNote: (body) =>
        addJobNote(jobId, companyId, operatorId, body, {
          jobPartId: context.jobPartId,
          jobOperationId: context.jobOperationId,
        }),
      uploadMedia: (file) => uploadJobNoteMediaFile(companyId, jobId, file),
      linkMedia: (note, upload) =>
        insertNoteMedia(companyId, note.id, upload),
      withMedia: (note, media) => ({ ...note, media }),
      eventContext: { jobOperationId: context.jobOperationId },
      analyticsSurface: 'operator_step',
    };
  }, [companyId, jobId, operatorId, context]);
}
