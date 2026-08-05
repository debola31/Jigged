'use client';

import { useMemo } from 'react';
import MachineComposer from '@/components/maintenance/MachineComposer';
import { useNoteCapture, type NoteWriter } from '@/hooks/useNoteCapture';
import { addMachineNote, uploadMachineNoteMediaFile } from '@/utils/machineMaintenanceAccess';
import { insertNoteMedia } from '@/utils/jobNoteMediaAccess';
import { logOperatorEvent } from '@/utils/operatorEventsAccess';
import type { MachineNote } from '@/types/machineMaintenance';

/**
 * The composer for ONE fix, owning its own draft.
 *
 * Why this is a component and not a second `useNoteCapture` back in the panel.
 *
 * The panel already had a separate reply capture, on the reasoning that two
 * composers with two drafts cannot contaminate each other. True — but it was one
 * reply capture shared by every open item, mounted for the panel's whole life,
 * and `useNoteCapture` clears its draft in exactly one place: a successful
 * submit. So re-pointing the reply at a different item moved the composer
 * without moving the text:
 *
 *   tap "Log the fix" on A, type "Replaced the way-cover wiper", tap "Log the
 *   fix" on B (its button is still there) — B's composer opens pre-filled with
 *   A's sentence, and submitting files it as B's resolution. B closes on a
 *   sentence written about something else, A stays outstanding forever, and
 *   because `notes` is append-only nobody can correct it afterwards. The same
 *   goes for pending photos and a failed-save error.
 *
 * The defect was never "one composer vs two". It was that the draft outlived the
 * thing it was written about. So the draft now lives with the target: the panel
 * mounts this keyed by the item being answered, and switching items unmounts one
 * and mounts another. There is no reset anybody has to remember to call, because
 * there is no shared state to reset — the same reasoning as deriving open state
 * instead of storing it (§4.4).
 */
export default function MachineReplyComposer({
  target,
  companyId,
  workCenterId,
  memberId,
  onSaved,
  onCancel,
}: {
  /** The open item this fix answers. Also the mount key — see above. */
  target: MachineNote;
  companyId: string;
  workCenterId: string;
  memberId: string;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const writer: NoteWriter<MachineNote> = useMemo(
    () => ({
      createNote: (body) =>
        addMachineNote(workCenterId, companyId, memberId, body, {
          // A fix carries no flag of its own (§4.4): it resolves something, and
          // if the work uncovered a new problem that is a new entry rather than
          // this one being both.
          maintenanceKind: null,
          resolvesNoteId: target.id,
        }),
      uploadMedia: (file) => uploadMachineNoteMediaFile(companyId, workCenterId, file),
      linkMedia: (note, upload) =>
        insertNoteMedia(companyId, note.id, upload.storagePath, upload.file, upload.dims),
      withMedia: (note, media) => ({ ...note, media }),
      eventContext: { workCenterId, resolving: true },
    }),
    [companyId, workCenterId, memberId, target.id],
  );

  const capture = useNoteCapture<MachineNote>({
    companyId,
    operatorId: memberId,
    writer,
    enabled: true,
  });

  const captureWithReset = useMemo(
    () => ({
      ...capture,
      submit: async () => {
        const saved = await capture.submit();
        if (saved) {
          // The loop closing, which is the behaviour the module is betting on:
          // somebody fixed a thing somebody else flagged.
          logOperatorEvent(companyId, 'noticed_resolved', { workCenterId });
          onSaved();
        }
        return saved;
      },
    }),
    [capture, companyId, workCenterId, onSaved],
  );

  return (
    <MachineComposer
      capture={captureWithReset}
      kind={null}
      onKindChange={() => {}}
      variant="reply"
      placeholder="What did you do to fix it?"
      submitLabel="Log the fix"
      onCancel={onCancel}
    />
  );
}
