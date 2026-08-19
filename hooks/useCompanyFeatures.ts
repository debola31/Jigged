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
 * The fallback (no companyId / fetch failure) is each flag's REGISTRY DEFAULT, not "every flag
 * false". It was the latter, justified as safer than leaking gated UI to a tenant that had not
 * opted in — true for opt-in flags, and wrong for opt-out ones: it renders a failed read as a
 * definitive "this tenant does not have the feature", which is the "'couldn't check' is never
 * 'denied'" rule in CLAUDE.md. Concretely, one failed `getCompany` used to bounce an operator off
 * /inventory and hide Storage — now the only route to counting — and did the same to `ai_insights`
 * long before that. Opt-in flags are unaffected: their default IS false.
 *
 * The no-companyId guard lives inside the loader (not a synchronous
 * setState in the effect body) so it doesn't trip set-state-in-effect.
 *
 * `companyName` rides along because `getCompany` already returns it. A separate
 * `useCompany()` would re-fetch the identical row for anything that needs both —
 * which is exactly what the operator "Me" tab was doing, requesting one companies
 * row twice per mount on the page whose problem was concurrent request volume.
 * Storage needs both too: the flag gates the page and the name heads its QR label
 * sheet.
 *
 * `isDemo` and `demoCompanyId` ride along for the same reason and on the same
 * row — `getCompany` selects both columns already. That is what lets the
 * operator shell know whether it is standing in a demo company, and whether the
 * shop has one to offer, without spending a request on the question. A
 * non-demo operator therefore pays nothing at all for demo mode; see
 * `components/operator/OperatorCompanyContext.tsx`, which is the only place
 * that turns these three fields into a decision.
 *
 * Both are DEMO-SHAPED FACTS ABOUT THE URL'S COMPANY, not a demo-mode API: the
 * real company a demo stands in for is a reverse lookup this row cannot answer
 * (`getDemoSourceCompany`), and nothing here should grow one.
 */
export function useCompanyFeatures() {
  const params = useParams();
  const companyId = params.companyId as string | undefined;

  const { data, loading } = useLoad(
    async (): Promise<CompanyFeaturesResult> => {
      if (!companyId) return EMPTY_RESULT;
      try {
        const company = await getCompany(companyId);
        return {
          features: readCompanyFeatures(company),
          name: company?.name ?? null,
          isDemo: company?.is_demo ?? false,
          demoCompanyId: company?.demo_company_id ?? null,
        };
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
    /** True when the URL's company IS a demo company. */
    isDemo: data?.isDemo ?? false,
    /** The demo this company owns, if an admin has created one. Null inside a demo. */
    demoCompanyId: data?.demoCompanyId ?? null,
    loading,
  };
}

interface CompanyFeaturesResult {
  features: Record<KnownFeatureKey, boolean>;
  name: string | null;
  isDemo: boolean;
  demoCompanyId: string | null;
}

function defaultFeatures(): Record<KnownFeatureKey, boolean> {
  const out = {} as Record<KnownFeatureKey, boolean>;
  for (const f of KNOWN_FEATURES) out[f.key] = f.defaultEnabled ?? false;
  return out;
}

// Stable registry-default map — computed once, shared as the loading/fallback value so consumers
// don't see a new object identity each render. `loading` is still what gates a flash: this map is
// what an unresolved read means, not what it proves.
const EMPTY_FEATURES: Record<KnownFeatureKey, boolean> = defaultFeatures();
const EMPTY_RESULT: CompanyFeaturesResult = {
  features: EMPTY_FEATURES,
  name: null,
  // "We could not read the row" must not read as "this is a demo" — a false
  // positive here would put the demo bar over a real shop's job list.
  isDemo: false,
  demoCompanyId: null,
};
