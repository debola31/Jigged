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

- part_pricing_tiers - Quantity break-points with markup % per tier; markup is the source of truth, unit price is derived live as `base_cost × (1 + markup/100)` — base cost from the routing/BOM for made parts, from procurement tiers for bought parts

- operation_types - Available operations

- routings, routing_nodes, routing_materials - Process definitions (1:1 with parts). `routing_nodes` is a linear, sequence-ordered list of operations; `routing_materials` is the routing-level materials list.

- quotes, quote_line_items - Customer quotes. Line items are immutable snapshots of selected `part_pricing_tiers` (with optional per-quote price overrides via `is_quote_override`).

- jobs, job_parts, job_operations, job_materials - Multi-part work orders. A `job` is created either by converting a quote (`J-NNNN ↔ Q-NNNN`, `quote_id` set) **or** directly from a customer PO with no quote (`quote_id` null, still a `J-NNNN` number); it owns customer/due-date/aggregate-status. Job/quote numbers come from one shared per-company order counter (`company_order_counters` + `next_order_number()`): a quote takes Q-N at creation, converting keeps J-N, and a direct-PO job takes the next J-N — so the J-space is collision-free without a separate prefix. Each part becomes a `job_part` carrying its own status, the agreed `unit_price`/`total_price`, and cloned routing operations + materials. `job_parts.quantity` is copied from the quote line (or PO) at creation and is **editable thereafter** (`updateJobPartQuantity`, floored at `max(shipped, invoiced)`); `total_price` re-derives as `quantity × unit_price` on edit. `jobs.status` is derived from the aggregate of `job_parts.status` via a Postgres trigger. **QuickBooks invoicing is job-keyed** (`quickbooks_invoice_links.job_id`), so quote- and PO-sourced jobs invoice identically — and both the invoice and AI revenue read the current `job_parts` values, not the quote snapshot. A job has **many** invoices (progressive billing, capped at the ordered qty — not shipped): `quickbooks_invoice_line_items` records the per-part quantity + price snapshot each invoice billed, and a third derived axis `invoicing_status` (`uninvoiced | partially_invoiced | fully_invoiced`) mirrors `fulfillment_status`. See [modules/invoicing.md](modules/invoicing.md).

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
| Unified data-import orchestration (structure, narrative, suggest-fixes) | 3 | `data_import_routes.py` (`/api/data-import/*`) | AI (client drives analysis, posts to the per-entity execute routes below) |
| Per-entity import analysis (AI column mapping) | 6 | `import_routes.py` (customers), `parts_import_routes.py`, `vendors_import_routes.py`, `work_centers_import_routes.py`, `routings_import_routes.py`, `bom_import_routes.py` | AI |
| Per-entity import validate/execute pipelines | 12 | same six `*_import_routes.py` files | Complex business logic (natural-identity upsert, conflict detection, batching) |
| Insights (dashboard, refresh, chat) | 3 | `insights_routes.py` | AI + complex aggregation |
| Operator management | 4 | `operators_routes.py` | Service role (`auth.admin.*`) |
| Admin company management | 4 | `admin_routes.py` | Service role + system admin |
| QuickBooks / quote email | — | `quickbooks_routes.py`, `quote_email_routes.py` | Service role / third-party integration |
| Chat history | 1 | `insights_routes.py` | Grouped with insights |

#### 8.5 Backend Structure

```plain text
api/
├── index.py                         # Entry point, CORS config, route registration
├── routes/
│   ├── admin_routes.py              # System admin endpoints (service role)
│   ├── data_import_routes.py        # Unified data-import: /api/data-import/{structure,narrative,suggest-fixes}
│   ├── import_routes.py             # Customer import (AI + pipeline)
│   ├── parts_import_routes.py       # Parts import (AI + pipeline; parts absorb inventory)
│   ├── vendors_import_routes.py     # Vendors import (AI + pipeline)
│   ├── work_centers_import_routes.py# Work centers import (AI + pipeline)
│   ├── routings_import_routes.py    # Routings import (AI + pipeline)
│   ├── bom_import_routes.py         # Bill-of-materials import (AI + pipeline)
│   ├── insights_routes.py           # AI insights + chat
│   ├── operators_routes.py          # Operator auth management (service role)
│   ├── quickbooks_routes.py         # QuickBooks integration (service role)
│   └── quote_email_routes.py        # Quote/transactional email
├── models/                          # Pydantic request/response models
├── services/
│   └── ai/                          # AI provider package: factory + base/claude/openai/gemini providers, model_config
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
jobs                 -- Project header; from a quote (J-NNNN ↔ Q-NNNN) or directly from a PO (J-NNNN, quote_id null); job/quote numbers share one per-company counter (company_order_counters)
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

---

### 15. Document Snapshot Standard

**Problem it solves.** Documents like quotes, jobs, shipments/packing slips, and
invoices are *point-in-time records*. Master data they reference (customer name,
addresses, contacts, part names) can change or be deleted later. If a document reads
that master data live by FK, editing or deleting the master silently rewrites
history — and FKs that block deletion (`ON DELETE RESTRICT`) trap users who simply
want to retire an old address. This is the industry-standard ERP/accounting approach
(NetSuite freezes the address onto the transaction; an invoice is "a frozen official
legal snapshot").

**The standard.**

> A transactional document must store an **immutable copy** of every master-data
> field it renders that should reflect the document's *issue date*. Any retained
> master FK is **nullable** (`ON DELETE SET NULL`) and used only for
> navigation/relinking — never as the read source for the rendered document.

**Decision rule for any new master→document reference:** *"If this master row is
later edited or deleted, must this document still show the original value?"*
Yes → snapshot. No → a live FK is correct (pickers, dashboards, "where-used",
navigation should always reflect current state).

**Mechanisms (both in use):**
- **Field / JSON snapshot on the document row** — for rich data. Examples:
  `quote_line_items.pricing_basis_snapshot`; the customer/address/contact block on
  `quotes`/`jobs`/`shipments` (`customer_name`, `bill_to_address`, `ship_to_address`,
  `contact_snapshot`).
- **Denormalized label + `ON DELETE SET NULL`** — for simple ledger references.
  Examples: `inventory_transactions.item_name` (deleted parts),
  `inventory_transactions.location_name` (deleted locations).

**Capture & freeze.** Snapshots are written by `BEFORE INSERT/UPDATE` triggers
(`snapshot_document_party` on quotes/jobs, `snapshot_shipment_party` on shipments;
cf. `snapshot_transaction_location_name`). A column is (re)snapshotted only when its
FK changes to a **non-null** value — so clearing an FK to NULL (including the
`ON DELETE SET NULL` fired by deleting the master) **preserves** the existing
snapshot rather than wiping it. Editing the master row never touches the document
tables, so the snapshot stays frozen.

**On snapshot, enable deletion.** Flip the document's FK to `ON DELETE SET NULL` and
**backfill every existing row** in the same migration (no "compute live if missing"
read-path fallback — see the "No silent runtime fallbacks" principle in CLAUDE.md).

#### Snapshot coverage (audit)

| Document | Field | Status |
|---|---|---|
| Quote PDF / view | bill-to & ship-to address, customer name, contact | ✅ snapshot (`quotes.bill_to_address` / `ship_to_address` / `customer_name` / `contact_snapshot`) |
| Quote line items | pricing basis, unit/total price, operation & material names | ✅ snapshot (pre-existing) |
| Job | address block, customer name, contact | ✅ snapshot (`jobs.*`) |
| Job part qty / price | order quantity, unit & total price | ◻️ **intentionally live** — `job_parts.quantity`/`unit_price`/`total_price` are the editable post-conversion source of truth (not identity fields). Invoicing and revenue read them live; this is by design, not a snapshot gap. |
| Shipment / packing slip | bill-to & ship-to address, customer name | ✅ snapshot (`shipments.*`) |
| Inventory ledger | part name (`item_name`), location (`location_name`) | ✅ snapshot (pre-existing) |
| **Quote line items / packing slip** | **part name & description** | ⚠️ **gap — rendered live** (follow-up) |
| **QuickBooks invoice push** | **customer name, part names, billing address** | ⚠️ **gap — rendered live at push** (follow-up) |

**Follow-up gaps** (tracked, not yet implemented): snapshot part name/description onto
`quote_line_items` and packing-slip lines; snapshot customer name / part names /
billing address into the QuickBooks invoice push (`api/services/quickbooks.py`).
These are the remaining live-FK reads of identity fields on customer-facing/financial
documents; apply the standard above when closing them.

### 16. Deletion & Archiving Policy

**"Delete" = archive (soft-delete), universally.** Every user-facing entity — `parts`,
`customers`, `vendors`, `work_centers`, `jobs`, `quotes` — carries a nullable
`deleted_at timestamptz`. The UI "Delete" action sets `deleted_at` instead of issuing a
SQL `DELETE`, and it **never blocks**: the row survives, so every downstream reference
(quote lines, job parts, shipments, invoices, BOM edges) keeps resolving and no foreign
key can trap the user. This replaced the prior model where `ON DELETE RESTRICT` / `NO
ACTION` FKs blocked deleting anything that was referenced.

**Reads hide archived rows.** Every list / search / picker / count / dashboard query
filters `deleted_at IS NULL` — centralised in the `utils/*Access.ts` read functions and
the dashboard/alerts rollups. By-id reads (`getPart`, `getJob`, …) intentionally do *not*
filter, so a direct link or a document's retained FK still resolves the archived row. A
stray missing `deleted_at IS NULL` on a list/metric query is the classic soft-delete
correctness bug — audit new queries for it.

**Name is the natural identity; reuse revives.** The unique name constraints
(`parts_unique_per_company (company_id, part_name)` and the `(company_id, name)`
equivalents on customers/vendors/work_centers) stay **full** constraints — *not* partial
indexes — because the data-import system upserts every entity on its name key
(`ON CONFLICT (company_id, <name>) DO UPDATE`) and PostgREST cannot target a partial
index. There is therefore only ever **one row per name**, and reusing an archived name
**revives** that row rather than duplicating it:
- **Import** (`api/routes/*_import_routes.py`): each upsert payload sets `deleted_at =
  None`, so `DO UPDATE` un-archives + updates the row.
- **Manual create** (`createPart` / `createVendor` / `createCustomer` /
  `createWorkCenter`): the name-exists pre-check (`checkXNameExists`) is scoped to live
  rows so an archived name doesn't falsely block; on the insert's `23505` the create path
  revives the archived row (`reviveArchivedXByName`). A collision with a **live** row is
  still a genuine duplicate error.

**Parts also detach BOM edges on archive.** Archiving a part must honestly change derived
numbers (no silent read-path fallback — see the CLAUDE.md "No silent runtime fallbacks"
principle). The `archive_parts(uuid[])` RPC, in one transaction, stamps `deleted_at`
**and** deletes the part's `parts_bom` rows where it is the *child*, so every parent
part's live cost rollup (`compute_part_cost_at_qty`) recomputes without it. Its own BOM
(where it is the *parent*) and its `part_location_stock` are left in place — hidden with
the part, and they return if it is revived. Reviving a part does **not** re-add BOM
memberships it was removed from — the deliberate "deleting changes pricing" trade-off.

**Impact warning, never a block.** Deletion is confirmed through
`components/common/DeleteImpactDialog.tsx`, which shows a consequence summary for both
single and bulk deletes — for parts, sourced from the `parts_deletion_impact(uuid[])` RPC
(how many quotes/jobs reference them, kept for history; how many other parts' costs will
change). The dialog never prevents the delete.

**Money/audit records: archive preserves them; only a permanent delete would destroy.**
Because archive keeps the row, archiving a shipped/invoiced job or a converted quote is
safe — its shipment/invoice/child-job history is intact, just hidden. The former "kept
for recordkeeping" hard guards on `deleteJob` were therefore removed. Jobs keep an
orthogonal `cancelled` production status (`cancelJob`/`reopenJob`) — a shop-floor
outcome, not deletion.

**Deferred (not built in v1): restore UX & permanent purge.** v1 archives and retains;
there is intentionally **no** Trash / Restore / Permanent-delete UI. Restore stays
possible (rows are retained; reuse-by-name already brings catalog entities back). When a
permanent-purge / empty-trash is added later, money/audit rows (shipments, invoices, and
rows referencing them) should be kept-and-reported, and any retention/purge job must
carry the `company_id` tenant predicate under RLS.

**Per-entity summary:**

| Entity | "Delete" behaviour | Reuse-by-name | Notes |
|---|---|---|---|
| parts | archive; `archive_parts` RPC also strips BOM-child edges | revives | impact dialog shows quote/job/BOM-cost counts |
| customers, vendors, work_centers | archive (`UPDATE deleted_at`) | revives | import upsert + create both revive |
| jobs | archive (`UPDATE deleted_at`) | n/a | `cancelled` status is separate; records-of-value guards removed |
| quotes | archive (`UPDATE deleted_at`) | n/a | `sweepExpiredQuotes` is a status change, not deletion |

**Relationship to the Document Snapshot Standard (§15):** complementary. Snapshots keep a
document readable if its master is edited/deleted; archive means the master usually is
*not* deleted at all (the row persists), so a document's retained FK still resolves.
Snapshots remain the correct belt-and-suspenders for true permanent deletion and for
fields that must reflect the issue date.
