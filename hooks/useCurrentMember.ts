'use client';

/**
 * Who the signed-in person is on the OFFICE surface — the counterpart of
 * `useOperatorIdentity`, for `components/layout/AccountMenu`.
 *
 * ## Why this exists rather than reading `user_metadata`
 *
 * The header used to greet you with `user.user_metadata.first_name`, and that key is only ever
 * WRITTEN by two paths — `components/auth/SignUp.tsx` and the accept-invite flow. An account
 * created any other way (the `/admin` company-creation flow, a seed, OAuth) has no `first_name`,
 * so the greeting rendered as nothing at all: no name, no email, no fallback, no error. The Team
 * page one route away showed the same person's name correctly the whole time, because it reads
 * `user_company_access.name`. Two sources for one fact, one of them sparse, and the sparse one was
 * wired to the only place that answers "who am I signed in as".
 *
 * So: the NAME comes from the membership row, which every path that grants access populates, and
 * the EMAIL comes from the session, which is the authoritative answer to the question being asked
 * and costs no round trip.
 *
 * ## Cost
 *
 * One indexed single-row `user_company_access` select per dashboard mount, via `getCurrentMember`,
 * which shares one in-flight request between concurrent callers. It is the same table and filter
 * `useUserRole` already hits for the Sidebar; `useLoad` does not dedupe across hooks, so the two
 * are separate round trips by construction. Deliberately does NOT fetch the company row for a
 * company name: the sidebar's CompanySwitcher shows it permanently, and `getCompany` has no
 * in-flight map, so asking here would be a second `companies` fetch on every page.
 *
 * ## Never blocks
 *
 * A failed lookup degrades to `name: null` (the menu then leads with the email) rather than
 * throwing. Sign out has to stay reachable even when identity does not resolve — the same promise
 * `useOperatorIdentity` makes for the operator's Log out button.
 */

import { useParams } from 'next/navigation';
import { useAuth } from '@/components/providers/AuthProvider';
import { getCurrentMember } from '@/utils/operatorAccess';
import { useLoad } from '@/hooks/useLoad';
import type { UserRole } from '@/hooks/useUserRole';

export interface CurrentMemberIdentity {
  /** Display name from `user_company_access.name`. Null when unset or the lookup failed. */
  name: string | null;
  /** The session's email — present whenever there is a session at all. */
  email: string | null;
  /** The caller's role in THIS company. */
  role: UserRole;
  loading: boolean;
}

export function useCurrentMember(): CurrentMemberIdentity {
  const { user } = useAuth();
  const params = useParams();
  const companyId = params.companyId as string | undefined;
  // Key on the id, NOT the `user` object — AuthProvider hands out a fresh User with the same id on
  // every auth event, and `useLoad` warns (loudly, in dev) about non-primitive deps. Same reasoning
  // as `useUserRole`; don't widen this back to [user].
  const userId = user?.id;

  // The no-user / no-company guard lives inside the loader rather than a synchronous setState in
  // the effect body, which is what keeps `react-hooks/set-state-in-effect` quiet. `pnpm lint` runs
  // at --max-warnings 17 and that cap only ever ratchets down.
  const { data, loading } = useLoad(
    async () => {
      if (!userId || !companyId) return null;
      try {
        return await getCurrentMember(companyId);
      } catch {
        return null;
      }
    },
    [userId, companyId],
  );

  return {
    name: data?.name ?? null,
    email: user?.email ?? null,
    role: (data?.role ?? null) as UserRole,
    loading,
  };
}
