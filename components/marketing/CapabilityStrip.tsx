'use client';

import Box from '@mui/material/Box';
import Container from '@mui/material/Container';
import Typography from '@mui/material/Typography';
import Reveal from './Reveal';
import { CAPABILITY_STRIP } from '@/lib/constants/marketing';

/**
 * Honest credibility strip. No customer logos are cleared yet, so this states who Jigged
 * is for — including the headcount, which is the reader's own self-recognition test — and
 * the shop capabilities it covers. Structured so a real grayscale logo row can replace the
 * tags later without touching the layout.
 *
 * This is the old LogoCloud, restored. A price + terms band briefly took its place; that
 * came out on 2026-09-14 because /pricing already carries the number and repeating it
 * bought a second recital of the same terms on a page trying to lose text.
 */
export default function CapabilityStrip() {
  return (
    <Box
      component="section"
      sx={{
        py: { xs: 3, md: 4 },
        borderTop: '1px solid rgba(255, 255, 255, 0.07)',
        borderBottom: '1px solid rgba(255, 255, 255, 0.07)',
      }}
    >
      <Container maxWidth="lg">
        <Reveal>
          <Box
            sx={{
              display: 'flex',
              flexDirection: { xs: 'column', md: 'row' },
              alignItems: 'center',
              gap: { xs: 2, md: 4 },
              justifyContent: 'center',
            }}
          >
            <Typography
              sx={{
                textTransform: 'uppercase',
                letterSpacing: '0.12em',
                fontSize: '0.72rem',
                fontWeight: 600,
                color: 'rgba(255, 255, 255, 0.62)',
                textAlign: 'center',
                flexShrink: 0,
              }}
            >
              {CAPABILITY_STRIP.label}
            </Typography>
            <Box
              sx={{
                display: 'flex',
                flexWrap: 'wrap',
                gap: { xs: 1, md: 1.5 },
                justifyContent: 'center',
              }}
            >
              {CAPABILITY_STRIP.tags.map((tag) => (
                <Box
                  key={tag}
                  sx={{
                    px: 1.75,
                    py: 0.75,
                    borderRadius: 999,
                    border: '1px solid rgba(255, 255, 255, 0.14)',
                    color: 'rgba(255, 255, 255, 0.7)',
                    fontSize: '0.85rem',
                    fontWeight: 500,
                  }}
                >
                  {tag}
                </Box>
              ))}
            </Box>
          </Box>
        </Reveal>
      </Container>
    </Box>
  );
}
