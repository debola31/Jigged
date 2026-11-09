'use client';

import { Suspense, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { AuthLayout, Login as LoginComponent } from '@/components/auth';
import { isValidReturnTo } from '@/components/auth/Login';
import { useAuth } from '@/components/providers/AuthProvider';
import CircularProgress from '@mui/material/CircularProgress';
import Box from '@mui/material/Box';

function LoginPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user, loading } = useAuth();

  const expired = searchParams.get('expired') === 'true';
  const returnTo = searchParams.get('returnTo');
  const reason = searchParams.get('reason');

  useEffect(() => {
    if (!loading && user) {
      // Signed in: go where they were headed, else home. This runs on the SIGNED_IN that the
      // form's own sign-in fires too, after the form has pushed `returnTo`, so a bare
      // replace('/') here overrode it and every returnTo landed on the dashboard instead. The
      // case that exposed it: connecting an AI assistant while signed out, where the consent
      // page's authorization_id was lost and the assistant's sign-in dead-ended.
      router.replace(returnTo && isValidReturnTo(returnTo) ? returnTo : '/');
    }
  }, [user, loading, router, returnTo]);

  // Show loading while checking auth status
  if (loading) {
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

  // Don't render login form if user is already logged in
  if (user) {
    return null;
  }

  return (
    <AuthLayout>
      <LoginComponent expired={expired} returnTo={returnTo} reason={reason} />
    </AuthLayout>
  );
}

export default function LoginPage() {
  return (
    <Suspense
      fallback={
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
      }
    >
      <LoginPageContent />
    </Suspense>
  );
}
