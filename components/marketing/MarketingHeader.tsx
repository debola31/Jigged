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

const navItems = [
  { label: 'Log In', href: '/login' },
];

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
          py: 1.5,
          bgcolor: 'rgba(26, 31, 74, 0.55)',
          backdropFilter: 'blur(8px)',
          WebkitBackdropFilter: 'blur(8px)',
          borderBottom: '1px solid rgba(255, 255, 255, 0.1)',
        }}
      >
        {/* Logo */}
        <MuiLink
          component={Link}
          href="/"
          underline="none"
          sx={{ display: 'flex', alignItems: 'center', '&:hover': { opacity: 0.85 } }}
        >
          <JiggedLogo size="small" variant="dark" />
        </MuiLink>

        {/* Desktop Nav */}
        <Box
          sx={{
            display: { xs: 'none', sm: 'flex' },
            alignItems: 'center',
            gap: 2,
          }}
        >
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
            href="/signup"
            variant="outlined"
            size="small"
            sx={{ ml: 1 }}
          >
            Sign Up
          </Button>
        </Box>

        {/* Mobile Hamburger */}
        <IconButton
          onClick={() => setDrawerOpen(true)}
          sx={{ display: { xs: 'flex', sm: 'none' }, color: 'white' }}
        >
          <MenuIcon />
        </IconButton>
      </Box>

      {/* Mobile Drawer */}
      <Drawer
        anchor="right"
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        slotProps={{
          paper: {
            sx: {
              width: 240,
              bgcolor: 'rgba(17, 20, 57, 0.98)',
              backdropFilter: 'blur(20px)',
            },
          },
        }}
      >
        <List sx={{ pt: 4, px: 1 }}>
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
          <ListItemButton
            component={Link}
            href="/signup"
            onClick={() => setDrawerOpen(false)}
            sx={{ borderRadius: 2 }}
          >
            <ListItemText primary="Sign Up" />
          </ListItemButton>
        </List>
      </Drawer>
    </>
  );
}
