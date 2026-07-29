'use client';

import { useState } from 'react';
import { useLoad } from '@/hooks/useLoad';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import VisibilityOutlinedIcon from '@mui/icons-material/VisibilityOutlined';
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
 * DISMISSAL ACKNOWLEDGES A NUMBER, NOT THE WEEK
 *   Permanent dismissal would kill the loop after one tap, so what gets stored
 *   is the count the operator has already seen. The banner returns as soon as
 *   the number GROWS past it.
 *
 *   The earlier version stored only the week, which had a suppression bug worth
 *   remembering: the count climbs all week, so someone who found the repetition
 *   annoying on Monday and dismissed at "1 person" would never see Friday's
 *   "6 people" — the largest and most motivating number of the week, silently
 *   swallowed. The nag and the reward were the same object, so killing one
 *   killed the other.
 *
 *   Storing the COUNT rather than a timestamp is deliberate. A stored "last
 *   opened" instant would have to be sent back as a query window, and a
 *   caller-supplied window is a bisection oracle — narrow it repeatedly and you
 *   recover WHEN someone read your note, which combined with note_viewers()
 *   naming them reconstructs "Kurtis had to look this up on Tuesday". The count
 *   is a number the server already told us; sending nothing back keeps the RPC's
 *   single server-computed boundary intact.
 */

// New key (not the old …-dismissed) so a stored week-string from a preview build
// is simply ignored rather than needing a parse fallback.
const SEEN_KEY = 'jigged:note-usage-banner-seen';

interface Seen {
  week: string;
  count: number;
}

/** ISO-8601 week key (YYYY-Www) in the viewer's own timezone. */
function isoWeekKey(d: Date): string {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  // Thursday of this week determines the ISO year.
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((t.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/** The count already acknowledged this week; 0 if none, or on any bad/absent value. */
function readSeenCount(weekKey: string): number {
  if (typeof window === 'undefined') return 0;
  try {
    const raw = window.localStorage.getItem(SEEN_KEY);
    if (!raw) return 0;
    const parsed = JSON.parse(raw) as Partial<Seen>;
    if (parsed?.week !== weekKey || typeof parsed.count !== 'number') return 0;
    return parsed.count;
  } catch {
    // Private mode, quota, or a hand-mangled value. Showing the banner is the
    // safe failure: the loop survives, at worst one extra impression.
    return 0;
  }
}

function writeSeenCount(weekKey: string, count: number): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(SEEN_KEY, JSON.stringify({ week: weekKey, count } satisfies Seen));
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
  const [seenCount, setSeenCount] = useState(() => readSeenCount(weekKey));

  // Both the ✕ and a tap-through count as "I have seen this number". Tapping
  // through especially: coming back from My work to the same banner you just
  // acted on reads as if nothing happened.
  const acknowledge = (n: number) => {
    writeSeenCount(weekKey, n);
    setSeenCount(n);
  };

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
  if (n <= 0 || n <= seenCount) return null;

  return (
    <Box sx={{ mb: 2 }}>
      <Alert
        severity="success"
        // The default success icon is a check circle — the vocabulary of "the
        // thing you just did worked". Nobody did anything here; this is ambient
        // news about other people. The eye ties it to the view counts on My work,
        // which is where tapping it lands, and stops the banner reading as a
        // confirmation of an action. Green stays: it is doing real work as the
        // reward signal, and that is the whole point of the banner.
        icon={<VisibilityOutlinedIcon fontSize="inherit" />}
        onClose={(e) => {
          // The close button sits INSIDE the tappable Alert, so without this the
          // click bubbles to onOpenDetail and dismissing navigates the operator
          // away from the screen they were trying to clear.
          e.stopPropagation();
          acknowledge(n);
        }}
        {...(onOpenDetail
          ? {
              onClick: () => {
                acknowledge(n);
                onOpenDetail();
              },
              sx: { cursor: 'pointer', minHeight: 48 },
            }
          : { sx: { minHeight: 48 } })}
      >
        {n === 1
          ? 'Someone viewed one of your notes this week.'
          : `${n} people viewed your notes this week.`}
      </Alert>
    </Box>
  );
}
