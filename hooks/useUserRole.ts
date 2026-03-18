'use client';

import { useState, useEffect } from 'react';
import { useParams } from 'next/navigation';
import { useAuth } from '@/components/providers/AuthProvider';
import { getUserRole } from '@/utils/companyAccess';

export type UserRole = 'admin' | 'user' | 'operator' | null;

export function useUserRole() {
  const { user } = useAuth();
  const params = useParams();
  const companyId = params.companyId as string | undefined;
  const [role, setRole] = useState<UserRole>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user || !companyId) {
      setLoading(false);
      return;
    }

    async function fetchRole() {
      try {
        const data = await getUserRole(user!.id, companyId!);
        setRole(data as UserRole);
      } catch {
        setRole(null);
      } finally {
        setLoading(false);
      }
    }

    fetchRole();
  }, [user, companyId]);

  const isAdmin = role === 'admin';

  return { role, isAdmin, loading };
}
