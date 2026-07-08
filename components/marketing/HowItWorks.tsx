'use client';

import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import Section from './Section';
import SectionHeading from './SectionHeading';
import Reveal from './Reveal';
import { STEPS } from '@/lib/constants/marketing';
import { gradientTextSx, DISPLAY_FONT } from './marketingStyles';

export default function HowItWorks() {
  return (
    <Section id="how-it-works" surface="light" maxWidth="lg">
      <Reveal distance={28}>
        <SectionHeading eyebrow="Getting started" heading="How it works" />
      </Reveal>

      <Stack
        direction={{ xs: 'column', md: 'row' }}
        spacing={{ xs: 4, md: 5 }}
        sx={{ mt: { xs: 6, md: 9 } }}
      >
        {STEPS.map((step, i) => (
          <Reveal key={step.number} delay={i * 100} distance={24} sx={{ flex: 1 }}>
            <Box sx={{ height: '100%' }}>
              <Typography
                sx={{
                  ...gradientTextSx,
                  fontFamily: DISPLAY_FONT,
                  fontWeight: 600,
                  fontSize: { xs: '2.75rem', md: '3.5rem' },
                  lineHeight: 1,
                  letterSpacing: '-0.03em',
                  mb: 2.5,
                }}
              >
                {step.number}
              </Typography>
              <Box
                sx={{
                  pt: 3,
                  borderTop: '1px solid rgba(255,255,255,0.14)',
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
                  {step.headline}
                </Typography>
                <Typography
                  sx={{
                    color: 'rgba(255, 255, 255, 0.72)',
                    lineHeight: 1.65,
                    fontSize: { xs: '1rem', md: '1.05rem' },
                  }}
                >
                  {step.description}
                </Typography>
              </Box>
            </Box>
          </Reveal>
        ))}
      </Stack>
    </Section>
  );
}
