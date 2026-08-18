'use client';

import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import MuiLink from '@mui/material/Link';
import Link from 'next/link';
import Section from './Section';
import Reveal from './Reveal';
import { PRICING } from '@/lib/constants/marketing';
import { gradientButtonSx, DISPLAY_FONT } from './marketingStyles';

/**
 * One price, one card, three questions. Typography only — no imagery.
 *
 * Deliberately does NOT redirect signed-in users the way LandingPageContent does: this
 * page is cited in the Terms of Service, so it has to render for everyone who follows
 * that link, the same as /terms and /privacy.
 */
export default function PricingPageContent() {
  return (
    <>
      <Section maxWidth="md" grid sx={{ pt: { xs: 7, md: 10 } }}>
        <Reveal distance={28}>
          <Typography
            component="h1"
            sx={{
              textAlign: 'center',
              fontFamily: DISPLAY_FONT,
              fontWeight: 600,
              fontSize: 'clamp(2.25rem, 5vw, 3.75rem)',
              lineHeight: 1.02,
              letterSpacing: '-0.03em',
            }}
          >
            {PRICING.headlineLead}
            {/* Forced break: at ≥1200px the full string all but fills the container, so
                left to wrap it breaks raggedly on any font-metric variation. */}
            <Box component="span" sx={{ display: 'block' }}>
              {PRICING.headlineEmphasis}
            </Box>
          </Typography>
        </Reveal>

        <Reveal delay={100} distance={24}>
          <Box
            sx={{
              mt: { xs: 5, md: 7 },
              mx: 'auto',
              maxWidth: 560,
              p: { xs: 3.5, md: 6 },
              textAlign: 'center',
              borderRadius: 2,
              // The `raised` surface recipe from Section.tsx, on a bounded card rather
              // than a full-bleed band.
              bgcolor: 'rgba(17, 20, 57, 0.55)',
              backdropFilter: 'blur(6px)',
              WebkitBackdropFilter: 'blur(6px)',
              border: '1px solid rgba(255, 255, 255, 0.1)',
            }}
          >
            {/* Solid white, not gradient text: the gradient is the "act here" signal and
                belongs to the CTA below. This number also gets zoomed and read under
                shop lighting, where 15:1 beats the gradient's ~4.3:1 steel stop. */}
            <Typography
              component="p"
              sx={{
                fontFamily: DISPLAY_FONT,
                fontWeight: 600,
                color: '#fff',
                fontSize: { xs: '2.75rem', md: '3.5rem' },
                lineHeight: 1,
                letterSpacing: '-0.03em',
              }}
            >
              {PRICING.amount}
              <Box
                component="span"
                sx={{
                  fontSize: { xs: '1.25rem', md: '1.5rem' },
                  fontWeight: 500,
                  letterSpacing: 0,
                  color: 'rgba(255, 255, 255, 0.72)',
                }}
              >
                {PRICING.period}
              </Box>
            </Typography>
            <Typography
              sx={{
                mt: 1,
                color: 'rgba(255, 255, 255, 0.72)',
                fontSize: { xs: '1rem', md: '1.08rem' },
              }}
            >
              {PRICING.unit}
            </Typography>

            <Box
              component="ul"
              sx={{
                listStyle: 'none',
                p: 0,
                mb: 0,
                mt: { xs: 3.5, md: 4 },
                pt: { xs: 3.5, md: 4 },
                borderTop: '1px solid rgba(255,255,255,0.14)',
                display: 'flex',
                flexDirection: 'column',
                gap: 1.5,
              }}
            >
              {PRICING.includes.map((line) => (
                <Typography
                  component="li"
                  key={line}
                  sx={{
                    color: 'rgba(255, 255, 255, 0.78)',
                    fontSize: { xs: '1rem', md: '1.05rem' },
                    lineHeight: 1.5,
                    maxWidth: 420,
                    mx: 'auto',
                  }}
                >
                  {line}
                </Typography>
              ))}
            </Box>

            <Button
              component={Link}
              href={PRICING.cta.href}
              variant="contained"
              size="large"
              sx={{
                mt: { xs: 4, md: 5 },
                width: { xs: '100%', sm: 'auto' },
                minWidth: { sm: 210 },
                py: 1.4,
                fontSize: '1rem',
                ...gradientButtonSx,
              }}
            >
              {PRICING.cta.label}
            </Button>
          </Box>
        </Reveal>

        <Reveal delay={160} distance={20}>
          <Typography
            sx={{
              mt: { xs: 4, md: 5 },
              textAlign: 'center',
              color: 'rgba(255, 255, 255, 0.72)',
              fontSize: { xs: '1rem', md: '1.05rem' },
              lineHeight: 1.6,
            }}
          >
            {PRICING.contact.lead}{' '}
            <MuiLink
              href={`mailto:${PRICING.contact.email}`}
              underline="hover"
              sx={{ color: 'rgba(255, 255, 255, 0.92)' }}
            >
              {PRICING.contact.email}
            </MuiLink>
            .
          </Typography>
        </Reveal>
      </Section>

      <Section surface="light" maxWidth="md" size="minor">
        <Reveal distance={24}>
          {/* SectionHeading isn't used here: its eyebrow/index row carries mb: 2.5
              unconditionally, so with no eyebrow it leaves ~20px of dead space. Same
              heading values, minus the gap. */}
          <Typography
            component="h2"
            sx={{
              textAlign: 'center',
              fontFamily: DISPLAY_FONT,
              fontWeight: 600,
              fontSize: 'clamp(2rem, 4.6vw, 3.4rem)',
              lineHeight: 1.04,
              letterSpacing: '-0.025em',
            }}
          >
            {PRICING.faqHeading}
          </Typography>
        </Reveal>

        <Box sx={{ maxWidth: 720, mx: 'auto', mt: { xs: 5, md: 7 } }}>
          {PRICING.faq.map((item, i) => (
            <Reveal key={item.q} delay={i * 80} distance={20}>
              <Box
                sx={{
                  mt: i === 0 ? 0 : { xs: 3.5, md: 4 },
                  pt: i === 0 ? 0 : { xs: 3.5, md: 4 },
                  borderTop: i === 0 ? 'none' : '1px solid rgba(255,255,255,0.14)',
                }}
              >
                <Typography
                  component="h3"
                  sx={{
                    fontFamily: DISPLAY_FONT,
                    fontWeight: 600,
                    fontSize: { xs: '1.3rem', md: '1.5rem' },
                    letterSpacing: '-0.02em',
                    mb: 1.5,
                  }}
                >
                  {item.q}
                </Typography>
                <Typography
                  sx={{
                    color: 'rgba(255, 255, 255, 0.72)',
                    fontSize: { xs: '1rem', md: '1.05rem' },
                    lineHeight: 1.65,
                  }}
                >
                  {item.a}
                </Typography>
              </Box>
            </Reveal>
          ))}
        </Box>
      </Section>
    </>
  );
}
