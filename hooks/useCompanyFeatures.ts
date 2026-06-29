'use client';

import { useParams } from 'next/navigation';
import { getCompany } from '@/utils/companyAccess';
import {
  KNOWN_FEATURES,
  readCompanyFeatures,
  type KnownFeatureKey,
} from '@/lib/featureFlags';
import { useLoad } from '@/hooks/useLoad';

/**
 * Read the current company's feature-flag state for use in render logic
 * (Sidebar nav gating, feature-flag-aware buttons, etc.).
 *
 * Returns a dense map keyed by KNOWN_FEATURES entries. `loading` is true
 * until the company row has been fetched the first time — render-aware
 * call sites (notably the Sidebar) should hide flag-gated items behind a
 * Skeleton while `loading` is true, rather than flashing them in once the
 * data arrives.
 *
 * The fallback (no companyId / fetch failure) is "every flag false" —
 * safer than the alternative of leaking gated UI to a tenant that hasn't
 * opted in. The no-companyId guard lives inside the loader (not a synchronous
 * setState in the effect body) so it doesn't trip set-state-in-effect.
 */
export function useCompanyFeatures() {
  const params = useParams();
  const companyId = params.companyId as string | undefined;

  const { data, loading } = useLoad(
    async () => {
      if (!companyId) return EMPTY_FEATURES;
      try {
        return readCompanyFeatures(await getCompany(companyId));
      } catch (err) {
        console.warn('useCompanyFeatures: failed to load company:', err);
        return EMPTY_FEATURES;
      }
    },
    [companyId],
  );

  return { features: data ?? EMPTY_FEATURES, loading };
}

function emptyFeatures(): Record<KnownFeatureKey, boolean> {
  const out = {} as Record<KnownFeatureKey, boolean>;
  for (const f of KNOWN_FEATURES) out[f.key] = false;
  return out;
}

// Stable "all flags false" map — computed once, shared as the loading/fallback
// value so consumers don't see a new object identity each render.
const EMPTY_FEATURES: Record<KnownFeatureKey, boolean> = emptyFeatures();
