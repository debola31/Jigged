'use client';

import * as Sentry from "@sentry/nextjs";
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Typography from '@mui/material/Typography';
import { useAuth } from '@/components/providers/AuthProvider';
import { verifyCompanyAccess, setLastCompany, getUserRole } from '@/utils/companyAccess';
import { consumeSessionExpiry, isTransientAbortError, toError } from '@/lib/supabaseErrors';

interface AuthGuardProps {
  children: React.ReactNode;
  companyId?: string;
  requireCompany?: boolean;
}

export default function AuthGuard({
  children,
  companyId,
  requireCompany = true,
}: AuthGuardProps) {
  const router = useRouter();
  const { user, loading: authLoading } = useAuth();
  const [hasAccess, setHasAccess] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  /** The check itself failed — distinct from a confirmed denial. See the render below. */
  const [verifyFailed, setVerifyFailed] = useState(false);
  /** Bumped by the retry button to re-run the effect. */
  const [retryNonce, setRetryNonce] = useState(0);

  // Depend on the id, not the `user` object. `useAuth` hands back a fresh object on
  // every render, so keying the effect on object identity re-ran the whole access check
  // after each of its own setState calls — firing redundant concurrent Supabase queries,
  // which is what made the auth lock contend in the first place. A primitive dep makes
  // the effect run once per actual user change.
  const userId = user?.id;

  useEffect(() => {
    if (authLoading) return;

    if (!userId) {
      // Check if this is an unexpected session expiry (vs. first visit)
      const expiry = consumeSessionExpiry();
      if (expiry) {
        const params = new URLSearchParams({
          expired: 'true',
          returnTo: expiry.returnTo,
        });
        router.replace(`/login?${params.toString()}`);
      } else {
        router.replace('/login');
      }
      return;
    }

    // If no company verification needed, we're done
    if (!requireCompany || !companyId) {
      setLoading(false);
      setHasAccess(true);
      return;
    }

    // A superseded run must not write state. The effect still re-runs on a genuine user
    // change or a retry, so without this an older attempt can resolve after a newer one
    // and overwrite a correct answer with a stale one.
    let cancelled = false;

    async function checkAccess(attempt = 1): Promise<void> {
      try {
        const access = await verifyCompanyAccess(userId!, companyId!);
        if (cancelled) return;
        setHasAccess(access);
        setVerifyFailed(false);

        if (access) {
          // Redirect operators to their dedicated view
          const role = await getUserRole(userId!, companyId!);
          if (cancelled) return;
          if (role === 'operator') {
            router.replace(`/operator/${companyId}`);
            return;
          }
          await setLastCompany(userId!, companyId!);
        }
      } catch (err) {
        if (cancelled) return;

        // A stolen auth lock means another call superseded this one — not that access
        // was denied. The lock is held for milliseconds, so one retry clears it.
        if (isTransientAbortError(err) && attempt === 1) {
          return checkAccess(attempt + 1);
        }

        console.error('Error checking access:', err);

        // Don't page ourselves over a lock race that is now handled; anything else is
        // real and gets reported — normalised, so it groups as more than "e".
        if (!isTransientAbortError(err)) {
          Sentry.captureException(toError(err, 'Failed to verify company access'));
        }

        // Deliberately NOT setHasAccess(false). We don't know access was denied, only
        // that we couldn't check. Claiming denial is what showed "You don't have access
        // to this company" to people who did.
        setVerifyFailed(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    checkAccess();

    return () => {
      cancelled = true;
    };
  }, [userId, authLoading, companyId, requireCompany, router, retryNonce]);

  // Loading state
  if (authLoading || loading) {
    return (
      <Box
        sx={{
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          minHeight: '100vh',
        }}
      >
        <CircularProgress />
      </Box>
    );
  }

  // Not authenticated (should have been redirected)
  if (!user) {
    return null;
  }

  // The check failed, so we don't know the answer. Must be tested BEFORE the denial
  // branch, because `hasAccess` is still null here and `!hasAccess` would be true —
  // which is exactly how a failed check used to render as "you don't have access".
  if (requireCompany && verifyFailed) {
    return (
      <Box
        sx={{
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          minHeight: '100vh',
          flexDirection: 'column',
          gap: 2,
        }}
      >
        <Typography color="error.main" sx={{ mb: 2 }}>
          Couldn&apos;t check your access just now.
        </Typography>
        <Button
          variant="contained"
          onClick={() => {
            setVerifyFailed(false);
            setLoading(true);
            setRetryNonce((n) => n + 1);
          }}
        >
          Try Again
        </Button>
      </Box>
    );
  }

  // No access to company
  if (requireCompany && !hasAccess) {
    return (
      <Box
        sx={{
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          minHeight: '100vh',
          flexDirection: 'column',
          gap: 2,
        }}
      >
        <Typography color="error.main" sx={{ mb: 2 }}>
          You don&apos;t have access to this company.
        </Typography>
        <Button variant="contained" onClick={() => router.push('/select-company')}>
          Select a Different Company
        </Button>
      </Box>
    );
  }

  return <>{children}</>;
}
