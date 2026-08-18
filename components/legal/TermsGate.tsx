'use client';

import { useState } from 'react';
import dynamic from 'next/dynamic';
import { usePathname } from 'next/navigation';
import posthog from 'posthog-js';

import { useAuth } from '@/components/providers/AuthProvider';
import { useTermsStatus } from '@/hooks/useTermsStatus';
import { CURRENT_LEGAL_VERSIONS } from '@/lib/legal/manifest';
import { canDefer as canStillDefer, recordDeferral } from '@/lib/termsDeferral';
import { isTermsExempt, termsGateMode } from '@/lib/termsGate';

// Loaded only when someone is actually out of compliance, which is ~nobody on
// ~every page load. Mounting this gate globally is therefore CHEAPER than
// mounting a dialog inside each shell would be — the operator layout in
// particular would have carried it in a 903-line chunk.
const TermsAcceptanceDialog = dynamic(() => import('./TermsAcceptanceDialog'), { ssr: false });

/**
 * The re-acceptance gate. Mounted ONCE, in app/layout.tsx inside AuthProvider.
 *
 * Global rather than per-shell because AuthGuard is mounted in exactly one place
 * and a system-admin-created shop owner passes through /, /launch and
 * /select-company before they ever reach it — three surfaces a dashboard-only
 * mount would miss entirely.
 *
 * IT RENDERS NOTHING WHEN THE CHECK FAILED, and deliberately not a retry screen.
 * Unlike AuthGuard there is nothing the user needs FROM this check, so letting
 * them proceed is correct and the next navigation retries for free. A "Try
 * again" screen here would be a self-inflicted outage on every surface at once.
 * "Couldn't check" is never "denied".
 */
export default function TermsGate() {
  const { user, loading: authLoading } = useAuth();
  const pathname = usePathname();
  const status = useTermsStatus();
  /**
   * The path a deferral was made on, rather than a boolean plus an effect to
   * clear it. A deferral is per-page, not per-session — the operator gets on
   * with the job and meets the prompt again next time they navigate — and
   * deriving that from the current pathname avoids a setState-in-effect, which
   * this repo's lint cap does not have room for and which would fire a
   * cascading render on every navigation.
   */
  const [dismissedOn, setDismissedOn] = useState<string | null>(null);

  if (authLoading || !user) return null;
  if (isTermsExempt(pathname)) return null;
  if (status.state !== 'resolved') return null;
  if (status.needs.length === 0) return null;
  if (dismissedOn === pathname) return null;

  const mode = termsGateMode(pathname);
  const primary = status.needs[0];
  const deferrable = status.needs.every((t) => canStillDefer(t, CURRENT_LEGAL_VERSIONS[t]));

  return (
    <TermsAcceptanceDialog
      needs={status.needs}
      mode={mode}
      canDefer={deferrable}
      onAccepted={() => status.refresh()}
      onDefer={() => {
        for (const t of status.needs) recordDeferral(t, CURRENT_LEGAL_VERSIONS[t].version);
        // Writing localStorage triggers no re-render, so without this the button
        // would do nothing and the operator would be hard-blocked mid-shift.
        setDismissedOn(pathname);
        posthog.capture('terms prompt deferred', {
          is_final_reminder: !canStillDefer(primary, CURRENT_LEGAL_VERSIONS[primary]),
        });
      }}
    />
  );
}
