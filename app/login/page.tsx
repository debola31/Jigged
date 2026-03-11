'use client';

import { Suspense, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { AuthLayout, Login as LoginComponent } from '@/components/auth';
import { useAuth } from '@/components/providers/AuthProvider';
import CircularProgress from '@mui/material/CircularProgress';
import Box from '@mui/material/Box';

function LoginPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user, loading } = useAuth();

  const expired = searchParams.get('expired') === 'true';
  const returnTo = searchParams.get('returnTo');

  useEffect(() => {
    if (!loading && user) {
      // User is already logged in, redirect to home
      router.replace('/');
    }
  }, [user, loading, router]);

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
      <LoginComponent expired={expired} returnTo={returnTo} />
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
