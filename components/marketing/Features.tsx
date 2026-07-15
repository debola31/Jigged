'use client';

import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Section from './Section';
import SectionHeading from './SectionHeading';
import Reveal from './Reveal';
import DeviceFrame from './DeviceFrame';
import { FEATURES } from '@/lib/constants/marketing';
import { DISPLAY_FONT, gradientTextSx } from './marketingStyles';

/** Frameless dark screenshot — edge-to-edge, dissolving into the page (editorial framing). */
function FramelessShot({ src, alt }: { src: string; alt: string }) {
  return (
    <Box sx={{ position: 'relative' }}>
      <Box
        aria-hidden
        sx={{
          position: 'absolute',
          inset: '4% -4% -8% -4%',
          background: 'radial-gradient(closest-side, rgba(70,130,180,0.22), transparent)',
          filter: 'blur(52px)',
          zIndex: 0,
        }}
      />
      <Box
        component="img"
        src={src}
        alt={alt}
        loading="lazy"
        sx={{
          position: 'relative',
          zIndex: 1,
          width: '100%',
          height: 'auto',
          borderRadius: 2,
          border: '1px solid rgba(255,255,255,0.1)',
          boxShadow: '0 36px 80px -30px rgba(0,0,0,0.78)',
        }}
      />
    </Box>
  );
}

/** Operator/mobile captures shown in a phone device frame (one or two phones). */
function PhoneShots({ images, alt }: { images: string[]; alt: string }) {
  const single = images.length === 1;
  return (
    <Box sx={{ display: 'flex', justifyContent: 'center', gap: { xs: 2, md: 3 } }}>
      {images.map((src, j) => (
        <DeviceFrame key={j} src={src} alt={alt} maxWidth={single ? 300 : 240} />
      ))}
    </Box>
  );
}

export default function Features() {
  return (
    <Section id="features" surface="raised" maxWidth="lg" grid>
      <Reveal distance={28}>
        <SectionHeading
          index="What you get"
          heading="Everything the floor needs. None of the enterprise weight."
          subhead="Quoting, job tracking, invoicing, and the shop floor — the parts of the job you touch every day."
        />
      </Reveal>

      <Box sx={{ mt: { xs: 8, md: 14 }, display: 'flex', flexDirection: 'column', gap: { xs: 10, md: 18 } }}>
        {FEATURES.map((feature, i) => {
          const reverse = i % 2 === 1;
          const isPhone = Array.isArray(feature.image);
          return (
            <Box
              key={feature.key}
              sx={{
                display: 'flex',
                flexDirection: { xs: 'column', md: reverse ? 'row-reverse' : 'row' },
                alignItems: 'center',
                gap: { xs: 5, md: 9 },
              }}
            >
              {/* Copy */}
              <Reveal distance={24} sx={{ flex: { md: '0 0 40%' }, width: '100%' }}>
                <Box sx={{ maxWidth: 470 }}>
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
                    {String(i + 1).padStart(2, '0')}
                  </Typography>
                  <Typography
                    component="h3"
                    sx={{
                      fontFamily: DISPLAY_FONT,
                      fontWeight: 600,
                      fontSize: { xs: '1.65rem', md: '2.15rem' },
                      lineHeight: 1.1,
                      letterSpacing: '-0.025em',
                      mb: 2.5,
                    }}
                  >
                    {feature.headline}
                  </Typography>
                  <Typography
                    sx={{
                      color: 'rgba(255, 255, 255, 0.74)',
                      fontSize: { xs: '1.02rem', md: '1.15rem' },
                      lineHeight: 1.65,
                    }}
                  >
                    {feature.description}
                  </Typography>
                </Box>
              </Reveal>

              {/* Media */}
              <Reveal delay={140} distance={36} sx={{ flex: { md: '1 1 auto' }, width: '100%', minWidth: 0 }}>
                {isPhone ? (
                  <PhoneShots images={feature.image as string[]} alt={feature.alt} />
                ) : (
                  <FramelessShot src={feature.image as string} alt={feature.alt} />
                )}
              </Reveal>
            </Box>
          );
        })}
      </Box>
    </Section>
  );
}
