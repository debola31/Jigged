'use client';

import * as Sentry from "@sentry/nextjs";
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Typography from '@mui/material/Typography';
import { useAuth } from '@/components/providers/AuthProvider';
import { verifyCompanyAccess, setLastCompany } from '@/utils/companyAccess';

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

  useEffect(() => {
    if (authLoading) return;

    if (!user) {
      router.replace('/login');
      return;
    }

    // If no company verification needed, we're done
    if (!requireCompany || !companyId) {
      setLoading(false);
      setHasAccess(true);
      return;
    }

    async function checkAccess() {
      try {
        const access = await verifyCompanyAccess(user!.id, companyId!);
        setHasAccess(access);

        if (access) {
          await setLastCompany(user!.id, companyId!);
        }
      } catch (err) {
        console.error('Error checking access:', err);
        Sentry.captureException(err);
        setHasAccess(false);
      } finally {
        setLoading(false);
      }
    }

    checkAccess();
  }, [user, authLoading, companyId, requireCompany, router]);

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
