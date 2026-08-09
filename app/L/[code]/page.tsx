/**
 * Location label scan target: `https://www.jigged.app/L/{company32}{location32}`.
 *
 * Uppercase `L` on purpose — see `components/scanner/ScanLanding.tsx`. All the behaviour lives
 * there; this file exists to claim the route.
 */
import ScanLanding from '@/components/scanner/ScanLanding';

export default function LocationScanPage() {
  return <ScanLanding kind="location" />;
}
