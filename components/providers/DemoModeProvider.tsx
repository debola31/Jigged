'use client';

import {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  Fragment,
  type ReactNode,
} from 'react';
import { useParams, usePathname, useRouter } from 'next/navigation';
import posthog from 'posthog-js';
import { useAuth } from '@/components/providers/AuthProvider';
import {
  getDemoStatus,
  createDemoCompany,
  resetDemoCompany,
  syncDemoAccess,
  type DemoStatus,
} from '@/utils/demoAccess';

interface DemoModeContextType {
  isDemoMode: boolean;
  hasDemoCompany: boolean;
  demoCompanyId: string | null;
  realCompanyId: string;
  realCompanyName: string;
  enterDemoMode: () => Promise<void>;
  exitDemoMode: () => void;
  resetDemo: () => Promise<void>;
  isLoading: boolean;
  isCreating: boolean;
  isResetting: boolean;
}

const DemoModeContext = createContext<DemoModeContextType | null>(null);

export function useDemoMode(): DemoModeContextType {
  const context = useContext(DemoModeContext);
  if (!context) {
    throw new Error('useDemoMode must be used within a DemoModeProvider');
  }
  return context;
}

export default function DemoModeProvider({ children }: { children: ReactNode }) {
  const params = useParams();
  const pathname = usePathname();
  const router = useRouter();
  const { user } = useAuth();
  const companyId = params.companyId as string;

  const [status, setStatus] = useState<DemoStatus | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isCreating, setIsCreating] = useState(false);
  const [isResetting, setIsResetting] = useState(false);
  const [resetKey, setResetKey] = useState(0);

  useEffect(() => {
    if (!companyId) return;

    let cancelled = false;

    async function fetchStatus() {
      setIsLoading(true);
      try {
        const result = await getDemoStatus(companyId);
        if (!cancelled) {
          setStatus(result);
        }
      } catch (err) {
        console.error('Error fetching demo status:', err);
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    }

    fetchStatus();
    return () => { cancelled = true; };
  }, [companyId]);

  const isDemoMode = status?.isDemoCompany ?? false;
  const hasDemoCompany = status?.hasDemoCompany ?? false;
  const demoCompanyId = status?.demoCompanyId ?? null;
  const realCompanyId = status?.sourceCompanyId ?? companyId;
  const realCompanyName = status?.sourceCompanyName ?? '';

  const enterDemoMode = useCallback(async () => {
    if (!user) return;

    let targetDemoId = demoCompanyId;

    if (!targetDemoId) {
      setIsCreating(true);
      try {
        targetDemoId = await createDemoCompany(realCompanyId, user.id);
        setStatus((prev) =>
          prev
            ? { ...prev, hasDemoCompany: true, demoCompanyId: targetDemoId }
            : prev
        );
      } catch (err) {
        console.error('Error creating demo company:', err);
        setIsCreating(false);
        return;
      }
      setIsCreating(false);
    } else {
      // Sync access for any new team members
      try {
        await syncDemoAccess(realCompanyId, targetDemoId);
      } catch (err) {
        console.error('Error syncing demo access:', err);
      }
    }

    // `surface` rather than two event names: the operator surface has its own way in
    // (components/operator/OperatorPracticeModeButton.tsx) and the two have to be
    // totalable. Encoding the surface in the name is what the tracking plan's convention
    // forbids — see docs/telemetry.md.
    posthog.capture('demo entered', { surface: 'office' });

    // Navigate to demo company, preserving current page
    const newPath = pathname.replace(realCompanyId, targetDemoId!);
    router.push(newPath);
  }, [user, demoCompanyId, realCompanyId, pathname, router]);

  const exitDemoMode = useCallback(() => {
    if (!demoCompanyId || !realCompanyId) return;
    const newPath = pathname.replace(demoCompanyId, realCompanyId);
    router.push(newPath);
  }, [demoCompanyId, realCompanyId, pathname, router]);

  const resetDemo = useCallback(async () => {
    if (!user || !realCompanyId) return;

    setIsResetting(true);
    try {
      await resetDemoCompany(realCompanyId, user.id);
      setResetKey(k => k + 1);
    } catch (err) {
      console.error('Error resetting demo:', err);
    } finally {
      setIsResetting(false);
    }
  }, [user, realCompanyId]);

  return (
    <DemoModeContext.Provider
      value={{
        isDemoMode,
        hasDemoCompany,
        demoCompanyId,
        realCompanyId,
        realCompanyName,
        enterDemoMode,
        exitDemoMode,
        resetDemo,
        isLoading,
        isCreating,
        isResetting,
      }}
    >
      <Fragment key={resetKey}>
        {children}
      </Fragment>
    </DemoModeContext.Provider>
  );
}
