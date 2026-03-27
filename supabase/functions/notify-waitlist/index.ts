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
  type: 'INSERT' | 'UPDATE';
  table: string;
  record: WaitlistRecord;
}

async function sendEmail(
  apiKey: string,
  { from, to, subject, text, html }: { from: string; to: string; subject: string; text: string; html?: string },
): Promise<void> {
  const payload: Record<string, unknown> = { from, to: [to], subject, text };
  if (html) payload.html = html;

  const res = await fetch(RESEND_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Resend API error (${res.status}): ${body}`);
  }
}

function buildWelcomeEmailHtml(name: string | null, companyName: string | null): string {
  const greeting = name ? `Hi ${name},` : 'Hi there,';
  const shopText = companyName
    ? `<strong style="color:#ffffff;">${companyName}</strong>`
    : 'your shop';

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0; padding:0; background-color:#111439; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" bgcolor="#111439" style="background-color:#111439; padding:40px 20px;">
    <tr><td align="center">
      <table width="480" cellpadding="0" cellspacing="0" bgcolor="#1a1f4a" style="background-color:#1a1f4a; border:1px solid #2d3260; border-radius:8px; padding:40px;">
        <tr><td align="center" style="padding-bottom:24px;">
          <svg viewBox="0 0 64 64" width="48" height="48" xmlns="http://www.w3.org/2000/svg">
            <rect width="64" height="64" rx="12" fill="#151520"/>
            <rect x="14" y="10" width="30" height="10" rx="2" fill="#D4872A"/>
            <rect x="30" y="10" width="10" height="32" fill="#4682B4"/>
            <path d="M40 42 L40 54 L26 54 Q14 54 14 42 L24 42 Q30 42 30 48 L30 54" fill="#2BBCB3"/>
          </svg>
        </td></tr>
        <tr><td align="center" style="color:#ffffff; font-size:20px; font-weight:600; padding-bottom:16px;">
          Welcome to Jigged
        </td></tr>
        <tr><td align="center" style="color:#B0B3B8; font-size:14px; line-height:1.5; padding-bottom:24px;">
          ${greeting}<br><br>
          Thanks for signing up for ${shopText}. We're setting up your shop now &mdash; you'll get a personal login shortly.
        </td></tr>
        <tr><td align="center" style="color:#B0B3B8; font-size:13px; padding-top:8px;">
          &mdash; Debola from Jigged
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
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

    if ((payload.type !== 'INSERT' && payload.type !== 'UPDATE') || payload.table !== 'waitlist') {
      return jsonResponse({ message: 'Ignored — not a waitlist event' });
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
        html: buildWelcomeEmailHtml(name, company_name),
        text: [
          `Hi ${name || 'there'},`,
          '',
          `Thanks for signing up for ${company_name || 'your shop'}. We're setting up your shop now — you'll get a personal login shortly.`,
          '',
          '— Debola from Jigged',
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
