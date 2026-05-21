'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { getCompany } from '@/utils/companyAccess';
import {
  KNOWN_FEATURES,
  readCompanyFeatures,
  type KnownFeatureKey,
} from '@/lib/featureFlags';

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
 * opted in.
 */
export function useCompanyFeatures() {
  const params = useParams();
  const companyId = params.companyId as string | undefined;
  const [features, setFeatures] = useState<Record<KnownFeatureKey, boolean>>(
    () => emptyFeatures(),
  );
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!companyId) {
      setFeatures(emptyFeatures());
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const company = await getCompany(companyId);
        if (cancelled) return;
        setFeatures(readCompanyFeatures(company));
      } catch (err) {
        if (cancelled) return;
        console.warn('useCompanyFeatures: failed to load company:', err);
        setFeatures(emptyFeatures());
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [companyId]);

  return { features, loading };
}

function emptyFeatures(): Record<KnownFeatureKey, boolean> {
  const out = {} as Record<KnownFeatureKey, boolean>;
  for (const f of KNOWN_FEATURES) out[f.key] = false;
  return out;
}
