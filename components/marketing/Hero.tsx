'use client';

import Container from '@mui/material/Container';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import JiggedIcon from '@/components/branding/JiggedIcon';
import EmailCapture from './EmailCapture';

export default function Hero() {
  return (
    <Box
      sx={{
        position: 'relative',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: 'calc(100vh - 64px - 48px)',
        py: { xs: 4, md: 6 },
        '&::before': {
          content: '""',
          position: 'absolute',
          inset: 0,
          backgroundImage: `
            linear-gradient(rgba(70,130,180,0.07) 1px, transparent 1px),
            linear-gradient(90deg, rgba(70,130,180,0.07) 1px, transparent 1px)
          `,
          backgroundSize: '60px 60px',
          maskImage: 'radial-gradient(ellipse at center, black 30%, transparent 70%)',
          WebkitMaskImage: 'radial-gradient(ellipse at center, black 30%, transparent 70%)',
          pointerEvents: 'none',
        },
      }}
    >
      <Container maxWidth="lg">
        <Box
          sx={{
            display: 'flex',
            flexDirection: { xs: 'column', md: 'row' },
            alignItems: 'center',
            gap: { xs: 4, md: 8 },
          }}
        >
          {/* Icon — visual anchor */}
          <Box
            sx={{
              flexShrink: 0,
              display: 'flex',
              justifyContent: 'center',
            }}
          >
            <JiggedIcon size={160} />
          </Box>

          {/* Content */}
          <Box sx={{ textAlign: { xs: 'center', md: 'left' } }}>
            <Typography
              variant="h2"
              component="h1"
              sx={{
                fontWeight: 700,
                mb: 2,
                fontSize: { xs: '2.25rem', sm: '3rem', md: '3.75rem' },
                lineHeight: 1.1,
              }}
            >
              Your Shop Floor,
              <br />
              Finally Under Control
            </Typography>

            <Typography
              variant="body1"
              sx={{
                color: 'rgba(255, 255, 255, 0.85)',
                mb: 4,
                maxWidth: 520,
                fontSize: { xs: '1rem', md: '1.15rem' },
                lineHeight: 1.7,
              }}
            >
              Built for precision manufacturing.
              <br />
              Everything you need, nothing you don&apos;t.
            </Typography>

            <Box sx={{ maxWidth: 480 }}>
              <EmailCapture source="landing_hero" />
            </Box>
          </Box>
        </Box>
      </Container>
    </Box>
  );
}
