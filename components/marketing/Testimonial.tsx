'use client';

import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Reveal from './Reveal';
import { TESTIMONIAL } from '@/lib/constants/marketing';
import { DISPLAY_FONT } from './marketingStyles';

/**
 * The one real quote, rendered directly under the knowledge-capture section — the claim
 * on this page most in need of a human voice.
 *
 * A material-connection disclosure line ran under the attribution for two days and was
 * removed on request 2026-09-14. The reasoning behind it, and the arrangement it referred
 * to, are recorded with the TESTIMONIAL constant so the removal reads as a decision.
 *
 * IT RENDERS NOTHING UNTIL `TESTIMONIAL.approved` IS TRUE. That gate is deliberate and
 * the reasoning lives with the constant in lib/constants/marketing.ts: issues #489/#509
 * forbid an invented voice here, and the FTC's Endorsement Guides treat quotation marks
 * as a claim that these are the endorser's exact words. The copy is a compression of a
 * paraphrase, so it needs the endorser's written adoption before it can wear quote marks.
 * Flipping the flag is the whole deployment step once that email exists.
 *
 * The disclosure line below the attribution is not optional decoration: the shop is on a
 * reserved discounted price, which is a material connection under the same Guides.
 *
 * Set deliberately small and quiet — no giant curly quotes, no five-star graphic. Both
 * read as a marketing asset rather than a person, and a flawless rating measurably
 * depresses trust rather than raising it.
 */
export default function Testimonial() {
  if (!TESTIMONIAL.approved) return null;

  return (
    <Box
      component="section"
      sx={{
        py: { xs: 4, md: 5 },
        borderTop: '1px solid rgba(255,255,255,0.08)',
      }}
    >
      <Reveal distance={20}>
        <Box sx={{ maxWidth: 720, mx: 'auto', px: { xs: 3, md: 0 }, textAlign: 'center' }}>
          <Typography
            component="blockquote"
            sx={{
              m: 0,
              fontFamily: DISPLAY_FONT,
              fontWeight: 500,
              color: '#fff',
              fontSize: { xs: '1.3rem', md: '1.6rem' },
              lineHeight: 1.35,
              letterSpacing: '-0.02em',
            }}
          >
            “{TESTIMONIAL.quote}”
          </Typography>

          <Box
            sx={{
              mt: 3,
              display: 'flex',
              flexWrap: 'wrap',
              alignItems: 'center',
              justifyContent: 'center',
              gap: { xs: 1.5, md: 2.5 },
            }}
          >
            <Typography sx={{ color: 'rgba(255,255,255,0.9)', fontWeight: 600, fontSize: '1rem' }}>
              {TESTIMONIAL.name}
              <Box component="span" sx={{ color: 'rgba(255,255,255,0.6)', fontWeight: 400 }}>
                {' · '}
                {TESTIMONIAL.role}
              </Box>
            </Typography>

            {/* The supplied wordmark is black on transparent, which is invisible on this
                page. It sits on a light chip rather than being inverted, because a CSS
                invert would swing the blue CTM mark to orange. Replace the chip with a
                bare <img> once a reversed logo arrives from the shop. */}
            <Box
              sx={{
                px: 1.5,
                py: 0.75,
                borderRadius: 1,
                bgcolor: 'rgba(255,255,255,0.92)',
                display: 'inline-flex',
                alignItems: 'center',
              }}
            >
              <Box
                component="img"
                src={TESTIMONIAL.logo}
                alt={TESTIMONIAL.logoAlt}
                width={552}
                height={102}
                loading="lazy"
                decoding="async"
                sx={{ height: 22, width: 'auto', display: 'block' }}
              />
            </Box>
          </Box>

        </Box>
      </Reveal>
    </Box>
  );
}
