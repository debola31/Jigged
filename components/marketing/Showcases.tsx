'use client';

import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import CheckRoundedIcon from '@mui/icons-material/CheckRounded';
import Section from './Section';
import Reveal from './Reveal';
import ScreenShot from './ScreenShot';
import { SHOWCASES, AI_EXAMPLES, AI_TRUST } from '@/lib/constants/marketing';
import { DISPLAY_FONT, EYEBROW_COLOR, eyebrowSx } from './marketingStyles';

/**
 * The only two stories that need a picture to be believed: reading a folder of drawings
 * into parts, and asking the shop a question. Everything else the product does is named
 * in the capability grid above, which is what let this go from three tall rows to two.
 *
 * Rows alternate, and the copy column is narrower than the media so the screenshot has
 * room to stay legible — an unreadable screenshot proves nothing.
 */

/** Worked question-and-answer pairs, shown instead of an empty chat box. */
function AskExamples() {
  return (
    <Box sx={{ mt: 3, display: 'flex', flexDirection: 'column', gap: 1.5 }}>
      {AI_EXAMPLES.map((ex) => (
        <Box key={ex.q}>
          <Typography
            sx={{
              color: 'rgba(255,255,255,0.6)',
              fontSize: { xs: '0.98rem', md: '1.02rem' },
              fontStyle: 'italic',
              lineHeight: 1.45,
            }}
          >
            “{ex.q}”
          </Typography>
          <Typography
            sx={{
              color: '#fff',
              fontFamily: DISPLAY_FONT,
              fontWeight: 500,
              fontSize: { xs: '1.05rem', md: '1.12rem' },
              lineHeight: 1.4,
              letterSpacing: '-0.01em',
            }}
          >
            {ex.a}
          </Typography>
        </Box>
      ))}
    </Box>
  );
}

/**
 * The trust block sits in body text and is never collapsed. This buyer verifies rather
 * than worries, so the useful thing is a checkable boundary — including the limit. Saying
 * what it does not do yet costs nothing against a demo that would show it anyway.
 */
function AskTrust() {
  return (
    <Box
      component="ul"
      sx={{
        listStyle: 'none',
        p: 0,
        mt: 3.25,
        display: 'flex',
        flexDirection: 'column',
        gap: 1,
        pl: 2.5,
        borderLeft: '2px solid rgba(127, 179, 224, 0.35)',
      }}
    >
      {AI_TRUST.map((line) => (
        <Typography
          component="li"
          key={line}
          sx={{ color: 'rgba(255,255,255,0.74)', fontSize: '0.98rem', lineHeight: 1.55 }}
        >
          {line}
        </Typography>
      ))}
    </Box>
  );
}

export default function Showcases() {
  return (
    <Section maxWidth="lg">
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: { xs: 6, md: 10 } }}>
        {SHOWCASES.map((s, i) => {
          const reverse = i % 2 === 1;
          return (
            <Box
              key={s.key}
              sx={{
                display: 'flex',
                flexDirection: { xs: 'column', md: reverse ? 'row-reverse' : 'row' },
                alignItems: 'center',
                gap: { xs: 4, md: 8 },
              }}
            >
              <Reveal distance={24} sx={{ flex: { md: '0 0 42%' }, width: '100%' }}>
                <Box sx={{ maxWidth: 500 }}>
                  <Typography sx={{ ...eyebrowSx, color: EYEBROW_COLOR, mb: 2 }}>
                    {s.eyebrow}
                  </Typography>
                  <Typography
                    component="h2"
                    sx={{
                      fontFamily: DISPLAY_FONT,
                      fontWeight: 600,
                      fontSize: { xs: '1.75rem', md: '2.3rem' },
                      lineHeight: 1.1,
                      letterSpacing: '-0.025em',
                      mb: 2.25,
                    }}
                  >
                    {s.headline}
                  </Typography>
                  <Typography
                    sx={{
                      color: 'rgba(255, 255, 255, 0.74)',
                      fontSize: { xs: '1.02rem', md: '1.12rem' },
                      lineHeight: 1.65,
                    }}
                  >
                    {s.description}
                  </Typography>

                  {s.points && (
                    <Box
                      component="ul"
                      sx={{
                        listStyle: 'none',
                        p: 0,
                        mt: 3,
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 1.5,
                      }}
                    >
                      {s.points.map((point) => (
                        <Box
                          component="li"
                          key={point}
                          sx={{ display: 'flex', alignItems: 'flex-start', gap: 1.5 }}
                        >
                          <CheckRoundedIcon
                            aria-hidden
                            sx={{ fontSize: 18, color: EYEBROW_COLOR, mt: '3px', flexShrink: 0 }}
                          />
                          <Typography
                            sx={{
                              color: 'rgba(255, 255, 255, 0.86)',
                              fontSize: '1rem',
                              lineHeight: 1.5,
                            }}
                          >
                            {point}
                          </Typography>
                        </Box>
                      ))}
                    </Box>
                  )}

                  {s.key === 'insights' && (
                    <>
                      <AskExamples />
                      <AskTrust />
                    </>
                  )}
                </Box>
              </Reveal>

              <Reveal
                delay={120}
                distance={32}
                sx={{ flex: { md: '1 1 auto' }, width: '100%', minWidth: 0 }}
              >
                {/* An optional second shot overlapping the first, the way the hero's phone
                    does. It exists because the drawings screenshot on its own showed where
                    the flow STARTS and stopped at the intermediary step; the quote is the
                    thing the reader actually wants at the end of it. Hidden below md,
                    where two overlapping screenshots are just clutter. */}
                <Box sx={{ position: 'relative' }}>
                  <ScreenShot src={s.image} alt={s.alt} />
                  {s.inset && (
                    <Box
                      sx={{
                        display: { xs: 'none', md: 'block' },
                        position: 'absolute',
                        // Low and right enough to leave the drawing itself readable —
                        // the sheet is the part of the first shot people look at.
                        right: { md: '-6%' },
                        bottom: { md: '-24%' },
                        width: { md: '48%' },
                        zIndex: 2,
                      }}
                    >
                      <ScreenShot
                        src={s.inset}
                        alt={s.insetAlt ?? ''}
                        width={2404}
                        height={1168}
                      />
                    </Box>
                  )}
                </Box>
              </Reveal>
            </Box>
          );
        })}
      </Box>
    </Section>
  );
}
