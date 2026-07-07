import type { Metadata } from 'next';
import LandingPageContent from '@/components/marketing/LandingPageContent';
import { MARKETING_META } from '@/lib/constants/marketing';

export const metadata: Metadata = {
  title: MARKETING_META.title,
  description: MARKETING_META.description,
};

export default function LandingPage() {
  return <LandingPageContent />;
}
