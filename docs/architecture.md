# System Architecture

**Last Updated: 2026-04-15**

This document describes the technical architecture of Jigged, a multi-tenant data platform for small-scale precision manufacturing shops.

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
│       │   └── [partId]/          # Routing edited inline on the part detail page
│       ├── quotes/
│       ├── jobs/                  # No /jobs/new — jobs come from quote conversion
│       ├── work-centers/          # Replaces the old "Operations" module
│       ├── vendors/
│       ├── markup-rates/
│       └── shipments/             # Feature-flagged per tenant
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
    ├── migrations/         # Source of truth for schema (timestamped)
    ├── schema.staging.sql  # Auto-generated; do not edit
    └── schema.prod.sql     # Auto-generated; do not edit
```

Routings live **inline on the part detail page** (`PartRoutingPanel`) — there is no `/parts/[partId]/routing/` page. See [Routings](modules/routings.md).

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
  role TEXT  -- owner, admin, user, operator
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

- Sidebar: 240px fixed navigation (Dashboard, Customers, Parts, Quotes, Jobs, Operations)

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

- parts - Part definitions (company-wide, no customer_id)

- part_pricing_tiers - Quantity break-points with markup % per tier; markup is the source of truth, unit price is derived live against the routing

- operation_types - Available operations

- routings, routing_nodes, routing_materials - Process definitions (1:1 with parts). `routing_nodes` is a linear, sequence-ordered list of operations; `routing_materials` is the routing-level materials list.

- quotes, quote_line_items - Customer quotes. Line items are immutable snapshots of selected `part_pricing_tiers` (with optional per-quote price overrides via `is_quote_override`).

- jobs, job_parts, job_operations, job_materials - Multi-part work orders. A `job` is created either by converting a quote (`J-NNNN ↔ Q-NNNN`, `quote_id` set) **or** directly from a customer PO with no quote (`quote_id` null, job number `PO-J-NNNN`); it owns customer/due-date/aggregate-status. Each part becomes a `job_part` carrying its own status, the agreed `unit_price`/`total_price`, and cloned routing operations + materials. `jobs.status` is derived from the aggregate of `job_parts.status` via a Postgres trigger. **QuickBooks invoicing is job-keyed** (`quickbooks_invoice_links.job_id`), so quote- and PO-sourced jobs invoice identically.

**Status Workflows:**

- Quote: active → expired (convertible any time; `converted_to_job_id` marks conversion)

- Job: not_started → in_progress → completed → shipped / cancelled

---

### 8. API Architecture Pattern

Jigged uses a **Supabase-first** architecture. The Supabase client (`lib/supabase.ts`) handles all simple CRUD operations via the `utils/*Access.ts` data access layer (14+ files). The frontend talks directly to PostgreSQL through Supabase's PostgREST API, secured by Row-Level Security (RLS).

The FastAPI backend (`api/`) exists **only** for operations that cannot run in the browser.

#### 8.1 When to Use FastAPI (Backend)

An endpoint belongs in FastAPI only if it meets one or more of these criteria:

| Criteria | Reason | Examples |
|----------|--------|----------|
| **AI-powered operations** | Requires API keys (Anthropic/OpenAI/Google) that must not be exposed to the browser | CSV column mapping (`/import/*/analyze`), insights chat, dashboard insights |
| **Supabase service role key** | Needs `auth.admin.*` or access to `auth.users` table, which the anon key cannot reach | Operator creation, admin company management, password resets, email lookups |
| **Complex multi-step business logic** | Validation pipelines, conflict detection, batch processing, or transactional guarantees beyond a single Supabase RPC | Import validate/execute pipelines |

#### 8.2 When to Use Supabase Client (Frontend)

Everything else:

- Single-table CRUD (create, read, update, soft-delete)
- List queries with search, sort, pagination
- Simple joins and filtered queries
- Any operation where RLS policies provide sufficient authorization

#### 8.3 Decision Checklist for New Features

1. Does it need an AI provider API key? → **FastAPI**
2. Does it need `auth.admin.*` or access to `auth.users`? → **FastAPI**
3. Does it involve multi-step validation, conflict detection, or batch transactional logic? → **FastAPI**
4. Is it a straightforward CRUD operation on a business table? → **Supabase client via `utils/*Access.ts`**

#### 8.4 Current FastAPI Endpoints

| Category | Count | Route file | Criteria met |
|----------|-------|------------|--------------|
| Import analysis (AI column mapping) | 4 | `import_routes.py`, `parts_import_routes.py`, `operations_import_routes.py`, `inventory_routes.py` | AI |
| Insights (dashboard, refresh, chat) | 3 | `insights_routes.py` | AI + complex aggregation |
| Operator management | 4 | `operators_routes.py` | Service role (`auth.admin.*`) |
| Admin company management | 4 | `admin_routes.py` | Service role + system admin |
| Import validate/execute pipelines | 8 | `import_routes.py`, `parts_import_routes.py`, `operations_import_routes.py`, `inventory_routes.py` | Complex business logic |
| Chat history | 1 | `insights_routes.py` | Grouped with insights |

#### 8.5 Backend Structure

```plain text
api/
├── index.py                         # Entry point, CORS config, route registration
├── routes/
│   ├── admin_routes.py              # System admin endpoints (service role)
│   ├── import_routes.py             # Customer import (AI + pipeline)
│   ├── insights_routes.py           # AI insights + chat
│   ├── inventory_routes.py          # Inventory import (AI + pipeline)
│   ├── operations_import_routes.py  # Operations import (AI + pipeline)
│   ├── operators_routes.py          # Operator auth management (service role)
│   └── parts_import_routes.py       # Parts import (AI + pipeline)
├── models/                          # Pydantic request/response models
├── services/
│   └── ai.py                        # AI provider abstraction (Anthropic, OpenAI, Google)
└── utils/
    └── rate_limiter.py              # Rate limiting for AI endpoints
```

**CSV Import Flow (all entity imports follow this pattern):**

1. **Analyze:** Upload CSV → AI suggests column mapping (requires AI key)
2. **Validate:** Check data → detect conflicts → preview (complex logic)
3. **Execute:** Insert records → return results (batch transactional)

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
/dashboard/{companyId}/parts/{partId}                # Part detail (routing edited inline here)
/dashboard/{companyId}/quotes       # Quotes module
/dashboard/{companyId}/jobs         # Jobs module
/dashboard/{companyId}/operations   # Operations module
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
parts                -- Part definitions with pricing (company-wide, no customer_id)
operation_types      -- Available operations
routings             -- Process routings (1:1 with parts, unique part_id)
routing_nodes        -- Linear, sequence-ordered list of operations per routing
routing_materials    -- Routing-level materials list (inventory_item_id, quantity, unit)
quotes               -- Customer quotes (no routing_id)
jobs                 -- Project header; from a quote (J-NNNN ↔ Q-NNNN) or directly from a PO (PO-J-NNNN, quote_id null); aggregate status derived from job_parts
job_parts            -- One row per physical part inside a job; owns per-part status + lifecycle timestamps
job_operations       -- Steps in jobs (keyed on job_part_id; one independent sequence per part)
job_materials        -- Per-(job, part) materials snapshot (expected + actual consumption)
```

---

### 14. Session Management

- Last accessed company stored in database (not localStorage) for multi-device support

- Users can switch between companies without re-authenticating

- Company context persists across page refreshes

- JWT tokens managed by Supabase Auth with automatic refresh
