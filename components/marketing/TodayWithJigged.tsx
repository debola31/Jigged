'use client';

import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import ArrowForwardRoundedIcon from '@mui/icons-material/ArrowForwardRounded';
import Section from './Section';
import SectionHeading from './SectionHeading';
import Reveal from './Reveal';
import { TODAY_WITH_JIGGED } from '@/lib/constants/marketing';
import { DISPLAY_FONT, EYEBROW_COLOR } from './marketingStyles';

/**
 * Replaces the four PainPoints pull-quote cards. Same job — "why change" — but a table
 * makes the argument, names capabilities and does the positioning at once, in fewer words
 * and less height than four cards and a closing paragraph.
 *
 * The mechanism is that the reader finishes the left column before he reads the right, so
 * the left has to be recognisable rather than clever. It is set in the display face and
 * slightly brighter for that reason; the right column is the quieter answer.
 *
 * MOBILE. Below md this becomes a stack of rows rather than a two-column grid — a table
 * that reflows to one column silently doubles in height and loses the pairing, which is
 * the whole point. Each row keeps its own header so the two halves stay legible as a pair.
 */
export default function TodayWithJigged() {
  const { eyebrow, heading, columns, rows } = TODAY_WITH_JIGGED;

  return (
    <Section maxWidth="lg" hairlineTop>
      <Reveal distance={28}>
        <SectionHeading eyebrow={eyebrow} heading={heading} />
      </Reveal>

      <Box sx={{ mt: { xs: 3, md: 5 } }}>
        {/* Column headers — desktop only; each mobile row labels its own halves. */}
        <Box
          aria-hidden
          sx={{
            display: { xs: 'none', md: 'grid' },
            gridTemplateColumns: '1fr 1fr',
            gap: 4,
            pb: 1.5,
            mb: 1,
            borderBottom: '1px solid rgba(255,255,255,0.12)',
          }}
        >
          <Typography
            sx={{
              textTransform: 'uppercase',
              letterSpacing: '0.14em',
              fontSize: '0.72rem',
              fontWeight: 600,
              color: 'rgba(255,255,255,0.5)',
            }}
          >
            {columns.today}
          </Typography>
          <Typography
            sx={{
              textTransform: 'uppercase',
              letterSpacing: '0.14em',
              fontSize: '0.72rem',
              fontWeight: 600,
              color: EYEBROW_COLOR,
            }}
          >
            {columns.jigged}
          </Typography>
        </Box>

        {rows.map((row, i) => (
          <Reveal key={row.job} delay={i * 60} distance={20}>
            <Box
              sx={{
                py: { xs: 2, md: 2.25 },
                borderTop: i === 0 ? { xs: '1px solid rgba(255,255,255,0.12)', md: 'none' } : '1px solid rgba(255,255,255,0.08)',
              }}
            >
              <Typography
                component="h3"
                sx={{
                  fontSize: '0.8rem',
                  fontWeight: 600,
                  textTransform: 'uppercase',
                  letterSpacing: '0.1em',
                  color: 'rgba(255,255,255,0.42)',
                  mb: 1.25,
                }}
              >
                {row.job}
              </Typography>

              <Box
                sx={{
                  display: 'grid',
                  gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' },
                  gap: { xs: 1.25, md: 4 },
                  alignItems: 'start',
                }}
              >
                <Typography
                  sx={{
                    fontFamily: DISPLAY_FONT,
                    color: 'rgba(255, 255, 255, 0.82)',
                    fontSize: { xs: '1.05rem', md: '1.2rem' },
                    lineHeight: 1.4,
                    letterSpacing: '-0.01em',
                  }}
                >
                  {/* Mobile only: without a label the two halves read as one paragraph. */}
                  <Box
                    component="span"
                    sx={{
                      display: { xs: 'inline', md: 'none' },
                      color: 'rgba(255,255,255,0.45)',
                      fontWeight: 600,
                    }}
                  >
                    {columns.today}:{' '}
                  </Box>
                  {row.today}
                </Typography>

                <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1.25 }}>
                  <ArrowForwardRoundedIcon
                    aria-hidden
                    sx={{
                      display: { xs: 'none', md: 'block' },
                      fontSize: 18,
                      color: EYEBROW_COLOR,
                      mt: '5px',
                      flexShrink: 0,
                    }}
                  />
                  <Typography
                    sx={{
                      fontFamily: DISPLAY_FONT,
                      color: '#fff',
                      fontSize: { xs: '1.05rem', md: '1.2rem' },
                      lineHeight: 1.4,
                      letterSpacing: '-0.01em',
                    }}
                  >
                    <Box
                      component="span"
                      sx={{
                        display: { xs: 'inline', md: 'none' },
                        color: EYEBROW_COLOR,
                        fontWeight: 600,
                      }}
                    >
                      {columns.jigged}:{' '}
                    </Box>
                    {row.jigged}
                  </Typography>
                </Box>
              </Box>
            </Box>
          </Reveal>
        ))}
      </Box>
    </Section>
  );
}
