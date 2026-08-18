import { CURRENT_LEGAL_VERSIONS, LEGAL_DOCUMENT_TYPES } from './manifest';

/**
 * Thin client for POST /legal/accept.
 *
 * Sends the versions it BELIEVES it displayed, which the server treats as
 * rejection-only: a mismatch is a 409, never a silent upgrade. That is the
 * stale-tab guard — a page open since before a version bump must not have its
 * tick recorded against text the user never saw.
 */

export type AcceptedVia =
  | 'invite_accept'
  | 'signup'
  | 'reacceptance_dashboard'
  | 'reacceptance_operator';

export class StaleLegalVersionError extends Error {
  constructor() {
    super('The documents were updated while this page was open. Please review them again.');
    this.name = 'StaleLegalVersionError';
  }
}

export async function recordTermsAcceptance(opts: {
  acceptedVia: AcceptedVia;
  companyId?: string | null;
  documentTypes?: readonly ('tos' | 'privacy')[];
}): Promise<void> {
  const types = opts.documentTypes ?? LEGAL_DOCUMENT_TYPES;

  const res = await fetch('/legal/accept', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      document_types: types,
      accepted_via: opts.acceptedVia,
      company_id: opts.companyId ?? null,
      displayed_versions: Object.fromEntries(
        types.map((t) => [t, CURRENT_LEGAL_VERSIONS[t].version]),
      ),
    }),
  });

  if (res.status === 409) throw new StaleLegalVersionError();
  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    throw new Error(detail?.error ?? 'Could not record your agreement');
  }
}
