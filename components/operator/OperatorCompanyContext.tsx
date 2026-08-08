'use client';

/**
 * Which shop the operator is standing in, and whether it is the real one.
 *
 * ## Why this exists
 *
 * The operator surface never said. The station picker renders with the AppBar's centre slot empty
 * (it only fills once a station is chosen) and the bottom nav hidden, so the screen where you
 * commit to a working context carried no company name, no logo and no user name — while the
 * operator LOGIN page, one screen earlier, shows the company name and then loses it. A person who
 * works for two shops, or an owner who has just stepped into the demo, had nothing to check
 * against.
 *
 * ## Why a context rather than a hook each caller runs
 *
 * `useCompanyFeatures()` is a `useLoad` wrapper with no shared cache, so every caller is another
 * `getCompany` round trip. The shell already ran one for feature flags; the picker, the practice
 * bar and the Me tab would each have added their own. This runs it ONCE per mounted company and
 * hands the answer down — `OperatorShell` reads `features` from here instead of calling the hook
 * itself, so the shell gains nothing and the three new consumers cost nothing.
 *
 * (Operator pages outside the shell — the maintenance page, the inventory gate — still call
 * `useCompanyFeatures` directly. Converting them is a separate, larger change and not this one's
 * business.)
 *
 * ## Demo mode costs a non-demo operator ZERO extra requests
 *
 * Demo mode is not a flag; it is a second, hidden `company_id` you navigate into. Both facts that
 * decide it — `is_demo` and `demo_company_id` — are columns on the company row `getCompany`
 * already selects, so "am I in a demo?" and "does this shop have one?" are answered by the fetch
 * the shell was making anyway. Only the remaining question needs a request of its own — "what is
 * the REAL name of the company this demo stands in for?" — and that one fires only when
 * `isDemo` is true, which for nearly every operator is never. Bundle weight and request count are
 * expensive on a phone on cellular; this is why the shape is what it is.
 *
 * ## `companyName` is the REAL name, always
 *
 * A demo company's own row is named "X - Demo", which is internal bookkeeping. Inside a demo the
 * user sees their own company's name with the practice bar saying it is not real — the same
 * convention the office `CompanySwitcher` follows. Showing "X - Demo" would leak the
 * implementation and, worse, make the picker's company line disagree with the office's.
 */

import { createContext, useContext, type ReactNode } from 'react';
import { useParams } from 'next/navigation';

import { useCompanyFeatures } from '@/hooks/useCompanyFeatures';
import { useLoad } from '@/hooks/useLoad';
import { getDemoSourceCompany } from '@/utils/demoAccess';
import type { KnownFeatureKey } from '@/lib/featureFlags';

export interface OperatorCompanyContextValue {
  /** The company in the URL — a demo company's id when in a demo. */
  companyId: string;
  /** Display name. The REAL company's name even inside a demo; null until resolved. */
  companyName: string | null;
  /** True when the URL's company is a demo company. */
  isDemo: boolean;
  /**
   * The shop has a demo an admin created. Drives the Me-tab entry, which must not
   * appear for a shop that has never set one up: an operator cannot create one
   * (`create_demo_company` raises for non-admins) so the button would dead-end.
   */
  hasDemo: boolean;
  /** The demo to enter. Null when already in it, or when none exists. */
  demoCompanyId: string | null;
  /** The company to return to. Non-null only inside a demo. */
  realCompanyId: string | null;
  features: Record<KnownFeatureKey, boolean>;
  loading: boolean;
}

const OperatorCompanyContext = createContext<OperatorCompanyContextValue | null>(null);

export function useOperatorCompany(): OperatorCompanyContextValue {
  const ctx = useContext(OperatorCompanyContext);
  if (!ctx) {
    throw new Error('useOperatorCompany must be used within an OperatorCompanyProvider');
  }
  return ctx;
}

export function OperatorCompanyProvider({ children }: { children: ReactNode }) {
  const params = useParams();
  const companyId = params.companyId as string;

  const { features, companyName, isDemo, demoCompanyId, loading } = useCompanyFeatures();

  // The second row, and the ONLY request demo mode adds — skipped entirely outside a demo,
  // which is nearly every operator, nearly always.
  //
  // `useLoad` rather than a hand-rolled effect for the reason its own header gives: every
  // setState happens inside the async callback, so this does not trip
  // `react-hooks/set-state-in-effect`. It also brings the request-id guard, which matters
  // here — the operator surface remounts this provider on a company switch, and a slow
  // lookup for the company you just left must not land on top of the one you are in.
  //
  // A rejection resolves to `data: null`, which is the right failure: a dropped request is
  // not evidence of anything. It costs the company NAME on the picker and the Leave
  // button's destination, both of which recover on the next resolve, and it must never be
  // mistaken for "this is not a demo" — `isDemo` comes off the company's own row and is
  // untouched, so the practice bar stays up and keeps telling the truth.
  const { data: source } = useLoad(
    async () => (isDemo && companyId ? getDemoSourceCompany(companyId) : null),
    [isDemo, companyId],
  );

  return (
    <OperatorCompanyContext.Provider
      value={{
        companyId,
        companyName: isDemo ? (source?.name ?? null) : companyName,
        isDemo,
        // Inside a demo one demonstrably exists — you are standing in it.
        hasDemo: isDemo || Boolean(demoCompanyId),
        demoCompanyId: isDemo ? null : demoCompanyId,
        realCompanyId: isDemo ? (source?.id ?? null) : companyId,
        features,
        loading,
      }}
    >
      {children}
    </OperatorCompanyContext.Provider>
  );
}
