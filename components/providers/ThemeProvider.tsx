'use client';

import { ThemeProvider as MuiThemeProvider } from '@mui/material/styles';
import CssBaseline from '@mui/material/CssBaseline';
import Box from '@mui/material/Box';
import jiggedTheme from '@/lib/theme';

interface ThemeProviderProps {
  children: React.ReactNode;
}

export default function ThemeProvider({ children }: ThemeProviderProps) {
  return (
    <MuiThemeProvider theme={jiggedTheme}>
      <CssBaseline />
      <Box
        sx={{
          minHeight: '100vh',
          // Dark, near-neutral indigo canvas. The old middle stop was a saturated steel
          // blue (#4682B4, L≈0.21) that dropped white body text to 4.11:1 app-wide; the
          // deep-indigo base restores 15:1+. This Box is the calm SUBSTRATE — a solid
          // readable base plus one top-anchored steel glow whose center is pushed
          // off-screen above the fold (only its soft falloff shows behind the header) and
          // fades to ZERO-ALPHA steel — never `transparent`, which interpolates a lighter
          // grey band mid-fade, the exact class of bug we just fixed.
          //
          // The richer ambient treatment lives per-shell on top of this: the app
          // workspace layers a lit steel-indigo gradient + brand aurora
          // (components/layout/AppAmbientBackdrop) so a working screen gets some of the
          // marketing page's shop-floor character. Deliberately 2D — no literal 3D scene
          // or looping video behind live data (both read as distracting); the marketing
          // page keeps its own hero video. Opaque cards (lib/theme.ts MuiCard) are the
          // readability firewall, so every ambient layer stays legible.
          backgroundColor: '#111439',
          backgroundImage: `
            radial-gradient(120% 62% at 50% -12%, rgba(70, 130, 180, 0.18) 0%, rgba(70, 130, 180, 0) 60%),
            linear-gradient(135deg, #111439 0%, #1a1f4a 50%, #111439 100%)
          `,
          backgroundSize: '100% 100%, 100% 100%',
          backgroundAttachment: 'fixed',
        }}
      >
        {children}
      </Box>
    </MuiThemeProvider>
  );
}
