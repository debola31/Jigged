'use client';

import { useMemo, useState } from 'react';
import { useLoad } from '@/hooks/useLoad';
import { Box, Button, Divider, Typography } from '@mui/material';
import { getMyIntervalJournal } from '@/utils/operationIntervalsAccess';
import { formatClockTime, formatDuration, intervalMs } from '@/lib/duration';
import type { OperationIntervalWithContext } from '@/types/operationInterval';

const PAGE = 10;

/**
 * The operator's own recorded time, on the Me tab.
 *
 * THE LINE THIS SURFACE WALKS: one entry is a RECORD; two entries summed are a
 * METRIC. Every row here is a fact the operator personally created, shown back
 * to them at full fidelity with its provenance — which is what makes it
 * transparency rather than a scoreboard, and what answers "the office can see my
 * times and I cannot", which is itself an asymmetry.
 *
 * SO THERE IS DELIBERATELY NO SCALAR ANYWHERE IN IT. No row count, no "showing
 * 47 entries", no weekly or monthly total, no average, no comparison with the
 * estimate, no colour encoding better or worse. The safety of this component is
 * *entirely* structural: there is no single number on it to optimise. Adding one
 * — even a private, self-only, comparison-free one — reintroduces exactly the
 * counter Etkin 2016 measured raising output ~26% while quality fell, and it is
 * a one-way door. See
 * docs/modules/operator-view.md#surveillance-guardrail-non-negotiable before
 * adding anything to this file.
 *
 * Paged by DATE CURSOR rather than by offset, so there is never a total to
 * render even accidentally.
 */
export default function MyWorkJournal({ companyId }: { companyId: string }) {
  // The first page through useLoad (which keeps setState out of the effect body
  // and guards against out-of-order responses); later pages appended separately,
  // so "Show earlier" never re-fetches what is already on screen.
  const {
    data: firstPage,
    loading,
    error,
  } = useLoad(() => getMyIntervalJournal(companyId, undefined, PAGE), [companyId]);

  const [older, setOlder] = useState<OperationIntervalWithContext[]>([]);
  const [exhausted, setExhausted] = useState(false);

  const entries = useMemo(() => [...(firstPage ?? []), ...older], [firstPage, older]);

  const loadOlder = async () => {
    const cursor = entries[entries.length - 1]?.effective_started_at;
    if (!cursor) return;
    try {
      const rows = await getMyIntervalJournal(companyId, cursor, PAGE);
      setOlder((prev) => [...prev, ...rows]);
      if (rows.length < PAGE) setExhausted(true);
    } catch {
      // Leave what is already shown in place; tapping again is a clean retry.
    }
  };

  if (loading) return null;

  if (error) {
    return (
      <Box sx={{ mt: 4 }}>
        <Typography variant="h6" sx={{ mb: 1 }}>
          Your work journal
        </Typography>
        <Typography variant="body2" color="text.secondary">
          Couldn&apos;t load this just now. Pull down to refresh.
        </Typography>
      </Box>
    );
  }

  // Nothing recorded yet renders nothing at all — no empty-state nudge, no
  // prompt to start using the timer. A surface that badgers an operator about
  // their own participation is the thing this module refuses.
  if (entries.length === 0) return null;

  return (
    <Box sx={{ mt: 4 }}>
      <Typography variant="h6">Your work journal</Typography>
      {/* States the data flow plainly, and never calls this "private" — the shop
          holds the same records, and a privacy claim that is not true would be
          discovered and would poison everything else on this screen. */}
      <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5, mb: 2 }}>
        The times you recorded. Your shop can see these on the job they belong to.
      </Typography>

      {entries.map((entry, i) => (
        <Box key={entry.id}>
          {i > 0 && <Divider sx={{ my: 1.5 }} />}
          <JournalRow entry={entry} />
        </Box>
      ))}

      {!exhausted && (
        <Button
          fullWidth
          onClick={loadOlder}
          sx={{ mt: 2, minHeight: 48 }}
        >
          Show earlier
        </Button>
      )}
    </Box>
  );
}

function JournalRow({ entry }: { entry: OperationIntervalWithContext }) {
  const duration = intervalMs(entry.effective_started_at, entry.effective_ended_at);
  const wasAdjusted = entry.adjusted_at != null;

  return (
    <Box>
      <Typography variant="body2" sx={{ fontWeight: 600 }}>
        {entry.operation_name}
        {entry.job_number ? ` · ${entry.job_number}` : ''}
      </Typography>

      <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
        {new Date(entry.effective_started_at).toLocaleDateString(undefined, {
          weekday: 'short',
          month: 'short',
          day: 'numeric',
        })}
        {' · '}
        {formatClockTime(entry.effective_started_at)}
        {entry.effective_ended_at ? ` – ${formatClockTime(entry.effective_ended_at)}` : ' – still running'}
        {duration != null ? ` · ${formatDuration(duration)}` : ''}
      </Typography>

      {/* PROVENANCE, NEUTRAL AND AGENTLESS. What was recorded, stated as fact.
          No pencil, no amber, no "edited by", and no count of how many times
          anyone has adjusted anything — that last one is a per-operator
          behavioural metric and is exactly what must not grow here. */}
      {wasAdjusted && (
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
          Recorded {formatClockTime(entry.started_at)}
          {entry.ended_at ? ` – ${formatClockTime(entry.ended_at)}` : ''}
        </Typography>
      )}

      {entry.note && (
        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
          {entry.note}
        </Typography>
      )}
    </Box>
  );
}
