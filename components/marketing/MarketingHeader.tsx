'use client';

import { useState } from 'react';
import Link from 'next/link';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import Drawer from '@mui/material/Drawer';
import List from '@mui/material/List';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemText from '@mui/material/ListItemText';
import MenuIcon from '@mui/icons-material/Menu';
import MuiLink from '@mui/material/Link';
import JiggedLogo from '@/components/branding/JiggedLogo';
import { gradientButtonSx } from './marketingStyles';

const navItems = [
  { label: 'How it works', href: '#how-it-works' },
  { label: 'Log in', href: '/login' },
];

const CTA = { label: 'Request access', href: '/invite/early-access' };

export default function MarketingHeader() {
  const [drawerOpen, setDrawerOpen] = useState(false);

  return (
    <>
      <Box
        component="header"
        sx={{
          position: 'sticky',
          top: 0,
          zIndex: 1100,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          px: { xs: 2, md: 4 },
          py: 0.75,
          minHeight: 52,
          bgcolor: 'rgba(17, 20, 57, 0.6)',
          backdropFilter: 'blur(10px)',
          WebkitBackdropFilter: 'blur(10px)',
          borderBottom: '1px solid rgba(255, 255, 255, 0.09)',
        }}
      >
        <MuiLink
          component={Link}
          href="/"
          underline="none"
          sx={{ display: 'flex', alignItems: 'center', '&:hover': { opacity: 0.85 } }}
        >
          <JiggedLogo size="small" variant="dark" />
        </MuiLink>

        {/* Desktop nav */}
        <Box sx={{ display: { xs: 'none', sm: 'flex' }, alignItems: 'center', gap: 3 }}>
          {navItems.map((item) => (
            <MuiLink
              key={item.label}
              component={item.href.startsWith('#') ? 'a' : Link}
              href={item.href}
              underline="none"
              sx={{
                color: 'rgba(255, 255, 255, 0.7)',
                fontSize: '0.9rem',
                fontWeight: 500,
                '&:hover': { color: 'white' },
              }}
            >
              {item.label}
            </MuiLink>
          ))}
          <Button
            component={Link}
            href={CTA.href}
            variant="contained"
            size="small"
            sx={{ px: 2.25, ...gradientButtonSx }}
          >
            {CTA.label}
          </Button>
        </Box>

        {/* Mobile hamburger */}
        <IconButton
          onClick={() => setDrawerOpen(true)}
          sx={{ display: { xs: 'flex', sm: 'none' }, color: 'white' }}
          aria-label="Open menu"
        >
          <MenuIcon />
        </IconButton>
      </Box>

      {/* Mobile drawer */}
      <Drawer
        anchor="right"
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        slotProps={{
          paper: {
            sx: {
              width: 260,
              bgcolor: 'rgba(17, 20, 57, 0.98)',
              backdropFilter: 'blur(20px)',
            },
          },
        }}
      >
        <List sx={{ pt: 4, px: 1.5 }}>
          {navItems.map((item) => (
            <ListItemButton
              key={item.label}
              component={item.href.startsWith('#') ? 'a' : Link}
              href={item.href}
              onClick={() => setDrawerOpen(false)}
              sx={{ borderRadius: 2, mb: 0.5 }}
            >
              <ListItemText primary={item.label} />
            </ListItemButton>
          ))}
          <Button
            component={Link}
            href={CTA.href}
            onClick={() => setDrawerOpen(false)}
            variant="contained"
            fullWidth
            sx={{ mt: 2, py: 1.15, ...gradientButtonSx }}
          >
            {CTA.label}
          </Button>
        </List>
      </Drawer>
    </>
  );
}
