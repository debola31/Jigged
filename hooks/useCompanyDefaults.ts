'use client';

import { useParams } from 'next/navigation';
import { getCompany } from '@/utils/companyAccess';
import {
  readCompanyDefaults,
  type CompanyDefaultKey,
} from '@/lib/companyDefaults';
import { useLoad } from '@/hooks/useLoad';

/**
 * Read the current company's business-default values (quote validity, etc.)
 * for use in render logic — e.g. pre-filling a new quote's expiration date.
 *
 * Returns a dense map keyed by KNOWN_DEFAULTS entries. `loading` is true until
 * the company row has been fetched the first time; the fallback (no companyId /
 * fetch failure) is every default's descriptor `fallback`, so a failed load
 * degrades to the same behavior as the old hard-coded constants rather than
 * blocking. Mirrors useCompanyFeatures.
 */
export function useCompanyDefaults() {
  const params = useParams();
  const companyId = params.companyId as string | undefined;

  const { data, loading } = useLoad(
    async () => {
      if (!companyId) return FALLBACK_DEFAULTS;
      try {
        return readCompanyDefaults(await getCompany(companyId));
      } catch (err) {
        console.warn('useCompanyDefaults: failed to load company:', err);
        return FALLBACK_DEFAULTS;
      }
    },
    [companyId],
  );

  return { defaults: data ?? FALLBACK_DEFAULTS, loading };
}

// Stable "all descriptor fallbacks" map — computed once (readCompanyDefaults of
// an empty company resolves every key to its fallback), shared as the
// loading/fallback value so consumers don't see a new object identity each render.
const FALLBACK_DEFAULTS: Record<CompanyDefaultKey, number> = readCompanyDefaults(null);
