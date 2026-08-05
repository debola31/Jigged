'use client';

import { useAuth } from '@/components/providers/AuthProvider';
import { getUserCompanies, UserCompanyAccess } from '@/utils/companyAccess';
import { useLoad } from '@/hooks/useLoad';

const EMPTY_COMPANIES: UserCompanyAccess[] = [];

export function useCompanies() {
  const { user } = useAuth();
  // Key on the id, NOT the `user` object — see the same note in useUserRole.
  // AuthProvider hands down a fresh User object on every auth event, so [user]
  // re-ran getUserCompanies for an answer that cannot have changed.
  const userId = user?.id;
  // The no-user guard lives inside the loader (returning []) rather than a
  // synchronous setState in the effect body — keeps set-state-in-effect quiet.
  // When signed-out, `loading` is briefly true before resolving to []; that
  // state is a redirect-to-login transient, so the flash isn't user-visible.
  const { data, loading, error } = useLoad(
    async () => (userId ? getUserCompanies(userId) : EMPTY_COMPANIES),
    [userId],
  );
  return {
    companies: data ?? EMPTY_COMPANIES,
    loading,
    error: (error as Error | null) ?? null,
  };
}
