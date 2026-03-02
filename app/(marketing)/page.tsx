import type { Metadata } from 'next';
import LandingPageContent from '@/components/marketing/LandingPageContent';

export const metadata: Metadata = {
  title: 'Jigged — Modern Shop Floor Management',
  description:
    'Replace your rigid legacy ERP with a flexible operations system built for small precision manufacturing shops. Real-time visibility, flexible inventory, and operators who actually log their work.',
};

export default function LandingPage() {
  return <LandingPageContent />;
}
