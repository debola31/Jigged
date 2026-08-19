import { NextResponse, type NextRequest } from 'next/server';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import * as Sentry from '@sentry/nextjs';

import { createClient } from '@/utils/supabase/server';
import { resolveClientIp, boundedUserAgent } from '@/lib/clientIp';
import {
  CURRENT_LEGAL_VERSIONS,
  LEGAL_DOCUMENT_TYPES,
  type LegalDocumentType,
} from '@/lib/legal/manifest';
import type { Database } from '@/types/database';

/**
 * POST /legal/accept — the only way a terms_acceptances row is ever written.
 *
 * WHY A NEXT ROUTE HANDLER AND NOT FASTAPI, given architecture.md §8.1 lists
 * service-role work under FastAPI. Three reasons, and the section has been
 * amended to record them: `app/actions/waitlist.ts` already builds a
 * service-role client inside the Next server, so this is precedented rather than
 * new; every FastAPI auth helper is COMPANY-scoped while a terms write is
 * USER-scoped (at signup there is no company at all), and `utils/supabase/server.ts`
 * gives user-scoped auth for free; and the current version and hash live in the
 * Next bundle, so a FastAPI writer would make two deployments from one commit
 * have to agree about a hash across a boundary. It sits at /legal/accept rather
 * than /api/* because vercel.json rewrites that whole path space to the Python
 * function.
 *
 * WHAT THE CLIENT MAY INFLUENCE, exhaustively: which documents it is accepting,
 * which surface presented them, a company id we then verify, and the versions it
 * believes it displayed (rejection-only, see below). There is NO parameter for
 * version, hash, IP, user agent or timestamp — the strongest form of "do not
 * trust a client-supplied version" is to have nowhere to put one.
 */

const ACCEPTED_VIA = [
  'invite_accept',
  'signup',
  'reacceptance_dashboard',
  'reacceptance_operator',
] as const;
type AcceptedVia = (typeof ACCEPTED_VIA)[number];

interface AcceptBody {
  document_types: LegalDocumentType[];
  accepted_via: AcceptedVia;
  company_id: string | null;
  displayed_versions: Partial<Record<LegalDocumentType, number>>;
}

export interface ParsedAcceptBody {
  document_types: LegalDocumentType[];
  accepted_via: AcceptedVia;
  company_id: string | null;
  displayed_versions: Partial<Record<LegalDocumentType, number>>;
}

/** Exported for the test that asserts the parser has nowhere to put a
 *  client-supplied IP, version or hash — a behavioural test alone can rot if
 *  someone later adds a field. */
export function parseAcceptBody(input: unknown): ParsedAcceptBody | null {
  if (typeof input !== 'object' || input === null) return null;
  const body = input as Partial<AcceptBody>;

  const types = Array.isArray(body.document_types)
    ? body.document_types.filter((t): t is LegalDocumentType =>
        (LEGAL_DOCUMENT_TYPES as readonly string[]).includes(t),
      )
    : [];
  if (!types.length) return null;

  const via = ACCEPTED_VIA.find((v) => v === body.accepted_via);
  if (!via) return null;

  const displayed: Partial<Record<LegalDocumentType, number>> = {};
  if (typeof body.displayed_versions === 'object' && body.displayed_versions !== null) {
    for (const t of types) {
      const v = (body.displayed_versions as Record<string, unknown>)[t];
      if (typeof v === 'number' && Number.isInteger(v)) displayed[t] = v;
    }
  }

  return {
    document_types: [...new Set(types)],
    accepted_via: via,
    company_id: typeof body.company_id === 'string' ? body.company_id : null,
    displayed_versions: displayed,
  };
}

/**
 * Same-origin check. There is no middleware.ts in this repo and Next's
 * Server-Action origin protection does not cover Route Handlers, so without
 * this the SameSite=Lax cookie default would be the only thing between a
 * third-party page and a silently-recorded acceptance. For a record whose whole
 * value is "the browser could not have produced this", a cookie default is the
 * wrong posture.
 */
export function isSameOrigin(request: NextRequest): boolean {
  const site = request.headers.get('sec-fetch-site');
  if (site) return site === 'same-origin' || site === 'same-site' || site === 'none';

  const origin = request.headers.get('origin');
  if (!origin) return true; // no Origin at all: not a cross-site form post
  try {
    return new URL(origin).host === request.headers.get('host');
  } catch {
    return false;
  }
}

function serviceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) throw new Error('Supabase service credentials are not configured');
  const client = createServiceClient<Database>(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  // waitlist.ts does not do this, which is why it console.errors into the void.
  // A failed legal write must reach Sentry with its query attached.
  Sentry.instrumentSupabaseClient(client);
  return client;
}

export async function POST(request: NextRequest) {
  if (!isSameOrigin(request)) {
    return NextResponse.json({ error: 'Cross-origin request refused' }, { status: 403 });
  }

  const supabase = await createClient();
  // getUser(), NOT getSession(): it validates the JWT against the auth server
  // rather than trusting whatever the cookie says. This IS the user-scoped auth
  // check the FastAPI helpers cannot provide.
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: 'Malformed request body' }, { status: 400 });
  }

  const body = parseAcceptBody(raw);
  if (!body) {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  // Server-authored, from the bundled manifest — NOT read off disk. This handler
  // is dynamic and runs in the Lambda, so a filesystem read here would be a live
  // failure mode on the only write path in the feature. The CI guard has already
  // proved this constant matches the bytes.
  const current = CURRENT_LEGAL_VERSIONS;

  // Stale-tab check, REJECTION-ONLY. A client that displayed v1 while v2 is
  // current must not have its tick silently recorded against v2 — it would be a
  // signature on a document the user never saw. Client input may narrow what is
  // recorded, never widen it.
  const stale = body.document_types.filter(
    (t) => body.displayed_versions[t] !== undefined && body.displayed_versions[t] !== current[t].version,
  );
  if (stale.length) {
    return NextResponse.json(
      {
        error: 'The document was updated while this page was open',
        current_versions: Object.fromEntries(
          LEGAL_DOCUMENT_TYPES.map((t) => [t, current[t].version]),
        ),
      },
      { status: 409 },
    );
  }

  const admin = serviceClient();

  // company_id is verified, never trusted. One read on a once-a-year path.
  let companyId: string | null = null;
  if (body.company_id) {
    const { data: access } = await admin
      .from('user_company_access')
      .select('company_id')
      .eq('user_id', user.id)
      .eq('company_id', body.company_id)
      .limit(1);
    companyId = access?.length ? body.company_id : null;
  }

  const { ip, source } = resolveClientIp(request.headers);
  const userAgent = boundedUserAgent(request.headers);

  const rows = body.document_types.map((t) => ({
    user_id: user.id,
    company_id: companyId,
    document_type: t,
    version: current[t].version,
    document_sha256: current[t].sha256,
    ip_address: ip,
    ip_source: source,
    user_agent: userAgent,
    accepted_via: body.accepted_via,
  }));

  const { error } = await admin.from('terms_acceptances').insert(rows);
  if (error) {
    // No captureException: lib/supabase.ts's Sentry integration is installed on
    // this client above, so the failure is already filed with its query.
    return NextResponse.json({ error: 'Could not record acceptance' }, { status: 500 });
  }

  return NextResponse.json({
    recorded: rows.map((r) => ({ document_type: r.document_type, version: r.version })),
  });
}
