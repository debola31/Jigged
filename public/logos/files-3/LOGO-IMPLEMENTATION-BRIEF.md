# Jigged Logo & Brand Implementation Brief

> **For Claude Code** — Final approved logo. Implement across the entire application.

---

## The Logo

The Jigged logo is a **Constructed J** — a letter J built from three geometric segments inside a dark container, paired with a wordmark. The three-piece construction references precision manufacturing — assembled parts held in alignment.

### Icon (one icon, used everywhere)

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="none">
  <rect width="64" height="64" rx="12" fill="#151520"/>
  <rect x="14" y="10" width="30" height="10" rx="2" fill="#D4872A"/>
  <rect x="30" y="10" width="10" height="32" rx="0" fill="#1a2744"/>
  <path d="M40 42 L40 54 L26 54 Q14 54 14 42 L24 42 Q30 42 30 48 L30 54" fill="#2BBCB3"/>
</svg>
```

**Anatomy:**
- Container: `#151520` (dark charcoal), `rx="12"`
- Top crossbar: `#D4872A` (Warm Amber)
- Vertical stem: `#1a2744` (Dark Indigo)
- Bottom hook: `#2BBCB3` (Teal)

There is also a **light-background variant** (for keynotes/print only) that swaps the container fill to `#F0EDE8`. The three inner pieces stay identical. See included `jigged-icon-light.svg`.

---

## Color Palette

### Brand Colors

| Name | Hex | Role |
|------|-----|------|
| Warm Amber | `#D4872A` | Logo top bar, primary brand accent |
| Dark Indigo | `#1a2744` | Logo stem, wordmark on light backgrounds |
| Steel Blue | `#4682B4` | App UI primary — links, active states, buttons (existing, do not change) |
| Teal | `#2BBCB3` | Logo hook, secondary accent, success states |
| Dark Charcoal | `#151520` | Icon container background |
| Warm Linen | `#F0EDE8` | Icon container background (light variant) |

### Existing App Colors (do NOT change)

| Hex | Role |
|-----|------|
| `#0d1b2a` | App background |
| `#091422` | Sidebar background |
| Login blue gradient | Keep as-is |

### Theme Integration

```typescript
// Add to MUI theme or CSS custom properties
const brandColors = {
  warmAmber: '#D4872A',
  darkIndigo: '#1a2744',
  steelBlue: '#4682B4',   // existing — keep
  teal: '#2BBCB3',
  iconBgDark: '#151520',
  iconBgLight: '#F0EDE8',
};
```

---

## Typography

### Primary Font: DM Sans

One font family for the wordmark and all app UI.

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

**Or via Google Fonts link:**
```html
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=Space+Mono:wght@400;700&display=swap" rel="stylesheet">
```

### Wordmark Style

```css
.jigged-wordmark {
  font-family: 'DM Sans', system-ui, -apple-system, sans-serif;
  font-weight: 700;
  letter-spacing: -0.03em;
}
```

- On dark backgrounds: `color: #FFFFFF`
- On light backgrounds: `color: #1a2744`

### App Typography Scale

| Usage | Font | Weight | Size |
|-------|------|--------|------|
| Page headings | DM Sans | 600–700 | 18–24px |
| Section headings | DM Sans | 600 | 14–16px |
| Body text | DM Sans | 400 | 13–14px |
| Labels / captions | DM Sans | 500 | 11–12px |
| Data tables / code | Space Mono | 400 | 12–13px |

---

## Placement Specifications

### Login Screen

```
           [ Icon 48px ]  Jigged
           Manufacturing Operations

        ┌──────────────────────────────┐
        │          Sign In              │
        │  [ Email ]                    │
        │  [ Password ]                 │
        │  [ Sign In button ]           │
        └──────────────────────────────┘
```

- **Icon:** `jigged-icon.svg` at **48px**
- **Wordmark:** DM Sans 700, **28–32px**, `#FFFFFF`, letter-spacing -0.03em
- **Subtitle "Manufacturing Operations":** DM Sans 400, **13px**, `rgba(255,255,255,0.45)`
- **Layout:** Icon and wordmark on the same line, vertically centered, horizontally centered on page
- **Gap icon → wordmark:** 14px
- **Gap wordmark line → subtitle:** 4–6px
- **Gap subtitle → sign-in card:** 20–24px

### App Sidebar

- **Icon:** `jigged-icon.svg` at **24–26px**
- **Wordmark:** DM Sans 700, **15–16px**, `#FFFFFF`
- **Gap icon → wordmark:** 10px
- **Layout:** Horizontal, vertically centered
- **Padding top of sidebar:** 16px
- **Margin below logo → first nav item:** 14px

### Favicon

Use `jigged-icon.svg` to generate:
- `favicon.ico` (16×16 and 32×32)
- `favicon-32x32.png`
- `favicon-16x16.png`
- `apple-touch-icon.png` (180×180)

```typescript
// app/layout.tsx
export const metadata = {
  title: { template: '%s — Jigged', default: 'Jigged' },
  icons: {
    icon: '/favicon.ico',
    apple: '/apple-touch-icon.png',
  },
};
```

### Browser Tab Title

Format: `{Page Name} — Jigged`

Examples: `Parts — Jigged`, `Dashboard — Jigged`, `Sign In — Jigged`

---

## Files Included

| File | Use |
|------|-----|
| `jigged-icon.svg` | Primary icon — use everywhere (login, sidebar, favicon, app icon, social) |
| `jigged-icon-light.svg` | Light-background variant (keynotes, print) |
| `LOGO-IMPLEMENTATION-BRIEF.md` | This file |

---

## Checklist

- [ ] Add `jigged-icon.svg` and `jigged-icon-light.svg` to `public/` or assets directory
- [ ] Generate favicon files from `jigged-icon.svg` (ICO + PNGs)
- [ ] Update login screen: icon (48px) + "Jigged" wordmark + "Manufacturing Operations" subtitle
- [ ] Update sidebar: icon (24px) + "Jigged" wordmark
- [ ] Switch app font to DM Sans (400, 500, 600, 700) + Space Mono for monospace
- [ ] Set `<title>` template to `%s — Jigged`
- [ ] Add brand colors to theme (`warmAmber`, `teal`, `darkIndigo`, `iconBgDark`)
- [ ] Update `docs/brand-guide.md` and `docs/design-system.md` with these values
- [ ] Do NOT change: app background colors, sidebar background, login gradient, Steel Blue UI usage
