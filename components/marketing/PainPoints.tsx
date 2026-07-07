'use client';

import Box from '@mui/material/Box';
import Grid from '@mui/material/Grid';
import Typography from '@mui/material/Typography';
import Section from './Section';
import SectionHeading from './SectionHeading';
import Reveal from './Reveal';
import { PAIN } from '@/lib/constants/marketing';
import { DISPLAY_FONT } from './marketingStyles';

export default function PainPoints() {
  return (
    <Section maxWidth="lg" hairlineTop>
      <Reveal distance={28}>
        <SectionHeading eyebrow={PAIN.eyebrow} heading={PAIN.heading} />
      </Reveal>

      <Grid container spacing={{ xs: 2, md: 3 }} sx={{ mt: { xs: 5, md: 7 } }}>
        {PAIN.points.map((quote, i) => (
          <Grid key={i} size={{ xs: 12, md: 6 }}>
            <Reveal delay={i * 70} distance={24}>
              <Box
                sx={{
                  height: '100%',
                  p: { xs: 3.5, md: 4 },
                  borderRadius: 2,
                  bgcolor: 'rgba(17, 20, 57, 0.4)',
                  border: '1px solid rgba(255, 255, 255, 0.07)',
                  borderLeft: '3px solid',
                  borderLeftColor: 'primary.main',
                }}
              >
                <Typography
                  component="p"
                  sx={{
                    fontFamily: DISPLAY_FONT,
                    color: 'rgba(255, 255, 255, 0.9)',
                    lineHeight: 1.32,
                    letterSpacing: '-0.01em',
                    fontSize: { xs: '1.2rem', md: '1.5rem' },
                  }}
                >
                  {quote}
                </Typography>
              </Box>
            </Reveal>
          </Grid>
        ))}
      </Grid>

      <Reveal delay={120}>
        <Typography
          sx={{
            mt: { xs: 5, md: 7 },
            maxWidth: 720,
            color: 'rgba(255, 255, 255, 0.72)',
            fontSize: { xs: '1.1rem', md: '1.35rem' },
            lineHeight: 1.5,
          }}
        >
          {PAIN.closer}
        </Typography>
      </Reveal>
    </Section>
  );
}
