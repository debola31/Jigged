'use client';

import Box from '@mui/material/Box';
import Container from '@mui/material/Container';
import Typography from '@mui/material/Typography';
import MuiLink from '@mui/material/Link';
import Link from 'next/link';
import JiggedLogo from '@/components/branding/JiggedLogo';

const linkSx = {
  color: 'rgba(255, 255, 255, 0.6)',
  '&:hover': { color: 'rgba(255, 255, 255, 0.9)' },
};

export default function MarketingFooter() {
  return (
    <Box
      component="footer"
      sx={{ borderTop: '1px solid rgba(255, 255, 255, 0.08)', py: { xs: 3.5, md: 3 } }}
    >
      <Container maxWidth="lg">
        <Box
          sx={{
            display: 'flex',
            flexDirection: { xs: 'column', md: 'row' },
            alignItems: { xs: 'flex-start', md: 'center' },
            justifyContent: 'space-between',
            gap: { xs: 1.5, md: 3 },
          }}
        >
          {/* Left: logo + tagline, aligned on one line */}
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap' }}>
            <JiggedLogo size="small" variant="dark" />
            <Typography sx={{ color: 'rgba(255, 255, 255, 0.55)', fontSize: '0.9rem' }}>
              Shop-floor software for precision machine shops.
            </Typography>
          </Box>

          {/* Right: legal line, aligned with the logo row */}
          <Typography variant="body2" sx={{ color: 'rgba(255, 255, 255, 0.5)', fontSize: '0.85rem' }}>
            &copy; 2026 Jigged{' · '}
            <MuiLink component={Link} href="/terms" underline="hover" sx={linkSx}>
              Terms
            </MuiLink>
            {' · '}
            <MuiLink component={Link} href="/privacy" underline="hover" sx={linkSx}>
              Privacy
            </MuiLink>
            {' · '}
            <MuiLink component={Link} href="/cookies" underline="hover" sx={linkSx}>
              Cookies
            </MuiLink>
            {' · '}
            <MuiLink href="mailto:hello@jigged.app" underline="hover" sx={linkSx}>
              hello@jigged.app
            </MuiLink>
          </Typography>
        </Box>
      </Container>
    </Box>
  );
}
