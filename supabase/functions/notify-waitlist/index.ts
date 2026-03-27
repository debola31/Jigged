import { jsonResponse, errorResponse, handleCors } from '../_shared/supabase.ts';

const RESEND_API_URL = 'https://api.resend.com/emails';

interface WaitlistRecord {
  id: string;
  email: string;
  name: string | null;
  company_name: string | null;
  shop_size: string | null;
  status: string;
  source: string;
  created_at: string;
}

interface WebhookPayload {
  type: 'INSERT';
  table: string;
  record: WaitlistRecord;
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

    if (payload.type !== 'INSERT' || payload.table !== 'waitlist') {
      return jsonResponse({ message: 'Ignored — not a waitlist insert' });
    }

    const { email, name, company_name, shop_size, source, created_at } = payload.record;

    // Send both emails in parallel
    const results = await Promise.allSettled([
      // Internal notification
      sendEmail(apiKey, {
        from: 'Jigged <noreply@jigged.app>',
        to: 'debola@jigged.app',
        subject: `New signup: ${company_name || 'Unknown'}`,
        text: [
          'New waitlist request:',
          '',
          `Name: ${name || 'Not provided'}`,
          `Email: ${email}`,
          `Company: ${company_name || 'Not provided'}`,
          `Shop Size: ${shop_size || 'Not specified'}`,
          `Source: ${source}`,
          `Submitted: ${created_at}`,
        ].join('\n'),
      }),

      // Confirmation to requester
      sendEmail(apiKey, {
        from: 'Debola from Jigged <noreply@jigged.app>',
        to: email,
        subject: 'We got your request — welcome to Jigged',
        text: [
          `Hi ${name || 'there'},`,
          '',
          `Thanks for signing up for ${company_name || 'your shop'}. We're setting up your shop now — you'll get a personal login shortly.`,
          '',
          '— Debola, Jigged',
        ].join('\n'),
      }),
    ]);

    // Log any failures but don't fail the webhook
    for (const result of results) {
      if (result.status === 'rejected') {
        console.error('Email send failed:', result.reason);
      }
    }

    return jsonResponse({ message: 'Notifications sent' });
  } catch (err) {
    console.error('notify-waitlist error:', err);
    // Return 200 anyway — the row is already inserted, don't retry the webhook
    return jsonResponse({ message: 'Error processing notification', error: String(err) });
  }
});
