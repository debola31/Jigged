'use client';

import { useParams } from 'next/navigation';
import { useAuth } from '@/components/providers/AuthProvider';
import { getUserRole } from '@/utils/companyAccess';
import { useLoad } from '@/hooks/useLoad';

export type UserRole = 'admin' | 'user' | 'operator' | null;

export function useUserRole() {
  const { user } = useAuth();
  const params = useParams();
  const companyId = params.companyId as string | undefined;

  // The no-user / no-company guard lives inside the loader (returning null)
  // rather than a synchronous setState in the effect body — keeps
  // set-state-in-effect quiet. The brief loading flash in those states is a
  // redirect transient, not user-visible.
  const { data: role, loading } = useLoad<UserRole>(
    async () => {
      if (!user || !companyId) return null;
      try {
        return (await getUserRole(user.id, companyId)) as UserRole;
      } catch {
        return null;
      }
    },
    [user, companyId],
  );

  const isAdmin = role === 'admin';

  return { role: role ?? null, isAdmin, loading };
}
