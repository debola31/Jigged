# Design System

## Overview

Jigged uses Material-UI (MUI) v5+ as the component library, following Material Design 3 principles with a **single dark gradient theme** that tested exceptionally well with manufacturing users ("pretty fucking awesome" feedback).

**Theme Philosophy:** Static, professional dark gradient theme optimized for manufacturing environments. No light/dark mode toggle - one polished theme that works everywhere.

**Last Updated:** 2026-01-03  - Corrected to vibrant gradient values

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

- **Type:** RADIAL (creates circular/spotlight effect) - NOT linear

- **Position:** Circle centered at top left (`circle at top left`)

- **Start Color:** Darker Deep Indigo (#0a0d28) at 0% - positioned at top-left corner

- **End Color:** Brighter Steel Blue (#5a96c9) at 100% - radiates toward bottom-right

- **Attachment:** Fixed - gradient stays in place when scrolling

**Why these EXACT colors:**

- `#0a0d28` - Darker, richer indigo creates stronger contrast

- `#5a96c9` - Brighter, more vibrant steel blue makes gradient POP

- These values match the prototype that users loved

- Creates VIBRANT gradient (not muted)

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

- **Vibrant Steel Blue:** `#5a96c9` - Primary brand color for CTAs, links, accents

- **Light Blue Accent:** `#6fa3d8` - Hover states, highlights

- **Original Steel Blue:** `#4682B4` - Pressed states, dark accents

- **Dark Blue Accent:** `#2e5a8a` - Deep accents

- **Deep Indigo:** `#0a0d28` - Foundation color, gradient start

- **Neutral Gray:** `#B0B3B8` - Secondary text, disabled states

### Glass Morphism Cards (Critical Styling)

**Cards should be substantial with subtle transparency for depth.**

```typescript
// Card styling - CRITICAL specifications
backgroundColor: 'rgba(26, 31, 74, 0.50)',  // 50% opacity - substantial but allows depth
backdropFilter: 'blur(15px)',               // Strong blur for premium glass
WebkitBackdropFilter: 'blur(15px)',         // Safari support
border: '1px solid rgba(255, 255, 255, 0.15)',
boxShadow: '0 8px 32px rgba(0, 0, 0, 0.4)',
```

**Why these specific values:**

- **50% opacity:** Substantial feel for industrial aesthetic, subtle gradient visibility

- **15px blur:** Strong frosted glass effect - premium feel

- **Visible border:** Defines card edges against gradient

**Visual Effect:**

Cards should feel solid and grounded while retaining subtle depth from the background gradient. This achieves "substantial, not playful" per the design principles while maintaining visual polish. Cards use MUI elevation for shadows combined with glassmorphism (backdrop blur + transparency).

**Test:**

Cards should feel substantial and professional. The gradient should be subtly visible, not prominently showing through.

**Common Mistakes:**

```typescript
/* ❌ WRONG - Too transparent, feels airy/playful */
backgroundColor: 'rgba(26, 31, 74, 0.35)'  // 35% opacity - too light for industrial feel

/* ✅ CORRECT - Substantial with subtle depth */
backgroundColor: 'rgba(26, 31, 74, 0.50)'  // 50% opacity
backdropFilter: 'blur(15px)'               // Strong blur
WebkitBackdropFilter: 'blur(15px)'         // Safari support
```

---

## MUI Theme Configuration

### Single Dark Theme

```typescript
import { createTheme } from '@mui/material/styles';

const jiggedTheme = createTheme({
  palette: {
    mode: 'dark',
    primary: {
      main: '#4682B4',      // Steel Blue (design system spec)
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
      default: '#111439',   // Deep Indigo
      paper: 'rgba(26, 31, 74, 0.50)',  // Semi-transparent for substantial cards
    },
    text: {
      primary: '#ffffff',
      secondary: '#B0B3B8',
    },
    success: { main: '#10b981' },
    warning: { main: '#f59e0b' },
    error: { main: '#ef4444' },
    info: { main: '#3b82f6' },
  },
  shape: {
    borderRadius: 8,
  },
  components: {
    MuiCard: {
      defaultProps: {
        elevation: 2,  // MUI shadow system
      },
      styleOverrides: {
        root: {
          backgroundColor: 'rgba(26, 31, 74, 0.50)',  // Semi-transparent substantial
          backdropFilter: 'blur(15px)',               // Frosted glass
          WebkitBackdropFilter: 'blur(15px)',         // Safari
          border: '1px solid rgba(255, 255, 255, 0.15)',
          // boxShadow from elevation prop
        },
      },
    },
  },
});

export default jiggedTheme;
```

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

- **Vibrant Steel Blue:** `#5a96c9` - Primary brand color, CTAs, links

- **Light Blue:** `#6fa3d8` - Hover states

- **Original Steel Blue:** `#4682B4` - Pressed states

- **Dark Blue:** `#2e5a8a` - Deep accents

- **Deep Indigo:** `#0a0d28` - Gradient start, foundation

- **Neutral Gray:** `#B0B3B8` - Secondary text

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

- Secondary text (#B0B3B8) meets minimum 4.5:1 ratio

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

- Use theme colors: `color="primary"` not `sx={{ color: '#5a96c9' }}`

- Apply the linear 3-stop gradient background (Deep Indigo → Steel Blue → Deep Indigo) to all pages

- Use very transparent cards (35% opacity) with strong blur (15px)

- Test readability in bright lighting conditions

### ❌ Don't:

- Mix plain HTML with MUI components

- Write custom CSS files

- Hardcode pixel values - use theme spacing

- Hardcode colors - use theme palette

- Add light/dark mode toggle

- Use flat backgrounds - gradient is brand identity

- Use radial gradients - use linear 3-stop gradient with Steel Blue (#4682B4) at center

- Make cards too opaque (60%) - use 35% opacity

- Use weak blur (10px) - use 15px

- Use `textTransform: 'uppercase'` on buttons (already set to 'none')

- Use overly playful or trendy styling

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
