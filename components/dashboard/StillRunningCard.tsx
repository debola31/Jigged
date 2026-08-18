'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Alert, Box, Card, CardContent, Chip, Divider, Typography } from '@mui/material';
import { getOpenIntervals } from '@/utils/operationIntervalsAccess';
import { elapsedMs, formatClockTime, formatDuration } from '@/lib/duration';
import type { OpenInterval } from '@/types/operationInterval';

/**
 * Work whose timer is still running, oldest first.
 *
 * THIS IS THE FORGOTTEN-STOP CHANNEL, and it is the office's job rather than the
 * operator's for a reason that is structural rather than preference. A web page
 * on a personal phone cannot be reached: iOS Web Push needs the site installed
 * as a Home Screen web app, which `app/manifest.ts` deliberately refuses because
 * standalone splits the cookie jar and breaks the zero-tap traveler QR. Even
 * fully built, reach is ~48% and the errors correlate the wrong way — the
 * operator disciplined enough to install a PWA is the same one who remembers to
 * close their interval. The office computer, by contrast, is always reachable.
 *
 * IT IS ALSO THE ONLY ROUTE TO AN ABANDONED INTERVAL. `close_operation_interval`
 * refuses a non-owner by design (an unchecked id would let any member rewrite
 * anyone's hours), so an interval whose owner has gone home is unreachable
 * except from here.
 *
 * NO OPERATOR NAMES. An open interval is a fact about a MACHINE — "Mill-2 has
 * been running since Friday 4pm" — and that is the fact the office acts on.
 * `get_open_intervals` does not return operator identity at all, so this is
 * enforced in the schema and not by this component's restraint. Whose it was is
 * a separate question, answered by an admin-gated function that logs the ask.
 */
const STALE_HOURS = 12;

export default function StillRunningCard({ companyId }: { companyId: string }) {
  const [rows, setRows] = useState<OpenInterval[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getOpenIntervals(companyId)
      .then((data) => {
        if (!cancelled) setRows(data);
      })
      .catch(() => {
        // Silent: this is a supplementary panel, and an error banner on the
        // dashboard for a list that is empty most days is worse than its
        // absence. The `.rpc()` call site has already reported to Sentry.
      })
      .finally(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [companyId]);

  // Nothing running is the normal state on most days and takes no space.
  if (!loaded || rows.length === 0) return null;

  const stale = rows.filter((r) => elapsedMs(r.started_at) > STALE_HOURS * 3_600_000);

  return (
    <Card>
      <CardContent>
        <Typography variant="h6" gutterBottom>
          Still running
        </Typography>

        {stale.length > 0 && (
          <Alert severity="warning" sx={{ mb: 2 }}>
            {/* Says what to DO, not who to blame. The times are wrong until
                somebody who was there says when the work actually stopped —
                which is a question, not an accusation. */}
            {stale.length === 1 ? 'One of these has' : `${stale.length} of these have`} been open
            more than {STALE_HOURS} hours. Nothing is auto-stopped, so the recorded time stays out
            of every total until someone confirms when the work finished.
          </Alert>
        )}

        {rows.map((row, i) => (
          <Box key={row.interval_id}>
            {i > 0 && <Divider sx={{ my: 1.5 }} />}
            <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1, flexWrap: 'wrap' }}>
              <Typography
                component={Link}
                href={`/dashboard/${companyId}/jobs/${row.job_id}`}
                variant="body2"
                sx={{ fontWeight: 600, textDecoration: 'none', color: 'primary.light' }}
              >
                {row.job_number}
              </Typography>
              <Typography variant="body2">
                {row.operation_name}
                {row.part_name ? ` · ${row.part_name}` : ''}
              </Typography>
              {row.capture_source !== 'operator' && (
                <Chip size="small" variant="outlined" label={row.capture_source} />
              )}
            </Box>
            <Typography variant="caption" color="text.secondary">
              {row.work_center_name ? `${row.work_center_name} · ` : ''}
              since {formatClockTime(row.started_at)}
              {' · '}
              {formatDuration(elapsedMs(row.started_at))} so far
            </Typography>
          </Box>
        ))}
      </CardContent>
    </Card>
  );
}
