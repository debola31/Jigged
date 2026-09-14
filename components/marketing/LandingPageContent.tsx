'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/components/providers/AuthProvider';
import { getPostLoginRoute } from '@/utils/companyAccess';
import Hero from './Hero';
import CapabilityStrip from './CapabilityStrip';
import Showcases from './Showcases';
import Capabilities from './Capabilities';
import ShopFloorShowcase from './ShopFloorShowcase';
import KnowledgeCapture from './KnowledgeCapture';
import Testimonial from './Testimonial';
import HowItWorks from './HowItWorks';
import Faq from './Faq';
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
      {/* Who it's for, in one line, plus the capabilities the shop will look for. */}
      <CapabilityStrip />
      {/* The two pictures that carry the page, moved directly under the hero on
          2026-09-14. They were sixth and seventh, behind three text sections, which is
          the wrong order when they are the strongest thing here. */}
      <Showcases />
      {/* Breadth: twenty feature names, visible, for the height of one old feature row. */}
      <Capabilities />
      <ShopFloorShowcase />
      <KnowledgeCapture />
      {/* Renders nothing unless the quote is approved in writing — see the constant. */}
      <Testimonial />
      {/* "No consultants, no six-month rollout" answers the objection that decides these
          deals, so it sits just before the closing ask rather than in the middle. */}
      <HowItWorks />
      <Faq />
      {/* One closing beat: the founding-shops message is folded into FinalCTA. */}
      <FinalCTA />
    </>
  );
}
