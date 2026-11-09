import { getServiceRoleClient, jsonResponse, errorResponse, handleCors } from '../_shared/supabase.ts';
import { callerUserId } from '../_shared/caller.ts';

/**
 * Emails the team a piece of in-app feedback.
 *
 * Called by the browser right after it saves the feedback (utils/feedbackAccess.ts), with
 * `{ feedback_id }` and the person's own session as the bearer token. verify_jwt is off
 * (supabase/config.toml), so the function establishes the caller itself, and sends only for
 * feedback that caller wrote in the last few minutes — so the most anyone can do is email the
 * team their own fresh feedback again.
 *
 * It used to be a Database Webhook on `feedback` INSERT, configured only in the prod dashboard.
 * When the project's legacy API keys were disabled (2026-03-11) the webhook's stored key stopped
 * working, and every feedback email failed silently. Now a failed send answers non-2xx and the
 * caller files it to Sentry.
 *
 * Secrets: RESEND_API_KEY (required).
 */

const RESEND_API_URL = 'https://api.resend.com/emails';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** How long after saving a piece of feedback its email may still be asked for. */
const FRESH_MS = 15 * 60 * 1000;

interface FeedbackRecord {
  id: string;
  company_id: string;
  user_id: string;
  page_path: string;
  page_title: string;
  feedback_text: string;
  created_at: string;
}

async function sendEmail(
  apiKey: string,
  { from, to, subject, text }: { from: string; to: string; subject: string; text: string },
): Promise<void> {
  const res = await fetch(RESEND_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ from, to: [to], subject, text }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Resend API error (${res.status}): ${body}`);
  }
}

Deno.serve(async (req: Request) => {
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;
  if (req.method !== 'POST') return errorResponse('Method not allowed', 405);

  const userId = await callerUserId(req.headers.get('Authorization') ?? '');
  if (!userId) return errorResponse('Unauthorized', 401);

  const apiKey = Deno.env.get('RESEND_API_KEY');
  if (!apiKey) {
    console.error('notify-feedback: RESEND_API_KEY is not configured');
    return errorResponse('Email service not configured', 500);
  }

  let feedbackId: unknown;
  try {
    feedbackId = (await req.json())?.feedback_id;
  } catch {
    return errorResponse('Malformed body', 400);
  }
  if (typeof feedbackId !== 'string' || !UUID.test(feedbackId)) {
    return errorResponse('Invalid feedback id', 400);
  }

  const supabase = getServiceRoleClient();
  const { data: feedback, error: readError } = await supabase
    .from('feedback')
    .select('id, company_id, user_id, page_path, page_title, feedback_text, created_at')
    .eq('id', feedbackId)
    .maybeSingle<FeedbackRecord>();
  if (readError) {
    console.error('notify-feedback: read failed', readError);
    return errorResponse('Could not read the feedback', 500);
  }
  // Someone else's feedback answers the same as none at all: nothing to learn by guessing ids.
  if (!feedback || feedback.user_id !== userId) return errorResponse('Feedback not found', 404);
  if (Date.now() - new Date(feedback.created_at).getTime() > FRESH_MS) {
    return errorResponse('Feedback is too old to send', 409);
  }

  const [userResult, companyResult] = await Promise.all([
    supabase.auth.admin.getUserById(userId),
    supabase.from('companies').select('name').eq('id', feedback.company_id).single(),
  ]);
  const userEmail = userResult.data?.user?.email ?? 'unknown';
  const companyName = companyResult.data?.name ?? 'unknown';

  try {
    await sendEmail(apiKey, {
      from: 'Jigged <noreply@jigged.app>',
      // Notify a real, monitored inbox. Was noreply@jigged.app, which Resend
      // suppresses (not a deliverable address). hello@ is an alias today, to
      // become a shared feedback inbox later.
      to: 'hello@jigged.app',
      subject: `Feedback: ${feedback.page_title} — ${companyName}`,
      text: [
        'New in-app feedback:',
        '',
        `Page: ${feedback.page_title} (${feedback.page_path})`,
        `User: ${userEmail}`,
        `Company: ${companyName}`,
        `Submitted: ${feedback.created_at}`,
        '',
        '---',
        '',
        feedback.feedback_text,
      ].join('\n'),
    });
  } catch (err) {
    console.error('notify-feedback: send failed', err);
    return errorResponse(`Email send failed (${String(err)})`, 502);
  }

  return jsonResponse({ message: 'Feedback notification sent' });
});
