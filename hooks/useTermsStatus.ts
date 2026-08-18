'use client';

import { useCallback, useEffect, useState } from 'react';

import { useAuth } from '@/components/providers/AuthProvider';
import { fetchAcceptedVersions, documentsNeedingAcceptance } from '@/utils/termsAccess';
import type { LegalDocumentType } from '@/lib/legal/manifest';

/**
 * Whether the signed-in user still owes an agreement.
 *
 * THREE STATES, NEVER A BOOLEAN. `unknown` means the check did not complete —
 * network, cold start, a revoked grant — and it is a distinct answer from "they
 * are compliant". Collapsing it into a boolean is how "couldn't check" quietly
 * becomes a definitive verdict, in whichever direction the default happens to
 * fall. Every variant carries `refresh`, so a caller can re-ask after recording
 * an acceptance without reaching for a second hook.
 */
export type TermsStatus =
  | { state: 'loading'; refresh: () => void }
  | { state: 'unknown'; refresh: () => void }
  | { state: 'resolved'; needs: LegalDocumentType[]; refresh: () => void };

/**
 * The result carries the user it belongs to, so "still loading" and "loaded for
 * a different user" are derived rather than stored. That is what lets the effect
 * touch state ONLY inside its async callbacks — a synchronous setState in an
 * effect body fires a cascading render on every navigation, and this hook is
 * mounted app-wide.
 */
type Result =
  | { userId: string; needs: LegalDocumentType[] }
  | { userId: string; failed: true };

const NONE: LegalDocumentType[] = [];

/**
 * @param enabled Whether the caller could act on the answer. `TermsGate` passes
 *   false on exempt routes.
 *
 *   NOT an optimisation -- it is the fix for a real bug. `TermsGate` has to call
 *   this hook unconditionally, so it used to query on /accept-invite too, BEFORE
 *   the user had agreed. `router.replace` into the dashboard is a client-side
 *   navigation, so the layout never remounts and that pre-acceptance answer
 *   survived onto a route where the gate DOES act on it -- prompting someone who
 *   had just ticked the box, then vanishing on the next reload. Not querying
 *   until the answer can be used, and re-querying on the transition, removes the
 *   staleness at its source rather than having the accept page remember to poke
 *   the gate afterwards.
 */
export function useTermsStatus(enabled = true): TermsStatus {
  const { user, loading: authLoading } = useAuth();
  const [result, setResult] = useState<Result | null>(null);
  const [nonce, setNonce] = useState(0);

  const refresh = useCallback(() => {
    setResult(null);
    setNonce((n) => n + 1);
  }, []);

  useEffect(() => {
    if (!enabled || authLoading || !user) return;
    const userId = user.id;
    let cancelled = false;

    // A plain Supabase read, not an AI call — a lifecycle hook is the right
    // place for it; the CLAUDE.md rule about useEffect concerns calls that cost
    // credits.
    fetchAcceptedVersions(userId)
      .then((rows) => {
        if (!cancelled) setResult({ userId, needs: documentsNeedingAcceptance(rows) });
      })
      .catch(() => {
        // No captureException: this is a .from().select(), which lib/supabase.ts
        // already files with its query attached via the Sentry integration.
        if (!cancelled) setResult({ userId, failed: true });
      });

    return () => {
      cancelled = true;
    };
  }, [user, authLoading, nonce, enabled]);

  // Nothing has been asked, so nothing is known. The gate renders null on
  // 'loading', which is what an exempt route wants anyway.
  if (!enabled) return { state: 'loading', refresh };
  if (authLoading) return { state: 'loading', refresh };
  // Signed out: nothing is owed, and the gate has nothing to do.
  if (!user) return { state: 'resolved', needs: NONE, refresh };
  if (!result || result.userId !== user.id) return { state: 'loading', refresh };
  if ('failed' in result) return { state: 'unknown', refresh };
  return { state: 'resolved', needs: result.needs, refresh };
}
