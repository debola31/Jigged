'use client';

import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import AddRoundedIcon from '@mui/icons-material/AddRounded';
import Section from './Section';
import Reveal from './Reveal';
import { FAQ } from '@/lib/constants/marketing';
import { DISPLAY_FONT } from './marketingStyles';

/**
 * Eight answers in roughly the height of half a feature row — the most content per pixel
 * on the page, which is why it earns a place while the page is trying not to grow.
 *
 * BUILT ON NATIVE <details>, NOT MUI's Accordion, for three reasons that all point the
 * same way:
 *
 *  1. Every answer stays in the DOM. MUI's Accordion (and any `{open && <Panel/>}`)
 *     unmounts collapsed content, which makes it invisible to anything that reads the
 *     HTML without running the page — including the crawlers now sitting in this buyer's
 *     research path, which fetch JavaScript and never execute it. Collapsing must be a
 *     paint decision, never a mount decision.
 *  2. Cmd+F finds the text. A browser will open a <details> to reveal a find-in-page
 *     match; it cannot find what was never rendered.
 *  3. Keyboard and screen-reader behaviour come free and correct, with no JS at all.
 *
 * The cost is that it must be styled by hand, since MUI has no wrapper for it — hence the
 * `&::-webkit-details-marker` reset and the sibling-selector rotation below, rather than
 * component props.
 */
export default function Faq() {
  return (
    <Section id="faq" surface="light" maxWidth="md" size="minor">
      <Reveal distance={24}>
        {/* SectionHeading isn't used here: its eyebrow/index row carries mb: 2.5
            unconditionally, so with no eyebrow it leaves ~20px of dead space. */}
        <Typography
          component="h2"
          sx={{
            textAlign: 'center',
            fontFamily: DISPLAY_FONT,
            fontWeight: 600,
            fontSize: 'clamp(2rem, 4.6vw, 3.4rem)',
            lineHeight: 1.04,
            letterSpacing: '-0.025em',
          }}
        >
          Questions we get
        </Typography>
      </Reveal>

      <Box sx={{ maxWidth: 760, mx: 'auto', mt: { xs: 4, md: 6 } }}>
        {FAQ.map((item, i) => (
          <Reveal key={item.q} delay={i * 50} distance={16}>
            <Box
              component="details"
              sx={{
                borderTop: i === 0 ? 'none' : '1px solid rgba(255,255,255,0.12)',
                '&[open] .faq-marker': { transform: 'rotate(45deg)' },
              }}
            >
              <Box
                component="summary"
                sx={{
                  listStyle: 'none',
                  '&::-webkit-details-marker': { display: 'none' },
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 2,
                  // 48px minimum target: this is the one interactive control in the
                  // middle of the page, and a third of visitors are on a phone.
                  minHeight: 48,
                  py: { xs: 2, md: 2.25 },
                  '&:hover .faq-question': { color: '#fff' },
                  '&:focus-visible': {
                    outline: '2px solid rgba(127,179,224,0.7)',
                    outlineOffset: 2,
                    borderRadius: 4,
                  },
                }}
              >
                <Typography
                  component="h3"
                  className="faq-question"
                  sx={{
                    fontFamily: DISPLAY_FONT,
                    fontWeight: 600,
                    fontSize: { xs: '1.08rem', md: '1.22rem' },
                    letterSpacing: '-0.015em',
                    lineHeight: 1.3,
                    color: 'rgba(255,255,255,0.92)',
                    transition: 'color 0.15s ease',
                  }}
                >
                  {item.q}
                </Typography>
                <AddRoundedIcon
                  aria-hidden
                  className="faq-marker"
                  sx={{
                    flexShrink: 0,
                    fontSize: 22,
                    color: 'rgba(255,255,255,0.5)',
                    transition: 'transform 0.2s ease',
                    '@media (prefers-reduced-motion: reduce)': { transition: 'none' },
                  }}
                />
              </Box>
              <Typography
                sx={{
                  pb: { xs: 2.5, md: 3 },
                  pr: { md: 5 },
                  color: 'rgba(255, 255, 255, 0.74)',
                  fontSize: { xs: '1rem', md: '1.05rem' },
                  lineHeight: 1.65,
                }}
              >
                {item.a}
              </Typography>
            </Box>
          </Reveal>
        ))}
      </Box>
    </Section>
  );
}
