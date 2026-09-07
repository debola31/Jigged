import type { Metadata } from 'next';
import PricingPageContent from '@/components/marketing/PricingPageContent';
import { PRICING } from '@/lib/constants/marketing';

export const metadata: Metadata = {
  // The root layout sets title.template = '%s | Jigged', so this bare string resolves to
  // "Pricing — $399/month for your whole shop | Jigged". Don't append the suffix by hand.
  title: PRICING.meta.title,
  description: PRICING.meta.description,
  // Resolves against metadataBase (https://jigged.app), which as of #695 is finally the same
  // host the Terms of Service cites for https://jigged.app/pricing — no redirect between them.
  alternates: { canonical: '/pricing' },
  // Deliberately NO openGraph override. A child openGraph replaces the parent's resolved
  // object wholesale — there is no per-field merge — so adding one here would silently
  // drop the site's OG card image (app/opengraph-image.tsx, attached at the root
  // segment) along with siteName/locale/type. Inheriting means /pricing shares show the
  // homepage og:title and og:url, exactly as /terms and /privacy already do.
};

export default function PricingPage() {
  return <PricingPageContent />;
}
