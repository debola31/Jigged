/**
 * Job traveler scan target: `https://www.jigged.app/T/{company32}{jobPart32}`.
 *
 * Uppercase `T` on purpose — see `components/scanner/ScanLanding.tsx`. All the behaviour lives
 * there; this file exists to claim the route.
 */
import ScanLanding from '@/components/scanner/ScanLanding';

export default function TravelerScanPage() {
  return <ScanLanding kind="traveler" />;
}
