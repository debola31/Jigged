'use client';

import Container from '@mui/material/Container';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import Link from 'next/link';
import Reveal from './Reveal';
import { HERO } from '@/lib/constants/marketing';
import {
  gradientButtonSx,
  eyebrowSx,
  DISPLAY_FONT,
  EYEBROW_COLOR,
} from './marketingStyles';

export default function Hero() {
  const backgroundSx = {
    position: 'absolute',
    bottom: 0,
    left: 0,
    width: '100%',
    height: '100%',
    objectFit: 'cover',
    objectPosition: 'center bottom',
    opacity: 0.18,
    mixBlendMode: 'screen',
    maskImage:
      'radial-gradient(ellipse 65% 60% at 50% 42%, transparent 0%, black 100%)',
    WebkitMaskImage:
      'radial-gradient(ellipse 65% 60% at 50% 42%, transparent 0%, black 100%)',
    pointerEvents: 'none',
    zIndex: 0,
  } as const;

  return (
    <Box
      component="section"
      sx={{
        position: 'relative',
        display: 'flex',
        alignItems: 'center',
        minHeight: { md: 'calc(100vh - 64px - 48px)' },
        pt: { xs: 7, md: 9 },
        pb: { xs: 10, md: 14 },
        overflow: 'hidden',
        '&::before': {
          content: '""',
          position: 'absolute',
          inset: 0,
          backgroundImage: `
            linear-gradient(rgba(70,130,180,0.08) 1px, transparent 1px),
            linear-gradient(90deg, rgba(70,130,180,0.08) 1px, transparent 1px)
          `,
          backgroundSize: '52px 52px',
          maskImage:
            'radial-gradient(ellipse at 25% 35%, black 15%, transparent 70%)',
          WebkitMaskImage:
            'radial-gradient(ellipse at 25% 35%, black 15%, transparent 70%)',
          pointerEvents: 'none',
        },
      }}
    >
      <Container maxWidth="lg" sx={{ position: 'relative', zIndex: 1 }}>
        <Box
          sx={{
            display: 'flex',
            flexDirection: { xs: 'column', md: 'row' },
            alignItems: 'center',
            gap: { xs: 6, md: 6 },
          }}
        >
          {/* Copy */}
          <Reveal distance={28} sx={{ flex: { md: '0 0 52%' }, width: '100%' }}>
            <Box sx={{ textAlign: { xs: 'center', md: 'left' } }}>
              <Typography sx={{ ...eyebrowSx, color: EYEBROW_COLOR, mb: 3 }}>
                {HERO.eyebrow}
              </Typography>
              <Typography
                component="h1"
                sx={{
                  fontFamily: DISPLAY_FONT,
                  fontWeight: 600,
                  fontSize: 'clamp(2.75rem, 7vw, 5.5rem)',
                  lineHeight: 0.98,
                  letterSpacing: '-0.035em',
                  textShadow: '0 2px 30px rgba(0,0,0,0.5)',
                }}
              >
                {HERO.headlineLead}
                <Box component="span" sx={{ display: 'block', color: '#fff' }}>
                  {HERO.headlineEmphasis}
                </Box>
              </Typography>
              <Typography
                sx={{
                  mt: 4,
                  color: 'rgba(255, 255, 255, 0.78)',
                  fontSize: { xs: '1.05rem', md: '1.22rem' },
                  lineHeight: 1.6,
                  maxWidth: 520,
                  mx: { xs: 'auto', md: 0 },
                }}
              >
                {HERO.subhead}
              </Typography>
              <Box
                sx={{
                  mt: 5,
                  display: 'flex',
                  flexDirection: { xs: 'column', sm: 'row' },
                  gap: 2,
                  alignItems: 'center',
                  justifyContent: { xs: 'center', md: 'flex-start' },
                }}
              >
                <Button
                  component={Link}
                  href={HERO.primaryCta.href}
                  variant="contained"
                  size="large"
                  sx={{ minWidth: 210, py: 1.4, fontSize: '1rem', ...gradientButtonSx }}
                >
                  {HERO.primaryCta.label}
                </Button>
                <Button
                  component="a"
                  href={HERO.secondaryCta.href}
                  variant="text"
                  size="large"
                  sx={{
                    color: 'rgba(255,255,255,0.85)',
                    fontWeight: 500,
                    '&:hover': { color: '#fff', bgcolor: 'rgba(255,255,255,0.06)' },
                  }}
                >
                  {HERO.secondaryCta.label} →
                </Button>
              </Box>
            </Box>
          </Reveal>

          {/* Product proof — frameless, dissolving into the page */}
          <Reveal
            delay={160}
            distance={36}
            sx={{ flex: { md: '1 1 auto' }, width: '100%', minWidth: 0 }}
          >
            <Box sx={{ position: 'relative' }}>
              <Box
                aria-hidden
                sx={{
                  position: 'absolute',
                  inset: '2% -6% -10% -2%',
                  background:
                    'radial-gradient(closest-side, rgba(70,130,180,0.28), transparent)',
                  filter: 'blur(56px)',
                  zIndex: 0,
                }}
              />
              <Box
                component="img"
                src="/screenshots/feature-job-status.png"
                alt="Jigged job list showing the status of every job at a glance"
                sx={{
                  position: 'relative',
                  zIndex: 1,
                  width: '100%',
                  height: 'auto',
                  borderRadius: 2,
                  border: '1px solid rgba(255,255,255,0.1)',
                  boxShadow: '0 40px 90px -30px rgba(0,0,0,0.8)',
                  maskImage:
                    'linear-gradient(to bottom, black 82%, transparent 100%)',
                  WebkitMaskImage:
                    'linear-gradient(to bottom, black 82%, transparent 100%)',
                }}
              />
            </Box>
          </Reveal>
        </Box>
      </Container>

      {/* Looping wireframe manufacturing scene — ambient backdrop */}
      <Box
        component="video"
        autoPlay
        loop
        muted
        playsInline
        poster="/wireframe-scene.png"
        preload="none"
        sx={{
          ...backgroundSx,
          '@media (prefers-reduced-motion: reduce)': { display: 'none' },
        }}
      >
        <source src="/wireframe-scene.mp4" type="video/mp4" />
      </Box>
      <Box
        component="img"
        src="/wireframe-scene.png"
        alt=""
        sx={{
          ...backgroundSx,
          display: 'none',
          '@media (prefers-reduced-motion: reduce)': { display: 'block' },
        }}
      />
    </Box>
  );
}
