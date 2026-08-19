/**
 * How often this shop has routed through each work centre.
 *
 * Used to ORDER the station picker, which is the only reason it stays fast at a
 * shop with forty work centres: a shop runs the same six on nearly everything, so
 * putting those first means the common route never scrolls and the search field is
 * for the exception. Alphabetical would be a filing order, not a working one.
 */

import { getSupabase } from '@/lib/supabase';
import { toError } from '@/lib/supabaseErrors';
import * as Sentry from '@sentry/nextjs';

/** Work centre id → how many operations across this company's live parts. */
export async function getWorkCenterUsage(companyId: string): Promise<Map<string, number>> {
  const supabase = getSupabase();
  const { data, error } = await supabase.rpc('work_center_usage', { p_company_id: companyId });

  if (error) {
    // `.rpc()` sits outside the Supabase integration's automatic capture, so this
    // reports itself. Ordering is a nicety — losing it must not cost the picker,
    // so the caller gets an empty map and falls back to ordering by name.
    Sentry.captureException(toError(error, 'work_center_usage'));
    return new Map();
  }

  return new Map((data ?? []).map((row) => [row.work_center_id, Number(row.uses)]));
}
