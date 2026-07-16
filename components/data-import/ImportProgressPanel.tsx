'use client';

import Box from '@mui/material/Box';
import CircularProgress from '@mui/material/CircularProgress';
import LinearProgress from '@mui/material/LinearProgress';
import Typography from '@mui/material/Typography';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import RadioButtonUncheckedIcon from '@mui/icons-material/RadioButtonUnchecked';
import type { ImportProgress } from '@/lib/dataImportIngest';
import { ENTITY_LABELS } from '@/lib/dataImportSchema';
import type { EntityType } from '@/types/data-import';

/**
 * Live feedback for the long-running write (~65 sequential batches, a minute+). A determinate
 * bar — we know exactly how many rows are done of how many — plus a stage checklist that ticks
 * off as each entity finishes, so a non-technical owner can see it's working, roughly how far
 * along, and that it's nearly there. No ETA (batch times are too uneven to estimate honestly);
 * no cancel (a half-done write is worse than waiting — and re-running is safe anyway).
 */
export default function ImportProgressPanel({ progress }: { progress: ImportProgress | null }) {
  // Before the first batch reports, show an indeterminate bar rather than a jumpy "0%".
  const started = !!progress && progress.rowsTotal > 0;
  const pct = started ? Math.round((progress.rowsDone / progress.rowsTotal) * 100) : 0;

  return (
    <Box>
      <Typography variant="h6" sx={{ fontWeight: 600, mb: 0.5 }}>
        Importing your data…
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2.5 }}>
        This can take a minute for a large import. Please keep this page open — we&apos;ll show you a
        summary as soon as it&apos;s done.
      </Typography>

      <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 0.5 }}>
        <Typography variant="body2" sx={{ fontWeight: 600 }}>
          {started
            ? `${progress!.rowsDone.toLocaleString()} of ${progress!.rowsTotal.toLocaleString()} rows`
            : 'Starting…'}
        </Typography>
        {started && (
          <Typography variant="body2" color="text.secondary">
            {pct}%
          </Typography>
        )}
      </Box>
      <LinearProgress
        variant={started ? 'determinate' : 'indeterminate'}
        value={pct}
        sx={{ height: 8, borderRadius: 4, mb: 3 }}
      />

      {/* Stage checklist — the phased view, in write order. */}
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.25 }}>
        {(progress?.entities ?? []).map((e) => {
          const done = e.rowsTotal > 0 && e.rowsDone >= e.rowsTotal;
          const active = progress?.currentEntity === e.entity && !done;
          return (
            <Box key={e.entity} sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
              {done ? (
                <CheckCircleIcon color="success" sx={{ fontSize: 20 }} />
              ) : active ? (
                <CircularProgress size={18} sx={{ mx: '1px' }} />
              ) : (
                <RadioButtonUncheckedIcon sx={{ fontSize: 20, color: 'text.disabled' }} />
              )}
              <Typography
                variant="body2"
                sx={{ fontWeight: done || active ? 600 : 400, color: done || active ? 'text.primary' : 'text.secondary', minWidth: 140 }}
              >
                {ENTITY_LABELS[e.entity as EntityType] ?? e.entity}
              </Typography>
              <Typography variant="body2" color="text.secondary">
                {active
                  ? `${e.rowsDone.toLocaleString()} of ${e.rowsTotal.toLocaleString()} rows`
                  : done
                    ? `${e.rowsTotal.toLocaleString()} rows`
                    : `${e.rowsTotal.toLocaleString()} rows`}
              </Typography>
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}
