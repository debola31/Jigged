'use client';

import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import Section from './Section';
import SectionHeading from './SectionHeading';
import Reveal from './Reveal';
import { STEPS, FIRST_WEEK } from '@/lib/constants/marketing';
import { gradientTextSx, DISPLAY_FONT, EYEBROW_COLOR } from './marketingStyles';

export default function HowItWorks() {
  return (
    <Section id="how-it-works" surface="light" maxWidth="lg">
      <Reveal distance={28}>
        <SectionHeading eyebrow="Getting started" heading="How it works" />
      </Reveal>

      <Stack
        direction={{ xs: 'column', md: 'row' }}
        spacing={{ xs: 3, md: 5 }}
        sx={{ mt: { xs: 4, md: 7 } }}
      >
        {STEPS.map((step, i) => (
          <Reveal key={step.number} delay={i * 100} distance={24} sx={{ flex: 1 }}>
            <Box sx={{ height: '100%' }}>
              <Typography
                sx={{
                  ...gradientTextSx,
                  fontFamily: DISPLAY_FONT,
                  fontWeight: 600,
                  fontSize: { xs: '2.25rem', md: '3.5rem' },
                  lineHeight: 1,
                  letterSpacing: '-0.03em',
                  mb: { xs: 1.5, md: 2.5 },
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

      {/* The concrete answer to "how long until we're running", which the reviews in this
          category say is the objection that actually kills these deals — ahead of price.
          Moved up the page with this section for the same reason. */}
      <Reveal delay={200} distance={20}>
        <Box
          sx={{
            mt: { xs: 4, md: 6 },
            pt: { xs: 3.5, md: 4.5 },
            borderTop: '1px solid rgba(255,255,255,0.14)',
            display: 'flex',
            flexDirection: { xs: 'column', md: 'row' },
            gap: { xs: 3, md: 6 },
            alignItems: { md: 'baseline' },
          }}
        >
          <Typography
            component="h3"
            sx={{
              fontFamily: DISPLAY_FONT,
              fontWeight: 600,
              fontSize: { xs: '1.2rem', md: '1.35rem' },
              letterSpacing: '-0.02em',
              flexShrink: 0,
            }}
          >
            {FIRST_WEEK.heading}
          </Typography>

          <Box>
            <Box
              component="ul"
              sx={{
                listStyle: 'none',
                p: 0,
                m: 0,
                display: 'flex',
                flexDirection: { xs: 'column', md: 'row' },
                flexWrap: 'wrap',
                gap: { xs: 1.25, md: 3 },
              }}
            >
              {FIRST_WEEK.days.map((day) => (
                <Typography
                  component="li"
                  key={day}
                  sx={{
                    color: 'rgba(255, 255, 255, 0.82)',
                    fontSize: { xs: '1rem', md: '1.02rem' },
                    lineHeight: 1.5,
                  }}
                >
                  {day}
                </Typography>
              ))}
            </Box>
            <Typography
              sx={{
                mt: 2,
                color: EYEBROW_COLOR,
                fontSize: { xs: '1rem', md: '1.02rem' },
                lineHeight: 1.55,
              }}
            >
              {FIRST_WEEK.demo}
            </Typography>
          </Box>
        </Box>
      </Reveal>
    </Section>
  );
}
