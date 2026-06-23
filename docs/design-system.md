# Design System

## Overview

Jigged uses Material-UI (MUI) v5+ as the component library, following Material Design 3 principles with a **single dark gradient theme** that tested exceptionally well with manufacturing users ("pretty fucking awesome" feedback).

**Theme Philosophy:** Static, professional dark gradient theme optimized for manufacturing environments. No light/dark mode toggle - one polished theme that works everywhere.

> **SOURCE OF TRUTH:** All design values are defined in `lib/theme.ts`. This document describes principles and rationale. For exact values, always refer to the theme file.

---

## Brand Identity

### The Gradient (Core Brand Element)

CRITICAL: This must be a LINEAR 3-stop gradient with Steel Blue accent.

The deep gradient background is Jigged's visual signature and must be present on all pages:

```css
/* Linear 3-stop gradient with Steel Blue accent */
background: linear-gradient(135deg, #111439 0%, #4682B4 50%, #111439 100%);
background-attachment: fixed;
```

**Gradient Specifications:**

- **Type:** LINEAR 3-stop gradient (135 degree angle)

- **Color 1:** Deep Indigo `#111439` at 0% - starts at top-left

- **Color 2:** Steel Blue `#4682B4` at 50% - accent in center

- **Color 3:** Deep Indigo `#111439` at 100% - ends at bottom-right

- **Attachment:** Fixed - gradient stays in place when scrolling

**Why these EXACT colors:**

- `#111439` - Deep indigo provides rich, dark foundation

- `#4682B4` - Steel Blue accent creates industrial, professional feel

- 3-stop creates centered spotlight effect with symmetrical fade

- Matches implementation in `lib/theme.ts`

**Visual Effect:**

The linear 3-stop gradient creates a dramatic spotlight effect with Steel Blue (#4682B4) at the center, fading to Deep Indigo (#111439) at both edges. This creates depth, dimension, and a premium industrial aesthetic - like a precision-machined surface under focused lighting.

**Common Mistake - DO NOT USE MUTED COLORS:**

```css
/* ✅ CORRECT - Linear 3-stop gradient with Steel Blue accent */
background: linear-gradient(135deg, #111439 0%, #4682B4 50%, #111439 100%);
background-attachment: fixed;

/* Alternative: Radial gradient (not currently used) */
/* background: radial-gradient(circle at top left, #0a0d28 0%, #5a96c9 100%); */
```

### Supporting Brand Colors

See `lib/theme.ts` for exact values. Primary colors:

- **Steel Blue (Primary):** `#4682B4` - Primary brand color for CTAs, links, accents

- **Light Blue Accent:** `#6FA3D8` - Hover states, highlights (primary.light)

- **Dark Blue Accent:** `#3A6B94` - Pressed states (primary.dark)

- **Deep Indigo:** `#111439` - Foundation color, background base

- **Neutral Gray:** `#B0B3B8` - Disabled states, subtle UI elements
- **Muted Label Gray:** `#C8CCD4` - Secondary text (`text.secondary` / `body2`); lightened from Neutral Gray so labels stay legible across the lighter end of the card gradient

### Glass Morphism Cards (Critical Styling)

**Principle:** Cards should feel substantial and grounded while retaining subtle depth.

See `lib/theme.ts` for exact values. The key design decisions:

- **Opacity:** Substantial feel for industrial aesthetic with subtle gradient visibility
- **Blur:** Strong frosted glass effect for premium feel
- **Border:** Subtle white border defines card edges against gradient

**Visual Effect:**

Cards should feel solid and professional. This achieves "substantial, not playful" per the design principles while maintaining visual polish. Cards use MUI elevation for shadows combined with glassmorphism (backdrop blur + transparency).

**Test:**

Cards should feel substantial and professional. The gradient should be subtly visible, not prominently showing through.

**Usage:**

```typescript
// Just use MUI Card - theme handles styling automatically
<Card elevation={2}>
  <CardContent>
    {/* Your content */}
  </CardContent>
</Card>
```

---

## MUI Theme Configuration

### Single Dark Theme

The complete theme configuration is in `lib/theme.ts`. Key aspects:

- **Palette:** Dark mode with Steel Blue primary, Neutral Gray secondary
- **Typography:** System font stack, no uppercase transforms
- **Components:** Card glassmorphism, 48px touch targets, custom button variants

**Usage:**

```typescript
import jiggedTheme from '@/lib/theme';
import { ThemeProvider } from '@mui/material/styles';

<ThemeProvider theme={jiggedTheme}>
  {/* Your app */}
</ThemeProvider>
```

See `lib/theme.ts` for the complete configuration with inline documentation.

---

## Design Principles

### 1. Professional, Not Trendy

Must appeal to 50-60 year old shop owners. Avoid flashy animations or overly modern aesthetics. Focus on clarity and function.

### 2. Industrial Aesthetic

Evoke machined metal, precision manufacturing. The Steel Blue gradient suggests depth and professionalism. Colors should feel substantial, not playful.

### 3. Readable in Bright Environments

Shop floors have bright fluorescent lighting (500-1000 lux). White text on dark gradient provides excellent contrast in these conditions.

### 4. No Theme Toggle

Single static theme. No light/dark mode switching. One polished, professional theme that works everywhere.

### 5. Material Design Compliance

Follow Material Design 3 guidelines for consistency, accessibility, and familiar interaction patterns.

---

## Component Usage Guidelines

### Buttons

Primary Actions (job creation, approvals):

```javascript
<Button variant="contained" color="primary" size="large">
  Create job
</Button>
```

**Secondary Actions** (cancel, back):

```javascript
<Button variant="outlined" color="primary">
  Cancel
</Button>
```

**Tertiary Actions** (less important options):

```javascript
<Button variant="text" color="primary">
  Skip
</Button>
```

**Button Variant Theme Overrides:**

The MUI theme includes custom styling for outlined and text button variants to ensure proper contrast against the gradient background:

- **Outlined buttons:** Transparent background with subtle white border (35% opacity) and slightly muted white text (85% opacity). Hover brightens border to 60% opacity.

- **Text buttons:** Use primary.light (#6FA3D8) for link-like appearance with underline on hover. This lighter blue provides good contrast against both dark and Steel Blue portions of the gradient.

```typescript
// Theme button overrides (lib/theme.ts)
outlined: {
  borderColor: "rgba(255, 255, 255, 0.35)",
  color: "rgba(255, 255, 255, 0.85)",
  backgroundColor: "transparent",
  "&:hover": {
    borderColor: "rgba(255, 255, 255, 0.6)",
    backgroundColor: "rgba(255, 255, 255, 0.08)",
  },
},
text: {
  color: "#6FA3D8",  // primary.light
  "&:hover": {
    backgroundColor: "rgba(111, 163, 216, 0.12)",
    textDecoration: "underline",
  },
},
```

### Text Fields

```javascript
<TextField
  fullWidth
  label="job Number"
  variant="outlined"
  margin="normal"
/>
```

### Form validation & required-field feedback

When a submit/save button is disabled because the form is incomplete, **tell the
user what's still missing** — a greyed-out button with no explanation is a dead
end. The standard is an inline notice, **not** a hover tooltip: the app runs on
shop-floor tablets where hover isn't available.

- **`components/common/MissingFieldsNotice`** — render it just above the submit
  button with an `items: string[]` of the blocking reasons (it returns `null`
  when the array is empty). Compute the list from the same conditions that drive
  the button's `disabled` prop. This is the canonical pattern; see
  `ConvertToJobModal`, `MaterialRowEditor`, `CompanyShippingSettingsCard`.
- **Field-level markers** — also set `required` and `error`/`helperText` on the
  specific blocking inputs so the error is visible at the field, not only in the
  summary notice.
- **Typed inputs** — validate with the shared helpers in **`lib/validators`**
  (`isValidEmail`, `isValidPhone`, `isValidPostalCode`, `parseOptionalNumber`,
  `parseOptionalInteger`). Don't re-implement email regexes or number parsers per
  form. Phone fields use `type="tel"`; numeric fields set `inputMode`
  (`'numeric'` for integers, `'decimal'` for decimals) for the right mobile
  keyboard.
- **Addresses** — use **`components/common/CountrySelect`** and **`StateSelect`**
  (US states / CA provinces, free-text fallback for other countries) instead of
  free-text country/state. City stays free text. Validate postal codes per
  country.

### Placeholders

**A placeholder must never resemble real data.** Our users are 50–60 year old
shop owners on tablets; a greyed `25` in an empty Markup % field reads as a
*pre-filled value*, not a hint, and ships wrong quotes. The misleading set —
**banned**:

- Bare numbers: `placeholder="1"`, `placeholder="25"`.
- Currency / value-shaped strings: `placeholder="$0.00"`, `placeholder="e.g. 5.50"`,
  or any computed value (`placeholder={suggestedUnitPrice}`).

These fields already carry a column header or `label`, so the placeholder adds
nothing but confusion. Prefer `label` + `helperText` for guidance on required
fields (see *Form validation* above).

**Allowed** — placeholders that can't be mistaken for entered data:

- Search prompts: `placeholder="Search parts…"`.
- True format hints: `placeholder="customer@example.com"`, `placeholder="Suite, unit, etc."`.
- Action prompts: `placeholder="Note about this part…"`.

This rule is enforced by [`__tests__/standards/interactionStandards.test.ts`](../__tests__/standards/interactionStandards.test.ts)
— a value-shaped placeholder fails CI.

### Cards

```javascript
<Card elevation={3}>
  <CardContent>
    <Typography variant="h6" gutterBottom>
      job #1234
    </Typography>
    <Typography variant="body2" color="text.secondary">
      Customer: Acme Corp
    </Typography>
  </CardContent>
</Card>
```

### Status Badges

```javascript
<Chip 
  label="In Progress" 
  color="info" 
  size="small"
/>

<Chip 
  label="Complete" 
  color="success" 
  size="small"
/>

<Chip 
  label="Overdue" 
  color="error" 
  size="small"
/>
```

---

## Typography Scale

- **h1**: 2.5rem (40px) - Page titles

- **h2**: 2rem (32px) - Section headings

- **h3**: 1.75rem (28px) - Subsection headings

- **h4**: 1.5rem (24px) - Card titles

- **h5**: 1.25rem (20px) - Component headings

- **h6**: 1rem (16px) - Small headings

- **body1**: 1rem (16px) - Primary body text

- **body2**: 0.875rem (14px) - Secondary body text

- **caption**: 0.75rem (12px) - Captions, helper text

---

## Spacing System

MUI uses an 8px base spacing unit accessed via `theme.spacing(n)`:

- `spacing(1)` = 8px

- `spacing(2)` = 16px

- `spacing(3)` = 24px

- `spacing(4)` = 32px

- `spacing(6)` = 48px

- `spacing(8)` = 64px

**Common usage:**

```javascript
<Box sx={{ p: 3 }}>  {/* 24px padding on all sides */}
<Box sx={{ mb: 2 }}>  {/* 16px margin bottom */}
<Box sx={{ px: 4, py: 2 }}>  {/* 32px horizontal, 16px vertical padding */}
```

---

## Color Palette

### Core Brand Colors

See `lib/theme.ts` for exact values:

- **Steel Blue (Primary):** `#4682B4` - Primary brand color, CTAs, links

- **Light Blue:** `#6FA3D8` - Hover states (primary.light)

- **Dark Blue:** `#3A6B94` - Pressed states (primary.dark)

- **Deep Indigo:** `#111439` - Background base, gradient foundation

- **Neutral Gray:** `#B0B3B8` - Disabled states, subtle UI elements
- **Muted Label Gray:** `#C8CCD4` - Secondary text (`text.secondary` / `body2`)

### Status Colors

- Success / Complete: #10b981 - jobs finished, quality passed

- **Warning / Pending**: `#f59e0b` - Approaching deadlines, needs attention

- **Error / Overdue**: `#ef4444` - Late jobs, critical issues

- **Info / In Progress**: `#3b82f6` - Active work, informational notices

### job Status Colors

```javascript
const statusColors = {
  requested: 'default',     // Gray
  approved: 'info',         // Blue
  in_progress: 'primary',   // Steel Blue
  quality_checked: 'info',  // Blue
  shipped: 'success',       // Green
  delivered: 'success',     // Green
  invoiced: 'warning',      // Amber
  complete: 'success',      // Green
  overdue: 'error',         // Red
};
```

---

## Elevation System

MUI provides elevation levels from 0-24:

- **0**: Flat elements (buttons in their default state)

- **1**: Slightly raised cards

- **2**: Standard cards

- **3**: Emphasized cards (auth pages, important forms)

- **4**: App bar, navigation

- **8**: Floating action buttons

- **16**: Modals

- **24**: Full-screen dialogs

**Usage:**

```javascript
<Card elevation={2}>  {/* Standard card */}
<Card elevation={3}>  {/* Emphasized card */}
<AppBar elevation={4}>  {/* Navigation bar */}
```

---

## Accessibility

### WCAG 2.1 Level A Compliance

**Color Contrast:**

- White text (#ffffff) on dark gradient background exceeds 7:1 ratio

- All status colors tested for sufficient contrast

- Secondary text (#C8CCD4) meets minimum 4.5:1 ratio across the card gradient

**Keyboard Navigation:**

- All interactive elements are keyboard accessible

- Focus indicators are visible

- Logical tab order throughout

**Touch Targets:**

- Minimum 48px × 48px for all interactive elements (MUI default)

- Adequate spacing between touch targets

**Screen Reader Support:**

- Semantic HTML via MUI components

- ARIA labels where needed

- Proper heading hierarchy

---

## Implementation Example

### App-Level Theme Setup (Next.js)

```typescript
// src/app/layout.tsx
'use client';

import { ThemeProvider } from '@mui/material/styles';
import { CssBaseline, Box } from '@mui/material';
import jiggedTheme from '@/lib/theme';

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body style={{ margin: 0 }}>
        <ThemeProvider theme={jiggedTheme}>
          <CssBaseline />
          <Box
            sx={{
              minHeight: '100vh',
              background: 'linear-gradient(135deg, #111439 0%, #4682B4 50%, #111439 100%)',
              backgroundAttachment: 'fixed',
            }}
          >
            {children}
          </Box>
        </ThemeProvider>
      </body>
    </html>
  );
}
```

### Component Example

```typescript
import { Card, CardContent, Typography, Button, Chip, Box } from '@mui/material';

function WorkOrderCard({ workOrder }) {
  return (
    <Card elevation={3} sx={{ mb: 2 }}>
      <CardContent>
        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2 }}>
          <Typography variant="h6">
            WO-{[workOrder.id](http://workorder.id/)}
          </Typography>
          <Chip 
            label={workOrder.status} 
            color={statusColors[workOrder.status]}
            size="small"
          />
        </Box>
        
        <Typography variant="body2" color="text.secondary" gutterBottom>
          Customer: {workOrder.customer}
        </Typography>
        
        <Typography variant="body2" color="text.secondary">
          Due: {workOrder.dueDate}
        </Typography>
        
        <Box sx={{ mt: 3 }}>
          <Button variant="contained" fullWidth>
            View Details
          </Button>
        </Box>
      </CardContent>
    </Card>
  );
}
```

---

## Do's and Don'ts

### ✅ Do:

- Use MUI components exclusively - no plain HTML elements

- Use the `sx` prop for styling - no external CSS files

- Use theme spacing: `sx={{ p: 3 }}` not `sx={{ padding: '24px' }}`

- Use theme colors: `color="primary"` not hardcoded hex values

- Apply the linear 3-stop gradient background to all pages

- Let cards use theme defaults - don't override card backgrounds

- Test readability in bright lighting conditions

- Reference `lib/theme.ts` for exact design values

### ❌ Don't:

- Mix plain HTML with MUI components

- Write custom CSS files

- Hardcode pixel values - use theme spacing

- Hardcode colors - use theme palette

- Add light/dark mode toggle

- Use flat backgrounds - gradient is brand identity

- Override card backgrounds unless functionally necessary (modals, etc.)

- Use `textTransform: 'uppercase'` on buttons (already set to 'none')

- Use overly playful or trendy styling

- Duplicate design values in documentation - reference theme.ts instead

---

## Page Layout Patterns

CLAUDE.md covers list, create/edit, and import pages. This section names the conventions for **detail pages** — the page that shows a single record of an entity.

Two patterns coexist by content type. Pick the one that matches the entity; don't mix.

### Pattern A — Reference entity detail

Used by **Parts, Customers, Vendors, Work Centers**. Reference entities are things users open to read settings, see relations, or scan a QR — not to drive a workflow.

```
[← Back to <List>]                           [Edit]  [Delete]

┌───────────────────────────────────────────────────────────┐
│ <Entity name>   [identity chip(s)]   <inline secondary>   │   ← title card
└───────────────────────────────────────────────────────────┘

┌──────────────────────────┬────────────────────────────────┐
│ Details (md=6)           │ Secondary (md=6)               │
│ — key/value rows         │ — QR code, contacts, address…  │
└──────────────────────────┴────────────────────────────────┘

┌───────────────────────────────────────────────────────────┐
│ Optional full-width footer: related counts, timestamps    │
└───────────────────────────────────────────────────────────┘
```

- **Title card** (separate `<Card>`) holds the name + identity chips (kind, status) inline on one row.
- **Body** is a `<Grid container>` of `xs=12 md=6` cards. Both cards use `sx={{ height: '100%' }}` so their bottoms align even when content lengths differ.
- **QR code goes in the md=6 right slot** when present (always visible, no toggle).

### Pattern B — Workflow / document entity detail

Used by **Jobs, Quotes**. Workflow entities are things users open to act on a process (ship, cancel, send PDF) or to step through a child collection (operations, line items).

```
[← Back to <List>]                  [Workflow action] [Workflow action] [Delete]

<Entity number>  [status pill]  [overdue/etc. badge]           ← inline title strip
                                                                 (no title card)

┌──────────────────────────┬────────────────────────────────┐
│ <Entity> Details (md=6)  │ QR Code or other summary (md=6)│
│ — customer, dates, terms │ — always-visible, no toggle    │
└──────────────────────────┴────────────────────────────────┘

┌───────────────────────────────────────────────────────────┐
│ Workhorse panel (full width): parts/operations, line      │
│ items, etc. — the reason the user opened the page.        │
└───────────────────────────────────────────────────────────┘
```

- **No title card.** The entity number, status pill, and any badges sit inline on one row (`flex` + `gap: 2`). Don't stack the pill on its own line below the title — it looks orphaned.
- **Summary row** of `xs=12 md=6` metadata cards above the workhorse panel. Same `height: '100%'` rule.
- **Workhorse panel is full-width** below — that's where the user spends their time.

### Where deviation is fine

- **Content-driven branching** (e.g., Parts' stocked vs made-to-order layout): keep it.
- **Document-style pages with rich document chrome** (Quotes' Email/View PDF buttons): keep the chrome; the body still follows Pattern B.
- New detail pages should default to one of the two patterns. If neither fits, that's a signal to push back on the content shape — not invent a third pattern.

---

## Mobile Considerations

### Shop Floor Requirements

1. **Large Touch Targets**: All buttons, inputs minimum 48px height (MUI default)

2. **Readable Text**: Minimum 16px font size for body text

3. **Gradient Performance**: Use `background-attachment: fixed` to prevent repainting

4. **QR Code Scanning**: Large scanning area, clear instructions

5. Landscape Support: job details should work in landscape

### Mobile-Specific Components

```typescript
// Bottom navigation for mobile
import { BottomNavigation, BottomNavigationAction } from '@mui/material';
import WorkIcon from '@mui/icons-material/Work';
import InventoryIcon from '@mui/icons-material/Inventory';

<BottomNavigation>
  <BottomNavigationAction label="jobs" icon={<WorkIcon />} />
  <BottomNavigationAction label="Inventory" icon={<InventoryIcon />} />
</BottomNavigation>
```

---

## Resources

- [Material-UI Documentation](https://mui.com/)

- [Material Design 3 Guidelines](https://m3.material.io/)

- [MUI Component API](https://mui.com/material-ui/api/button/)

- [CSS Gradients Guide](https://developer.mozilla.org/en-US/docs/Web/CSS/gradient)
