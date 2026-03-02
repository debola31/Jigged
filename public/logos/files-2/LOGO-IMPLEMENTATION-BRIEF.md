# Jigged Logo & Brand Implementation Brief

> **For Claude Code** — Final, approved logo specification. Use this to implement branding across the application.

---

## The Logo

The Jigged logo is a **Constructed J** — a letter J built from three distinct geometric segments, each a different color. The concept references manufacturing (precision-assembled parts) and uses the first letter as a standalone icon, similar to Figma's approach.

### Icon Anatomy

Three pieces, three colors, zero gaps:

```
  ████████████████████████████   ← Top crossbar: Warm Amber (#D4872A)
                  ▓▓▓▓▓▓▓▓▓▓
                  ▓▓ STEM ▓▓▓   ← Vertical stem: Dark Indigo (#1a2744)
                  ▓▓▓▓▓▓▓▓▓▓
                  ▓▓▓▓▓▓▓▓▓▓
  ░░░░░░░░░░░░░░░▓▓▓▓▓▓▓▓▓▓
  ░░░░ HOOK ░░░░░░░░░░░░░░░░   ← Bottom hook: Teal (#2BBCB3)
  ░░░░░░░░░░░░░░░░░░░░░░░░░░
```

### Two Variants

The icon has **two versions** for different contexts:

| Variant | When to use | Notes |
|---------|-------------|-------|
| **Containerless** | Login screen hero, website header, keynotes, marketing materials, any placement ≥ 32px | The J floats directly on the background. Looks premium at large sizes. |
| **Contained** (dark bg) | Favicon, sidebar icon, app icon, social profiles, any placement < 32px | The J sits inside a `#151520` rounded-rect container. Ensures legibility at small sizes. |

---

## SVG Source Code

### Containerless Mark (for login screen, website, large placements)

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 44 54" fill="none">
  <rect x="0" y="0" width="30" height="10" rx="2" fill="#D4872A"/>
  <rect x="16" y="0" width="10" height="32" rx="0" fill="#1a2744"/>
  <path d="M26 32 L26 44 L12 44 Q0 44 0 32 L10 32 Q16 32 16 38 L16 44" fill="#2BBCB3"/>
</svg>
```

### Contained Icon — Dark (for favicon, sidebar, app icon)

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="none">
  <rect width="64" height="64" rx="12" fill="#151520"/>
  <rect x="14" y="10" width="30" height="10" rx="2" fill="#D4872A"/>
  <rect x="30" y="10" width="10" height="32" rx="0" fill="#1a2744"/>
  <path d="M40 42 L40 54 L26 54 Q14 54 14 42 L24 42 Q30 42 30 48 L30 54" fill="#2BBCB3"/>
</svg>
```

### Contained Icon — Light (for keynote slides, print, white backgrounds)

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="none">
  <rect width="64" height="64" rx="12" fill="#F0EDE8"/>
  <rect x="14" y="10" width="30" height="10" rx="2" fill="#D4872A"/>
  <rect x="30" y="10" width="10" height="32" rx="0" fill="#1a2744"/>
  <path d="M40 42 L40 54 L26 54 Q14 54 14 42 L24 42 Q30 42 30 48 L30 54" fill="#2BBCB3"/>
</svg>
```

---

## Color Palette

### Brand Colors (Final)

| Role | Name | Hex | Usage |
|------|------|-----|-------|
| Primary accent | Warm Amber | `#D4872A` | Logo top bar, primary brand accent |
| Stem / dark neutral | Dark Indigo | `#1a2744` | Logo stem, wordmark on light backgrounds |
| App primary | Steel Blue | `#4682B4` | UI interactive elements (links, active states, buttons) — unchanged |
| Tertiary / fresh | Teal | `#2BBCB3` | Logo hook, secondary accent, success states |
| Icon container dark | Dark Charcoal | `#151520` | Contained icon background (dark variant) |
| Icon container light | Warm Linen | `#F0EDE8` | Contained icon background (light variant) |

### App Background Colors (do NOT change)

| Role | Hex |
|------|-----|
| App background | `#0d1b2a` |
| Sidebar background | `#091422` |
| Login gradient | Existing blue gradient — keep as-is |

---

## Typography

### Font Family: DM Sans

Use **DM Sans** as the single font family for both the logo wordmark and all app UI text.

**Google Fonts import:**
```html
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=Space+Mono:wght@400;700&display=swap" rel="stylesheet">
```

**Next.js setup:**
```typescript
import { DM_Sans, Space_Mono } from 'next/font/google';

export const dmSans = DM_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-dm-sans',
});

export const spaceMono = Space_Mono({
  subsets: ['latin'],
  weight: ['400', '700'],
  variable: '--font-space-mono',
});
```

### Wordmark Styling

```css
.jigged-wordmark {
  font-family: 'DM Sans', system-ui, -apple-system, sans-serif;
  font-weight: 700;
  letter-spacing: -0.03em;
}
```

- On dark backgrounds: color `#FFFFFF`
- On light backgrounds: color `#1a2744`

### App Typography Scale

| Usage | Font | Weight | Size |
|-------|------|--------|------|
| Wordmark in logo lockup | DM Sans | 700 | Context-dependent |
| Page headings | DM Sans | 600–700 | 18–24px |
| Section headings | DM Sans | 600 | 14–16px |
| Body text | DM Sans | 400 | 13–14px |
| Labels / captions | DM Sans | 500 | 11–12px |
| Data tables / code | Space Mono | 400 | 12–13px |

---

## Implementation: Placement Specifications

### 1. Login Screen (Hero — Containerless)

```
              [ Containerless J mark, 48–52px ]  Jigged
                    Manufacturing Operations

           ┌──────────────────────────────────┐
           │            Sign In                │
           │  ...                              │
           └──────────────────────────────────┘
```

- **Icon variant:** Containerless mark (no background rect)
- **Icon size:** 48–52px tall
- **Wordmark:** DM Sans 700, 28–32px, `#FFFFFF`, letter-spacing: -0.03em
- **Subtitle:** DM Sans 400, 13px, `rgba(255, 255, 255, 0.45)`
- **Layout:** Icon and wordmark on the same horizontal line, centered
- **Gap between icon and wordmark:** 12–14px
- **Gap between wordmark line and subtitle:** 4–6px
- **Gap between subtitle and sign-in card:** 20–24px

### 2. App Sidebar (Contained)

- **Icon variant:** Contained dark (`#151520` background)
- **Icon size:** 24–26px
- **Wordmark:** DM Sans 700, 15–16px, `#FFFFFF`
- **Gap between icon and wordmark:** 10px
- **Layout:** Horizontal, vertically centered
- **Padding from sidebar top:** 16px
- **Margin below logo before nav items:** 14px

### 3. Favicon (Contained)

Use the contained dark icon. Generate:
- `favicon.ico` — 16×16 and 32×32
- `favicon-32x32.png`
- `favicon-16x16.png`
- `apple-touch-icon.png` — 180×180

```typescript
// Next.js app/layout.tsx
export const metadata = {
  title: { template: '%s — Jigged', default: 'Jigged' },
  icons: {
    icon: '/favicon.ico',
    apple: '/apple-touch-icon.png',
  },
};
```

### 4. Browser Tab Title Format

```
{Page Name} — Jigged
```

Examples: `Parts — Jigged`, `Dashboard — Jigged`, `Sign In — Jigged`

---

## Brand Colors for Theme

Add these to the MUI theme or CSS custom properties:

```typescript
const brandColors = {
  warmAmber: '#D4872A',      // Logo top bar, primary brand accent
  darkIndigo: '#1a2744',     // Logo stem, wordmark on light backgrounds
  steelBlue: '#4682B4',      // UI primary (existing — do not change)
  teal: '#2BBCB3',           // Logo hook, secondary accent
  iconBgDark: '#151520',     // Contained icon background
  iconBgLight: '#F0EDE8',    // Contained icon background (light)
};
```

---

## Files Included

| File | Description |
|------|-------------|
| `svg/jigged-mark-containerless.svg` | Containerless J mark (login hero, website, marketing) |
| `svg/jigged-icon-contained-dark.svg` | Contained icon with dark bg (favicon, sidebar, app icon) |
| `svg/jigged-icon-contained-light.svg` | Contained icon with light bg (keynotes, print) |
| `LOGO-IMPLEMENTATION-BRIEF.md` | This file |

---

## Checklist

- [ ] Add SVG files to `public/` or appropriate assets directory
- [ ] Replace favicon with contained dark icon (generate ICO + PNG sizes)
- [ ] Update login screen: containerless icon + wordmark lockup + subtitle
- [ ] Update sidebar: contained icon + wordmark lockup
- [ ] Switch app font to DM Sans (400, 500, 600, 700) + Space Mono
- [ ] Set `<title>` template to `%s — Jigged`
- [ ] Add brand colors to theme (`warmAmber`, `teal`, `darkIndigo`)
- [ ] Update brand-guide.md and design-system.md with new values
