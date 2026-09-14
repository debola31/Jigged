'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/components/providers/AuthProvider';
import { getPostLoginRoute } from '@/utils/companyAccess';
import Hero from './Hero';
import CapabilityStrip from './CapabilityStrip';
import WhatYouGet from './WhatYouGet';
import KnowledgeCapture from './KnowledgeCapture';
import HowItWorks from './HowItWorks';
import Faq from './Faq';
import Testimonial from './Testimonial';
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
      {/* The whole product in five numbered rows, each with a picture. This replaced three
          sections — a Quoting showcase, a chip grid naming the same capabilities again,
          and a standalone shop-floor block — which were one argument told twice at
          different resolutions. */}
      <WhatYouGet />
      {/* The one claim no incumbent makes, so it keeps its own section. */}
      <KnowledgeCapture />
      {/* "No consultants, no six-month rollout" answers the objection that decides these
          deals, so it and the FAQ sit together as the objection-handling block. */}
      <HowItWorks />
      <Faq />
      {/* Last word before the ask. Moved here from mid-page 2026-09-14: the quote is about
          the product overall — "I've used other ERPs" — not about any one section, so the
          adjacency argument for parking it under Knowledge capture never really held. As
          the only quote on the page, it does most work closing the objection block.
          Renders nothing unless approved in writing — see the constant. */}
      <Testimonial />
      <FinalCTA />
    </>
  );
}
