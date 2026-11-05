import { createHmac } from 'crypto';
import { createClient } from '@supabase/supabase-js';
import * as Sentry from '@sentry/nextjs';

import { toError } from '@/lib/supabaseErrors';
import type { Database } from '@/types/database';

/**
 * Server-only half of the showcase pilot request: imported by `app/pilot-requests/**` and never
 * by the form, since it holds the service-role key and node's `crypto`.
 *
 * WHY NEXT ROUTE HANDLERS (architecture.md §8.1). None of the four FastAPI criteria applies:
 * no AI, no `auth.admin.*`, no multi-step transaction, no inbound webhook. What it needs is a
 * service-role write, which §8.1 places in a Route Handler (`app/legal/accept/route.ts`), plus
 * the platform-observed client address for the rate limit, which `lib/clientIp.ts` already
 * resolves for Vercel. Route Handlers rather than a server action because the visitor's tab may
 * sit through a deploy during a 50 MB upload, and a server action's id dies with the build that
 * minted it (lib/serverActionSkew.ts); a URL does not.
 */

/** A day, the window both limits count over. */
export const PILOT_RATE_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Requests per window. Rows count whether or not the upload finished, because an unfinished
 * request still minted an upload URL — that is the resource being protected.
 */
export const PILOT_RATE_LIMITS = {
  perEmail: 3,
  /** Higher than per-email: one shop's office shares an address. */
  perIp: 5,
} as const;

export function pilotServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) throw new Error('Supabase service credentials are not configured');
  const client = createClient<Database>(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  // A failed table read or write files itself, query attached (docs/telemetry.md). Storage and
  // fetch failures are not covered and are captured by hand at their call sites.
  Sentry.instrumentSupabaseClient(client);
  return client;
}

/**
 * The address as a keyed hash, so the rate limit can match it without the table ever holding it.
 * Keyed with the service secret because an unkeyed SHA-256 of an IPv4 address is reversed by
 * trying all four billion. Rotating that secret only restarts everyone's window.
 */
export function hashClientIp(ip: string | null): string | null {
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!ip || !key) return null;
  return createHmac('sha256', key).update(ip).digest('hex');
}

/**
 * Ask `notify-pilot-request` to email the team. Never throws: the request is already saved, so a
 * failed email must not turn the visitor's "done" into an error — but it must not vanish either,
 * which is why it reports here. The Edge Function's own console only reaches Supabase's logs.
 *
 * It sends no credentials. The function trusts nothing in the call but the id: it re-reads the
 * row and claims `notified_at` itself, so the most any caller can do is cause the one email a
 * finished request was owed anyway.
 */
export async function notifyPilotRequest(requestId: string): Promise<void> {
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL;
  try {
    if (!base) throw new Error('NEXT_PUBLIC_SUPABASE_URL is not configured');
    const res = await fetch(`${base}/functions/v1/notify-pilot-request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ request_id: requestId }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`notify-pilot-request answered ${res.status}`);
  } catch (err) {
    Sentry.captureException(toError(err, 'Pilot request notification failed'), {
      tags: { pilot_request: 'notify_failed' },
      extra: { request_id: requestId },
    });
  }
}
