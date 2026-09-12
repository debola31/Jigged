'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/components/providers/AuthProvider';
import { getPostLoginRoute } from '@/utils/companyAccess';
import Hero from './Hero';
import PriceStrip from './PriceStrip';
import TodayWithJigged from './TodayWithJigged';
import HowItWorks from './HowItWorks';
import Capabilities from './Capabilities';
import Showcases from './Showcases';
import ShopFloorShowcase from './ShopFloorShowcase';
import KnowledgeCapture from './KnowledgeCapture';
import Testimonial from './Testimonial';
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
      {/* The price, printed. Nobody in this category does it, and it disqualifies the
          wrong prospect before either side spends a call on it. */}
      <PriceStrip />
      {/* Why change — a table rather than four pull-quotes, so the same argument also
          names capabilities and does the positioning. */}
      <TodayWithJigged />
      {/* Moved up from seventh. "No consultants, no six-month rollout" is the strongest
          objection-killer on the page, and the hero's own secondary CTA anchor-jumps
          here — the page was already telling us where this belonged. */}
      <HowItWorks />
      {/* Breadth: twenty feature names, visible, for the height of one old feature row. */}
      <Capabilities />
      {/* Depth: only the two stories that need a picture to be believed. */}
      <Showcases />
      <ShopFloorShowcase />
      <KnowledgeCapture />
      {/* Renders nothing until the quote is approved in writing — see the constant. */}
      <Testimonial />
      <Faq />
      {/* One closing beat: the founding-shops message is folded into FinalCTA — a separate
          early-access band above it just repeated the same pitch before the same button. */}
      <FinalCTA />
    </>
  );
}
