/**
 * Count sheet — pure logic. No Supabase, no React; everything here is unit-tested directly.
 *
 * Mirrors the split in lib/dataImportIngest.ts: the decisions live in pure functions, and the
 * thin network driver (utils/inventoryCountAccess.ts) only walks the plan and reports progress.
 */

import type {
  CountCandidate,
  CountDraft,
  CountLine,
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
 * The rules, and why each exists:
 *
 *  - **Untracked** → `parts.quantity` directly. The only legal write for a part whose
 *    quantity isn't a rollup.
 *  - **Tracked, nothing anywhere** → Unassigned. This is the opening-count case, not an edge
 *    case: `trg_auto_track_stocked_part` seeds every stocked part at Unassigned with 0, so a
 *    shop starting from zero has every part here. Unassigned is also the honest target — you
 *    counted the stock, you haven't said where it lives.
 *  - **Tracked, exactly one location holding stock** → that location. Unambiguous.
 *  - **Tracked, two or more** → excluded. Counting "38 total" against 10+20+10 has no
 *    defensible bin to absorb the difference, and pushing it to Unassigned would corrupt
 *    bin-level accuracy — the one part of the locations build that works today.
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

  return {
    kind: 'excluded',
    reason: `Stock is split across ${holding.length} locations — count this at its locations.`,
  };
}

/** Candidates that can actually be counted item-by-item. */
export function countableCandidates(candidates: CountCandidate[]): CountCandidate[] {
  return candidates.filter((c) => c.target.kind !== 'excluded');
}

/** Candidates held back, so the scope step can name them instead of dropping them silently. */
export function excludedCandidates(candidates: CountCandidate[]): CountCandidate[] {
  return candidates.filter((c) => c.target.kind === 'excluded');
}

/** How many lines carry a number. Drives the "18 of 40 counted" header. */
export function countedTally(lines: CountLine[]): { counted: number; total: number } {
  return { counted: lines.filter((l) => l.counted !== null).length, total: lines.length };
}

/**
 * Variances for the counted lines only, against **freshly read** system quantities.
 *
 * `openedWith` is what the sheet showed when it was started; a line whose current system
 * quantity differs moved while the count was open, which is worth flagging even though the
 * commit is unaffected (adjust sets an absolute value).
 */
export function buildVariances(
  candidates: CountCandidate[],
  lines: CountLine[],
  openedWith: Map<string, number>,
): CountVariance[] {
  const byId = new Map(candidates.map((c) => [c.partId, c]));
  const out: CountVariance[] = [];

  for (const line of lines) {
    if (line.counted === null) continue;
    const candidate = byId.get(line.partId);
    if (!candidate || candidate.target.kind === 'excluded') continue;

    const delta = line.counted - candidate.systemQuantity;
    const opened = openedWith.get(line.partId);
    out.push({
      candidate,
      counted: line.counted,
      delta,
      movedSinceOpened: opened !== undefined && opened !== candidate.systemQuantity,
      magnitude:
        candidate.systemQuantity === 0
          ? line.counted === 0
            ? 0
            : 1
          : Math.abs(delta) / candidate.systemQuantity,
    });
  }
  return out;
}

/** Variances that change something. A line counted equal to the system needs no write. */
export function committableVariances(variances: CountVariance[]): CountVariance[] {
  return variances.filter((v) => v.delta !== 0);
}

/**
 * Lines worth a second look before committing.
 *
 * ~30% of large variances turn out to be count errors rather than real movement, so a
 * confirm on the big ones catches more than a blanket review gate would — and costs nothing
 * on the routine ones.
 */
export const BIG_VARIANCE_THRESHOLD = 0.5;

export function bigVariances(variances: CountVariance[]): CountVariance[] {
  return committableVariances(variances).filter((v) => v.magnitude >= BIG_VARIANCE_THRESHOLD);
}

/** Note recorded on each adjustment, so the ledger says where the number came from. */
export function countNote(v: CountVariance): string {
  const unit = v.candidate.unit;
  return `Stock count — counted ${v.counted} ${unit} (system said ${v.candidate.systemQuantity} ${unit})`;
}

// ── Draft persistence (shape only; the storage call sites live in the page) ──────────────

export const DRAFT_VERSION = 1 as const;

export function draftKey(companyId: string): string {
  return `jigged.inventoryCount.${companyId}`;
}

/**
 * localStorage, or null where it isn't usable.
 *
 * Absent during SSR, and *also* absent or throwing in private-browsing modes and some
 * embedded webviews — so this is a real runtime case, not just a test artefact. A count must
 * work without a draft; losing resume is a downgrade, not a failure.
 */
export function safeStorage(): Storage | null {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

/** Read a stored draft, tolerating storage being unavailable or unreadable. */
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

/** Drop a draft once its counts are committed, or when explicitly discarded. */
export function clearDraft(companyId: string): void {
  const store = safeStorage();
  if (!store) return;
  try {
    store.removeItem(draftKey(companyId));
  } catch {
    /* nothing to clean up */
  }
}

export function buildDraft(companyId: string, partIds: string[], lines: CountLine[], now: number): CountDraft {
  return { version: DRAFT_VERSION, companyId, partIds, lines, savedAt: now };
}

/**
 * Parse a stored draft, returning null for anything unusable.
 *
 * Deliberately strict: a draft from an older shape, another company, or corrupted storage is
 * discarded rather than half-restored. Losing an in-progress count is annoying; resuming one
 * with lines silently mismatched to the wrong parts would be worse.
 */
export function parseDraft(raw: string | null, companyId: string): CountDraft | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<CountDraft>;
    if (parsed.version !== DRAFT_VERSION) return null;
    if (parsed.companyId !== companyId) return null;
    if (!Array.isArray(parsed.partIds) || !Array.isArray(parsed.lines)) return null;
    if (typeof parsed.savedAt !== 'number') return null;
    return parsed as CountDraft;
  } catch {
    return null;
  }
}
