'use client';

/**
 * Who the signed-in operator is, for the "Me" tab.
 *
 * Lifted verbatim out of the old `/profile` page when Profile stopped being a tab. The email
 * comes from the auth session, the display name from `user_company_access` via
 * `getCurrentMember`, and the company name from `useCompanyFeatures`.
 *
 * Deliberately never throws and never blocks: the "Me" tab's reason to exist is the operator's
 * own work, and identity failing to resolve must not take the work — or the Log out button —
 * down with it. A null return renders as "You" with no company line.
 *
 * THE COMPANY NAME IS NOT FETCHED HERE. It comes from `useCompanyFeatures`, which the operator
 * shell already mounts on every screen and which returns `companyName` off the same `getCompany`
 * row it needs for the feature flags — exactly the reuse that hook's own docstring describes.
 * Fetching it again here meant the Me tab asked for one `companies` row twice on every mount,
 * on the page whose problem was already too many concurrent requests. `useLoad` dedupes nothing,
 * so two callers really were two round trips.
 */

import { useLoad } from '@/hooks/useLoad';
import { useCompanyFeatures } from '@/hooks/useCompanyFeatures';
import { getCurrentMember } from '@/utils/operatorAccess';
// `getTypedSupabase`, not `getSupabase` — new code uses the typed client (issue #573). Only
// `auth.getSession()` is used here, which is schema-independent, so the two behave identically;
// the typed one is simply what new files are required to reach for.
import { getTypedSupabase } from '@/lib/supabase';
import type { OperatorIdentity } from '@/components/operator/OperatorAccountBlock';

export function useOperatorIdentity(companyId: string) {
  const { companyName } = useCompanyFeatures();

  const { data, loading, error, reload } = useLoad<Omit<OperatorIdentity, 'companyName'>>(
    async () => {
      // Both reads are guarded independently. The docstring above promises this never blocks
      // the work or the Log out button, and an unguarded `getSession()` quietly broke that
      // promise — one throw took the whole identity down, name included, rather than degrading
      // to a missing email.
      const [session, member] = await Promise.all([
        getTypedSupabase()
          .auth.getSession()
          .then((r) => r.data.session)
          .catch(() => null),
        getCurrentMember(companyId).catch(() => null),
      ]);

      return {
        name: member?.name || 'Operator',
        email: session?.user?.email ?? '',
        userId: session?.user?.id ?? '',
      };
    },
    [companyId],
  );

  // The company name arrives on its own schedule (the shell's load, not ours), so it is
  // merged at read time rather than awaited — the name and email must not wait on a flag
  // fetch to render.
  return {
    data: data ? { ...data, companyName: companyName ?? '' } : null,
    loading,
    error,
    reload,
  };
}
