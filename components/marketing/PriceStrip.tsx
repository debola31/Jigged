'use client';

import Box from '@mui/material/Box';
import Container from '@mui/material/Container';
import Typography from '@mui/material/Typography';
import Reveal from './Reveal';
import { PRICE_STRIP, PRICING } from '@/lib/constants/marketing';
import { EYEBROW_COLOR, DISPLAY_FONT } from './marketingStyles';

/**
 * The price, printed. Replaces the old capability-only LogoCloud, whose tags now ride on
 * this band's second line.
 *
 * Nobody in this category publishes a number — the nearest competitors link to a pricing
 * page that still won't print one — so this band is the cheapest differentiator on the
 * page and it disqualifies the wrong prospect before either side spends a call on it.
 *
 * The amount is read from PRICING, not repeated: that object is pinned by
 * __tests__/lib/pricingCopy.test.ts and cited in the Terms of Service, so there is one
 * string to change and one test guarding it.
 *
 * The number is solid white, never the brand gradient — the gradient sweeps through a
 * ~4.3:1 steel stop, and this is the one figure on the page people zoom in on. Same
 * reasoning as the pricing page's own amount.
 */
export default function PriceStrip() {
  return (
    <Box
      component="section"
      sx={{
        py: { xs: 3.5, md: 4.5 },
        borderTop: '1px solid rgba(255, 255, 255, 0.07)',
        borderBottom: '1px solid rgba(255, 255, 255, 0.07)',
      }}
    >
      <Container maxWidth="lg">
        <Reveal>
          <Box
            sx={{
              display: 'flex',
              flexDirection: { xs: 'column', md: 'row' },
              alignItems: { xs: 'flex-start', md: 'baseline' },
              justifyContent: 'center',
              textAlign: { xs: 'left', md: 'center' },
              gap: { xs: 1, md: 2 },
              flexWrap: 'wrap',
            }}
          >
            <Typography
              component="p"
              sx={{
                fontFamily: DISPLAY_FONT,
                fontWeight: 600,
                color: '#fff',
                fontSize: { xs: '1.5rem', md: '1.75rem' },
                letterSpacing: '-0.02em',
                lineHeight: 1.1,
              }}
            >
              {PRICING.amount}
              <Box
                component="span"
                sx={{ fontSize: '0.62em', fontWeight: 500, color: 'rgba(255,255,255,0.72)' }}
              >
                {PRICING.period}
              </Box>
            </Typography>
            <Typography
              sx={{
                color: 'rgba(255, 255, 255, 0.86)',
                fontSize: { xs: '1rem', md: '1.05rem' },
                lineHeight: 1.5,
              }}
            >
              {PRICE_STRIP.terms}{' '}
              <Box component="span" sx={{ color: 'rgba(255, 255, 255, 0.62)' }}>
                {PRICE_STRIP.trial}
              </Box>
            </Typography>
          </Box>
        </Reveal>

        <Reveal delay={80}>
          <Box
            sx={{
              mt: { xs: 2, md: 2.25 },
              display: 'flex',
              flexWrap: 'wrap',
              alignItems: 'center',
              justifyContent: { xs: 'flex-start', md: 'center' },
              gap: { xs: 1, md: 1.5 },
            }}
          >
            <Typography
              sx={{
                fontSize: '0.85rem',
                color: EYEBROW_COLOR,
                fontWeight: 500,
                mr: { md: 0.5 },
              }}
            >
              {PRICE_STRIP.fine}
            </Typography>
            {PRICE_STRIP.tags.map((tag) => (
              <Box
                key={tag}
                sx={{
                  px: 1.5,
                  py: 0.5,
                  borderRadius: 999,
                  border: '1px solid rgba(255, 255, 255, 0.14)',
                  color: 'rgba(255, 255, 255, 0.66)',
                  fontSize: '0.8rem',
                  fontWeight: 500,
                }}
              >
                {tag}
              </Box>
            ))}
          </Box>
        </Reveal>
      </Container>
    </Box>
  );
}
