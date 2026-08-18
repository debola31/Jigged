import type { LegalDocumentType, LegalVersion } from '@/lib/legal/manifest';

/**
 * The operator grace window: "Remind me later" works for 14 days from the first
 * prompt OR 5 dismissals, whichever comes first, then the prompt blocks.
 *
 * SPLIT BY JOB, because the two halves are doing different work:
 *
 *   * The DEADLINE is the real control, and its floor comes from the manifest's
 *     `enforcement_starts_on` — server-authored, identical for everyone, and
 *     not editable from a phone. That is what makes acceptances actually
 *     converge instead of a cleared browser restarting the clock forever.
 *   * The DISMISSAL BUDGET is a courtesy, not a legal control. It lives in
 *     localStorage and clearing it buys five more taps inside a window the date
 *     has already closed.
 *
 * WHY NOT user_preferences: it is browser-writable (setLastCompany upserts to it
 * straight from the client), so it would be exactly as forgeable as
 * localStorage and cost a round trip. WHY NOT A COLUMN ON terms_acceptances:
 * that table is deliberately unwritable from the browser, so a nag counter
 * would need a second service-role endpoint to maintain a number that does not
 * warrant one. lib/operatorStationStorage.ts is the precedent for device-local
 * on purpose.
 *
 * THE COUNT IS NEVER RENDERED. Across every dismissal the operator sees the same
 * screen and the same button; the only visible change is the escape hatch
 * disappearing at the end. A disappearing affordance is not a read-back of
 * someone's behaviour — a number would be, and that is forbidden on operator
 * surfaces.
 */

export const MAX_DEFERRALS = 5;
export const GRACE_DAYS = 14;

const KEY_PREFIX = 'jigged.terms.deferrals';

function key(type: LegalDocumentType, version: number): string {
  return `${KEY_PREFIX}.${type}.${version}`;
}

interface DeferralState {
  count: number;
  firstPromptedAt: string;
}

function read(type: LegalDocumentType, version: number): DeferralState | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(key(type, version));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<DeferralState>;
    if (typeof parsed.count !== 'number' || typeof parsed.firstPromptedAt !== 'string') return null;
    return { count: parsed.count, firstPromptedAt: parsed.firstPromptedAt };
  } catch {
    return null;
  }
}

export function recordDeferral(type: LegalDocumentType, version: number, now = new Date()): void {
  if (typeof window === 'undefined') return;
  const existing = read(type, version);
  const next: DeferralState = {
    count: (existing?.count ?? 0) + 1,
    firstPromptedAt: existing?.firstPromptedAt ?? now.toISOString(),
  };
  try {
    window.localStorage.setItem(key(type, version), JSON.stringify(next));
  } catch {
    // A phone with storage disabled simply gets no grace. Failing toward
    // "prompt again" is the safe direction.
  }
}

/**
 * The deadline for a version: 14 days after the EARLIER of the platform's
 * enforcement date and this device's first prompt.
 *
 * Earlier, not later — a device that first sees the prompt months after the
 * version shipped must not be handed a fresh 14 days, or clearing storage would
 * extend the window indefinitely.
 */
export function deferralDeadline(entry: LegalVersion, firstPromptedAt?: string): Date {
  const platform = new Date(`${entry.enforcement_starts_on}T00:00:00Z`).getTime();
  const device = firstPromptedAt ? new Date(firstPromptedAt).getTime() : Number.POSITIVE_INFINITY;
  const start = Math.min(platform, Number.isNaN(device) ? Number.POSITIVE_INFINITY : device);
  return new Date(start + GRACE_DAYS * 24 * 60 * 60 * 1000);
}

/** Whether "Remind me later" should still be offered. */
export function canDefer(
  type: LegalDocumentType,
  entry: LegalVersion,
  now = new Date(),
): boolean {
  const state = read(type, entry.version);
  if ((state?.count ?? 0) >= MAX_DEFERRALS) return false;
  return now.getTime() < deferralDeadline(entry, state?.firstPromptedAt).getTime();
}
