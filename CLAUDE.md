# Jigged - Manufacturing ERP

## Project Overview

Jigged is a web-based ERP system designed for small-scale precision manufacturing shops. It centralizes work orders, inventory tracking, and shop-floor status with AI-driven insights and gamification for operators.

## Tech Stack

- **Frontend:** Next.js 16+ with TypeScript, Material-UI (MUI) v7+
- **Backend:** FastAPI (Python)
- **Database:** PostgreSQL on Supabase
- **Authentication:** Supabase Auth
- **Hosting:** Vercel

## API Architecture Rule

**Supabase-first architecture.** All simple CRUD operations go through the Supabase client (`utils/*Access.ts` files). The FastAPI backend (`api/`) is ONLY for:
1. AI-powered operations (requires API keys not safe for browser)
2. Operations requiring Supabase service role key (`auth.admin.*`, `auth.users` access)
3. Complex multi-step business logic (import pipelines with conflict detection)

**Do NOT create new FastAPI endpoints for standard CRUD.** See `docs/architecture.md` Section 8 for the full standard and decision checklist.

---

## Design System: Jigged Manufacturing ERP (Material-UI)

> **Source of Truth:** `lib/theme.ts` contains all design values with inline documentation.
> **Detailed Reference:** `docs/design-system.md` explains principles and rationale.

**Framework:** Material-UI (MUI) v7+ with Material Design 3 principles

### Design Principles

1. **Professional, Not Trendy** - Must appeal to 50-60 year old shop owners. Focus on clarity and function.
2. **Substantial, Not Playful** - Industrial aesthetic. Cards should feel solid and grounded.
3. **Readable in Bright Environments** - Ensure sufficient contrast for use under bright fluorescent lighting on tablets.
4. **Single Dark Theme** - Optimized for shop floor environments with consistent dark UI.

### Quick Reference

| Element | Approach |
|---------|----------|
| Colors | Use theme palette (`color="primary"`) - never hardcode |
| Spacing | Use `theme.spacing(n)` - never hardcode pixels |
| Cards | Use default `<Card elevation={2}>` - theme handles glassmorphism |
| Touch targets | Minimum 48px (theme enforces this) |

### Component Guidelines

**Always use MUI components:**
- `Button`, `TextField`, `Card`, `Paper`, `Box`, `Typography`
- `List`, `ListItem`, `ListItemButton`, `ListItemText`
- `Alert`, `CircularProgress`, `Chip`
- `Container`, `Grid`, `Stack`

**Styling approach:**
- Use MUI's `sx` prop for component-level styles
- Let cards use theme defaults - don't override backgrounds unless necessary
- Never use external CSS files for MUI components
- Never use plain HTML elements when MUI equivalents exist

**Standard elevation values:**
- `2`: Standard cards (default)
- `3`: Auth cards, modals
- `4`: App bar, floating elements

### Page Layout Patterns

**IMPORTANT:** All dashboard pages must follow consistent layout patterns. The page title is displayed in the top Header component, so pages should NOT include redundant inline titles.

**List Pages (e.g., Parts, Customers, Resources):**
```tsx
<Box>
  {/* Toolbar - single row */}
  <Box sx={{ display: 'flex', gap: 2, mb: 3, flexWrap: 'wrap', alignItems: 'center' }}>
    <TextField placeholder="Search..." size="small" sx={{ width: 300 }} />
    <Box sx={{ flex: 1 }} />  {/* Spacer */}
    <Button variant="outlined">Import</Button>
    <Button variant="contained">New Item</Button>
  </Box>
  {/* Content (cards, tables, etc.) */}
</Box>
```

**Create/Edit Pages:**
- Use `<Box>` container with NO padding (layout provides padding)
- Do NOT add inline page titles - the Header component displays the title
- Render the form component directly

**Import Pages:**
- Use `<Box>` container with NO padding
- Include a simple "Back" button at top left (no redundant page title)
- Content follows below

### Mobile/Shop Floor Requirements

1. **Large Touch Targets:** Minimum 48px height for buttons/inputs
2. **Readable Text:** Minimum 16px font size for body text
3. **Simple Navigation:** Use bottom navigation for primary actions on mobile
4. **QR Code Scanning:** Design with large scanning area
5. **Landscape Support:** Ensure work order details are usable in landscape mode

### Accessibility (WCAG 2.1 Level A)

- Color contrast: Text on background minimum 4.5:1
- Large text (18pt+): Minimum 3:1
- All elements keyboard accessible with visible focus indicators
- Touch targets: Minimum 48px x 48px
- Use semantic HTML and proper ARIA labels

---

## Multi-Tenancy Model

Jigged is a multi-tenant SaaS application where each company's data is isolated, but a single user can have access to multiple companies.

### Database Schema

```sql
-- Companies table
companies (id, name, created_at, updated_at)

-- User-Company access junction table
user_company_access (id, user_id, company_id, role, created_at)

-- User preferences
user_preferences (id, user_id, last_company_id, created_at, updated_at)
```

### URL Structure

All app routes include a `companyId` to ensure data isolation:
- `/dashboard/{companyId}`
- `/dashboard/{companyId}/parts`
- `/dashboard/{companyId}/parts/{partId}/routing/new` -- Create routing for part
- `/dashboard/{companyId}/parts/{partId}/routing/edit` -- Edit routing for part
- `/dashboard/{companyId}/quotes`
- `/dashboard/{companyId}/jobs`
- `/dashboard/{companyId}/operations`

### Auth Flow

1. User logs in
2. System checks companies user has access to
3. If 1 company: Direct to `/dashboard/{companyId}`
4. If multiple companies + has last_company_id: Direct to that dashboard
5. If multiple companies + no preference: Show company selector
6. If no companies: Show no-access page

---

## Project Structure

```
/
├── app/                      # Next.js App Router pages
│   ├── layout.tsx           # Root layout with providers
│   ├── page.tsx             # Home page (redirects)
│   ├── login/               # Login page
│   ├── signup/              # Sign up page
│   ├── select-company/      # Company selector
│   ├── no-access/           # No access page
│   └── dashboard/[companyId]/ # Dashboard (protected)
│       ├── parts/
│       │   └── [partId]/routing/  # Routing editor (1:1 with part)
│       ├── quotes/
│       ├── jobs/
│       └── operations/
├── components/
│   ├── auth/                # Auth-related components
│   └── providers/           # Context providers
├── lib/
│   ├── theme.ts            # MUI theme configuration
│   ├── agGridTheme.ts      # AG Grid theme (matches MUI theme)
│   └── supabase.ts         # Supabase client
├── utils/
│   └── companyAccess.ts    # Company access helpers
└── api/                     # FastAPI backend
    └── index.py
```

---

## Environment Variables

```bash
NEXT_PUBLIC_SUPABASE_URL=your_supabase_project_url
NEXT_PUBLIC_SUPABASE_ANON_KEY=your_supabase_anon_key
```

---

## Development Commands

```bash
# Install dependencies
pnpm install

# Run frontend dev server
pnpm dev

# Run backend dev server (separate terminal)
cd api && python index.py

# Build for production
pnpm build
```

---

## Documentation

Product documentation is version-controlled in the `/docs` folder.

### Key Documents

| Document | Path |
|----------|------|
| Product Requirements | [docs/prd.md](docs/prd.md) |
| System Architecture | [docs/architecture.md](docs/architecture.md) |
| Design System | [docs/design-system.md](docs/design-system.md) |
| Build Sequence | [docs/build-sequence.md](docs/build-sequence.md) |

### Module Specifications

See [docs/modules/](docs/modules/) for detailed module specs:
- [Customers](docs/modules/customers.md)
- [Parts](docs/modules/parts.md)
- [Quotes](docs/modules/quotes.md)
- [Jobs](docs/modules/jobs.md)
- [Operations](docs/modules/operations.md)
- [Dashboard](docs/modules/dashboard.md)
- [Routings](docs/modules/routings.md)
- [Inventory](docs/modules/inventory.md)
- [Operator View](docs/modules/operator-view.md)
- [Invitation System](docs/modules/invitation-system.md)

### Testing Documentation

See [docs/testing/](docs/testing/) for testing strategy and guides.

### Guidelines

- **Consult PRD** before implementing new features
- **Check module specs** for detailed requirements
- **Keep docs in sync** - update docs if implementation diverges

---

## Notion Integration (Deprecated)

> **Note:** All product documentation has been migrated to the `/docs` folder. The Notion CLI is no longer needed for standard development workflows. Notion page IDs are retained for historical reference only.
