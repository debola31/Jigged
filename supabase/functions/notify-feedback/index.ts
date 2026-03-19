import { getServiceRoleClient, jsonResponse, errorResponse, handleCors } from '../_shared/supabase.ts';

const RESEND_API_URL = 'https://api.resend.com/emails';

interface FeedbackPayload {
  user_id: string;
  company_id: string;
  page_title: string;
  page_path: string;
  feedback_text: string;
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

    const payload: FeedbackPayload = await req.json();
    const { user_id, company_id, page_title, page_path, feedback_text } = payload;

    if (!user_id || !company_id || !feedback_text) {
      return errorResponse('Missing required fields', 400);
    }

    // Look up user email and company name for the notification
    const supabase = getServiceRoleClient();

    const [userResult, companyResult] = await Promise.all([
      supabase.auth.admin.getUserById(user_id),
      supabase.from('companies').select('name').eq('id', company_id).single(),
    ]);

    const userEmail = userResult.data?.user?.email ?? 'unknown';
    const companyName = companyResult.data?.name ?? 'unknown';

    await sendEmail(apiKey, {
      from: 'Jigged <hello@jigged.app>',
      to: 'hello@jigged.app',
      subject: `Feedback: ${page_title} — ${companyName}`,
      text: [
        'New in-app feedback:',
        '',
        `Page: ${page_title} (${page_path})`,
        `User: ${userEmail}`,
        `Company: ${companyName}`,
        '',
        '---',
        '',
        feedback_text,
      ].join('\n'),
    });

    return jsonResponse({ message: 'Feedback notification sent' });
  } catch (err) {
    console.error('notify-feedback error:', err);
    return errorResponse('Failed to send notification', 500);
  }
});
