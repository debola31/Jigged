'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import CircularProgress from '@mui/material/CircularProgress';
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
import MachineComposer from '@/components/maintenance/MachineComposer';
import MachineDetailsCard from '@/components/maintenance/MachineDetailsCard';
import MachineEntryCard from '@/components/maintenance/MachineEntryCard';
import MachineOpenItems from '@/components/maintenance/MachineOpenItems';
import type { MachineNote, MaintenanceKind } from '@/types/machineMaintenance';

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
  const [resolving, setResolving] = useState<MachineNote | null>(null);

  const {
    data: log,
    loading,
    reload,
  } = useLoad(() => getMachineLog(workCenterId, companyId), [workCenterId, companyId], {
    onError: (err) => setError(err instanceof Error ? err.message : 'Could not load the log.'),
  });

  const { data: details } = useLoad(() => getMachineDetails(workCenterId), [workCenterId]);

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
          resolvesNoteId: resolving?.id ?? null,
        }),
      attachMedia: (note, file, dims) =>
        addMachineNoteMedia(companyId, workCenterId, note.id, file, { dims }),
      withMedia: (note, media) => ({ ...note, media }),
      eventContext: { workCenterId, maintenanceKind: kind },
    };
  }, [readOnly, memberId, workCenterId, companyId, kind, resolving]);

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
          if (resolving) {
            // The loop closing, which is the behaviour the module is betting on:
            // somebody fixed a thing somebody else flagged.
            logOperatorEvent(companyId, 'noticed_resolved', { workCenterId });
          }
          setKind(null);
          setResolving(null);
          reload();
        }
        return saved;
      },
    }),
    [capture, resolving, companyId, workCenterId, reload],
  );

  const startFix = useCallback((item: MachineNote) => {
    setResolving(item);
    // Kind stays unset. Pre-selecting "repaired" would be the taxonomy nudge the
    // optional chip exists to avoid, and plenty of fixes are a clean or an
    // adjustment.
    setKind(null);
    if (typeof window !== 'undefined') window.scrollTo({ top: 0, behavior: 'smooth' });
  }, []);

  const openIds = useMemo(() => new Set((log?.open ?? []).map((o) => o.id)), [log]);
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

      {machineName && (
        <Typography variant="h6" sx={{ mb: 1.5 }}>
          {machineName}
        </Typography>
      )}

      <MachineOpenItems items={log?.open ?? []} onLogFix={readOnly ? undefined : startFix} />

      {!readOnly && (
        <MachineComposer
          capture={captureWithReset}
          kind={kind}
          onKindChange={setKind}
          resolving={resolving}
          onCancelResolving={() => setResolving(null)}
        />
      )}

      {entries.length === 0 ? (
        // A plain statement of fact. Not a nudge, not an illustration, not a
        // "get started" — the machine simply has no history yet, and saying so
        // is the honest version of an empty container.
        <Typography variant="body2" color="text.secondary" sx={{ py: 2 }}>
          Nothing logged for this machine yet.
        </Typography>
      ) : (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
          {entries.map((entry) => (
            // observe() attaches to the BODY element, never the card or a count
            // badge — a read means somebody actually dwelled on the words.
            <Box key={entry.id} ref={observe(entry.id)}>
              <MachineEntryCard
                entry={entry}
                companyId={companyId}
                memberId={memberId}
                isOpen={openIds.has(entry.id)}
                resolvedBy={resolverAuthorById.get(entry.id) ?? null}
                onLogFix={() => startFix(entry)}
                readOnly={readOnly}
              />
            </Box>
          ))}
        </Box>
      )}

      <MachineDetailsCard details={details ?? null} />
    </Box>
  );
}
