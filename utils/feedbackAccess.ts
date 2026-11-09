import * as Sentry from '@sentry/nextjs';

import { getEdgeFunctionUrl, getSupabase } from '@/lib/supabase';
import { toError } from '@/lib/supabaseErrors';
import type { TablesInsert } from '@/types/database';

export type NewFeedback = Omit<TablesInsert<'feedback'>, 'id' | 'created_at'>;

/**
 * Save a piece of in-app feedback and return its id.
 *
 * The id is minted here rather than read back: only a company's admins may SELECT its feedback,
 * so for everyone else `.insert().select()` would come back empty — and `notifyFeedback` needs
 * the id to name the row.
 */
export async function createFeedback(input: NewFeedback): Promise<string> {
  const id = crypto.randomUUID();
  const { error } = await getSupabase().from('feedback').insert({ ...input, id });
  if (error) throw error;
  return id;
}

/**
 * Ask `notify-feedback` to email the team this feedback. The function checks the caller wrote it,
 * so it goes with the person's own session.
 *
 * Never throws: the feedback is already saved, so a failed email must not tell the person their
 * feedback failed — but it must not vanish either, which is what the Database Webhook this
 * replaces did. A failure files itself to Sentry here.
 */
export async function notifyFeedback(feedbackId: string): Promise<void> {
  try {
    const {
      data: { session },
    } = await getSupabase().auth.getSession();
    if (!session) throw new Error('No session to send the feedback email with');
    const res = await fetch(getEdgeFunctionUrl('notify-feedback'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify({ feedback_id: feedbackId }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`notify-feedback answered ${res.status}${detail ? `: ${detail.slice(0, 500)}` : ''}`);
    }
  } catch (err) {
    Sentry.captureException(toError(err, 'Feedback notification failed'), {
      tags: { feedback: 'notify_failed' },
    });
  }
}
