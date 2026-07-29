'use client';

import { useState } from 'react';
import { useLoad } from '@/hooks/useLoad';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import { getTypedSupabase as getSupabase } from '@/lib/supabase';

/**
 * "3 people viewed your notes this week."
 *
 * The return half of the loop. An operator writes something down and, today,
 * nothing comes back — no way to know whether it was read, no reason to believe
 * writing it did anything. This is the smallest honest signal that it did.
 *
 * WHAT IT SAYS, AND WHAT IT MUST NOT
 *   PEOPLE, not reads. The digest counts distinct viewers, so three means three
 *   colleagues — not one person opening a note three times. In a shop this size
 *   the author can simply ask, so an inflated number is not a rounding error, it
 *   discredits the whole mechanism.
 *
 *   Nothing at zero. A "0 people viewed your notes" banner is a weekly reminder
 *   that nobody cares, which is worse than silence. It renders null.
 *
 *   No names here. Who read what is the author's alone and lives behind
 *   note_viewers(); a banner is glanceable and public to anyone over a shoulder.
 *
 * WEEK BOUNDARY
 *   The browser's own timezone, passed to the digest so Postgres computes the
 *   boundary. "This week" has to mean the shop's week — a UTC cutoff would flip
 *   mid-shift for a US shop and make Monday morning's banner cover Sunday night.
 *
 * DISMISSAL IS PER WEEK
 *   Permanent dismissal would kill the loop after one tap. The key carries the
 *   ISO week, so dismissing this week's banner leaves next week's intact.
 */

const DISMISS_KEY = 'jigged:note-usage-banner-dismissed';

/** ISO-8601 week key (YYYY-Www) in the viewer's own timezone. */
function isoWeekKey(d: Date): string {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  // Thursday of this week determines the ISO year.
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((t.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function readDismissed(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(DISMISS_KEY);
  } catch {
    return null; // private mode / quota — the banner is best-effort
  }
}

function writeDismissed(weekKey: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(DISMISS_KEY, weekKey);
  } catch {
    /* ignore */
  }
}

interface NoteUsageBannerProps {
  companyId: string;
  /** Tapping through goes to the author's own notes; omitted until My Work ships. */
  onOpenDetail?: () => void;
}

export default function NoteUsageBanner({ companyId, onOpenDetail }: NoteUsageBannerProps) {
  const weekKey = isoWeekKey(new Date());
  const [dismissed, setDismissed] = useState(() => readDismissed() === weekKey);

  const { data: count } = useLoad(async () => {
    const tz =
      typeof Intl !== 'undefined'
        ? Intl.DateTimeFormat().resolvedOptions().timeZone
        : 'UTC';
    const { data, error } = await getSupabase().rpc('my_note_view_digest', {
      p_tz: tz || 'UTC',
    });
    // Silent on failure: a broken digest must not put an error in front of an
    // operator who was only trying to start work.
    if (error) return 0;
    return (data as number | null) ?? 0;
  }, [companyId]);

  const n = count ?? 0;
  if (dismissed || n <= 0) return null;

  return (
    <Box sx={{ mb: 2 }}>
      <Alert
        severity="success"
        onClose={(e) => {
          // The close button sits INSIDE the tappable Alert, so without this the
          // click bubbles to onOpenDetail and dismissing navigates the operator
          // away from the screen they were trying to clear.
          e.stopPropagation();
          writeDismissed(weekKey);
          setDismissed(true);
        }}
        {...(onOpenDetail
          ? { onClick: onOpenDetail, sx: { cursor: 'pointer', minHeight: 48 } }
          : { sx: { minHeight: 48 } })}
      >
        {n === 1
          ? 'Someone viewed one of your notes this week.'
          : `${n} people viewed your notes this week.`}
      </Alert>
    </Box>
  );
}
