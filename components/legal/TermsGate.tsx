'use client';

import dynamic from 'next/dynamic';
import { usePathname } from 'next/navigation';

import { useAuth } from '@/components/providers/AuthProvider';
import { useTermsStatus } from '@/hooks/useTermsStatus';
import { isTermsExempt, termsSurface } from '@/lib/termsGate';

// Loaded only when someone is actually out of compliance, which is ~nobody on
// ~every page load. Mounting this gate globally is therefore CHEAPER than
// mounting a dialog inside each shell would be -- the operator layout in
// particular would have carried it in a 903-line chunk.
const TermsAcceptanceDialog = dynamic(() => import('./TermsAcceptanceDialog'), { ssr: false });

/**
 * The re-acceptance gate. Mounted ONCE, in app/layout.tsx inside AuthProvider.
 *
 * Global rather than per-shell because AuthGuard is mounted in exactly one place
 * and a system-admin-created shop owner passes through /, /launch and
 * /select-company before they ever reach it -- three surfaces a dashboard-only
 * mount would miss entirely.
 *
 * UNIVERSAL AND BLOCKING. There is no "remind me later" and no grace window.
 * Deferral was built to spare the shop floor an interruption and did the
 * opposite: it did not remove the prompt, it repeated it -- up to five times,
 * then blocked anyway. One checkbox, once per published version (expected
 * roughly annually), is strictly less friction than that. Deleting it also
 * removed the only browser-writable state in a feature whose whole premise is
 * that the browser cannot influence the record.
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

  // Do not even ask on a route the gate cannot act on. Beyond saving a query on
  // every marketing and login page, this is what stops a pre-acceptance answer
  // fetched on /accept-invite being reused on the dashboard the user is
  // redirected to -- see the note on useTermsStatus.
  const exempt = isTermsExempt(pathname);
  const status = useTermsStatus(!exempt);

  if (authLoading || !user) return null;
  if (exempt) return null;
  if (status.state !== 'resolved') return null;
  if (status.needs.length === 0) return null;

  return (
    <TermsAcceptanceDialog
      needs={status.needs}
      surface={termsSurface(pathname)}
      onAccepted={() => status.refresh()}
    />
  );
}
