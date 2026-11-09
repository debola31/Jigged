import { getServiceRoleClient, jsonResponse, errorResponse, handleCors } from '../_shared/supabase.ts';
import { getEmailFrom, getNotifyEmail } from '../_shared/email.ts';

/**
 * Emails the team when a showcase pilot request's file has landed.
 *
 * Called by POST /pilot-requests/complete (app/pilot-requests/complete/route.ts) with
 * `{ request_id }`, once the server has confirmed the object is in the bucket. NOT a Database
 * Webhook: those lived only in the prod dashboard, so nothing in the repo showed they existed, and
 * their failures only reached Supabase's logs — notify-waitlist's and notify-feedback's failed
 * silently for eight months before they were replaced by calls from the app
 * (20261109194121_drop_waitlist_feedback_webhooks.sql). Here the trigger is code, and a failed
 * send comes back as a non-2xx that the caller reports to Sentry.
 *
 * verify_jwt is off (supabase/config.toml) and the caller sends no credentials, so this trusts
 * nothing in the request except the id. It re-reads the row and CLAIMS it —
 * `UPDATE ... SET notified_at = now() WHERE uploaded_at IS NOT NULL AND notified_at IS NULL` — so
 * an unknown id, an unfinished upload or a repeat call sends nothing. The email goes only to
 * JIGGED_NOTIFY_EMAIL, never to the visitor: a confirmation to whatever address was typed would
 * let the form mail anyone.
 *
 * Secrets: RESEND_API_KEY and JIGGED_NOTIFY_EMAIL (required), JIGGED_FROM_EMAIL (optional).
 */

const RESEND_API_URL = 'https://api.resend.com/emails';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BUCKET = 'pilot-requests';

interface PilotRequestRow {
  id: string;
  email: string;
  name: string | null;
  company_name: string | null;
  note: string | null;
  file_name: string;
  file_type: string;
  file_size_bytes: number;
  storage_path: string;
  created_at: string;
}

const FILE_TYPE_LABELS: Record<string, string> = {
  step: 'STEP',
  iges: 'IGES',
  parasolid: 'Parasolid',
  solidworks: 'SolidWorks part',
  pdf: 'PDF drawing',
};

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Visitor text in a subject line: one line, bounded. */
function oneLine(value: string, max: number): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, max);
}

function buildText(row: PilotRequestRow): string {
  return [
    'New pilot request from the showcase page.',
    '',
    `Email: ${row.email}`,
    `Name: ${row.name ?? 'Not provided'}`,
    `Company: ${row.company_name ?? 'Not provided'}`,
    `Submitted: ${row.created_at}`,
    '',
    `File: ${row.file_name} (${FILE_TYPE_LABELS[row.file_type] ?? row.file_type}, ${formatBytes(row.file_size_bytes)})`,
    `Storage: ${BUCKET}/${row.storage_path}`,
    `Request id: ${row.id}`,
    '',
    'Note:',
    row.note ?? '(none)',
    '',
    '---',
    'Reply to this email to reach them. The file is in the private pilot-requests bucket',
    '(Supabase dashboard, Storage). The form promised: only the Jigged team opens it, it is',
    'used only for their walkthrough, and it is deleted when they ask. To delete: remove the',
    'object above and the pilot_requests row with this id.',
  ].join('\n');
}

Deno.serve(async (req: Request) => {
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;
  if (req.method !== 'POST') return errorResponse('Method not allowed', 405);

  const apiKey = Deno.env.get('RESEND_API_KEY');
  const to = getNotifyEmail();
  if (!apiKey || !to) {
    console.error('notify-pilot-request: RESEND_API_KEY or JIGGED_NOTIFY_EMAIL is not configured');
    return errorResponse('Email service not configured', 500);
  }

  let requestId: unknown;
  try {
    requestId = (await req.json())?.request_id;
  } catch {
    return errorResponse('Malformed body', 400);
  }
  if (typeof requestId !== 'string' || !UUID.test(requestId)) {
    return errorResponse('Invalid request id', 400);
  }

  const supabase = getServiceRoleClient();
  const { data: row, error: claimError } = await supabase
    .from('pilot_requests')
    .update({ notified_at: new Date().toISOString() })
    .eq('id', requestId)
    .not('uploaded_at', 'is', null)
    .is('notified_at', null)
    .select('id, email, name, company_name, note, file_name, file_type, file_size_bytes, storage_path, created_at')
    .maybeSingle<PilotRequestRow>();

  if (claimError) {
    console.error('notify-pilot-request: claim failed', claimError);
    return errorResponse('Could not read the request', 500);
  }
  if (!row) return jsonResponse({ message: 'Nothing to send' });

  const res = await fetch(RESEND_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      from: getEmailFrom(),
      to: [to],
      reply_to: row.email,
      subject: `Pilot request: ${oneLine(row.company_name ?? row.name ?? row.email, 80)}`,
      text: buildText(row),
    }),
  });

  if (!res.ok) {
    console.error(`notify-pilot-request: Resend API error (${res.status}): ${await res.text()}`);
    // Release the claim so a later call can still send it; the row must not read "notified" for
    // an email that never went.
    await supabase.from('pilot_requests').update({ notified_at: null }).eq('id', requestId);
    return errorResponse('Email send failed', 502);
  }

  return jsonResponse({ message: 'Notification sent' });
});
