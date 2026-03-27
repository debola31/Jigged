'use client';

import * as Sentry from '@sentry/nextjs';
import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { submitWaitlist } from '@/app/actions/waitlist';
import { SHOP_SIZES } from '@/lib/constants/marketing';
import Container from '@mui/material/Container';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import TextField from '@mui/material/TextField';
import Button from '@mui/material/Button';
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import Alert from '@mui/material/Alert';
import CircularProgress from '@mui/material/CircularProgress';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';

export default function InviteForm() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [companyName, setCompanyName] = useState('');
  const [shopSize, setShopSize] = useState('');
  const [status, setStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');

  useEffect(() => {
    if (status !== 'success') return;
    const timer = setTimeout(() => router.push('/'), 4000);
    return () => clearTimeout(timer);
  }, [status, router]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || !name || !companyName) return;

    setStatus('loading');
    try {
      const result = await submitWaitlist({
        email,
        name,
        company_name: companyName,
        shop_size: shopSize || null,
        source: 'invite_link',
      });

      if (result.error) throw new Error(result.error);
      setStatus('success');
    } catch (err) {
      setStatus('error');
      Sentry.captureException(err, { level: 'warning' });
    }
  };

  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: 'calc(100vh - 64px - 48px)',
        py: { xs: 6, md: 10 },
      }}
    >
      <Container maxWidth="sm">
        <Box
          sx={{
            bgcolor: 'rgba(17, 20, 57, 0.95)',
            backdropFilter: 'blur(20px)',
            border: '1px solid rgba(255, 255, 255, 0.1)',
            borderRadius: 3,
            p: { xs: 3, md: 5 },
          }}
        >
          {status === 'success' ? (
            <Stack spacing={2} alignItems="center" sx={{ py: 4 }}>
              <CheckCircleIcon sx={{ color: 'success.main', fontSize: 48 }} />
              <Typography
                variant="h5"
                sx={{ fontWeight: 600, textAlign: 'center' }}
              >
                You&apos;re in!
              </Typography>
              <Typography
                sx={{
                  color: 'rgba(255, 255, 255, 0.75)',
                  textAlign: 'center',
                  lineHeight: 1.7,
                }}
              >
                We&apos;ll have your shop set up shortly and send you a
                personal login.
              </Typography>
            </Stack>
          ) : (
            <>
              <Button
                href="/"
                size="small"
                startIcon={<ArrowBackIcon sx={{ fontSize: 16 }} />}
                sx={{
                  color: 'rgba(255, 255, 255, 0.5)',
                  textTransform: 'none',
                  mb: 2,
                  ml: -1,
                  '&:hover': { color: 'rgba(255, 255, 255, 0.8)' },
                }}
              >
                Back to home
              </Button>
              <Typography
                variant="h4"
                component="h1"
                sx={{
                  fontWeight: 700,
                  mb: 1,
                  fontSize: { xs: '1.5rem', md: '2rem' },
                }}
              >
                Get Started with Jigged
              </Typography>
              <Typography
                variant="body1"
                sx={{
                  color: 'rgba(255, 255, 255, 0.75)',
                  mb: 4,
                  lineHeight: 1.7,
                }}
              >
                Tell us about your shop and we&apos;ll get you set up
                personally.
              </Typography>

              <form onSubmit={handleSubmit}>
                <Stack spacing={2.5}>
                  <TextField
                    label="Name"
                    required
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    disabled={status === 'loading'}
                    fullWidth
                    sx={{ '& .MuiInputBase-root': { minHeight: 48 } }}
                  />
                  <TextField
                    label="Email"
                    type="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    disabled={status === 'loading'}
                    fullWidth
                    sx={{ '& .MuiInputBase-root': { minHeight: 48 } }}
                  />
                  <TextField
                    label="Company / Shop Name"
                    required
                    value={companyName}
                    onChange={(e) => setCompanyName(e.target.value)}
                    disabled={status === 'loading'}
                    fullWidth
                    sx={{ '& .MuiInputBase-root': { minHeight: 48 } }}
                  />
                  <TextField
                    label="Shop Size"
                    select
                    value={shopSize}
                    onChange={(e) => setShopSize(e.target.value)}
                    disabled={status === 'loading'}
                    fullWidth
                    sx={{ '& .MuiInputBase-root': { minHeight: 48 } }}
                  >
                    <MenuItem value="">
                      <em>Select (optional)</em>
                    </MenuItem>
                    {SHOP_SIZES.map((size) => (
                      <MenuItem key={size} value={size}>
                        {size}
                      </MenuItem>
                    ))}
                  </TextField>

                  {status === 'error' && (
                    <Alert severity="error">
                      Something went wrong. Email us at hello@jigged.app
                    </Alert>
                  )}

                  <Button
                    type="submit"
                    variant="contained"
                    size="large"
                    disabled={status === 'loading'}
                    sx={{
                      minHeight: 48,
                      fontWeight: 600,
                      background:
                        'linear-gradient(135deg, #D4872A 0%, #4682B4 50%, #2BBCB3 100%)',
                      '&:hover': {
                        background:
                          'linear-gradient(135deg, #b8721f 0%, #3A6B94 50%, #239e97 100%)',
                      },
                    }}
                  >
                    {status === 'loading' ? (
                      <CircularProgress size={22} color="inherit" />
                    ) : (
                      'Get Started'
                    )}
                  </Button>
                </Stack>
              </form>
            </>
          )}
        </Box>
      </Container>
    </Box>
  );
}
