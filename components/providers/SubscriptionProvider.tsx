'use client';

import {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  type ReactNode,
} from 'react';
import { useParams } from 'next/navigation';
import * as Sentry from '@sentry/nextjs';
import { useDemoMode } from '@/components/providers/DemoModeProvider';
import { getCompanyBilling, type CompanyBilling } from '@/utils/companyAccess';
import {
  getEntitlement,
  isWriteAllowed,
  type Entitlement,
} from '@/lib/entitlement';

/**
 * Reads the company's billing cache (via RLS — zero Stripe calls) and derives
 * entitlement. Demo companies short-circuit to `full` and never render billing
 * UI (D11). This is the UI twin of the DB `company_can_write()` gate; it drives
 * banners, not enforcement — the DB blocks writes regardless.
 */
interface SubscriptionContextType {
  entitlement: Entitlement;
  billing: CompanyBilling | null;
  isDemo: boolean;
  isPastDue: boolean;
  isReadOnly: boolean;
  mustSubscribe: boolean;
  canWrite: boolean;
  /** Whether a Stripe customer exists (→ "Manage billing" vs "Subscribe"). */
  hasCustomer: boolean;
  isLoading: boolean;
  refresh: () => Promise<void>;
}

const SubscriptionContext = createContext<SubscriptionContextType | null>(null);

export function useSubscription(): SubscriptionContextType {
  const context = useContext(SubscriptionContext);
  if (!context) {
    throw new Error('useSubscription must be used within a SubscriptionProvider');
  }
  return context;
}

export default function SubscriptionProvider({ children }: { children: ReactNode }) {
  const params = useParams();
  const companyId = params.companyId as string;
  const { isDemoMode, isLoading: demoLoading } = useDemoMode();

  const [billing, setBilling] = useState<CompanyBilling | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const fetchBilling = useCallback(async () => {
    if (!companyId) return;
    // Note: no synchronous setIsLoading(true) here. `isLoading` starts true, so
    // the first load shows the spinner; all state writes below happen after the
    // await (async), which keeps the calling effect free of synchronous setState.
    try {
      const row = await getCompanyBilling(companyId);
      setBilling(row);
    } catch (err) {
      // Billing path: surface loudly, never silently default to full. Leaving
      // billing null resolves to `must_subscribe` (a banner, not a block), and the
      // DB still enforces writes regardless of this UI read.
      Sentry.captureException(err);
      setBilling(null);
    } finally {
      setIsLoading(false);
    }
  }, [companyId]);

  useEffect(() => {
    if (demoLoading) return; // wait until we know whether this is a demo company
    if (isDemoMode) return; // demo companies are never billing-gated — skip the fetch
    // Inline async wrapper (mirrors DemoModeProvider) so the effect body doesn't
    // directly invoke a setState-bearing callback — react-hooks/set-state-in-effect.
    async function load() {
      await fetchBilling();
    }
    load();
  }, [companyId, isDemoMode, demoLoading, fetchBilling]);

  // Demo companies never fetch billing; treat their cache as empty and resolved.
  // Deriving these (rather than setting state inside the effect) keeps the effect
  // free of synchronous setState and gives the same result — getEntitlement
  // short-circuits is_demo → full regardless of the row.
  const effectiveBilling = isDemoMode ? null : billing;
  const loading = demoLoading || (!isDemoMode && isLoading);

  const entitlement = getEntitlement(isDemoMode, effectiveBilling);

  return (
    <SubscriptionContext.Provider
      value={{
        entitlement,
        billing: effectiveBilling,
        isDemo: isDemoMode,
        isPastDue: entitlement === 'past_due',
        isReadOnly: entitlement === 'read_only',
        mustSubscribe: entitlement === 'must_subscribe',
        canWrite: isWriteAllowed(entitlement),
        hasCustomer: Boolean(effectiveBilling?.stripe_customer_id),
        isLoading: loading,
        refresh: fetchBilling,
      }}
    >
      {children}
    </SubscriptionContext.Provider>
  );
}
