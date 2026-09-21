# Jigged Brand Style Guide

> Lightweight brand reference for landing pages, coming-soon pages, and marketing materials.
> For the in-app design system and MUI theme, see [`design-system.md`](design-system.md) and [`lib/theme.ts`](../lib/theme.ts).

---

## 1. Logo

Jigged currently uses a **text wordmark** — the word "Jigged" rendered in Steel Blue, bold weight.

### Wordmark Specification

| Property | Value |
|----------|-------|
| Text | Jigged |
| Color (on dark) | Steel Blue `#4682B4` |
| Color (on light) | Deep Indigo `#111439` |
| Weight | 700 (Bold) |
| Letter spacing | -0.5px |
| Tagline | Manufacturing Operations |
| Tagline color (on dark) | Neutral Gray `#B0B3B8` |

### Usage Rules

- **Minimum size:** 24px font size (print equivalent: 18pt)
- **Clear space:** Maintain padding equal to the height of the letter "J" on all sides
- **Approved backgrounds:** Deep Indigo (`#111439`), brand gradient, or white/light neutral

### Logo Don'ts

- Do not stretch, skew, or rotate the wordmark
- Do not change the wordmark colors beyond the approved dark/light variants
- Do not add drop shadows, outlines, or glow effects
- Do not place on busy photography or low-contrast backgrounds
- Do not rearrange the wordmark and tagline onto a single line

---

## 2. Color Palette

### Primary Brand Colors

| Color | Hex | Usage |
|-------|-----|-------|
| Steel Blue | `#4682B4` | Primary brand color, CTAs, links, accents |
| Deep Indigo | `#111439` | Backgrounds, gradient foundation |
| Light Blue | `#6FA3D8` | Hover states, secondary accents |
| Neutral Gray | `#B0B3B8` | Secondary text, subtle UI elements |

### Extended Palette

| Color | Hex | Usage |
|-------|-----|-------|
| Dark Blue | `#3A6B94` | Pressed/active states |
| White | `#FFFFFF` | Primary text on dark backgrounds |

### Status Colors (Reference)

| Status | Hex | Context |
|--------|-----|---------|
| Success | `#10b981` | Completed, passed, positive |
| Warning | `#f59e0b` | Attention needed, pending |
| Error | `#ef4444` | Overdue, critical, failed |
| Info | `#3b82f6` | In progress, informational |

### Color Usage Rules

- **Dark contexts (default):** White text on Deep Indigo/gradient backgrounds
- **Light contexts (marketing print):** Deep Indigo text on white backgrounds
- **CTAs and links:** Always Steel Blue `#4682B4`
- **Never** hardcode colors in app code — use theme tokens instead (see `design-system.md`)

---

## 3. Brand Gradient

The gradient is Jigged's visual signature. It must appear on all dark-background pages and marketing hero sections.

```css
background: linear-gradient(135deg, #111439 0%, #4682B4 50%, #111439 100%);
background-attachment: fixed;
```

| Property | Value |
|----------|-------|
| Type | Linear, 135-degree angle |
| Stop 1 | Deep Indigo `#111439` at 0% (top-left) |
| Stop 2 | Steel Blue `#4682B4` at 50% (center) |
| Stop 3 | Deep Indigo `#111439` at 100% (bottom-right) |
| Attachment | Fixed (gradient stays in place when scrolling) |

**Effect:** A centered spotlight of Steel Blue fading to Deep Indigo at both edges — evoking a precision-machined surface under focused lighting.

### Gradient Usage

- **Hero sections:** Full-bleed gradient background
- **Marketing cards/sections:** May use the gradient as an overlay or accent
- **Print/static:** Use the gradient at 135 degrees; omit `background-attachment`
- **Never** substitute different colors or angles — the gradient is a fixed brand element

---

## 4. Typography

### Marketing Pages

For landing pages, coming-soon pages, and marketing materials, use **Space Grotesk** for display
type — headlines, section headings, large numerals — over the system stack for body copy.

*(Corrected 2026-09-11: this section specified **Inter** and had done since it was written, but the
marketing layout has never loaded it. `app/(marketing)/layout.tsx`
loads Space Grotesk at weights 500/600/700 and exposes it as `--font-space-grotesk`, which
[`marketingStyles.ts`](../components/marketing/marketingStyles.ts) reads as `DISPLAY_FONT`. The
implementation is the one that shipped and was validated, so the guide follows the code rather than
the other way round.)*

| Element | Font | Weight | Size |
|---------|------|--------|------|
| Hero headline | Space Grotesk | 600 | `clamp(2.75rem, 7vw, 5.5rem)` |
| Section heading | Space Grotesk | 600 | `clamp(2rem, 4.6vw, 3.4rem)` |
| Subheading | Space Grotesk | 600 | 20–24px |
| Body text | System stack | 400 (Regular) | 16–18px |
| Caption / fine print | System stack | 400 (Regular) | 14px |

**Loading it:** already done, once, in the marketing route group's layout — do not add a second
loader:

```typescript
import { Space_Grotesk } from 'next/font/google';

const spaceGrotesk = Space_Grotesk({
  subsets: ['latin'],
  weight: ['500', '600', '700'],
  variable: '--font-space-grotesk',
  display: 'swap',
});
```

### In-App (Reference)

The app uses a system font stack — see `lib/theme.ts`:
```
-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif
```

Marketing pages use Space Grotesk for headings and the system stack for body text. Small text —
eyebrows, captions, chips — must **never** use the brand gradient as a fill: the gradient sweeps
through a steel stop at roughly 4.3:1 and fails small-text contrast. `EYEBROW_COLOR` (`#7FB3E0`)
exists for that, and clears 8:1 on the indigo ground.

### Typography Rules

- **No uppercase transforms** on buttons or headings — sentence case only
- **Minimum body text:** 16px for readability under bright shop-floor lighting
- **Line height:** 1.4–1.6 for body text; 1.1–1.2 for large headlines
- **Letter spacing:** Slightly tightened (-0.5px) for headings at large sizes

---

## 5. Brand Voice & Tone

### Who We're Talking To

Jigged's primary audience is **small manufacturing shop owners and managers** — typically 50–60 years old, hands-on, practical, and skeptical of software that over-promises.

### Voice Principles

| Principle | What it means |
|-----------|--------------|
| **Clear** | Say exactly what you mean. No buzzwords, no filler. |
| **Professional** | Respectful, competent tone. Not corporate-stiff, not casual-sloppy. |
| **Practical** | Focus on outcomes and real problems. Lead with what it does, not how it works. |
| **Confident** | State facts directly. Avoid hedging ("might help," "could possibly"). |

### Tone in Practice

**Headlines and CTAs:**
Direct, benefit-oriented, action-driven.

- "Track every job from quote to delivery"
- "See your shop floor in real time"
- "Get started in minutes"

**Body copy:**
Straightforward, specific, outcome-focused.

- "Jigged replaces spreadsheets and whiteboards with a single system your whole team can use — from the office to the shop floor."

**Error messages and UI text:**
Helpful, not robotic. Tell the user what happened and what to do next.

- "We couldn't save your changes. Check your connection and try again."

### Vocabulary Preferences

| Use | Avoid |
|-----|-------|
| Jobs | Work orders (unless in formal context) |
| Shop floor | Production environment |
| Track | Monitor / surveil |
| Team | Workforce / human capital |
| Simple | Intuitive / seamless |
| Get started | Onboard / activate |
| Built for shops like yours | Enterprise-grade solution |

### Words to Avoid Entirely

- Synergy, leverage, paradigm, disrupt, revolutionize
- AI-powered (unless describing a specific AI feature)
- Best-in-class, world-class, cutting-edge
- Any superlative you can't back up with data

---

## 6. Do's and Don'ts

### Visual

| Do | Don't |
|----|-------|
| Use the brand gradient on dark backgrounds | Use flat solid backgrounds where the gradient should appear |
| Use Steel Blue for CTAs and primary actions | Use other blues or off-brand colors for primary actions |
| Maintain generous whitespace | Crowd elements together |
| Use the wordmark in approved colors only | Recolor, outline, or add effects to the wordmark |
| Ensure text contrast meets WCAG 4.5:1 minimum | Place light text on light backgrounds or vice versa |

### Messaging

| Do | Don't |
|----|-------|
| Speak in plain language a shop owner understands | Use SaaS jargon or buzzwords |
| Lead with the benefit, not the feature | Describe technical architecture to the user |
| Be specific: "track 50 jobs at once" | Be vague: "manage your operations more efficiently" |
| Use sentence case for headings and buttons | Use ALL CAPS or Title Case For Every Word |
| Keep sentences short (under 25 words) | Write long, complex sentences with multiple clauses |

---

## Quick Reference Card

```
Brand:      Jigged — Manufacturing Operations
Gradient:   linear-gradient(135deg, #111439 0%, #4682B4 50%, #111439 100%)
Primary:    #4682B4 (Steel Blue)
Background: #111439 (Deep Indigo)
Accent:     #6FA3D8 (Light Blue)
Secondary:  #B0B3B8 (Neutral Gray)
Font:       Inter (marketing) / System stack (app)
Voice:      Clear. Professional. Practical.
```
