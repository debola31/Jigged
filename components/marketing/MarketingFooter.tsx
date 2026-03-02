'use client';

import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import MuiLink from '@mui/material/Link';

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
      <Typography variant="body2" sx={{ color: 'rgba(255, 255, 255, 0.4)' }}>
        &copy; 2026 Jigged &middot;{' '}
        <MuiLink
          href="mailto:hello@jigged.app"
          underline="hover"
          sx={{ color: 'rgba(255, 255, 255, 0.4)', '&:hover': { color: 'rgba(255, 255, 255, 0.7)' } }}
        >
          hello@jigged.app
        </MuiLink>
      </Typography>
    </Box>
  );
}
