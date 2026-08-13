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
    /**
     * `main` is for BORDERS, ICONS and FILLS — not for text on a tinted panel.
     *
     * #ef4444 on the alert-tinted card background (which composites to about
     * rgb(57,55,92)) measures 2.98:1. The bar is 4.5:1 body / 3:1 large
     * (design-system.md, "Contrast, keyboard, semantics"), so it fails even the
     * easier large-text clause. `light` is the same alert red raised until it
     * clears the body-text floor with room to spare — 5.90:1 — rather than
     * squeaking past it, since the standard is measured against a 500–1000 lux
     * shop floor and treated as a hard limit.
     *
     * Use `error.light` for error TEXT on any tinted surface; `error.main`
     * still reads fine as a border or icon against the darker page canvas.
     */
    error: { main: '#ef4444', light: '#fca5a5' },
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
        /**
         * `color="error"` on a TEXT or OUTLINED button paints the label in
         * `error.main`, which measures 3.70:1 on a card and 4.47:1 on a dialog —
         * both under the 4.5:1 body floor. Only the raw page canvas passes, and
         * a destructive button almost never sits on the raw canvas.
         *
         * `contained` is deliberately untouched: it paints white on an
         * error.main FILL, which is a different calculation and already fine.
         * Lightening it would wash out the one affordance that should look
         * unmistakably dangerous.
         */
        root: ({ ownerState, theme }) => ({
          textTransform: 'none',
          fontWeight: 500,
          padding: '10px 20px',
          minHeight: 48, // Touch target size for shop floor
          transition: 'all 0.2s ease',
          ...(ownerState.color === 'error' && ownerState.variant !== 'contained'
            ? { color: theme.palette.error.light }
            : {}),
        }),
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
    /*
     * A MODAL SURFACE IS OPAQUE. `background.paper` is `rgba(32, 38, 82, 0.78)` on purpose — a card
     * is meant to sit *on* the lit canvas and let a little of it through. A drawer is not a card:
     * it covers the page, and at 78% the page reads straight through it. Caught on a 390px screen,
     * where a full-width drawer over a full-width grid made both illegible at once.
     *
     * Dialog and Menu already carry this same override for this same reason; a drawer was the one
     * modal surface still inheriting the card value. Every drawer in the app today sets its own
     * paper background, so this changes none of them — it fixes the DEFAULT, which is what the next
     * one will get.
     */
    MuiDrawer: {
      styleOverrides: {
        paper: {
          backgroundColor: '#111439',
          backgroundImage: 'linear-gradient(135deg, #111439 0%, #1a1f4a 100%)',
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
