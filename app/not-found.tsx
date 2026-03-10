'use client';

import { useRouter } from 'next/navigation';
import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Container from '@mui/material/Container';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import Stack from '@mui/material/Stack';
import CircularProgress from '@mui/material/CircularProgress';
import SearchOffIcon from '@mui/icons-material/SearchOff';
import { JiggedLogo } from '@/components/branding';
import { useAuth } from '@/components/providers/AuthProvider';

export default function NotFound() {
  const router = useRouter();
  const { user, loading } = useAuth();

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
              <SearchOffIcon
                sx={{ fontSize: 64, color: 'warning.main' }}
              />
            </Box>

            <Typography variant="h5" component="h1" gutterBottom>
              Page Not Found
            </Typography>

            <Typography variant="body1" color="text.secondary" sx={{ mb: 4 }}>
              The page you&apos;re looking for doesn&apos;t exist or may have been moved.
            </Typography>

            <Stack spacing={2}>
              {user ? (
                <Button
                  variant="contained"
                  onClick={() => router.push('/select-company')}
                  fullWidth
                >
                  Go to Dashboard
                </Button>
              ) : (
                <Button
                  variant="contained"
                  onClick={() => router.push('/login')}
                  fullWidth
                >
                  Go to Login
                </Button>
              )}
              <Button
                variant="outlined"
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
