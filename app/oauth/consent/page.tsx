'use client';

import { Suspense } from 'react';
import Box from '@mui/material/Box';
import CircularProgress from '@mui/material/CircularProgress';

import { AuthLayout } from '@/components/auth';
import OAuthConsent from '@/components/auth/OAuthConsent';

/**
 * `/oauth/consent`: Supabase Auth's `authorization_url_path` (supabase/config.toml). Where someone
 * approves connecting an AI assistant to Jigged. The component documents the flow.
 */
export default function OAuthConsentPage() {
  return (
    <AuthLayout>
      <Suspense
        fallback={
          <Box sx={{ textAlign: 'center', py: 4 }}>
            <CircularProgress />
          </Box>
        }
      >
        <OAuthConsent />
      </Suspense>
    </AuthLayout>
  );
}
