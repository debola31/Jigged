/**
 * Duration formatting and elapsed-time arithmetic for recorded work time.
 *
 * NET NEW because this repo has no date library at all — no date-fns, dayjs,
 * luxon or moment — and the only pre-existing elapsed helper
 * (components/dashboard/activityFormat.tsx) answers a different question
 * ("how long ago", not "how long for"). Kept in one module for the reason that
 * file already states: a second copy of this arithmetic will drift from the
 * first, and two surfaces disagreeing about how long a job took is worse than
 * either being slightly wrong.
 */

const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 3_600_000;

/**
 * Elapsed milliseconds for a running interval, from a server-anchored start.
 *
 * COMPUTE, NEVER ACCUMULATE. The obvious implementation — a setInterval that
 * increments a counter — is wrong on exactly the device this feature targets: a
 * backgrounded tab is throttled to one tick a minute in Chrome after five
 * minutes hidden, clamped to fifteen in Firefox for Android, and suspended
 * outright by iOS Safari, so a phone that went in a pocket comes back with a
 * counter that is short by however long it was there. Subtracting two instants
 * is immune to all of it: call this on every repaint and the number is right
 * however long the tab was asleep.
 *
 * `serverSkewMs` (server_now − Date.now() at the time of the call) corrects for
 * a phone whose own clock is wrong, which on a shop floor is not rare.
 */
export function elapsedMs(startedAt: string, serverSkewMs = 0): number {
  const started = new Date(startedAt).getTime();
  if (Number.isNaN(started)) return 0;
  return Math.max(0, Date.now() + serverSkewMs - started);
}

/** Elapsed milliseconds between two recorded instants; null while still running. */
export function intervalMs(startedAt: string, endedAt: string | null): number | null {
  if (!endedAt) return null;
  const a = new Date(startedAt).getTime();
  const b = new Date(endedAt).getTime();
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.max(0, b - a);
}

/**
 * A duration as `1h 47m`, `47m`, or `<1m`.
 *
 * COMPACT UNITS ARE DELIBERATE, and not only for width. The operator Me tab
 * asserts that the word "minutes" never appears on it — a guardrail against the
 * surface growing pace language — so spelling the unit out would fail that test
 * for a real reason rather than a cosmetic one. `<1m` rather than `0m` because a
 * recorded interval always happened, and rendering it as zero invites the reader
 * to treat it as missing.
 */
export function formatDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '—';
  if (ms < MS_PER_MINUTE) return '<1m';

  const hours = Math.floor(ms / MS_PER_HOUR);
  const minutes = Math.round((ms % MS_PER_HOUR) / MS_PER_MINUTE);
  // 59.7 minutes rounds to 60, which must read as 1h rather than "0h 60m".
  if (minutes === 60) return `${hours + 1}h`;
  if (hours === 0) return `${minutes}m`;
  if (minutes === 0) return `${hours}h`;
  return `${hours}h ${minutes}m`;
}

/**
 * A running duration as `H:MM:SS` or `MM:SS`.
 *
 * Seconds only while a timer is live, where movement is the point — it is how an
 * operator can tell at a glance that the thing is actually running rather than
 * stuck. Everywhere else uses `formatDuration`, because seconds on a recorded
 * span imply a precision a human tap does not have.
 */
export function formatStopwatch(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(h > 0 ? 2 : 1, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/**
 * A wall-clock time as `9:12 AM`, in the reader's own locale and zone.
 *
 * The interval's LEAD value on every operator surface. A start time is a fact
 * about the job — it answers "is this running, and did I forget to switch" — in
 * a way a ticking counter does not, and it carries no comparison with it.
 */
export function formatClockTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/**
 * An ISO instant as the `HH:mm` value a native `<input type="time">` wants.
 *
 * Local time, because that input is always local. Pairs with `timeInputToIso`,
 * and the two must stay symmetric.
 */
export function isoToTimeInput(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * An `HH:mm` input value back to an ISO instant, on the same DAY as `sameDayAs`.
 *
 * TIME-OF-DAY IS THE STORED TRUTH and the input only carries a time, so the date
 * has to come from the interval being corrected. Anchoring on `sameDayAs`
 * rather than today is what makes correcting yesterday's forgotten stop land on
 * yesterday.
 *
 * A result that lands BEFORE the anchor by more than half a day is rolled
 * forward a day: closing at 00:20 an interval that started at 23:50 is a night
 * shift, not a negative duration. The opposite case — an adjusted start typed as
 * 23:50 against an end at 00:20 — rolls back for the same reason.
 */
export function timeInputToIso(
  value: string,
  sameDayAs: string,
  direction: 'start' | 'end' = 'start',
): string | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;

  const anchor = new Date(sameDayAs);
  if (Number.isNaN(anchor.getTime())) return null;

  const result = new Date(anchor);
  result.setHours(hours, minutes, 0, 0);

  const HALF_DAY = 12 * MS_PER_HOUR;
  const delta = result.getTime() - anchor.getTime();
  if (direction === 'end' && delta < -HALF_DAY) {
    result.setDate(result.getDate() + 1);
  } else if (direction === 'start' && delta > HALF_DAY) {
    result.setDate(result.getDate() - 1);
  }
  return result.toISOString();
}

/** Shift an ISO instant by whole minutes — the ±5 / ±15 nudge buttons. */
export function nudgeIso(iso: string, deltaMinutes: number): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Date(d.getTime() + deltaMinutes * MS_PER_MINUTE).toISOString();
}
