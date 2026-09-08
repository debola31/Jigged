'use client';

import { useMemo } from 'react';
import { useLoad } from '@/hooks/useLoad';
import { readLogoIncludesName } from '@/lib/companyDefaults';
import { getSignedUrls, LOGOS_BUCKET } from '@/utils/storageHelpers';
import type { UserCompanyAccess } from '@/utils/companyAccess';

const EMPTY_URLS: ReadonlyMap<string, string> = new Map();

/**
 * How long a minted logo URL stays good.
 *
 * Matches the settings-page preview (`CompanyProfileCard`). An office tab left open past the hour
 * outlives its URLs and the images stop loading — which is exactly why `CompanyIdentity` falls back
 * to the initials avatar on error rather than showing a hole, and why the switcher re-mints when
 * the drawer opens.
 */
const LOGO_URL_TTL_SECONDS = 3600;

/**
 * Signed URLs for the workspace logos that are allowed to stand in for a company's name.
 *
 * Only companies with BOTH a `logo_url` and `settings.logo_includes_name` are minted: a logo that
 * doesn't carry the shop's name can't replace it, so fetching it would buy nothing. That filter is
 * the same rule `CompanyIdentity` renders, kept here so a workspace list never pays for artwork it
 * won't draw.
 *
 * One `createSignedUrls` request covers every row. The `logos` bucket is private, and its SELECT
 * policy admits any company in the user's own `user_company_access` — so every workspace in this
 * list is readable, including the ones they aren't currently in.
 *
 * Failures are absent keys, never throws (`getSignedUrls` swallows per-path errors by design), so a
 * shop whose logo won't resolve simply renders the way it does today.
 */
export function useCompanyLogos(companies: UserCompanyAccess[]) {
  // company_id → logo path, for the companies whose logo may stand in for their name.
  const entries = useMemo(
    () =>
      companies
        .filter((c) => c.companies?.logo_url && readLogoIncludesName(c.companies))
        .map((c) => [c.company_id, c.companies.logo_url as string] as const),
    [companies],
  );

  // `useLoad` requires PRIMITIVE deps — an array literal here is an infinite render loop. The paths
  // are content-addressed (a fresh uuid per upload), so this key also re-mints after a re-upload.
  const key = entries.map(([companyId, path]) => `${companyId}:${path}`).join('|');

  const { data, refresh } = useLoad(async () => {
    if (entries.length === 0) return EMPTY_URLS;

    const byPath = await getSignedUrls(
      entries.map(([, path]) => path),
      LOGO_URL_TTL_SECONDS,
      LOGOS_BUCKET,
    );

    const byCompany = new Map<string, string>();
    for (const [companyId, path] of entries) {
      const url = byPath.get(path);
      if (url) byCompany.set(companyId, url);
    }
    return byCompany as ReadonlyMap<string, string>;
  }, [key]);

  return {
    /** company_id → signed URL, for logos that carry the shop's name. */
    logoUrls: data ?? EMPTY_URLS,
    /** Re-mint without a loading flash — for a tab open longer than the TTL. */
    refreshLogoUrls: refresh,
  };
}
