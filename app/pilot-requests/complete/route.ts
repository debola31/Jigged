import { NextResponse, type NextRequest } from 'next/server';
import * as Sentry from '@sentry/nextjs';

import { PILOT_REQUEST_BUCKET } from '@/lib/pilotRequest';
import { notifyPilotRequest, pilotServiceClient } from '@/lib/pilotRequestServer';
import { toError } from '@/lib/supabaseErrors';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * POST /pilot-requests/complete — step 3 of 3: the browser says its upload finished, and this
 * checks rather than believes it. Only a file that is actually in the bucket stamps
 * `uploaded_at`, and only the call that makes that transition asks for the team email, so a
 * repeated or retried call is answered 200 and sends nothing twice.
 *
 * Body `{ request_id }`. The id is the only capability: it is a v4 UUID handed to one browser in
 * step 1, and the most a guessed one can do is confirm a request that really was uploaded.
 *
 * Responses: 200 `{ ok: true }`; 404 for an unknown id; 409 when there is no file at the path
 * (the upload never arrived, or was empty); 500 otherwise.
 */
export async function POST(request: NextRequest) {
  let requestId: unknown;
  try {
    requestId = ((await request.json()) as { request_id?: unknown } | null)?.request_id;
  } catch {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 });
  }
  if (typeof requestId !== 'string' || !UUID.test(requestId)) {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 });
  }

  const admin = pilotServiceClient();
  const { data: row, error: readError } = await admin
    .from('pilot_requests')
    .select('id, storage_path, uploaded_at')
    .eq('id', requestId)
    .maybeSingle();
  if (readError) return NextResponse.json({ error: 'Could not confirm your upload.' }, { status: 500 });
  if (!row) return NextResponse.json({ error: 'That request was not found.' }, { status: 404 });
  if (row.uploaded_at) return NextResponse.json({ ok: true });

  const { data: info, error: infoError } = await admin.storage
    .from(PILOT_REQUEST_BUCKET)
    .info(row.storage_path);
  if (infoError || !info) {
    const status = (infoError as { status?: number } | null)?.status;
    if (status === 400 || status === 404) {
      return NextResponse.json({ error: 'Your file did not arrive. Please send it again.' }, { status: 409 });
    }
    Sentry.captureException(toError(infoError, 'Could not read a pilot request upload'));
    return NextResponse.json({ error: 'Could not confirm your upload.' }, { status: 500 });
  }
  if (!info.size) {
    return NextResponse.json({ error: 'Your file arrived empty. Please send it again.' }, { status: 409 });
  }

  // `.is('uploaded_at', null)` makes this the one transition: a concurrent duplicate call updates
  // nothing, gets no row back, and so does not ask for a second email.
  const { data: updated, error: updateError } = await admin
    .from('pilot_requests')
    .update({ uploaded_at: new Date().toISOString(), file_size_bytes: info.size })
    .eq('id', requestId)
    .is('uploaded_at', null)
    .select('id');
  if (updateError) return NextResponse.json({ error: 'Could not confirm your upload.' }, { status: 500 });

  // Awaited, not deferred with after(): it is one short call bounded by a 10 s timeout, it
  // never throws, and awaiting it keeps the Sentry report inside the request's lifetime.
  if (updated?.length) await notifyPilotRequest(requestId);

  return NextResponse.json({ ok: true });
}
