'use client';

import Container from '@mui/material/Container';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import useMediaQuery from '@mui/material/useMediaQuery';
import Link from 'next/link';
import posthog from 'posthog-js';
import Reveal from './Reveal';
import ScreenShot from './ScreenShot';
import { HERO } from '@/lib/constants/marketing';
import {
  gradientButtonSx,
  eyebrowSx,
  DISPLAY_FONT,
  EYEBROW_COLOR,
} from './marketingStyles';

export default function Hero() {
  // Decorative only, so `noSsr` is safe and correct: there is no server-rendered truth to
  // match, and the first client paint is the first paint that matters for a backdrop.
  const wideEnoughForVideo = useMediaQuery('(min-width:900px)', { noSsr: true });
  const prefersReducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)', {
    noSsr: true,
  });

  const backgroundSx = {
    position: 'absolute',
    bottom: 0,
    left: 0,
    width: '100%',
    height: '100%',
    objectFit: 'cover',
    objectPosition: 'center bottom',
    // The scene is the one piece of shop-floor character in the hero; at 0.18 it was
    // so faint it paid no rent. The radial mask below already keeps it out of the
    // centre (where the headline sits), so it can carry more without touching text —
    // it's `screen`, so this lightens the edges only.
    opacity: 0.32,
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
        pt: { xs: 5, md: 9 },
        pb: { xs: 7, md: 12 },
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
                  onClick={() => posthog.capture('marketing cta clicked', { location: 'hero' })}
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
            {/* The one above-the-fold image, so it loads eagerly at high priority while
                everything below stays lazy. Framing moved into the shared ScreenShot
                component — this used to be a second, slightly drifted copy of the recipe
                inside Features.tsx. */}
            <ScreenShot
              src="/screenshots/feature-job-status.png"
              alt="Jigged job list showing the status of every job at a glance"
              fade
              priority
            />
          </Reveal>
        </Box>
      </Container>

      {/* Looping wireframe manufacturing scene — ambient backdrop, at opacity 0.32 behind
          a radial mask.

          IT IS A DESKTOP-ONLY LUXURY, and mounted rather than hidden. The clip is 1.6 MB —
          the single heaviest asset on the page, larger than every image put together — and
          `preload="none"` does NOT hold it back, because `autoPlay` overrides preload: an
          autoplaying video has to load. CSS-hiding it downloads it anyway.

          So it is only mounted at md and up, which is exactly the split the device model in
          CLAUDE.md draws: bundle weight is cheap on the office computer and expensive on
          the phone on cellular. Phones get the 175 KB still, which is what the poster was
          anyway. `noSsr` because this is decoration — there is nothing here to server-render
          correctly, and it avoids a hydration mismatch on the first paint. */}
      {wideEnoughForVideo && !prefersReducedMotion && (
        <Box
          component="video"
          autoPlay
          loop
          muted
          playsInline
          poster="/wireframe-scene.webp"
          sx={backgroundSx}
        >
          <source src="/wireframe-scene.mp4" type="video/mp4" />
        </Box>
      )}
      {(!wideEnoughForVideo || prefersReducedMotion) && (
        <Box
          component="img"
          src="/wireframe-scene.webp"
          alt=""
          sx={backgroundSx}
        />
      )}
    </Box>
  );
}
