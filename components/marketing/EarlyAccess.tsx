'use client';

import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Section from './Section';
import Reveal from './Reveal';
import { EARLY_ACCESS } from '@/lib/constants/marketing';
import { gradientTextSx, DISPLAY_FONT } from './marketingStyles';

/** Honest "pricing" beat — no invented tiers, just the early-access reality. */
export default function EarlyAccess() {
  return (
    <Section surface="raised" maxWidth="md" size="minor">
      <Reveal>
        <Box sx={{ textAlign: 'center' }}>
          <Typography
            component="h2"
            sx={{
              ...gradientTextSx,
              fontFamily: DISPLAY_FONT,
              fontWeight: 600,
              fontSize: 'clamp(2rem, 4.2vw, 3.1rem)',
              letterSpacing: '-0.03em',
              mb: 2,
            }}
          >
            {EARLY_ACCESS.heading}
          </Typography>
          <Typography
            sx={{
              color: 'rgba(255, 255, 255, 0.78)',
              fontSize: { xs: '1.05rem', md: '1.2rem' },
              lineHeight: 1.6,
              maxWidth: 560,
              mx: 'auto',
            }}
          >
            {EARLY_ACCESS.body}
          </Typography>
        </Box>
      </Reveal>
    </Section>
  );
}
