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
  // Key on the id, NOT the `user` object. AuthProvider calls setUser on every
  // auth event (INITIAL_SESSION, SIGNED_IN, each TOKEN_REFRESHED), each time
  // with a fresh User object carrying the same id — keying on the object
  // re-ran getUserRole on all of them, and tripped useLoad's non-primitive-dep
  // warning on every render. Don't widen this back to [user].
  const userId = user?.id;

  // The no-user / no-company guard lives inside the loader (returning null)
  // rather than a synchronous setState in the effect body — keeps
  // set-state-in-effect quiet. The brief loading flash in those states is a
  // redirect transient, not user-visible.
  const { data: role, loading } = useLoad<UserRole>(
    async () => {
      if (!userId || !companyId) return null;
      try {
        return (await getUserRole(userId, companyId)) as UserRole;
      } catch {
        return null;
      }
    },
    [userId, companyId],
  );

  const isAdmin = role === 'admin';

  return { role: role ?? null, isAdmin, loading };
}
