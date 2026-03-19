'use client';

import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import MuiLink from '@mui/material/Link';
import Link from 'next/link';

const linkSx = {
  color: 'rgba(255, 255, 255, 0.68)',
  '&:hover': { color: 'rgba(255, 255, 255, 0.9)' },
};

export default function MarketingFooter() {
  return (
    <Box
      component="footer"
      sx={{
        py: 2,
        px: 2,
        textAlign: 'center',
        borderTop: '1px solid rgba(255, 255, 255, 0.08)',
      }}
    >
      <Typography variant="body2" sx={{ color: 'rgba(255, 255, 255, 0.62)' }}>
        &copy; 2026 Jigged &middot;{' '}
        <MuiLink component={Link} href="/terms" underline="hover" sx={linkSx}>
          Terms
        </MuiLink>
        {' \u00B7 '}
        <MuiLink component={Link} href="/privacy" underline="hover" sx={linkSx}>
          Privacy
        </MuiLink>
        {' \u00B7 '}
        <MuiLink component={Link} href="/cookies" underline="hover" sx={linkSx}>
          Cookies
        </MuiLink>
        {' \u00B7 '}
        <MuiLink
          href="mailto:hello@jigged.app"
          underline="hover"
          sx={linkSx}
        >
          hello@jigged.app
        </MuiLink>
      </Typography>
    </Box>
  );
}
