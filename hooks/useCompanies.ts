'use client';

import { useAuth } from '@/components/providers/AuthProvider';
import { getUserCompanies, UserCompanyAccess } from '@/utils/companyAccess';
import { useLoad } from '@/hooks/useLoad';

const EMPTY_COMPANIES: UserCompanyAccess[] = [];

export function useCompanies() {
  const { user } = useAuth();
  // The no-user guard lives inside the loader (returning []) rather than a
  // synchronous setState in the effect body — keeps set-state-in-effect quiet.
  // When signed-out, `loading` is briefly true before resolving to []; that
  // state is a redirect-to-login transient, so the flash isn't user-visible.
  const { data, loading, error } = useLoad(
    async () => (user ? getUserCompanies(user.id) : EMPTY_COMPANIES),
    [user],
  );
  return {
    companies: data ?? EMPTY_COMPANIES,
    loading,
    error: (error as Error | null) ?? null,
  };
}
