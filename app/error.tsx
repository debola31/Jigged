'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Container from '@mui/material/Container';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import Stack from '@mui/material/Stack';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutline';
import { JiggedLogo } from '@/components/branding';
import { useAuth } from '@/components/providers/AuthProvider';

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const router = useRouter();
  const { user } = useAuth();

  useEffect(() => {
    console.error('Root error boundary:', error);
  }, [error]);

  return (
    <Container maxWidth="sm">
      <Box
        sx={{
          minHeight: '100vh',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          py: 4,
        }}
      >
        <Card elevation={3}>
          <CardContent sx={{ p: 4, textAlign: 'center' }}>
            <Box sx={{ mb: 3, display: 'flex', justifyContent: 'center' }}>
              <JiggedLogo size="large" />
            </Box>

            <Box sx={{ mb: 3 }}>
              <ErrorOutlineIcon
                sx={{ fontSize: 64, color: 'error.main' }}
              />
            </Box>

            <Typography variant="h5" component="h1" gutterBottom>
              Something Went Wrong
            </Typography>

            <Typography variant="body1" color="text.secondary" sx={{ mb: 2 }}>
              An unexpected error occurred. Please try again.
            </Typography>

            {error.message && (
              <Box
                sx={{
                  bgcolor: 'rgba(255, 255, 255, 0.05)',
                  borderRadius: 1,
                  p: 2,
                  mb: 4,
                }}
              >
                <Typography variant="body2" color="text.secondary">
                  {error.message}
                </Typography>
              </Box>
            )}

            <Stack spacing={2}>
              <Button variant="contained" onClick={reset} fullWidth>
                Try Again
              </Button>
              {user ? (
                <Button
                  variant="outlined"
                  onClick={() => router.push('/select-company')}
                  fullWidth
                >
                  Go to Dashboard
                </Button>
              ) : (
                <Button
                  variant="outlined"
                  onClick={() => router.push('/login')}
                  fullWidth
                >
                  Go to Login
                </Button>
              )}
              <Button
                variant="text"
                onClick={() => router.back()}
                fullWidth
              >
                Go Back
              </Button>
            </Stack>
          </CardContent>
        </Card>
      </Box>
    </Container>
  );
}
