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
 *
 * `companyName` rides along because `getCompany` already returns it. A separate
 * `useCompany()` would re-fetch the identical row for anything that needs both —
 * which is exactly what the operator "Me" tab was doing, requesting one companies
 * row twice per mount on the page whose problem was concurrent request volume.
 * Storage needs both too: the flag gates the page and the name heads its QR label
 * sheet.
 */
export function useCompanyFeatures() {
  const params = useParams();
  const companyId = params.companyId as string | undefined;

  const { data, loading } = useLoad(
    async (): Promise<{ features: Record<KnownFeatureKey, boolean>; name: string | null }> => {
      if (!companyId) return EMPTY_RESULT;
      try {
        const company = await getCompany(companyId);
        return { features: readCompanyFeatures(company), name: company?.name ?? null };
      } catch (err) {
        console.warn('useCompanyFeatures: failed to load company:', err);
        return EMPTY_RESULT;
      }
    },
    [companyId],
  );

  return {
    features: data?.features ?? EMPTY_FEATURES,
    companyName: data?.name ?? null,
    loading,
  };
}

function emptyFeatures(): Record<KnownFeatureKey, boolean> {
  const out = {} as Record<KnownFeatureKey, boolean>;
  for (const f of KNOWN_FEATURES) out[f.key] = false;
  return out;
}

// Stable "all flags false" map — computed once, shared as the loading/fallback
// value so consumers don't see a new object identity each render.
const EMPTY_FEATURES: Record<KnownFeatureKey, boolean> = emptyFeatures();
const EMPTY_RESULT = { features: EMPTY_FEATURES, name: null } as const;
