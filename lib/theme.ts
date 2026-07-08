'use client';

import { createTheme } from '@mui/material/styles';

/**
 * =============================================================================
 * JIGGED DESIGN SYSTEM - SOURCE OF TRUTH
 * =============================================================================
 *
 * This file is the SINGLE SOURCE OF TRUTH for all design values.
 * For design principles and rationale, see: docs/design-system.md
 *
 * DESIGN PRINCIPLES:
 * 1. "Professional, not trendy" - Appeal to 50-60 year old shop owners
 * 2. "Substantial, not playful" - Industrial aesthetic, feels solid
 * 3. "Readable in bright environments" - Shop floor under fluorescent lights
 *
 * KEY DESIGN DECISIONS:
 *
 * Card Opacity (0.55):
 *   - Provides substantial feel while allowing subtle background gradient visibility
 *   - Higher than 0.35 (too airy) but lower than 0.6+ (too opaque)
 *   - Optimized for shop floor readability
 *
 * Touch Targets (48px min):
 *   - All interactive elements meet mobile accessibility standards
 *   - Critical for tablet use on shop floor with gloves/dirty hands
 *
 * Glassmorphism:
 *   - backdrop-filter: blur(15px) creates frosted glass effect
 *   - Combined with MUI elevation for shadows
 *   - Subtle border (rgba white 0.15) defines card edges
 *
 * =============================================================================
 */

const jiggedTheme = createTheme({
  palette: {
    mode: 'dark',
    primary: {
      main: '#4682B4',      // Steel Blue (per design system spec)
      light: '#6FA3D8',     // Hover state
      dark: '#3A6B94',      // Pressed state
      contrastText: '#fff',
    },
    secondary: {
      main: '#B0B3B8',      // Neutral Gray
      light: '#c5c7cc',
      dark: '#9a9da1',
    },
    background: {
      default: '#111439',   // Deep Indigo (per design system spec)
      // Cards are DEEP indigo glass panels, not lighter ones. On the lit steel-indigo
      // canvas (AppAmbientBackdrop) a pale surface goes washed-out/muddy; a deeper,
      // slightly translucent panel reads as substantial (frosted blur lets the lit canvas
      // glow through faintly) and is sealed by a crisp light hairline (below). Deeper =
      // safer too: white text on this sits ~13:1. This is the glass-on-lit-canvas model,
      // matching the richer look the shop pages had.
      paper: 'rgba(32, 38, 82, 0.78)',
    },
    text: {
      primary: '#ffffff',
      // Lightened from #B0B3B8: the old grey lost contrast on the lighter end of
      // the card gradient (labels like "Customer PO" were hard to read). This value
      // keeps a muted label feel while staying legible across the whole gradient.
      secondary: '#C8CCD4',
    },
    success: { main: '#10b981' },
    warning: { main: '#f59e0b' },
    error: { main: '#ef4444' },
    info: { main: '#3b82f6' },
  },
  typography: {
    fontFamily: 'var(--font-dm-sans), "DM Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    h1: { fontSize: '2.5rem', fontWeight: 700, lineHeight: 1.2, color: '#ffffff' },
    h2: { fontSize: '2rem', fontWeight: 600, lineHeight: 1.3, color: '#ffffff' },
    h3: { fontSize: '1.75rem', fontWeight: 600, lineHeight: 1.3, color: '#ffffff' },
    h4: { fontSize: '1.5rem', fontWeight: 600, lineHeight: 1.4, color: '#ffffff' },
    h5: { fontSize: '1.25rem', fontWeight: 600, lineHeight: 1.4, color: '#ffffff' },
    h6: { fontSize: '1rem', fontWeight: 600, lineHeight: 1.5, color: '#ffffff' },
    body1: { fontSize: '1rem', lineHeight: 1.6, color: '#ffffff' },
    body2: { fontSize: '0.875rem', lineHeight: 1.5, color: '#C8CCD4' },
    button: { textTransform: 'none', fontWeight: 500 },
  },
  shape: {
    borderRadius: 8,
  },
  components: {
    MuiButton: {
      styleOverrides: {
        root: {
          textTransform: 'none',
          fontWeight: 500,
          padding: '10px 20px',
          minHeight: 48, // Touch target size for shop floor
          transition: 'all 0.2s ease',
        },
        contained: {
          boxShadow: '0 4px 12px rgba(70, 130, 180, 0.3)',
          '&:hover': {
            boxShadow: '0 6px 20px rgba(70, 130, 180, 0.4)',
            transform: 'translateY(-1px)',
          },
        },
        outlined: {
          borderColor: 'rgba(255, 255, 255, 0.35)',
          color: 'rgba(255, 255, 255, 0.85)',
          backgroundColor: 'transparent',
          '&:hover': {
            borderColor: 'rgba(255, 255, 255, 0.6)',
            backgroundColor: 'rgba(255, 255, 255, 0.08)',
          },
        },
        text: {
          color: '#6FA3D8',  // primary.light - visible against gradient
          '&:hover': {
            backgroundColor: 'rgba(111, 163, 216, 0.12)',
            textDecoration: 'underline',
          },
        },
        sizeLarge: {
          padding: '12px 24px',
          fontSize: '1rem',
        },
      },
    },
    MuiTextField: {
      defaultProps: {
        variant: 'outlined',
      },
      styleOverrides: {
        root: {
          '& .MuiInputBase-root': {
            minHeight: 48, // Touch target size
          },
        },
      },
    },
    MuiCard: {
      defaultProps: {
        elevation: 2,  // Use MUI shadow system
      },
      styleOverrides: {
        root: {
          // A DEEP indigo glass panel over the lit canvas — a lighter fill here just looks
          // washed-out. Slightly translucent so the frosted blur carries a hint of the lit
          // canvas; the crisp hairline (below) does the edge definition, not a lightness
          // step. Deep + mostly opaque = the text's contrast floor (~13:1).
          backgroundColor: 'rgba(32, 38, 82, 0.78)',
          backdropFilter: 'blur(15px)',               // Frosted glass effect
          WebkitBackdropFilter: 'blur(15px)',         // Safari support
          // Hairline that seals the panel against the lit canvas. 0.18 nearly vanished on the
          // dark canvas, but 0.28 — crisp on a small card — read as a bright frame stretched
          // around large full-width tables (Jobs/Parts/Quotes wrap an AG Grid in a Card, and
          // that Card edge IS the table's outer border). 0.20 is the middle: still a defined
          // edge on cards, calm around big tables. Internal grid row lines keep their own
          // fainter 0.12 (lib/agGridTheme.ts).
          border: '1px solid rgba(255, 255, 255, 0.20)',
          // boxShadow handled by elevation prop
          transition: 'transform 0.2s ease, box-shadow 0.2s ease',
          '&:hover': {
            transform: 'translateY(-2px)',
          },
        },
      },
    },
    MuiPaper: {
      styleOverrides: {
        root: {
          backgroundImage: 'none',
        },
      },
    },
    MuiDialog: {
      styleOverrides: {
        paper: {
          backgroundColor: '#111439',  // Deep Indigo (per design system spec)
          backgroundImage: 'linear-gradient(135deg, #111439 0%, #1a1f4a 100%)',
          border: '1px solid rgba(255, 255, 255, 0.12)',
        },
      },
    },
    MuiListItemButton: {
      styleOverrides: {
        root: {
          minHeight: 48, // Touch target size
        },
      },
    },
    MuiMenu: {
      styleOverrides: {
        paper: {
          backgroundColor: '#1a1f4a',  // Solid Deep Indigo for dropdown menus
          backgroundImage: 'none',
          boxShadow: '0 8px 32px rgba(0, 0, 0, 0.5)',
        },
      },
    },
    MuiPopover: {
      styleOverrides: {
        paper: {
          backgroundColor: '#1a1f4a',  // Solid Deep Indigo for popovers (Select menus)
          backgroundImage: 'none',
          boxShadow: '0 8px 32px rgba(0, 0, 0, 0.5)',
        },
      },
    },
    MuiAutocomplete: {
      styleOverrides: {
        paper: {
          backgroundColor: '#1a1f4a',  // Solid Deep Indigo for autocomplete dropdowns
          backgroundImage: 'none',
          border: '1px solid rgba(255, 255, 255, 0.12)',
        },
        option: {
          '&:hover': {
            backgroundColor: 'rgba(255, 255, 255, 0.08)',
          },
          '&[aria-selected="true"]': {
            backgroundColor: 'rgba(70, 130, 180, 0.2)',
          },
        },
        groupLabel: {
          fontWeight: 600,
          color: '#4682B4',
          borderBottom: '1px solid rgba(255, 255, 255, 0.12)',
        },
      },
    },
    MuiLink: {
      styleOverrides: {
        root: {
          color: '#ffffff',  // text.primary - visible against gradient background
          '&:hover': {
            color: '#6FA3D8',  // primary.light on hover
          },
        },
      },
    },
  },
});

export default jiggedTheme;
