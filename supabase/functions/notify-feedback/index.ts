import { getServiceRoleClient, jsonResponse, errorResponse, handleCors } from '../_shared/supabase.ts';

const RESEND_API_URL = 'https://api.resend.com/emails';

interface FeedbackRecord {
  id: string;
  company_id: string;
  user_id: string;
  page_path: string;
  page_title: string;
  feedback_text: string;
  created_at: string;
}

interface WebhookPayload {
  type: 'INSERT';
  table: string;
  record: FeedbackRecord;
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

  try {
    const apiKey = Deno.env.get('RESEND_API_KEY');
    if (!apiKey) {
      console.error('RESEND_API_KEY not configured');
      return errorResponse('Email service not configured', 500);
    }

    const payload: WebhookPayload = await req.json();

    if (payload.type !== 'INSERT' || payload.table !== 'feedback') {
      return jsonResponse({ message: 'Ignored — not a feedback insert' });
    }

    const { user_id, company_id, page_title, page_path, feedback_text, created_at } = payload.record;

    // Look up user email and company name for the notification
    const supabase = getServiceRoleClient();

    const [userResult, companyResult] = await Promise.all([
      supabase.auth.admin.getUserById(user_id),
      supabase.from('companies').select('name').eq('id', company_id).single(),
    ]);

    const userEmail = userResult.data?.user?.email ?? 'unknown';
    const companyName = companyResult.data?.name ?? 'unknown';

    await sendEmail(apiKey, {
      from: 'Jigged <noreply@jigged.app>',
      // Notify a real, monitored inbox. Was noreply@jigged.app, which Resend
      // suppresses (not a deliverable address). hello@ is an alias today, to
      // become a shared feedback inbox later.
      to: 'hello@jigged.app',
      subject: `Feedback: ${page_title} — ${companyName}`,
      text: [
        'New in-app feedback:',
        '',
        `Page: ${page_title} (${page_path})`,
        `User: ${userEmail}`,
        `Company: ${companyName}`,
        `Submitted: ${created_at}`,
        '',
        '---',
        '',
        feedback_text,
      ].join('\n'),
    });

    return jsonResponse({ message: 'Feedback notification sent' });
  } catch (err) {
    console.error('notify-feedback error:', err);
    // Return 200 anyway — the row is already inserted, don't retry the webhook
    return jsonResponse({ message: 'Error processing notification', error: String(err) });
  }
});
