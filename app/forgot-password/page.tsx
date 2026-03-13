'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { AuthLayout, ForgotPassword as ForgotPasswordComponent } from '@/components/auth';
import { useAuth } from '@/components/providers/AuthProvider';
import CircularProgress from '@mui/material/CircularProgress';
import Box from '@mui/material/Box';

export default function ForgotPasswordPage() {
  const router = useRouter();
  const { user, loading } = useAuth();

  useEffect(() => {
    if (!loading && user) {
      router.replace('/');
    }
  }, [user, loading, router]);

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

  if (user) {
    return null;
  }

  return (
    <AuthLayout>
      <ForgotPasswordComponent />
    </AuthLayout>
  );
}
