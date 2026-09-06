/**
 * Count sheet — pure logic. No Supabase, no React; everything here is unit-tested directly.
 *
 * Mirrors the split in lib/dataImportIngest.ts: the decisions live in pure functions, and the
 * thin network driver (utils/inventoryCountAccess.ts) only walks the plan and reports progress.
 */

import { compareLocationNames } from '@/lib/locationTree';
import type {
  CountCandidate,
  CountEntries,
  CountVariance,
} from '@/types/inventoryCount';

/**
 * The place a part is counted at when it holds stock **nowhere**.
 *
 * This is all that survives of `resolveCountTarget`, which used to pick one target per part from
 * four arms. Three of them are gone: `aggregate` with `is_location_tracked` (20260802015837), and
 * both `excluded` arms with the sheet's move to one row per place. What remains is a single
 * decision — where does a part with no stock anywhere get counted? — and the answer is the
 * company's system bucket.
 *
 * **This is the opening count, not an edge case.** `trg_auto_track_stocked_part` seeds every
 * stocked part at `Unassigned` with 0, so a shop counting for the first time has its entire
 * catalogue here. It is also the most valuable count there is: *the system says zero and I am
 * holding twelve*. A rule that emitted rows only for places with stock would delete exactly that.
 *
 * Resolved by `kind`, not by the literal name "Unassigned": `isReservedKind` stops anyone typing
 * `system` into a location's kind, while nothing stops them renaming one.
 */
export function resolveFallbackPlace(
  locations: { id: string; name: string; kind: string | null }[],
): { id: string; name: string } {
  const system = locations.find((l) => l.kind === 'system');
  if (!system) {
    // Not a fallback and not a silent drop. Every company has had a system bucket since
    // 20260802015837 created one for all of them and asserted it, so its absence is a real data
    // fault — and dropping the part from the sheet would hide it behind a shorter list nobody
    // counts. Fail loudly enough to diagnose.
    throw new Error(
      'This company has no "Unassigned" location, so there is nowhere to record a count for a part that is not on a shelf. This is a data fault — please report it.',
    );
  }
  return { id: system.id, name: system.name };
}

/**
 * A part and every row of it on this sheet.
 *
 * The unit the PICKER works in and the unit the sheet groups by. Ticking a part means "count this
 * part wherever it is", which keeps the picker one-row-per-part — the list is unbounded,
 * unvirtualised and client-filtered, and multiplying it by places-per-part would have cost a lot
 * and bought nothing: nobody chooses a *shelf* when deciding which parts to walk.
 */
export interface CountGroup {
  partId: string;
  partName: string;
  description: string | null;
  unit: string;
  /** Sorted by `target.locationPath`, so the sheet's row order is a stable route round the shop. */
  rows: CountCandidate[];
  /** Σ of the rows' system quantities — the shop-wide figure, shown read-only on the header. */
  total: number;
}

/**
 * Group rows by part, preserving a deterministic order.
 *
 * Sorted by part name, and **within a part by place path** — the page used to sort on part name
 * alone, which for several rows of one part is a tie, so their order fell out of `Array.sort`'s
 * stability and changed between visits. On a walk-the-shop task the row order is the route.
 */
export function groupByPart(candidates: CountCandidate[]): CountGroup[] {
  const byPart = new Map<string, CountGroup>();

  for (const c of candidates) {
    const g = byPart.get(c.partId);
    if (g) {
      g.rows.push(c);
      g.total += c.systemQuantity;
    } else {
      byPart.set(c.partId, {
        partId: c.partId,
        partName: c.partName,
        description: c.description,
        unit: c.unit,
        rows: [c],
        total: c.systemQuantity,
      });
    }
  }

  const groups = [...byPart.values()];
  for (const g of groups) {
    g.rows.sort((x, y) => compareLocationNames(x.target.locationPath, y.target.locationPath));
  }
  return groups.sort((a, b) => a.partName.localeCompare(b.partName));
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
 * Unconditional since every row has a place. The `partId`-only branch that used to serve the
 * placeless `aggregate` and `excluded` rows is deliberately not kept "just in case": a second key
 * format nobody produces is an invitation to reintroduce the exact bug the key was created to fix.
 *
 * **The lot joined the key in 2026-09**, on the same argument one level down: a lot-tracked part
 * holding two heats in one bin is two rows, and keyed by (part, place) they shared a number — so
 * typing 8 for heat 4471 would have committed 8 to heat 8823 as well, which is precisely the
 * 828-to-both-shelves bug this key was created to end. `none` for an untracked part, which has
 * exactly one row per place and so cannot collide with itself.
 */
export function countRowKey(candidate: CountCandidate): string {
  return `${candidate.partId}::${candidate.target.locationId}::${candidate.lotId ?? 'none'}`;
}

/**
 * The same key WITHOUT the place — one balance row of `part_location_stock`.
 *
 * What `readPlaceBalances` is keyed by, and what any form standing at a single bin keys its typed
 * numbers by. The place is dropped because it is already fixed: every row shares it, so including
 * it would be a constant repeated down the map.
 *
 * Two callers, one definition, deliberately. Written out by hand in either place it would be two
 * string formats that agree until someone changes one, and a disagreement here does not throw — it
 * silently reads back "not counted" for a row that was counted.
 */
export function refreshedKey(partId: string, lotId: string | null): string {
  return `${partId}::${lotId ?? 'none'}`;
}

/**
 * How a row names its heat, or null when the part is not tracked.
 *
 * The counterpart to `countRowKey`: the key stops two heats sharing a number, and this stops them
 * sharing a LABEL. Keyed apart but rendered identically, a sheet showing "1.25″ 4140 BAR · Rack 2"
 * twice with different Recorded figures is a worse trap than the collision was — two controls, no
 * way to tell which bar either is about, and no reason to believe the numbers are not a duplicate.
 *
 * Falls back to the lot code, which is what a lot minted for untagged material carries. A
 * tracked row always has one of the two, so this returns null only for an untracked part.
 */
export function rowHeatLabel(candidate: {
  lotId: string | null;
  lotCode: string | null;
  heatNumber: string | null;
}): string | null {
  if (!candidate.lotId) return null;
  return candidate.heatNumber ? `Heat ${candidate.heatNumber}` : (candidate.lotCode ?? null);
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

/**
 * A part counted at several places where stock moved between them while you were counting.
 *
 * ## The failure this exists to stop (#656)
 *
 * A sheet holds one part at Shelf A (40) and Shelf B (12).
 *
 *  1. You walk to Shelf A, find 40, type 40. True.
 *  2. A coworker transfers 6 from A to B. Also legitimate. The truth is now A=34, B=18.
 *  3. You walk to Shelf B, find 18, type 18. Also true.
 *  4. Save. Shelf B's delta is zero, so `committableVariances` drops it. Shelf A writes **40
 *     absolutely** — putting back six units that have legitimately left. Total 58; truth 52.
 *
 * Neither count was wrong. The *pair* is, because an absolute write replays a once-true
 * observation over a movement that happened after it.
 *
 * ## Why it is scoped this narrowly
 *
 * For a part on ONE row the existing rule is right and is left alone: the count is what is on the
 * shelf, so a mid-count movement changes nothing about what to save, and it is reported after the
 * fact rather than asked about. What makes the multi-row case different is that the rows are not
 * independent observations — a transfer between two of them moves the same stock twice.
 *
 * ## Feed it EVERY counted line
 *
 * Not `committableVariances(...)`. The zero-delta line is exactly the half that reveals the
 * problem, and that is the half `committableVariances` discards.
 */
export function contestedParts(variances: CountVariance[]): CountVariance[][] {
  const byPart = new Map<string, CountVariance[]>();
  for (const v of variances) {
    const list = byPart.get(v.candidate.partId) ?? [];
    list.push(v);
    byPart.set(v.candidate.partId, list);
  }
  return [...byPart.values()].filter(
    (rows) => rows.length > 1 && rows.some((v) => v.movedSinceOpened),
  );
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
  // The place is named because one part can now be counted at several of them in one session, and
  // the ledger would otherwise carry three notes about one part each quoting a different "recorded
  // as" figure — which reads as three contradictory statements rather than three shelves.
  //
  // The heat is named for the same reason one level down: two heats of one bar counted in one bin
  // write two adjustment rows against the same part at the same place, and without the heat the
  // bin's history shows "set to 8" and "set to 4" about what looks like one pile of material.
  const heat = rowHeatLabel(v.candidate);
  const where = heat
    ? `${v.candidate.target.locationPath} (${heat.toLowerCase()})`
    : v.candidate.target.locationPath;
  return `Inventory count at ${where} — counted ${v.counted} ${unit} (recorded as ${v.candidate.systemQuantity} ${unit})`;
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
