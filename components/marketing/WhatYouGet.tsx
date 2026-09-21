'use client';

import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import DescriptionOutlinedIcon from '@mui/icons-material/DescriptionOutlined';
import TuneOutlinedIcon from '@mui/icons-material/TuneOutlined';
import LockOutlinedIcon from '@mui/icons-material/LockOutlined';
import SwapHorizOutlinedIcon from '@mui/icons-material/SwapHorizOutlined';
import LocalShippingOutlinedIcon from '@mui/icons-material/LocalShippingOutlined';
import ReceiptLongOutlinedIcon from '@mui/icons-material/ReceiptLongOutlined';
import CheckCircleOutlinedIcon from '@mui/icons-material/CheckCircleOutlined';
import PhotoCameraOutlinedIcon from '@mui/icons-material/PhotoCameraOutlined';
import QrCodeScannerOutlinedIcon from '@mui/icons-material/QrCodeScannerOutlined';
import BuildOutlinedIcon from '@mui/icons-material/BuildOutlined';
import ChecklistOutlinedIcon from '@mui/icons-material/ChecklistOutlined';
import VerifiedOutlinedIcon from '@mui/icons-material/VerifiedOutlined';
import Section from './Section';
import SectionHeading from './SectionHeading';
import Reveal from './Reveal';
import ScreenShot from './ScreenShot';
import PhoneShot from './PhoneShot';
import { WHAT_YOU_GET, AI_EXAMPLES } from '@/lib/constants/marketing';
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
    </Box>
  );
}

/** Keyed by a bullet's `icon` — keep this map in step with the rows in marketing.ts. */
const BULLET_ICONS: Record<string, typeof LockOutlinedIcon> = {
  print: DescriptionOutlinedIcon,
  price: TuneOutlinedIcon,
  lock: LockOutlinedIcon,
  outside: SwapHorizOutlinedIcon,
  ship: LocalShippingOutlinedIcon,
  invoice: ReceiptLongOutlinedIcon,
  done: CheckCircleOutlinedIcon,
  camera: PhotoCameraOutlinedIcon,
  scan: QrCodeScannerOutlinedIcon,
  machine: BuildOutlinedIcon,
  count: ChecklistOutlinedIcon,
  cert: VerifiedOutlinedIcon,
};

export default function WhatYouGet() {
  return (
    <Section id="features" surface="raised" maxWidth="lg" grid>
      <Reveal distance={28}>
        <SectionHeading
          index="What you get"
          heading="Everything the shop needs, and nothing it doesn’t."
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

                  {row.items && (
                    <Box
                      component="ul"
                      sx={{
                        listStyle: 'none',
                        p: 0,
                        m: 0,
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 1.25,
                      }}
                    >
                      {row.items.map((item) => {
                        const Icon = BULLET_ICONS[item.icon] ?? CheckCircleOutlinedIcon;
                        return (
                          <Box
                            component="li"
                            key={item.label}
                            sx={{ display: 'flex', alignItems: 'flex-start', gap: 1.5 }}
                          >
                            <Icon
                              aria-hidden
                              sx={{
                                fontSize: 20,
                                color: EYEBROW_COLOR,
                                mt: '2px',
                                flexShrink: 0,
                              }}
                            />
                            <Typography
                              sx={{
                                color: 'rgba(255, 255, 255, 0.86)',
                                fontSize: '1rem',
                                lineHeight: 1.45,
                              }}
                            >
                              {item.label}
                            </Typography>
                          </Box>
                        );
                      })}
                    </Box>
                  )}

                  {row.key === 'books' && <AskExamples />}
                </Box>
              </Reveal>

              {/* Media */}
              <Reveal
                delay={120}
                distance={32}
                sx={{ flex: { md: '1 1 auto' }, width: '100%', minWidth: 0 }}
              >
                {row.phone ? (
                  /* One phone, large enough to read. The floor row carried two staggered
                     placeholders while the art was pending; with a real capture in hand a
                     single legible screen beats two small ones. */
                  <Box sx={{ display: 'flex', justifyContent: 'center' }}>
                    <PhoneShot
                      src={row.image}
                      alt={row.alt}
                      maxWidth={{ xs: 230, md: 292 }}
                      glow="rgba(70, 130, 180, 0.22)"
                    />
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
                          // Bigger and lower than it was. The quote is the OUTCOME of this
                          // row — prints go in, a quote comes out — and at 48% it read as
                          // a footnote to the step that produces it. At 68% the totals are
                          // legible and it is plainly the thing the row is about, while the
                          // drawing behind still shows where it came from.
                          right: { md: '-11%' },
                          bottom: { md: '-30%' },
                          width: { md: '62%' },
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
