// Shared marketing brand tokens. The app-wide theme (lib/theme.ts) is off-limits for
// marketing work, so the signature gradient + palette live here, defined once, and both
// landing-page variants pull from this file.

export const BRAND = {
  indigo: '#111439',
  indigoRaised: 'rgba(17, 20, 57, 0.55)',
  steel: '#4682B4',
  steelLight: '#6FA3D8',
  steelDark: '#3A6B94',
  amber: '#D4872A',
  teal: '#2BBCB3',
} as const;

export const BRAND_GRADIENT =
  'linear-gradient(135deg, #D4872A 0%, #4682B4 50%, #2BBCB3 100%)';
export const BRAND_GRADIENT_HOVER =
  'linear-gradient(135deg, #b8721f 0%, #3A6B94 50%, #239e97 100%)';

// The one gradient CTA, defined once so every "Request access" button matches.
export const gradientButtonSx = {
  fontWeight: 600,
  background: BRAND_GRADIENT,
  boxShadow: '0 6px 20px -6px rgba(70, 130, 180, 0.5)',
  '&:hover': { background: BRAND_GRADIENT_HOVER },
} as const;

// Gradient-filled text, used sparingly for eyebrows / a single accent word.
export const gradientTextSx = {
  background: BRAND_GRADIENT,
  WebkitBackgroundClip: 'text',
  backgroundClip: 'text',
  color: 'transparent',
} as const;

// Uppercase eyebrow label above section headings.
export const eyebrowSx = {
  display: 'inline-block',
  textTransform: 'uppercase',
  letterSpacing: '0.16em',
  fontSize: { xs: '0.72rem', md: '0.78rem' },
  fontWeight: 600,
} as const;

// Editorial display face (Space Grotesk), loaded in app/(marketing)/layout.tsx.
// Falls back to DM Sans if the variable isn't present.
export const DISPLAY_FONT =
  'var(--font-space-grotesk), var(--font-dm-sans), sans-serif';

// Faint isometric/blueprint grid — the editorial motif, echoing the wireframe hero.
export const blueprintGridSx = {
  backgroundImage: `
    linear-gradient(rgba(70,130,180,0.06) 1px, transparent 1px),
    linear-gradient(90deg, rgba(70,130,180,0.06) 1px, transparent 1px)
  `,
  backgroundSize: '46px 46px',
} as const;
