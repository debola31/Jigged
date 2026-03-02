import type { Metadata } from 'next';
import ComingSoonContent from '@/components/marketing/ComingSoonContent';

export const metadata: Metadata = {
  title: 'Coming Soon',
  description:
    'Jigged is launching soon. Join the waitlist to get early access to the manufacturing operations system built for small shops.',
};

export default function ComingSoonPage() {
  return <ComingSoonContent />;
}
