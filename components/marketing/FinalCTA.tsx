'use client';

import Container from '@mui/material/Container';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import Stack from '@mui/material/Stack';
import Link from 'next/link';
import EmailCapture from './EmailCapture';

export default function FinalCTA() {
  return (
    <Box
      component="section"
      sx={{ py: { xs: 6, md: 10 } }}
    >
      <Container maxWidth="md">
        <Box sx={{ textAlign: 'center' }}>
          <Typography
            variant="h3"
            component="h2"
            sx={{
              fontWeight: 700,
              mb: 2,
              fontSize: { xs: '1.5rem', md: '2rem' },
            }}
          >
            Ready to run your shop without fighting your software?
          </Typography>

          <Typography
            variant="body1"
            sx={{
              color: 'rgba(255, 255, 255, 0.75)',
              mb: 4,
              maxWidth: 560,
              mx: 'auto',
              fontSize: { xs: '1rem', md: '1.1rem' },
              lineHeight: 1.7,
            }}
          >
            Jigged is free during early access. We&apos;re working with a small
            group of shops to build exactly what you need.
          </Typography>

          <Stack
            direction={{ xs: 'column', sm: 'row' }}
            spacing={2}
            justifyContent="center"
            alignItems="center"
          >
            <Button
              component={Link}
              href="/invite/early-access"
              variant="contained"
              size="large"
              sx={{
                minWidth: 200,
                fontWeight: 600,
                background: 'linear-gradient(135deg, #D4872A 0%, #4682B4 50%, #2BBCB3 100%)',
                '&:hover': {
                  background: 'linear-gradient(135deg, #b8721f 0%, #3A6B94 50%, #239e97 100%)',
                },
              }}
            >
              Get Started
            </Button>
          </Stack>

          <Box sx={{ mt: 4, maxWidth: 480, mx: 'auto' }}>
            <Typography
              variant="body2"
              sx={{ color: 'rgba(255, 255, 255, 0.5)', mb: 2 }}
            >
              Or request early access and we&apos;ll reach out:
            </Typography>
            <EmailCapture source="landing_footer_cta" />
          </Box>
        </Box>
      </Container>
    </Box>
  );
}
