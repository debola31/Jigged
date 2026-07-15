'use client';

import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import CheckRoundedIcon from '@mui/icons-material/CheckRounded';
import Section from './Section';
import Reveal from './Reveal';
import PhoneShot from './PhoneShot';
import { SHOP_FLOOR } from '@/lib/constants/marketing';
import { eyebrowSx, EYEBROW_COLOR, DISPLAY_FONT } from './marketingStyles';

/**
 * The operator/shop-floor moment: copy + a bulleted list of what the person at the
 * machine gets, next to two staggered phone shots (the station queue and a job step).
 * Focused on the paperless experience; the notes/photos knowledge story is its own
 * section (KnowledgeCapture) right after, so the two phones tease it without stealing it.
 */
export default function ShopFloorShowcase() {
  return (
    <Section id="shop-floor" maxWidth="lg">
      <Box
        sx={{
          display: 'flex',
          flexDirection: { xs: 'column', md: 'row' },
          alignItems: 'center',
          gap: { xs: 7, md: 10 },
        }}
      >
        {/* Copy + bullet points */}
        <Reveal distance={28} sx={{ flex: { md: '0 0 46%' }, width: '100%' }}>
          <Box>
            <Typography sx={{ ...eyebrowSx, color: EYEBROW_COLOR, mb: 3 }}>
              {SHOP_FLOOR.eyebrow}
            </Typography>
            <Typography
              component="h2"
              sx={{
                fontFamily: DISPLAY_FONT,
                fontWeight: 600,
                fontSize: 'clamp(2rem, 4.4vw, 3.2rem)',
                lineHeight: 1.05,
                letterSpacing: '-0.03em',
                mb: 3,
              }}
            >
              {SHOP_FLOOR.heading}
            </Typography>
            <Typography
              sx={{
                color: 'rgba(255, 255, 255, 0.76)',
                fontSize: { xs: '1.05rem', md: '1.2rem' },
                lineHeight: 1.65,
                mb: 4,
                maxWidth: 520,
              }}
            >
              {SHOP_FLOOR.subhead}
            </Typography>
            <Box
              component="ul"
              sx={{
                listStyle: 'none',
                p: 0,
                m: 0,
                display: 'flex',
                flexDirection: 'column',
                gap: 2.25,
              }}
            >
              {SHOP_FLOOR.points.map((point) => (
                <Box
                  component="li"
                  key={point}
                  sx={{ display: 'flex', alignItems: 'flex-start', gap: 1.75 }}
                >
                  <Box
                    aria-hidden
                    sx={{
                      flexShrink: 0,
                      mt: '2px',
                      width: 26,
                      height: 26,
                      borderRadius: '50%',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      bgcolor: 'rgba(127, 179, 224, 0.14)',
                      border: '1px solid rgba(127, 179, 224, 0.35)',
                    }}
                  >
                    <CheckRoundedIcon sx={{ fontSize: 16, color: EYEBROW_COLOR }} />
                  </Box>
                  <Typography
                    sx={{
                      color: 'rgba(255, 255, 255, 0.86)',
                      fontSize: { xs: '1rem', md: '1.08rem' },
                      lineHeight: 1.5,
                    }}
                  >
                    {point}
                  </Typography>
                </Box>
              ))}
            </Box>
          </Box>
        </Reveal>

        {/* Two phones, staggered for editorial rhythm */}
        <Reveal
          delay={140}
          distance={40}
          sx={{ flex: { md: '1 1 auto' }, width: '100%' }}
        >
          <Box
            sx={{
              display: 'flex',
              justifyContent: 'center',
              alignItems: 'flex-start',
              gap: { xs: 1.5, md: 2.5 },
            }}
          >
            <PhoneShot
              src={SHOP_FLOOR.images[0]}
              alt={SHOP_FLOOR.alt}
              maxWidth={244}
              glow="rgba(70, 130, 180, 0.22)"
            />
            <Box sx={{ mt: { xs: 3, md: 7 } }}>
              <PhoneShot
                src={SHOP_FLOOR.images[1]}
                alt={SHOP_FLOOR.alt}
                maxWidth={244}
                glow="rgba(43, 188, 179, 0.20)"
              />
            </Box>
          </Box>
        </Reveal>
      </Box>
    </Section>
  );
}
