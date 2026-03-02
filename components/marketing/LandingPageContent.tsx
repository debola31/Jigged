'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/components/providers/AuthProvider';
import { getPostLoginRoute } from '@/utils/companyAccess';
import Hero from './Hero';

export default function LandingPageContent() {
  const router = useRouter();
  const { user, loading } = useAuth();

  useEffect(() => {
    if (loading || !user) return;

    async function redirect() {
      const route = await getPostLoginRoute(user!.id);
      router.replace(route);
    }
    redirect();
  }, [user, loading, router]);

  // Authenticated user — hide landing page while redirecting
  if (user) return null;

  return (
    <>
      <Hero />
    </>
  );
}
