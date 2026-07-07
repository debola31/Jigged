'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/components/providers/AuthProvider';
import { getPostLoginRoute } from '@/utils/companyAccess';
import Hero from './Hero';
import LogoCloud from './LogoCloud';
import PainPoints from './PainPoints';
import Features from './Features';
import KnowledgeCapture from './KnowledgeCapture';
import HowItWorks from './HowItWorks';
import EarlyAccess from './EarlyAccess';
// import Testimonial from './Testimonial'; // Re-enable once a real quote is confirmed
import FinalCTA from './FinalCTA';

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
      <LogoCloud />
      <PainPoints />
      <Features />
      <KnowledgeCapture />
      <HowItWorks />
      <EarlyAccess />
      {/* <Testimonial /> Re-enable once a real quote is confirmed */}
      <FinalCTA />
    </>
  );
}
