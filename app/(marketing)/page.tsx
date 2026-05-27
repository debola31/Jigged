import type { Metadata } from 'next';
import LandingPageContent from '@/components/marketing/LandingPageContent';

export const metadata: Metadata = {
  title: 'Jigged — Modern Shop Floor Management',
  description:
    'A flexible data platform for small precision manufacturing shops. Real-time visibility, flexible inventory, and operators who actually log their work.',
};

export default function LandingPage() {
  return <LandingPageContent />;
}
