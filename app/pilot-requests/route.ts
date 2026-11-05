import { NextResponse, type NextRequest } from 'next/server';
import * as Sentry from '@sentry/nextjs';

import { resolveClientIp } from '@/lib/clientIp';
import {
  PILOT_RATE_LIMITED_MESSAGE,
  PILOT_REQUEST_BUCKET,
  parsePilotRequestBody,
  pilotContentType,
  pilotStoragePath,
} from '@/lib/pilotRequest';
import {
  PILOT_RATE_LIMITS,
  PILOT_RATE_WINDOW_MS,
  hashClientIp,
  pilotServiceClient,
} from '@/lib/pilotRequestServer';
import { toError } from '@/lib/supabaseErrors';

/**
 * POST /pilot-requests — step 1 of 3 of a showcase pilot request: validate, rate-limit, record the
 * request, and hand back a signed upload URL for one server-chosen path. The browser then PUTs the
 * file straight to Storage (so a 50 MB part never passes through a Vercel function's 4.5 MB body
 * limit) and calls POST /pilot-requests/complete. Why a Route Handler: lib/pilotRequestServer.ts.
 *
 * Outside /api because vercel.json rewrites that whole path space to the Python function.
 *
 * Responses: 200 `{ request_id, upload: { url, content_type } }`; 200 with both null when the
 * honeypot is filled (a script is told it succeeded and given nothing); 400 with a message for
 * the visitor; 429 when a limit is reached; 500 otherwise.
 */
export async function POST(request: NextRequest) {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 });
  }

  const parsed = parsePilotRequestBody(raw);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  if (parsed.honeypot) return NextResponse.json({ request_id: null, upload: null });

  const input = parsed.value;
  const admin = pilotServiceClient();
  const since = new Date(Date.now() - PILOT_RATE_WINDOW_MS).toISOString();
  const ipHash = hashClientIp(resolveClientIp(request.headers).ip);

  const countSince = (column: 'email' | 'ip_hash', value: string) =>
    admin
      .from('pilot_requests')
      .select('id', { count: 'exact', head: true })
      .eq(column, value)
      .gte('created_at', since);

  const [byEmail, byIp] = await Promise.all([
    countSince('email', input.email),
    ipHash ? countSince('ip_hash', ipHash) : Promise.resolve({ count: 0, error: null }),
  ]);
  // No captureException: the client is instrumented, so a failed read has already filed itself.
  if (byEmail.error || byIp.error) {
    return NextResponse.json({ error: 'Could not take your request right now.' }, { status: 500 });
  }
  if ((byEmail.count ?? 0) >= PILOT_RATE_LIMITS.perEmail || (byIp.count ?? 0) >= PILOT_RATE_LIMITS.perIp) {
    return NextResponse.json({ error: PILOT_RATE_LIMITED_MESSAGE }, { status: 429 });
  }

  const id = crypto.randomUUID();
  const storagePath = pilotStoragePath(id, input.file_name);

  // The URL first, then the row: a URL that fails leaves nothing behind, and a row is only ever
  // written for a request that was actually given somewhere to upload.
  const { data: signed, error: signError } = await admin.storage
    .from(PILOT_REQUEST_BUCKET)
    .createSignedUploadUrl(storagePath);
  if (signError || !signed) {
    // Storage is not covered by the Supabase integration, so this one is reported by hand.
    Sentry.captureException(toError(signError, 'Could not create a pilot request upload URL'));
    return NextResponse.json({ error: 'Could not take your request right now.' }, { status: 500 });
  }

  const { error: insertError } = await admin.from('pilot_requests').insert({
    id,
    email: input.email,
    name: input.name,
    company_name: input.company_name,
    note: input.note,
    file_name: input.file_name,
    file_type: input.file_type,
    file_size_bytes: input.file_size,
    storage_path: storagePath,
    ip_hash: ipHash,
  });
  if (insertError) {
    return NextResponse.json({ error: 'Could not take your request right now.' }, { status: 500 });
  }

  return NextResponse.json({
    request_id: id,
    upload: { url: signed.signedUrl, content_type: pilotContentType(input.file_type) },
  });
}
