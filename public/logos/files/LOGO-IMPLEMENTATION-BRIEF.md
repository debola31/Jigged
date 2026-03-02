# Jigged Logo & Brand Implementation Brief

> **For Claude Code** — This document contains everything needed to implement the finalized Jigged logo across the application. Use it to update the branding branch.

---

## The Logo

The Jigged logo is a **Constructed J** — a letter J built from three distinct geometric segments, each with its own color. The concept references manufacturing (assembled precision parts) and mirrors Figma's approach of using a deconstructed first letter as the brand icon.

### Icon Anatomy

```
┌──────────────────────────┐
│  ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓  │  ← Top crossbar: Warm Amber (#D4872A)
│            ████████████  │
│            ██ STEM ████  │  ← Vertical stem: Steel Blue (#4682B4)
│            ████████████  │
│            ████████████  │
│  ▒▒▒▒▒▒▒▒▒████████████  │
│  ▒▒ HOOK ▒▒▒▒▒▒▒▒▒▒▒▒▒  │  ← Bottom hook: Teal (#2BBCB3)
│  ▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒  │
└──────────────────────────┘
```

### The SVG (canonical source — 64×64 viewBox)

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="none">
  <rect width="64" height="64" rx="12" fill="#151520"/>
  <rect x="14" y="10" width="30" height="10" rx="2" fill="#D4872A"/>
  <rect x="30" y="10" width="10" height="32" rx="0" fill="#4682B4"/>
  <path d="M40 42 L40 54 L26 54 Q14 54 14 42 L24 42 Q30 42 30 48 L30 54" fill="#2BBCB3"/>
</svg>
```

---

## Color Palette

### Brand Colors (Logo)

| Role | Name | Hex | Usage |
|------|------|-----|-------|
| Primary accent | Warm Amber | `#D4872A` | Logo top bar, primary brand accent, CTAs where appropriate |
| Secondary | Steel Blue | `#4682B4` | Logo stem, app UI primary, links, active states |
| Tertiary | Teal | `#2BBCB3` | Logo hook, secondary accent, success states |

### App Background Colors (existing — do not change)

| Role | Hex | Usage |
|------|-----|-------|
| App background | `#0d1b2a` | Main content area |
| Sidebar background | `#091422` | Navigation sidebar |
| Icon container (dark) | `#151520` | Dark icon background |
| Icon container (light) | `#F0EDE8` | Light/keynote icon background |
| Deep Indigo | `#1a2744` | Wordmark on light backgrounds |

---

## Typography

### Wordmark Font: DM Sans Bold (700)

The wordmark "Jigged" uses **DM Sans** at weight **700** with letter-spacing **-0.03em**.

**Why DM Sans:** It's geometric, clean, and slightly humanist — modern without being cold. It pairs well with the constructed icon and doesn't compete with it. It's already available via Google Fonts and works well for UI text too, which means the logo font and app font can be the same family (reducing font load).

```css
/* Wordmark styling */
.jigged-wordmark {
  font-family: 'DM Sans', system-ui, -apple-system, sans-serif;
  font-weight: 700;
  letter-spacing: -0.03em;
}
```

### Application Font: DM Sans

Use **DM Sans** as the primary font across the application. This gives visual consistency between the logo wordmark and the UI.

| Usage | Weight | Size (reference) |
|-------|--------|------------------|
| Wordmark (logo lockup) | 700 | Varies by context |
| Page headings | 600–700 | 18–24px |
| Section headings | 600 | 14–16px |
| Body text | 400 | 13–14px |
| Labels / captions | 500 | 11–12px |
| Monospace (data, code) | Space Mono 400 | 12–13px |

**Google Fonts import:**
```html
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=Space+Mono:wght@400;700&display=swap" rel="stylesheet">
```

**Next.js setup (if using next/font):**
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

---

## Logo Lockups

### 1. Full Lockup (Icon + Wordmark) — Primary

Use this as the default logo wherever space allows.

```
[ J icon ]  Jigged
```

- Icon sits to the left of the wordmark
- Vertical centering: align icon center with wordmark x-height center
- Gap between icon and wordmark: approximately 25% of icon width
- Minimum size: icon at 24px, wordmark at 14px

**On dark backgrounds:**
- Wordmark color: `#FFFFFF`
- Icon: standard dark variant (bg: `#151520`)

**On light backgrounds:**
- Wordmark color: `#1a2744` (Deep Indigo)
- Icon: light variant (bg: `#F0EDE8`)

### 2. Icon Only — Favicon / App Icon / Compact

Use the icon alone for:
- Browser favicon (use at 32×32, 16×16)
- Mobile app icon
- Sidebar when collapsed
- Social media profile pictures
- Anywhere space is too tight for the full lockup

### 3. Wordmark Only — Text Contexts

"Jigged" in DM Sans 700 with -0.03em tracking. Use when the icon has already been established on the page (e.g., wordmark in the page header when the icon is in the sidebar).

---

## Implementation Locations

### Favicon
Place the dark icon SVG as the favicon. Generate sizes:
- `favicon.ico` (16×16, 32×32)
- `apple-touch-icon.png` (180×180)
- `favicon-32x32.png`
- `favicon-16x16.png`

**In Next.js `app/layout.tsx`:**
```typescript
export const metadata = {
  icons: {
    icon: '/favicon.ico',
    apple: '/apple-touch-icon.png',
  },
};
```

### Login Screen
The login screen (see current screenshot) should use the **full lockup** centered above the sign-in card:

```
        [ J icon 48px ]  Jigged
        Manufacturing Operations      ← subtitle in DM Sans 400, 13px
                                         color: rgba(255,255,255,0.45)

     ┌─────────────────────────────┐
     │         Sign In              │
     │                              │
     │  [ Email field ]             │
     │  [ Password field ]          │
     │  [ Sign In button ]          │
     │                              │
     └─────────────────────────────┘
```

- Icon size: **48px** (with `#151520` background container)
- Wordmark: **DM Sans 700, 28–30px, #FFFFFF**
- Subtitle "Manufacturing Operations": **DM Sans 400, 13px, rgba(255,255,255,0.45)**
- Gap between icon and wordmark: **14px**

### App Sidebar
The sidebar should show the full lockup at smaller scale:

- Icon size: **24–26px**
- Wordmark: **DM Sans 700, 15–16px, #FFFFFF**
- Gap: **10px**
- Padding from sidebar top: **16px**
- Margin below logo before nav items: **14px**

### Browser Tab Title
Format: `{Page Name} — Jigged`
Examples: `Parts — Jigged`, `Dashboard — Jigged`

---

## SVG Files Included

All SVG source files are in the `svg/` directory alongside this document:

| File | Description | Use when |
|------|-------------|----------|
| `jigged-icon-dark.svg` | Icon with dark container (#151520) | On dark app backgrounds, sidebar |
| `jigged-icon-light.svg` | Icon with light container (#F0EDE8) | On white/light backgrounds, keynotes |
| `jigged-mark.svg` | Standalone mark, no background | When you need to place on a custom background |

---

## Quick Reference for Claude Code

### What to update:
1. **Favicon** — Replace with `jigged-icon-dark.svg` rendered as ICO/PNG
2. **Login page** — Replace current logo with full lockup (icon + "Jigged" wordmark + "Manufacturing Operations" subtitle)
3. **Sidebar** — Replace current logo with smaller full lockup
4. **Font** — Switch app font to DM Sans (all weights: 400, 500, 600, 700) + Space Mono for monospace contexts
5. **`<title>` tag** — Format as `{Page} — Jigged`
6. **Brand guide & design system docs** — Update color values and font references to match this spec

### Brand colors to add/update in the theme:

```typescript
// Add to your MUI theme or CSS variables
const brandColors = {
  // Logo / brand accent colors
  warmAmber: '#D4872A',     // Primary brand accent
  steelBlue: '#4682B4',     // Already in use — keep as-is
  teal: '#2BBCB3',          // New — logo hook, secondary accent
  deepIndigo: '#1a2744',    // Wordmark on light backgrounds

  // Icon container backgrounds
  iconBgDark: '#151520',
  iconBgLight: '#F0EDE8',
};
```

### Do NOT change:
- The app's existing blue gradient background on the login page
- The sidebar background color (#091422)
- The Steel Blue (#4682B4) usage for UI interactive elements
- The existing glassmorphism card styling
