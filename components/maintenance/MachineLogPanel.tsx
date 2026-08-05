'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import CircularProgress from '@mui/material/CircularProgress';
import Divider from '@mui/material/Divider';
import MenuBookOutlinedIcon from '@mui/icons-material/MenuBookOutlined';
import Typography from '@mui/material/Typography';
import { useLoad } from '@/hooks/useLoad';
import { useNoteDwell } from '@/hooks/useNoteDwell';
import { useNoteCapture } from '@/hooks/useNoteCapture';
import type { NoteWriter } from '@/hooks/useNoteCapture';
import { getCurrentMember, updateNoteBody } from '@/utils/operatorAccess';
import { deleteJobNote, deleteJobNoteMedia, insertNoteMedia } from '@/utils/jobNoteMediaAccess';
import {
  addMachineNote,
  getMachineDetails,
  getMachineLog,
  uploadMachineNoteMediaFile,
} from '@/utils/machineMaintenanceAccess';
import { logOperatorEvent } from '@/utils/operatorEventsAccess';
import { countWorkCenterAttachments } from '@/utils/workCenterAttachmentsAccess';
import MachineComposer from '@/components/maintenance/MachineComposer';
import MachineReplyComposer from '@/components/maintenance/MachineReplyComposer';
import MachineDetailsCard from '@/components/maintenance/MachineDetailsCard';
import MachineEntry from '@/components/maintenance/MachineEntry';
import MachineManualsSheet from '@/components/maintenance/MachineManualsSheet';
import MachineOpenItems from '@/components/maintenance/MachineOpenItems';
import NoteEditDialog from '@/components/notes/NoteEditDialog';
import NoteDeleteDialog from '@/components/notes/NoteDeleteDialog';
import type { MachineNote, MaintenanceKind } from '@/types/machineMaintenance';

const cardSx = { bgcolor: 'rgba(26, 31, 74, 0.55)', backdropFilter: 'blur(8px)' };

/**
 * One machine's logbook: open items pinned, then everything, newest first.
 *
 * NEWEST FIRST AND NOT GROUPED BY KIND. The reader's question on arriving at a
 * machine is almost always "what has happened to this machine lately". Any
 * grouping answers a question nobody asked and pushes the recent thing below the
 * fold.
 *
 * Read logging attaches with a null job, which is correct and also the source of
 * both limitations §8 records in advance: usage_count stays zero forever (and is
 * never fetched, let alone shown), and the read log dedupes per person per entry
 * with the absent job equal to itself — so somebody rereading the way-cover entry
 * six months later is invisible. That reread is exactly the event a logbook would
 * most want to see. viewer_count, distinct people, still works.
 */
export default function MachineLogPanel({
  workCenterId,
  companyId,
  machineName,
  readOnly = false,
}: {
  workCenterId: string;
  companyId: string;
  machineName?: string | null;
  /** Office rendering: the log without a composer. */
  readOnly?: boolean;
}) {
  const [error, setError] = useState<string | null>(null);
  const [memberId, setMemberId] = useState<string | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [kind, setKind] = useState<MaintenanceKind | null>(null);
  const [replyingTo, setReplyingTo] = useState<MachineNote | null>(null);
  const [manualsOpen, setManualsOpen] = useState(false);
  const [editingEntry, setEditingEntry] = useState<MachineNote | null>(null);
  const [deletingEntry, setDeletingEntry] = useState<MachineNote | null>(null);
  const [rowBusy, setRowBusy] = useState(false);
  const [rowError, setRowError] = useState<string | null>(null);

  const {
    data: log,
    loading,
    reload,
  } = useLoad(() => getMachineLog(workCenterId, companyId), [workCenterId, companyId], {
    onError: (err) => setError(err instanceof Error ? err.message : 'Could not load the log.'),
  });

  const { data: details } = useLoad(
    () => getMachineDetails(workCenterId, companyId),
    [workCenterId, companyId],
  );

  // Only decides whether an affordance renders, and returns 0 rather than
  // throwing — so a failure degrades to "this machine has no manuals", which is
  // also what it looks like when it genuinely has none.
  const { data: manualCount } = useLoad(
    () => countWorkCenterAttachments(workCenterId, companyId),
    [workCenterId, companyId],
  );

  // The precondition for reading any result at all: a container nobody filled
  // and a container nobody reached both look like silence from outside, and this
  // is what tells them apart.
  useEffect(() => {
    if (readOnly) return;
    logOperatorEvent(companyId, 'machine_page_opened', { workCenterId });
  }, [companyId, workCenterId, readOnly]);

  useEffect(() => {
    let active = true;
    getCurrentMember(companyId).then((m) => {
      if (active && m) {
        setMemberId(m.id);
        setIsAdmin(m.role === 'admin');
      }
    });
    return () => {
      active = false;
    };
  }, [companyId]);

  // A machine read has no job, and passing one would be a lie — see the header.
  const { observe } = useNoteDwell(companyId, null);

  const writer: NoteWriter<MachineNote> | null = useMemo(() => {
    if (readOnly || !memberId) return null;
    return {
      createNote: (body) =>
        addMachineNote(workCenterId, companyId, memberId, body, {
          maintenanceKind: kind,
          // The main composer never resolves anything — that is the reply's job.
          resolvesNoteId: null,
        }),
      uploadMedia: (file) => uploadMachineNoteMediaFile(companyId, workCenterId, file),
      linkMedia: (note, upload) =>
        insertNoteMedia(companyId, note.id, upload.storagePath, upload.file, upload.dims),
      withMedia: (note, media) => ({ ...note, media }),
      eventContext: { workCenterId, maintenanceKind: kind },
    };
  }, [readOnly, memberId, workCenterId, companyId, kind]);

  const capture = useNoteCapture<MachineNote>({
    companyId,
    operatorId: memberId,
    writer,
    enabled: !readOnly,
  });

  // Wrap submit so the surface can reset its own state and reload afterwards.
  // The hook deliberately does not know what "saved" means to the caller.
  const captureWithReset = useMemo(
    () => ({
      ...capture,
      submit: async () => {
        const saved = await capture.submit();
        if (saved) {
          setKind(null);
          reload();
        }
        return saved;
      },
    }),
    [capture, reload],
  );


  /**
   * Save an edited entry (#628). Body first, then any photo removals.
   *
   * That order is deliberate: the body update is the statement most likely to be
   * refused (RLS, or the billing gate on a lapsed shop), so it fails before
   * anything irreversible has happened to the photos.
   *
   * Reload rather than patch in place, because `open` is DERIVED server-side by
   * deriveOpenItems and the thread structure below is computed from `openIds`.
   * Editing cannot change either — maintenance_kind and resolves_note_id are
   * immutable under the guard — but delete can, and using one refresh path for
   * both keeps the pinned block and the log from ever disagreeing (§4.4).
   */
  const handleEditSave = useCallback(
    async (body: string | null, removedMediaIds: string[]) => {
      if (!editingEntry) return;
      setRowBusy(true);
      setRowError(null);
      try {
        await updateNoteBody(editingEntry.id, body);
        for (const id of removedMediaIds) {
          const m = editingEntry.media.find((x) => x.id === id);
          if (m) await deleteJobNoteMedia({ id: m.id, storage_path: m.storage_path });
        }
        setEditingEntry(null);
        reload();
      } catch (err) {
        setRowError(err instanceof Error ? err.message : 'Could not save that change.');
      } finally {
        setRowBusy(false);
      }
    },
    [editingEntry, reload],
  );

  const handleDelete = useCallback(async () => {
    if (!deletingEntry) return;
    setRowBusy(true);
    setRowError(null);
    try {
      await deleteJobNote(deletingEntry.id);
      setDeletingEntry(null);
      // MANDATORY, not stylistic — see handleEditSave. Deleting a resolver puts
      // its target back in Needs attention, and that only shows if the derived
      // open list is refetched.
      reload();
    } catch (err) {
      setRowError(err instanceof Error ? err.message : 'Could not delete that entry.');
    } finally {
      setRowBusy(false);
    }
  }, [deletingEntry, reload]);

  // Opens a reply directly under the item. No scroll-to-top and no banner: the
  // composer's POSITION says what it answers, which is a thing you cannot lose
  // track of the way you can lose a mode indicator that has scrolled off-screen.
  const startFix = useCallback((item: MachineNote) => {
    setReplyingTo((current) => (current?.id === item.id ? null : item));
  }, []);

  const openIds = useMemo(() => new Set((log?.open ?? []).map((o) => o.id)), [log]);
  // The log excludes whatever is pinned above it. Each entry appears EXACTLY
  // once: outstanding items live in the pinned block, and the moment somebody
  // logs the fix the pair drops into the log below as a thread.
  /**
   * The log as THREADS: each entry that fixes something hangs under the entry it
   * fixed, the way a reply sits under its message.
   *
   * Sorted by the thread's LATEST activity, not the root's own timestamp. That
   * is the part worth getting right: nesting alone would leave a fix logged
   * today buried under an observation from three weeks ago, and §4.2 keeps this
   * list newest-first precisely because the reader's question on arriving is
   * "what has happened to this machine lately". Sorting by latest activity gives
   * the reply structure without answering that question worse.
   *
   * Completeness is guaranteed by the database, not hoped for: a resolver must
   * sit on the same work center as its target, so every reply's root is in this
   * same result set.
   */
  const threads = useMemo(() => {
    const entries = log?.entries ?? [];
    const repliesByRoot = new Map<string, MachineNote[]>();
    for (const e of entries) {
      if (!e.resolves_note_id) continue;
      const list = repliesByRoot.get(e.resolves_note_id) ?? [];
      list.push(e);
      repliesByRoot.set(e.resolves_note_id, list);
    }

    return entries
      .filter((e) => !e.resolves_note_id && !openIds.has(e.id))
      .map((root) => {
        // Oldest first within a thread — a conversation reads downward.
        //
        // `openIds` is applied to REPLIES as well as roots, and that symmetry is
        // load-bearing: an entry pinned above must not also appear below, or the
        // exactly-once invariant (§4.2) quietly stops holding. A reply is
        // normally never open — a resolver carries no flag of its own — but that
        // is true today only because replyWriter hard-codes maintenanceKind:
        // null, which is invisible from here. Add a kind chip to the reply
        // composer and without this filter the entry renders twice.
        const replies = (repliesByRoot.get(root.id) ?? [])
          .filter((r) => !openIds.has(r.id))
          .slice()
          .sort((a, b) => a.created_at.localeCompare(b.created_at));
        const lastActivity = replies.length
          ? replies[replies.length - 1].created_at
          : root.created_at;
        return { root, replies, lastActivity };
      })
      .sort((a, b) => b.lastActivity.localeCompare(a.lastActivity));
  }, [log, openIds]);

  if (loading && !log) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
        <CircularProgress />
      </Box>
    );
  }

  const entries = log?.entries ?? [];

  return (
    <Box>
      {error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>
          {error}
        </Alert>
      )}

      {/* No machine name here. On the operator surface the AppBar already shows
          it — in orange, with the station switcher attached — so a heading
          underneath said the same word twice and cost a row on a phone. The
          office page passes no name at all, because the work-center page it sits
          on is already titled. `machineName` survives only for the manuals sheet
          below, which opens fullscreen over both and does need to say which
          machine it belongs to. */}

      {/* Only when there is something to open. A machine with no manuals shows
          nothing at all — never an "add a manual" row, which is the shape a
          setup prompt takes when it sneaks back in (§4.5).

          Operator surface ONLY. The office work-center page manages manuals
          itself, in a section directly above this one that lists each file with
          its size, uploader and a delete control — so rendering this button
          there put the same manual on screen twice in two different chromes,
          one of which quietly dropped the management affordances. Reading on
          the floor, uploading in the office: the button is the floor half. */}
      {!readOnly && (manualCount ?? 0) > 0 && (
        <Box sx={{ mb: 2 }}>
          <Button
            variant="outlined"
            startIcon={<MenuBookOutlinedIcon />}
            onClick={() => setManualsOpen(true)}
            sx={{ minHeight: 48 }}
          >
            Manuals · {manualCount}
          </Button>
        </Box>
      )}

      <MachineManualsSheet
        open={manualsOpen}
        onClose={() => setManualsOpen(false)}
        workCenterId={workCenterId}
        companyId={companyId}
        machineName={machineName}
      />

      {/* COMPOSER FIRST. It used to sit below the outstanding items, so a machine
          with several of them pushed the one thing this screen exists to make
          easy off the top of the phone. Writing is the primary act here; it does
          not queue behind however much is outstanding. */}
      {!readOnly && (
        <MachineComposer
          capture={captureWithReset}
          kind={kind}
          onKindChange={setKind}
        />
      )}

      <MachineOpenItems
        items={log?.open ?? []}
        companyId={companyId}
        memberId={memberId}
        isAdmin={isAdmin}
        onEditItem={(item) => {
          setRowError(null);
          setEditingEntry(item);
        }}
        onDeleteItem={(item) => {
          setRowError(null);
          setDeletingEntry(item);
        }}
        onLogFix={readOnly ? undefined : startFix}
        replyingToId={replyingTo?.id ?? null}
        // KEYED BY THE ITEM IT ANSWERS. The draft lives inside this component,
        // so switching targets unmounts one composer and mounts another and the
        // half-typed sentence dies with the item it was written about. It used
        // to be one shared capture whose draft outlived its target, which meant
        // a sentence about A could be filed as the fix for B — the very defect
        // the second composer was introduced to remove. See MachineReplyComposer.
        renderReply={() =>
          replyingTo && memberId ? (
            <MachineReplyComposer
              key={replyingTo.id}
              target={replyingTo}
              companyId={companyId}
              workCenterId={workCenterId}
              memberId={memberId}
              onSaved={() => {
                setReplyingTo(null);
                reload();
              }}
              onCancel={() => setReplyingTo(null)}
            />
          ) : null
        }
        readOnly={readOnly}
      />

      {entries.length === 0 ? (
        // A plain statement of fact. Not a nudge, not an illustration, not a
        // "get started" — the machine simply has no history yet, and saying so
        // is the honest version of an empty container.
        <Typography variant="body2" color="text.secondary" sx={{ py: 2 }}>
          Nothing logged for this machine yet.
        </Typography>
      ) : threads.length > 0 ? (
        // ONE card, rows separated by dividers — the shape the job feed already
        // uses for notes. Same content type, same reading gesture, and a
        // four-word entry no longer costs a whole card plus a gap.
        <Card elevation={2} sx={cardSx}>
          <CardContent>
            {threads.map(({ root, replies }, idx) => (
              <Box key={root.id}>
                {idx > 0 && <Divider sx={{ my: 1.5 }} />}
                {/* observe() attaches to the entry BODY, never a container or a
                    count badge — a read means somebody dwelled on the words. */}
                <Box ref={observe(root.id)}>
                  <MachineEntry
                    entry={root}
                    companyId={companyId}
                    memberId={memberId}
                    isAdmin={isAdmin}
                    onEdit={() => {
                      setRowError(null);
                      setEditingEntry(root);
                    }}
                    onDelete={() => {
                      setRowError(null);
                      setDeletingEntry(root);
                    }}
                    readOnly={readOnly}
                  />
                </Box>

                {replies.map((reply) => (
                  <Box
                    key={reply.id}
                    ref={observe(reply.id)}
                    // Indented under what it answers, with a rule down the side:
                    // the reply shape people already read everywhere else. No
                    // "Fixes: …" quote and no "Fixed by …" line — position says
                    // both, and the quote had to be truncated to fit, which cut
                    // off the very text it was quoting.
                    sx={{
                      mt: 1.5,
                      ml: 2,
                      pl: 2,
                      borderLeft: '2px solid',
                      borderColor: 'rgba(255,255,255,0.14)',
                    }}
                  >
                    <MachineEntry
                      entry={reply}
                      companyId={companyId}
                      memberId={memberId}
                      isAdmin={isAdmin}
                      onEdit={() => {
                        setRowError(null);
                        setEditingEntry(reply);
                      }}
                      onDelete={() => {
                        setRowError(null);
                        setDeletingEntry(reply);
                      }}
                      readOnly={readOnly}
                    />
                  </Box>
                ))}
              </Box>
            ))}
          </CardContent>
        </Card>
      ) : null}

      <MachineDetailsCard details={details ?? null} />

      {editingEntry && (
      <NoteEditDialog
        key={editingEntry.id}
        open
        initialBody={editingEntry.body}
        media={editingEntry.media}
        noun="entry"
        saving={rowBusy}
        error={rowError}
        onClose={() => {
          setEditingEntry(null);
          setRowError(null);
        }}
        onSave={({ body, removedMediaIds }) => handleEditSave(body, removedMediaIds)}
      />
      )}

      <NoteDeleteDialog
        open={deletingEntry !== null}
        noun="entry"
        // Said BEFORE the fact rather than discovered after. "Open" is derived
        // from the absence of a resolver (§4.4), so deleting the record that
        // something was fixed necessarily returns the item to outstanding. That
        // is correct behaviour and completely unguessable from the word "delete".
        consequence={
          deletingEntry?.resolves_note_id
            ? 'The item this fixed goes back to Needs attention.'
            : null
        }
        deleting={rowBusy}
        error={rowError}
        onClose={() => {
          setDeletingEntry(null);
          setRowError(null);
        }}
        onConfirm={handleDelete}
      />
    </Box>
  );
}
