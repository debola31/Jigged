# System Architecture

**Last Updated: January 2026**

This document describes the technical architecture of Jigged, a multi-tenant ERP system for small-scale precision manufacturing shops.

---

### 1. Tech Stack

| Layer | Technology | Notes |
|---|---|---|
| Frontend | Next.js 16+ (App Router) | TypeScript, React 19 |
| UI Library | Material-UI v7+ | Custom dark theme |
| Backend | FastAPI (Python) | Serverless on Vercel |
| Database | PostgreSQL | Supabase hosted |
| Auth | Supabase Auth | JWT-based |
| Hosting | Vercel | Frontend + API |
| Storage | Supabase Storage | File attachments |

---

### 2. Project Structure

```plain text
Jigged/
├── app/                      # Next.js App Router pages
│   ├── layout.tsx           # Root layout with providers
│   ├── login/signup/        # Auth pages
│   ├── select-company/      # Company selector
│   └── dashboard/[companyId]/  # Protected routes
│       ├── customers/
│       ├── parts/
│       ├── quotes/
│       ├── jobs/
│       ├── operations/
│       └── routings/
│
├── components/
│   ├── providers/           # AuthProvider, ThemeProvider
│   ├── auth/               # AuthGuard, Login, SignUp
│   ├── layout/             # Header, Sidebar
│   └── [module]/           # Module-specific components
│
├── lib/
│   ├── theme.ts           # MUI theme config
│   └── supabase.ts        # Supabase client
│
├── utils/                  # Data access layer
│   ├── companyAccess.ts   # Multi-tenancy
│   └── [entity]Access.ts  # CRUD operations
│
├── types/                  # TypeScript interfaces
│
├── api/                    # FastAPI backend
│   ├── index.py           # Entry point
│   ├── routes/            # API routes
│   └── services/          # Business logic
│
└── supabase/
    └── schema.sql         # Database schema
```

---

### 3. Multi-Tenancy Architecture

**3.1 Data Isolation Model**

Jigged uses single-database multi-tenancy:

- All tenants share the same PostgreSQL instance

- Data isolation via company_id column in all tables

- Row-Level Security (RLS) policies prevent cross-tenant access

- Users can access multiple companies

**3.2 Access Control Tables**

```sql
companies (id, name, slug, settings, created_at, updated_at)

user_company_access (
  user_id UUID REFERENCES auth.users,
  company_id UUID REFERENCES companies,
  role TEXT  -- owner, admin, operator, engineer, sales, quality, bookkeeper
)

user_preferences (
  user_id UUID UNIQUE,
  last_company_id UUID,
  preferences JSONB
)
```

---

### 4. Authentication Flow

**4.1 Login Process**

1. User submits email/password to Supabase Auth

2. Supabase returns JWT token + session

3. App calls getPostLoginRoute(userId) to determine redirect

**4.2 Post-Login Routing**

- 0 companies → /no-access

- 1 company → /dashboard/{companyId} (auto-select)

- 2+ companies with preference → /dashboard/{lastCompanyId}

- 2+ companies without preference → /select-company

**4.3 Route Protection**

All dashboard routes wrapped in AuthGuard component which verifies authentication and company access, updates last_company_id on access.

---

### 5. Frontend Architecture

**5.1 Layout Structure**

- Header: Top navigation with company name, user menu

- Sidebar: 240px fixed navigation (Dashboard, Customers, Parts, Quotes, Jobs, Operations, Routings)

- Main Content: Flex container with page content

**5.2 Providers**

- AuthProvider: Manages Supabase auth state, exposes useAuth() hook

- ThemeProvider: MUI theme with dark mode, glassmorphic design

**5.3 Design System**

- Primary Color: Steel Blue (#5a96c9)

- Background: Very dark (#0a0e1a) with glassmorphic cards

- Touch Targets: 48px minimum for shop floor use

- Data Grid: AG Grid v35 with custom dark theme

---

### 6. Data Access Layer

All data operations follow consistent patterns in utils/ files:

```typescript
// utils/customerAccess.ts pattern
getCustomers(companyId, options)  // Paginated list
getAllCustomers(companyId)        // Full list (batched 1000/batch)
getCustomer(id)                   // Single record
createCustomer(data)              // Create
updateCustomer(id, data)          // Update
softDeleteCustomer(id)            // Soft delete
bulkSoftDeleteCustomers(ids)      // Bulk delete
```

**Key Features:**

- All queries filtered by company_id for isolation

- Batch fetching to bypass Supabase row limits

- Search, sort, pagination support

- Error handling with logging

---

### 7. Database Schema

**Core Business Tables:**

- customers - Customer records

- parts - Part definitions with pricing tiers

- operation_types - Available operations

- routings, routing_operations - Process definitions

- quotes, quote_attachments - Customer quotes

- jobs, job_operations - Work orders

**Status Workflows:**

- Quote: draft → pending_approval → approved/rejected/expired

- Job: pending → in_progress → completed → shipped / cancelled

---

### 8. Backend (FastAPI)

**Structure:**

- index.py - Entry point, CORS config, route registration

- routes/ - API route handlers (imports for customers, parts, operations)

- services/ai.py - AI provider abstraction (Anthropic, OpenAI, Google)

**CSV Import Flow:**

1. Analyze: Upload CSV → AI suggests column mapping

2. Validate: Check data → detect conflicts → preview

3. Execute: Insert records → return results

---

### 9. Environment Variables

**Frontend (.env.local):**

```bash
NEXT_PUBLIC_SUPABASE_URL=<url>
NEXT_PUBLIC_SUPABASE_ANON_KEY=<key>
```

**Backend (.env):**

```bash
SUPABASE_URL=<url>
SUPABASE_SECRET_KEY=<service_key>
ALLOWED_ORIGINS=<cors_origins>
ANTHROPIC_API_KEY=<key>
```

---

### 10. Development Commands

```bash
# Frontend
pnpm install
pnpm dev          # localhost:3000

# Backend
cd api
pip install -r requirements.txt
python index.py   # localhost:8000

# Tests
pnpm test         # Unit tests
pnpm test:e2e     # E2E tests
```

---

### 11. Key Architectural Decisions

| Decision | Rationale |
|---|---|
| Single-DB multi-tenancy | Cost-effective for small shops |
| RLS for data isolation | Security at database level |
| App Router (not Pages) | Modern Next.js patterns |
| Supabase for auth+DB | Integrated solution, fast setup |
| FastAPI for backend | Python AI ecosystem, async support |
| AG Grid | Enterprise-grade data tables |
| Dark theme | Shop floor visibility |

---

### 12. URL Structure

All app routes include company context for multi-tenant data isolation:

```plain text
/dashboard/{companyId}              # Main dashboard
/dashboard/{companyId}/customers    # Customers module
/dashboard/{companyId}/parts        # Parts module
/dashboard/{companyId}/quotes       # Quotes module
/dashboard/{companyId}/jobs         # Jobs module
/dashboard/{companyId}/operations   # Operations module
/dashboard/{companyId}/routings     # Routings module
```

**Benefits:**

- Company ID in URL ensures proper data isolation

- Allows bookmarking company-specific pages

- Enables deep linking to specific resources

---

### 13. Database Structure

**Core tables for multi-tenancy:**

```sql
companies           -- Each manufacturing shop
user_company_access -- User-company junction (roles)
user_preferences    -- Last accessed company, settings
```

**Business data tables (all include company_id):**

```sql
customers            -- Customer records
parts                -- Part definitions with pricing
operation_types      -- Available operations
routings             -- Process routings
routing_operations   -- Steps in routings
quotes               -- Customer quotes
quote_attachments    -- Quote files
jobs                 -- Work orders
job_operations       -- Steps in jobs
```

---

### 14. Session Management

- Last accessed company stored in database (not localStorage) for multi-device support

- Users can switch between companies without re-authenticating

- Company context persists across page refreshes

- JWT tokens managed by Supabase Auth with automatic refresh
