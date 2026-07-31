'use client';

/**
 * Who the signed-in operator is, for the "Me" tab.
 *
 * Lifted verbatim out of the old `/profile` page when Profile stopped being a tab. The email
 * comes from the auth session, the display name from `user_company_access` via
 * `getCurrentMember`, and the company name from `getCompany`.
 *
 * Deliberately never throws and never blocks: the "Me" tab's reason to exist is the operator's
 * own work, and identity failing to resolve must not take the work — or the Log out button —
 * down with it. A null return renders as "You" with no company line.
 */

import { useLoad } from '@/hooks/useLoad';
import { getCurrentMember } from '@/utils/operatorAccess';
import { getCompany } from '@/utils/companyAccess';
// `getTypedSupabase`, not `getSupabase` — new code uses the typed client (issue #573). Only
// `auth.getSession()` is used here, which is schema-independent, so the two behave identically;
// the typed one is simply what new files are required to reach for.
import { getTypedSupabase } from '@/lib/supabase';
import type { OperatorIdentity } from '@/components/operator/OperatorAccountBlock';

export function useOperatorIdentity(companyId: string) {
  return useLoad<OperatorIdentity>(async () => {
    // Every one of the three reads is guarded independently. The docstring above promises this
    // never blocks the work or the Log out button, and an unguarded `getSession()` quietly broke
    // that promise — one throw took the whole identity down, name included, rather than degrading
    // to a missing email.
    const session = await getTypedSupabase()
      .auth.getSession()
      .then((r) => r.data.session)
      .catch(() => null);

    const [member, company] = await Promise.all([
      getCurrentMember(companyId).catch(() => null),
      getCompany(companyId).catch(() => null),
    ]);

    return {
      name: member?.name || 'Operator',
      email: session?.user?.email ?? '',
      companyName: company?.name ?? '',
      userId: session?.user?.id ?? '',
    };
  }, [companyId]);
}
