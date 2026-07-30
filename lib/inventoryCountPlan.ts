/**
 * Count sheet — pure logic. No Supabase, no React; everything here is unit-tested directly.
 *
 * Mirrors the split in lib/dataImportIngest.ts: the decisions live in pure functions, and the
 * thin network driver (utils/inventoryCountAccess.ts) only walks the plan and reports progress.
 */

import type {
  CountCandidate,
  CountDraft,
  CountEntries,
  CountTarget,
  CountVariance,
} from '@/types/inventoryCount';

/** A part's stock, per location, as read from part_location_stock. */
export interface LocationBalance {
  locationId: string;
  locationName: string;
  quantity: number;
}

/**
 * Decide where a counted quantity goes for one part.
 *
 *  - **Untracked** → `parts.quantity`. The only legal write for a part whose quantity isn't
 *    a rollup.
 *  - **Tracked, nothing anywhere** → Unassigned. The opening-count case, not an edge case:
 *    `trg_auto_track_stocked_part` seeds every stocked part there at 0, so a shop starting
 *    from zero has every part here. It's also the honest target — you counted the stock, you
 *    haven't said where it lives.
 *  - **Tracked, exactly one location holding stock** → that location.
 *  - **Tracked, two or more** → excluded. "38 total" against 10+20+10 has no defensible bin
 *    to absorb the difference, and pushing it to Unassigned would corrupt bin-level accuracy.
 *
 * "Holding stock" means quantity > 0: the seeded zero-row at Unassigned must not make a part
 * look placed.
 */
export function resolveCountTarget(
  isLocationTracked: boolean,
  balances: LocationBalance[],
  unassigned: { id: string; name: string } | null,
): CountTarget {
  if (!isLocationTracked) return { kind: 'aggregate' };

  const holding = balances.filter((b) => b.quantity > 0);

  if (holding.length === 0) {
    if (!unassigned) {
      return {
        kind: 'excluded',
        reason: 'No "Unassigned" location exists to hold the count.',
        // Nowhere to send anyone: the part holds stock nowhere, so there is no
        // place-scoped worksheet that would help.
        locations: [],
      };
    }
    return { kind: 'location', locationId: unassigned.id, locationName: unassigned.name };
  }

  if (holding.length === 1) {
    return {
      kind: 'location',
      locationId: holding[0].locationId,
      locationName: holding[0].locationName,
    };
  }

  // Carrying the places, not just their count, is what turns this from a dead end into a
  // route: the sheet links each one to its place-scoped worksheet, where the same part IS
  // countable because "Shelf A holds 830" says nothing about Shelf B.
  return {
    kind: 'excluded',
    reason: `Stock is split across ${holding.length} locations — count this at its locations.`,
    locations: holding.map((b) => ({ id: b.locationId, name: b.locationName })),
  };
}

/** Candidates that can be counted item-by-item. */
export function countableCandidates(candidates: CountCandidate[]): CountCandidate[] {
  return candidates.filter((c) => c.target.kind !== 'excluded');
}

/** Candidates held back, so they can be named rather than silently missing. */
export function excludedCandidates(candidates: CountCandidate[]): CountCandidate[] {
  return candidates.filter((c) => c.target.kind === 'excluded');
}

/**
 * The unit shared by every part on the sheet, or null when they differ.
 *
 * When one unit covers the whole count it belongs in the footer, said once — repeating "each"
 * down forty rows is noise in a column of numbers. When units are mixed the sheet needs a
 * per-row unit instead, because a bare column of figures in different units is a trap.
 */
export function commonUnit(candidates: CountCandidate[]): string | null {
  if (candidates.length === 0) return null;
  const first = candidates[0].unit;
  return candidates.every((c) => c.unit === first) ? first : null;
}

/** How many parts carry a number. Drives the footer's running tally. */
export function countedTally(entries: CountEntries): number {
  return Object.keys(entries).length;
}

/**
 * The delta for one row, or null when it hasn't been counted.
 *
 * Used for the inline feedback that replaced the separate review page — the number appears on
 * the row the moment it's typed, which is when it's actually useful.
 */
export function rowDelta(candidate: CountCandidate, entries: CountEntries): number | null {
  const counted = entries[candidate.partId];
  if (counted === undefined) return null;
  return counted - candidate.systemQuantity;
}

/**
 * Variances for every counted part, against **freshly read** system quantities.
 *
 * `openedWith` is what the sheet showed when it loaded; a part whose current quantity differs
 * moved while the count was open. Worth flagging, though the commit is unaffected — adjust
 * sets an absolute value.
 */
export function buildVariances(
  candidates: CountCandidate[],
  entries: CountEntries,
  openedWith: Map<string, number>,
): CountVariance[] {
  const out: CountVariance[] = [];

  for (const candidate of candidates) {
    const counted = entries[candidate.partId];
    if (counted === undefined) continue;
    if (candidate.target.kind === 'excluded') continue;

    const delta = counted - candidate.systemQuantity;
    const opened = openedWith.get(candidate.partId);
    out.push({
      candidate,
      counted,
      delta,
      movedSinceOpened: opened !== undefined && opened !== candidate.systemQuantity,
    });
  }
  return out;
}

/** Variances that change something. A part counted equal to the system needs no write. */
export function committableVariances(variances: CountVariance[]): CountVariance[] {
  return variances.filter((v) => v.delta !== 0);
}

/*
 * There is deliberately no "is this variance suspiciously large?" helper here.
 *
 * One existed — a 50% proportional threshold, backed by the cycle-count finding that ~30% of
 * large variances are count errors. It drove a per-row caution icon and a confirm dialog, and
 * both were removed: against the quantities a small shop actually holds (7 on hand, 3 found),
 * proportional change is large almost every time, so the flag fired on nearly every line and
 * stopped meaning anything.
 *
 * The finding is probably still true; expressing it as a percentage of quantity is what failed.
 * A threshold on the *value* moved (`parts.cost_per_unit × delta`) would scale correctly across
 * a $2 bearing and a $2,000 casting, but the right figure is a question for a real shop, not a
 * guess from here. See docs/modules/inventory.md J9.
 */

/**
 * Note stored on each adjustment, so the ledger says where the number came from.
 *
 * Wording tracks the sheet's own: "inventory count", not "stock count" (the nav says
 * Inventory — "stock" would be a second word for the same thing), and "recorded", matching the
 * column header. Rows written before 2026-07-28 carry the older phrasing; each is still an
 * accurate record of what was said at the time, so they are left as they are.
 */
export function countNote(v: CountVariance): string {
  const unit = v.candidate.unit;
  return `Inventory count — counted ${v.counted} ${unit} (recorded as ${v.candidate.systemQuantity} ${unit})`;
}

// ── Draft persistence ────────────────────────────────────────────────────────

export const DRAFT_VERSION = 3 as const;

export function draftKey(companyId: string): string {
  return `jigged.inventoryCount.${companyId}`;
}

export function buildDraft(
  companyId: string,
  partIds: string[],
  entries: CountEntries,
  now: number,
): CountDraft {
  return { version: DRAFT_VERSION, companyId, partIds, entries, savedAt: now };
}

/**
 * Parse a stored draft, returning null for anything unusable.
 *
 * Deliberately strict: a draft from an older shape, another company, or corrupted storage is
 * discarded rather than half-restored. Losing an in-progress count is annoying; resuming one
 * with numbers attached to the wrong parts would be worse.
 */
export function parseDraft(raw: string | null, companyId: string): CountDraft | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<CountDraft>;
    if (parsed.version !== DRAFT_VERSION) return null;
    if (parsed.companyId !== companyId) return null;
    if (typeof parsed.savedAt !== 'number') return null;
    if (!Array.isArray(parsed.partIds)) return null;
    if (!parsed.entries || typeof parsed.entries !== 'object' || Array.isArray(parsed.entries)) {
      return null;
    }
    return parsed as CountDraft;
  } catch {
    return null;
  }
}

/**
 * localStorage, or null where it isn't usable.
 *
 * Absent during SSR, and *also* absent or throwing in private-browsing modes and some
 * embedded webviews — a real runtime case, not just a test artefact. A count must work
 * without a draft; losing resume is a downgrade, not a failure.
 */
export function safeStorage(): Storage | null {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

export function readDraft(companyId: string): CountDraft | null {
  const store = safeStorage();
  if (!store) return null;
  try {
    return parseDraft(store.getItem(draftKey(companyId)), companyId);
  } catch {
    return null;
  }
}

/** Persist a draft. Silent on failure — a full or blocked store must not interrupt counting. */
export function writeDraft(draft: CountDraft): void {
  const store = safeStorage();
  if (!store) return;
  try {
    store.setItem(draftKey(draft.companyId), JSON.stringify(draft));
  } catch {
    /* quota exceeded or blocked — the count continues in memory */
  }
}

export function clearDraft(companyId: string): void {
  const store = safeStorage();
  if (!store) return;
  try {
    store.removeItem(draftKey(companyId));
  } catch {
    /* nothing to clean up */
  }
}
