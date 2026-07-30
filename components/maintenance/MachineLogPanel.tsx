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
import { getCurrentMember } from '@/utils/operatorAccess';
import {
  addMachineNote,
  addMachineNoteMedia,
  getMachineDetails,
  getMachineLog,
} from '@/utils/machineMaintenanceAccess';
import { logOperatorEvent } from '@/utils/operatorEventsAccess';
import { countWorkCenterAttachments } from '@/utils/workCenterAttachmentsAccess';
import MachineComposer from '@/components/maintenance/MachineComposer';
import MachineDetailsCard from '@/components/maintenance/MachineDetailsCard';
import MachineEntry from '@/components/maintenance/MachineEntry';
import MachineManualsSheet from '@/components/maintenance/MachineManualsSheet';
import MachineOpenItems from '@/components/maintenance/MachineOpenItems';
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
  const [kind, setKind] = useState<MaintenanceKind | null>(null);
  const [replyingTo, setReplyingTo] = useState<MachineNote | null>(null);
  const [manualsOpen, setManualsOpen] = useState(false);

  const {
    data: log,
    loading,
    reload,
  } = useLoad(() => getMachineLog(workCenterId, companyId), [workCenterId, companyId], {
    onError: (err) => setError(err instanceof Error ? err.message : 'Could not load the log.'),
  });

  const { data: details } = useLoad(() => getMachineDetails(workCenterId), [workCenterId]);

  // Only decides whether an affordance renders, and returns 0 rather than
  // throwing — so a failure degrades to "this machine has no manuals", which is
  // also what it looks like when it genuinely has none.
  const { data: manualCount } = useLoad(
    () => countWorkCenterAttachments(workCenterId),
    [workCenterId],
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
      if (active && m) setMemberId(m.id);
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
      attachMedia: (note, file, dims) =>
        addMachineNoteMedia(companyId, workCenterId, note.id, file, { dims }),
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

  /**
   * The reply's OWN writer and OWN capture — a second draft, not a mode on the
   * first.
   *
   * This is why it matters beyond looks: `startFix` used to leave whatever was
   * half-typed in the main composer alone while re-binding it to a resolution,
   * so a sentence written about something else silently became the fix for an
   * item somebody tapped afterwards. Two composers cannot do that to each other.
   */
  const replyWriter: NoteWriter<MachineNote> | null = useMemo(() => {
    if (readOnly || !memberId || !replyingTo) return null;
    const target = replyingTo;
    return {
      createNote: (body) =>
        addMachineNote(workCenterId, companyId, memberId, body, {
          maintenanceKind: null,
          resolvesNoteId: target.id,
        }),
      attachMedia: (note, file, dims) =>
        addMachineNoteMedia(companyId, workCenterId, note.id, file, { dims }),
      withMedia: (note, media) => ({ ...note, media }),
      eventContext: { workCenterId, resolving: true },
    };
  }, [readOnly, memberId, workCenterId, companyId, replyingTo]);

  const replyCapture = useNoteCapture<MachineNote>({
    companyId,
    operatorId: memberId,
    writer: replyWriter,
    enabled: !readOnly && replyingTo != null,
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

  const replyWithReset = useMemo(
    () => ({
      ...replyCapture,
      submit: async () => {
        const saved = await replyCapture.submit();
        if (saved) {
          // The loop closing, which is the behaviour the module is betting on:
          // somebody fixed a thing somebody else flagged.
          logOperatorEvent(companyId, 'noticed_resolved', { workCenterId });
          setReplyingTo(null);
          reload();
        }
        return saved;
      },
    }),
    [replyCapture, companyId, workCenterId, reload],
  );

  // Opens a reply directly under the item. No scroll-to-top and no banner: the
  // composer's POSITION says what it answers, which is a thing you cannot lose
  // track of the way you can lose a mode indicator that has scrolled off-screen.
  const startFix = useCallback((item: MachineNote) => {
    setReplyingTo((current) => (current?.id === item.id ? null : item));
  }, []);

  const openIds = useMemo(() => new Set((log?.open ?? []).map((o) => o.id)), [log]);
  // The log excludes whatever is pinned above it. Each entry appears EXACTLY
  // once: outstanding items live in the pinned block, and the moment somebody
  // logs the fix they drop into the log here, carrying their author. Rendering
  // both was the same fact twice with different chrome.
  const logged = useMemo(
    () => (log?.entries ?? []).filter((e) => !openIds.has(e.id)),
    [log, openIds],
  );
  const resolverAuthorById = useMemo(() => {
    const map = new Map<string, string | null>();
    for (const e of log?.entries ?? []) {
      if (e.resolves_note_id) map.set(e.resolves_note_id, e.author_name);
    }
    return map;
  }, [log]);

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
          setup prompt takes when it sneaks back in (§4.5). */}
      {(manualCount ?? 0) > 0 && (
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
        onLogFix={readOnly ? undefined : startFix}
        replyingToId={replyingTo?.id ?? null}
        renderReply={() => (
          <MachineComposer
            capture={replyWithReset}
            kind={null}
            onKindChange={() => {}}
            variant="reply"
            placeholder="What did you do to fix it?"
            submitLabel="Log the fix"
            onCancel={() => setReplyingTo(null)}
          />
        )}
        readOnly={readOnly}
      />

      {entries.length === 0 ? (
        // A plain statement of fact. Not a nudge, not an illustration, not a
        // "get started" — the machine simply has no history yet, and saying so
        // is the honest version of an empty container.
        <Typography variant="body2" color="text.secondary" sx={{ py: 2 }}>
          Nothing logged for this machine yet.
        </Typography>
      ) : logged.length > 0 ? (
        // ONE card, rows separated by dividers — the shape the job feed already
        // uses for notes. Same content type, same reading gesture, and a
        // four-word entry no longer costs a whole card plus a gap.
        <Card elevation={2} sx={cardSx}>
          <CardContent>
            {logged.map((entry, idx) => (
              <Box key={entry.id}>
                {idx > 0 && <Divider sx={{ my: 1.5 }} />}
                {/* observe() attaches to the entry BODY, never a container or a
                    count badge — a read means somebody dwelled on the words. */}
                <Box ref={observe(entry.id)}>
                  <MachineEntry
                    entry={entry}
                    companyId={companyId}
                    memberId={memberId}
                    resolvedBy={resolverAuthorById.get(entry.id) ?? null}
                    readOnly={readOnly}
                  />
                </Box>
              </Box>
            ))}
          </CardContent>
        </Card>
      ) : null}

      <MachineDetailsCard details={details ?? null} />
    </Box>
  );
}
