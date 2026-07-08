'use client';

import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Section from './Section';
import Reveal from './Reveal';
import DeviceFrame from './DeviceFrame';
import { KNOWLEDGE } from '@/lib/constants/marketing';
import { eyebrowSx, DISPLAY_FONT, EYEBROW_COLOR } from './marketingStyles';

export default function KnowledgeCapture() {
  return (
    <Section surface="recess" maxWidth="lg" grid>
      <Box
        sx={{
          display: 'flex',
          flexDirection: { xs: 'column', md: 'row' },
          alignItems: 'center',
          gap: { xs: 6, md: 10 },
        }}
      >
        {/* Copy — the emotional core, set large */}
        <Reveal distance={28} sx={{ flex: { md: '0 0 52%' }, width: '100%' }}>
          <Box>
            <Typography sx={{ ...eyebrowSx, color: EYEBROW_COLOR, mb: 3 }}>
              {KNOWLEDGE.eyebrow}
            </Typography>
            <Typography
              component="h2"
              sx={{
                fontFamily: DISPLAY_FONT,
                fontWeight: 600,
                fontSize: 'clamp(2.25rem, 5vw, 4rem)',
                lineHeight: 1.02,
                letterSpacing: '-0.03em',
                mb: 3.5,
              }}
            >
              {KNOWLEDGE.heading}
            </Typography>
            <Typography
              sx={{
                color: 'rgba(255, 255, 255, 0.78)',
                fontSize: { xs: '1.05rem', md: '1.2rem' },
                lineHeight: 1.7,
                mb: 4,
                maxWidth: 520,
              }}
            >
              {KNOWLEDGE.body}
            </Typography>
            <Box sx={{ pl: 3, borderLeft: '3px solid', borderColor: 'secondary.main' }}>
              <Typography
                sx={{
                  fontFamily: DISPLAY_FONT,
                  color: '#fff',
                  fontWeight: 500,
                  fontSize: { xs: '1.15rem', md: '1.4rem' },
                  lineHeight: 1.4,
                  letterSpacing: '-0.01em',
                }}
              >
                {KNOWLEDGE.micro}
              </Typography>
            </Box>
          </Box>
        </Reveal>

        {/* The signature artifact — the operator job feed (notes) on the shop floor */}
        <Reveal
          delay={140}
          distance={40}
          sx={{ flex: { md: '1 1 auto' }, width: '100%', display: 'flex', justifyContent: 'center' }}
        >
          <DeviceFrame src={KNOWLEDGE.image} alt={KNOWLEDGE.alt} maxWidth={340} />
        </Reveal>
      </Box>
    </Section>
  );
}
