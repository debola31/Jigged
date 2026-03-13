'use client';

import { Suspense } from 'react';
import { AuthLayout, ResetPassword as ResetPasswordComponent } from '@/components/auth';
import CircularProgress from '@mui/material/CircularProgress';
import Box from '@mui/material/Box';

function ResetPasswordContent() {
  return (
    <AuthLayout>
      <ResetPasswordComponent />
    </AuthLayout>
  );
}

export default function ResetPasswordPage() {
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
      <ResetPasswordContent />
    </Suspense>
  );
}
