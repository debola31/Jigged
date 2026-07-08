'use client';

import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Section from './Section';
import Reveal from './Reveal';
import { gradientTextSx } from './marketingStyles';

/**
 * Testimonial section. DORMANT until a real, approved quote exists (issue #489/#509
 * forbid an invented voice) — it is intentionally not rendered in LandingPageContent.
 * When Shane's (or another) quote is approved, pass real props and uncomment the
 * import + usage in LandingPageContent. No placeholder ships live.
 */
interface TestimonialProps {
  quote: string;
  name: string;
  role: string;
  company: string;
}

export default function Testimonial({ quote, name, role, company }: TestimonialProps) {
  return (
    <Section maxWidth="md" hairlineTop>
      <Reveal>
        <Box sx={{ textAlign: 'center' }}>
          <Typography sx={{ ...gradientTextSx, fontSize: '3rem', lineHeight: 1, mb: 2 }}>
            &ldquo;
          </Typography>
          <Typography
            component="blockquote"
            sx={{
              fontWeight: 500,
              fontSize: { xs: '1.4rem', md: '1.9rem' },
              lineHeight: 1.35,
              letterSpacing: '-0.01em',
              maxWidth: 760,
              mx: 'auto',
              mb: 4,
            }}
          >
            {quote}
          </Typography>
          <Typography sx={{ color: '#fff', fontWeight: 600 }}>{name}</Typography>
          <Typography sx={{ color: 'rgba(255,255,255,0.6)', fontSize: '0.95rem' }}>
            {role}, {company}
          </Typography>
        </Box>
      </Reveal>
    </Section>
  );
}
