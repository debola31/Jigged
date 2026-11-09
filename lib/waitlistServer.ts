import * as Sentry from '@sentry/nextjs';

import { toError } from '@/lib/supabaseErrors';
import type { Tables } from '@/types/database';

/** The saved row's fields notify-waitlist words its emails from. */
export type WaitlistNotifyRecord = Pick<
  Tables<'waitlist'>,
  'email' | 'name' | 'company_name' | 'shop_size' | 'source' | 'created_at'
>;

/**
 * Ask `notify-waitlist` to send a sign-up's two emails: the team's heads-up and the visitor's
 * confirmation. Server-only — it sends the project's secret key, the one credential that function
 * accepts (supabase/functions/notify-waitlist/index.ts).
 *
 * Never throws: the sign-up is already saved, so a failed email must not turn the visitor's
 * "you're in" into an error — but it must not vanish either, which is what the Database Webhook
 * this replaces did for eight months. A failure files itself to Sentry here.
 */
export async function notifyWaitlist(record: WaitlistNotifyRecord): Promise<void> {
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  try {
    if (!base || !key) throw new Error('Supabase service credentials are not configured');
    const res = await fetch(`${base}/functions/v1/notify-waitlist`, {
      method: 'POST',
      // `apikey`, not `Authorization: Bearer`: Supabase refuses an sb_secret_ key as a bearer token.
      headers: { 'Content-Type': 'application/json', apikey: key },
      body: JSON.stringify({ record }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`notify-waitlist answered ${res.status}${detail ? `: ${detail.slice(0, 500)}` : ''}`);
    }
  } catch (err) {
    // Shape only: the source, never the address or the name.
    Sentry.captureException(toError(err, 'Waitlist notification failed'), {
      tags: { waitlist: 'notify_failed', waitlist_source: record.source },
    });
  }
}
