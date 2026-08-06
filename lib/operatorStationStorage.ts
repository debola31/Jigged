/**
 * Device-local persistence for the operator's selected station.
 *
 * The operator's selected station is a "where am I standing right now" default.
 * It lives in localStorage (NOT sessionStorage) so it survives a backgrounded-tab
 * eviction or a browser restart — the shop-floor reality that had operators
 * landing on a job with the station picker stacked underneath it every morning.
 *
 * Split out of OperatorStationContext so that sign-out paths OUTSIDE the operator
 * tree (AuthProvider, which every dashboard page mounts) can clear the station
 * without importing the React context and dragging the operator access layer into
 * their bundle. Nothing here touches React or Supabase — it is localStorage and
 * string keys.
 */

// A station IS a work center, and a work center belongs to exactly ONE company —
// so the stored selection is PER COMPANY, not per device. One user can hold
// access to several companies (demo mode hands out two routinely), and under the
// single flat key this used to use, switching company carried the previous
// company's machine along: the header named a station that was absent from the
// station dropdown, the job list went permanently empty WITHOUT offering the
// picker, and the first maintenance note saved against it was rejected by the
// `notes_validate_subject()` trigger with "work center … is not in company …",
// surfacing on the floor as "Could not save that."
//
// Matches the convention the rest of the app already uses for device-local
// company state — `jigged.jobs.statusFilter.${companyId}` on the dashboard jobs
// page, and the companyId-keyed dismissal in components/demo/OnboardingCard.tsx.
const STORAGE_PREFIX = 'jigged_operator_station';

// The flat key devices wrote before that fix. It names a machine in SOME company
// and cannot say which — see readStoredStation for how it is retired.
const LEGACY_STORAGE_KEY = STORAGE_PREFIX;

function storageKey(companyId: string): string {
  return `${STORAGE_PREFIX}:${companyId}`;
}

/**
 * The station stored for this company, or null.
 *
 * localStorage access can throw (Safari private mode throws on setItem; access
 * can be blocked entirely). A remembered station default must never white-screen
 * the whole operator app, so every access is guarded and degrades to in-memory.
 */
export function readStoredStation(companyId: string): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const scoped = window.localStorage.getItem(storageKey(companyId));
    if (scoped) return scoped;

    // One-shot migration off the flat key, so this fix does not put every
    // operator already out on a floor back in front of the picker one morning
    // for a bug they never hit. The old value carries no company, so it is
    // adopted by whichever company opens first and CONSUMED — copying it to
    // every company would re-seed each one in turn with the same wrong machine.
    // A wrong guess costs exactly one re-pick, because `getStationName` now
    // validates by company and the provider clears what it rejects.
    const legacy = window.localStorage.getItem(LEGACY_STORAGE_KEY);
    if (!legacy) return null;
    try {
      window.localStorage.setItem(storageKey(companyId), legacy);
      window.localStorage.removeItem(LEGACY_STORAGE_KEY);
    } catch {
      /* storage is read-only — the value still seeds this session */
    }
    return legacy;
  } catch {
    return null;
  }
}

/** Remember `stationId` as this company's station on this device. */
export function writeStoredStation(companyId: string, stationId: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(storageKey(companyId), stationId);
  } catch {
    /* storage unavailable — keep the value in memory only */
  }
}

/**
 * Clear the persisted station.
 *
 * With a `companyId`, forgets only that company's station — what the provider
 * does when the stored machine turns out to be archived, or to belong to a
 * different company.
 *
 * Without one, forgets EVERY company's station plus the legacy key, which is
 * what ending a session on this device means: a phone that changes hands must
 * not hand the next person a station, in any company.
 */
export function clearStoredStation(companyId?: string): void {
  if (typeof window === 'undefined') return;
  try {
    if (companyId) {
      window.localStorage.removeItem(storageKey(companyId));
      return;
    }
    // Collect before removing — removing while iterating by index reindexes the
    // store underneath the loop and silently skips entries.
    const doomed: string[] = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i);
      if (key === LEGACY_STORAGE_KEY || key?.startsWith(`${STORAGE_PREFIX}:`)) {
        doomed.push(key);
      }
    }
    doomed.forEach((key) => window.localStorage.removeItem(key));
  } catch {
    /* ignore */
  }
}
