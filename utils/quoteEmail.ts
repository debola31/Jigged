import { getSupabase } from '@/lib/supabase';
import { API_BASE_URL } from '@/lib/api';

export interface SendQuoteEmailPayload {
  to: string;
  cc?: string;
  subject: string;
  body: string;
  /** PDF bytes — built client-side via generateQuotePdf + doc.output('blob'). */
  pdf: Blob;
  /** Suggested filename for the attachment. */
  pdfFilename: string;
}

export interface SendQuoteEmailResult {
  message_id: string;
}

/**
 * Send a quote email via the FastAPI /api/quotes/{id}/email endpoint.
 *
 * The PDF is rendered client-side (utils/quotePdf.ts) and posted as
 * multipart so we don't duplicate the rendering logic in Python.
 *
 * Throws:
 *   - Error with `service_unavailable` flag when Resend isn't configured
 *     (503 from the server). Use this to show a clear "ask an admin to
 *     configure email" message rather than a generic failure.
 */
export async function sendQuoteEmail(
  quoteId: string,
  payload: SendQuoteEmailPayload,
): Promise<SendQuoteEmailResult> {
  const supabase = getSupabase();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session?.access_token) {
    throw new Error('Not signed in.');
  }

  const form = new FormData();
  form.append('to', payload.to);
  if (payload.cc) form.append('cc', payload.cc);
  form.append('subject', payload.subject);
  form.append('body', payload.body);
  form.append('pdf', payload.pdf, payload.pdfFilename);

  const response = await fetch(
    `${API_BASE_URL}/api/quotes/${quoteId}/email`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${session.access_token}`,
      },
      body: form,
    },
  );

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    if (response.status === 503) {
      const e = new Error(
        err.detail ??
          'Email sending isn\'t configured yet. Ask an admin to set RESEND_API_KEY.',
      );
      (e as Error & { service_unavailable?: boolean }).service_unavailable = true;
      throw e;
    }
    throw new Error(err.detail ?? `Email send failed (${response.status})`);
  }

  return (await response.json()) as SendQuoteEmailResult;
}
