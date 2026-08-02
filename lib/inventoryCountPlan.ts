/**
 * Count sheet — pure logic. No Supabase, no React; everything here is unit-tested directly.
 *
 * Mirrors the split in lib/dataImportIngest.ts: the decisions live in pure functions, and the
 * thin network driver (utils/inventoryCountAccess.ts) only walks the plan and reports progress.
 */

import type {
  CountCandidate,
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
  balances: LocationBalance[],
  unassigned: { id: string; name: string } | null,
): CountTarget {
  // The `aggregate` arm is gone with `is_location_tracked` (20260802015837). It existed for a
  // part whose stock lived in `parts.quantity` alone; no such part remains.
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

/**
 * The delta for one row, or null when it hasn't been counted.
 *
 * Used for the inline feedback that replaced the separate review page — the number appears on
 * the row the moment it's typed, which is when it's actually useful.
 */
/**
 * The key a counted number is stored under.
 *
 * **Not the part id.** A sheet can hold the same part more than once — that is the whole point of
 * counting a part across every place it sits in, where BUY-ORING-214 appears for Shelf A and again
 * for Shelf B. Keying by part alone made those two rows share one number, so typing 828 for Shelf A
 * silently wrote 828 to Shelf B as well and committed both.
 *
 * An `aggregate` row has no place, so the part id IS its identity. An `excluded` row is never
 * counted, and falls through to the same shape harmlessly.
 */
export function countRowKey(candidate: CountCandidate): string {
  return candidate.target.kind === 'location'
    ? `${candidate.partId}::${candidate.target.locationId}`
    : candidate.partId;
}

export function rowDelta(candidate: CountCandidate, entries: CountEntries): number | null {
  const counted = entries[countRowKey(candidate)];
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
    const key = countRowKey(candidate);
    const counted = entries[key];
    if (counted === undefined) continue;
    if (candidate.target.kind === 'excluded') continue;

    const delta = counted - candidate.systemQuantity;
    const opened = openedWith.get(key);
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

// ── Draft persistence: REMOVED 2026-08-01 ────────────────────────────────────
//
// The whole feature is gone — `DRAFT_VERSION`, `draftKey`, `buildDraft`, `parseDraft`,
// `safeStorage`, `readDraft`, `writeDraft`, `clearDraft` and the `CountDraft` type.
//
// Founder's call, verbatim: "we should remove this unfinished counting feature — it only proves
// annoying, if a user moves away from the page that's them discarding the operation and doing
// something else."
//
// That reading is right, and the code had been arguing with it for a while. Navigating away is a
// deliberate act; treating it as an accident meant the next count opened with an interruption
// asking about a decision the user had already made. The banner also could not be trusted at
// face value — a place-scoped count had to be excluded from writing a draft at all, because the
// key was company-wide and the resume prompt lived only on the company-wide branch, so an
// abandoned Shelf A count would have come back as a company-wide one and committed a wildly
// wrong adjustment. That guard is gone with the feature it was guarding.
//
// If resume is ever wanted again it should be a real count SESSION on the server — something you
// can assign, hand over and pick up on another device — not a browser-local snapshot keyed by
// company. localStorage was never the right home for work that two people might share.
