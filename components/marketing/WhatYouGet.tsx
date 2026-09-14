'use client';

import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import CheckRoundedIcon from '@mui/icons-material/CheckRounded';
import Section from './Section';
import SectionHeading from './SectionHeading';
import Reveal from './Reveal';
import ScreenShot from './ScreenShot';
import PhoneShot from './PhoneShot';
import { WHAT_YOU_GET, AI_EXAMPLES, AI_TRUST } from '@/lib/constants/marketing';
import { DISPLAY_FONT, EYEBROW_COLOR, gradientTextSx, eyebrowSx } from './marketingStyles';

/**
 * The whole product, in five numbered rows.
 *
 * This replaces three sections that were arguing with each other: a "Quoting" showcase with
 * big screenshots, a chip grid that named the same capabilities again with no pictures, and
 * a standalone shop-floor section. The grid said WHAT and the showcases said LOOK, two
 * sections apart, which is one argument told twice at different resolutions.
 *
 * Each row is a number, a claim, ONE line of prose, the sub-features as chips, and a
 * picture. That balance is the design: the chips carry breadth (twenty capability names,
 * readable without a click), the picture carries proof, and the prose stays to a line.
 * Two earlier passes lost this by letting the prose grow back — if a row needs a second
 * sentence, the sentence is probably a chip.
 *
 * Rows alternate side to side, and the copy column is narrower than the media so the
 * screenshots stay legible. An unreadable screenshot proves nothing.
 */

/** Worked question-and-answer pairs. Never show an empty chat box. */
function AskExamples() {
  return (
    <Box sx={{ mt: 3, display: 'flex', flexDirection: 'column', gap: 1.5 }}>
      {AI_EXAMPLES.map((ex) => (
        <Box key={ex.q}>
          <Typography
            sx={{
              color: 'rgba(255,255,255,0.6)',
              fontSize: '0.98rem',
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
              fontSize: '1.08rem',
              lineHeight: 1.4,
              letterSpacing: '-0.01em',
            }}
          >
            {ex.a}
          </Typography>
        </Box>
      ))}
      <Box
        component="ul"
        sx={{
          listStyle: 'none',
          p: 0,
          mt: 1.5,
          display: 'flex',
          flexDirection: 'column',
          gap: 0.75,
          pl: 2.25,
          borderLeft: '2px solid rgba(127, 179, 224, 0.35)',
        }}
      >
        {AI_TRUST.map((line) => (
          <Typography
            component="li"
            key={line}
            sx={{ color: 'rgba(255,255,255,0.7)', fontSize: '0.94rem', lineHeight: 1.5 }}
          >
            {line}
          </Typography>
        ))}
      </Box>
    </Box>
  );
}

export default function WhatYouGet() {
  return (
    <Section id="features" surface="raised" maxWidth="lg" grid>
      <Reveal distance={28}>
        <SectionHeading
          index="What you get"
          heading="Everything the shop needs. None of the enterprise weight."
        />
      </Reveal>

      <Box
        sx={{
          mt: { xs: 5, md: 8 },
          display: 'flex',
          flexDirection: 'column',
          gap: { xs: 7, md: 11 },
        }}
      >
        {WHAT_YOU_GET.map((row, i) => {
          const reverse = i % 2 === 1;
          return (
            <Box
              key={row.key}
              sx={{
                display: 'flex',
                flexDirection: { xs: 'column', md: reverse ? 'row-reverse' : 'row' },
                alignItems: 'center',
                gap: { xs: 4, md: 8 },
              }}
            >
              {/* Copy */}
              <Reveal distance={24} sx={{ flex: { md: '0 0 40%' }, width: '100%' }}>
                <Box sx={{ maxWidth: 480 }}>
                  <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 2, mb: 1.5 }}>
                    <Typography
                      component="span"
                      sx={{
                        ...gradientTextSx,
                        fontFamily: DISPLAY_FONT,
                        fontWeight: 600,
                        fontSize: { xs: '1.6rem', md: '2rem' },
                        lineHeight: 1,
                        letterSpacing: '-0.03em',
                      }}
                    >
                      {String(i + 1).padStart(2, '0')}
                    </Typography>
                    <Typography sx={{ ...eyebrowSx, color: EYEBROW_COLOR }}>
                      {row.eyebrow}
                    </Typography>
                  </Box>

                  <Typography
                    component="h3"
                    sx={{
                      fontFamily: DISPLAY_FONT,
                      fontWeight: 600,
                      fontSize: { xs: '1.65rem', md: '2.15rem' },
                      lineHeight: 1.1,
                      letterSpacing: '-0.025em',
                      mb: 2,
                    }}
                  >
                    {row.headline}
                  </Typography>

                  <Typography
                    sx={{
                      color: 'rgba(255, 255, 255, 0.74)',
                      fontSize: { xs: '1.02rem', md: '1.1rem' },
                      lineHeight: 1.6,
                      mb: 2.5,
                    }}
                  >
                    {row.description}
                  </Typography>

                  <Box
                    component="ul"
                    sx={{
                      listStyle: 'none',
                      p: 0,
                      m: 0,
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 1,
                    }}
                  >
                    {row.items.map((item) => (
                      <Box
                        component="li"
                        key={item}
                        sx={{ display: 'flex', alignItems: 'flex-start', gap: 1.25 }}
                      >
                        <CheckRoundedIcon
                          aria-hidden
                          sx={{ fontSize: 17, color: EYEBROW_COLOR, mt: '3px', flexShrink: 0 }}
                        />
                        <Typography
                          sx={{
                            color: 'rgba(255, 255, 255, 0.86)',
                            fontSize: '1rem',
                            lineHeight: 1.45,
                          }}
                        >
                          {item}
                        </Typography>
                      </Box>
                    ))}
                  </Box>

                  {row.key === 'books' && <AskExamples />}
                </Box>
              </Reveal>

              {/* Media */}
              <Reveal
                delay={120}
                distance={32}
                sx={{ flex: { md: '1 1 auto' }, width: '100%', minWidth: 0 }}
              >
                {row.placeholder ? (
                  /* Two phones, staggered — the queue and the step screen, which is the
                     pair the old standalone floor section carried. They are labelled
                     stand-ins so the slots the real captures will fill are visible in
                     review rather than imagined. */
                  <Box
                    sx={{
                      display: 'flex',
                      justifyContent: 'center',
                      alignItems: 'flex-start',
                      gap: { xs: 1.5, md: 2.5 },
                    }}
                  >
                    <PhoneShot
                      src={row.image}
                      alt={row.alt}
                      maxWidth={{ xs: 150, md: 228 }}
                      glow="rgba(70, 130, 180, 0.22)"
                    />
                    {row.inset && (
                      <Box sx={{ mt: { xs: 3, md: 6 } }}>
                        <PhoneShot
                          src={row.inset}
                          alt={row.insetAlt ?? ''}
                          maxWidth={{ xs: 150, md: 228 }}
                          glow="rgba(43, 188, 179, 0.20)"
                        />
                      </Box>
                    )}
                  </Box>
                ) : (
                  <Box sx={{ position: 'relative' }}>
                    <ScreenShot src={row.image} alt={row.alt} />
                    {row.inset && (
                      /* The outcome overlapping the step — so the picture shows where the
                         flow ends and not only where it starts. */
                      <Box
                        sx={{
                          display: { xs: 'none', md: 'block' },
                          position: 'absolute',
                          right: { md: '-6%' },
                          bottom: { md: '-24%' },
                          width: { md: '48%' },
                          zIndex: 2,
                        }}
                      >
                        <ScreenShot
                          src={row.inset}
                          alt={row.insetAlt ?? ''}
                          width={2404}
                          height={1168}
                        />
                      </Box>
                    )}
                  </Box>
                )}
              </Reveal>
            </Box>
          );
        })}
      </Box>
    </Section>
  );
}
