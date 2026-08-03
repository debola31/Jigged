# System Architecture

> **Rewritten 2026-08-03 (#634), verified against the code the same day; adversarial
> re-check the same day restored §9 (below).
> 3,424 → ~4,300 words — it grew, and that is the honest number.** ~300 words of
> stale or duplicated material came out; the rest of the delta is correction,
> citation and previously-undocumented behaviour. **Cut:** §10 Development Commands
> (CLAUDE.md owns it, and this copy said `pip install -r requirements.txt` /
> `python index.py`, against the rule that backend Python runs in the `jigged` conda
> env and never a per-repo venv); the `app/`/`api/`/`supabase/` listings `ls`
> reproduces; §13, which duplicated §3 and §7; prose restating the access layer.
> **§ numbers unchanged** — §8 and §16 are cited by number from CLAUDE.md and five
> module docs. **Kept deliberately:** every measured number, the withdrawn reasons
> in §6/§16, both open snapshot gaps in §15.
>
> **§9 Environment Variables was cut in the first pass and has been put back**, its
> stated reason ("CLAUDE.md owns it") being false: CLAUDE.md's Environment Variables
> section was deleted the same day, and `ALLOWED_ORIGINS` and the backend
> `SUPABASE_URL` were then written down nowhere in the repo — not in CLAUDE.md, not
> in the local-dev runbook, not in `.env.local.example`. The restored §9 is the
> corrected, current contract, not the 2026-04 copy.
>
> **Ten corrections, marked inline:** `operation_types` listed live twice (dropped
> for `work_centers`); `jobs.status` (no such column — three orthogonal axes);
> `quotes.converted_to_job_id` (no such column); an `owner` role (never in the
> CHECK); two wrong theme hexes; `stripe_routes.py` absent; insights endpoints 4×
> overcounted; a `getCustomers()` paginated pattern that does not exist;
> `supabase/schema.staging.sql` (deleted with staging); a `shipments/` route
> "feature-flagged per tenant" (neither exists).

Multi-tenant data platform for small-scale precision manufacturing shops.
Environment variables are §9; dev/test commands and pre-PR validation live in
**[CLAUDE.md](../CLAUDE.md)** and
**[docs/runbooks/local-dev-and-testing.md](runbooks/local-dev-and-testing.md)**.

---

### 1. Tech Stack

| Layer | Technology | Pinned / notes |
|---|---|---|
| Frontend | Next.js App Router | `16.2.11`, React `19.2.3`, TypeScript 5 |
| UI | Material-UI `^7.3.6` | Custom dark theme, [`lib/theme.ts`](../lib/theme.ts) |
| Data grid | AG Grid Community `^35.0.0` | + [`lib/agGridTheme.ts`](../lib/agGridTheme.ts); 10 call sites |
| Backend | FastAPI (Python) | Serverless on Vercel, `maxDuration: 60s`; one rewrite fans `/api/:path*` → `/api/index` ([`vercel.json`](../vercel.json)) |
| Database | PostgreSQL (Supabase) | RLS-enforced |
| Auth | Supabase Auth | JWT |
| Storage | Supabase Storage | File attachments |
| Hosting | Vercel | Frontend **and** API on one domain — which is why the browser calls `/api/*` relatively and `NEXT_PUBLIC_API_URL` is set only for local dev, where the two run on `:3000` and `:8000` |

---

### 2. Project Structure

Only what `ls` doesn't tell you.

| Path | Non-obvious |
|---|---|
| [`app/dashboard/[companyId]/`](../app/dashboard) | Office surface. **No** `jobs/new` page — jobs arrive by quote conversion or [`createJobFromPurchaseOrder`](../utils/jobsAccess.ts) from a dialog. **No** `shipments/` route; shipments render inside job and customer detail. *(Previously listed `shipments/` as "feature-flagged per tenant" — the flag was removed when shipments went core, [`lib/featureFlags.ts`](../lib/featureFlags.ts).)* |
| [`app/operator/[companyId]/`](../app/operator) | Phone surface — a separate tree, not a `/dashboard` child. |
| [`app/admin/`](../app/admin) | Platform-admin console; **not** company-scoped. |
| [`components/parts/PartRoutingPanel.tsx`](../components/parts/PartRoutingPanel.tsx) | Routings are edited **inline on the part detail page** — no `/parts/[partId]/routing/` page, no wizard. [Routings](modules/routings.md). |
| [`api/`](../api) | `routes/` (thin) → `models/` (Pydantic) → `services/` → `tools/` → `utils/`. §8.5. |
| [`supabase/migrations/`](../supabase/migrations) | **Source of truth.** `schema.prod.sql` is a generated snapshot ([`scripts/export_schema.py`](../scripts/export_schema.py)), never hand-edited. *(Previously also listed `schema.staging.sql`; deleted when staging was retired for Supabase Branching.)* |

---

### 3. Multi-Tenancy Architecture

One PostgreSQL instance; `company_id` on every tenant table; RLS blocks
cross-tenant reads; one user can belong to many companies.

| Table | Shape that matters |
|---|---|
| `companies` | `id, name, slug UNIQUE, settings jsonb, is_demo, demo_company_id` + the shop's own address/contact block. `settings.features.*` holds per-tenant flags ([`lib/featureFlags.ts`](../lib/featureFlags.ts)). |
| `user_company_access` | `(user_id, company_id) UNIQUE`; `role` CHECK-constrained to **`admin` \| `user` \| `operator`** (default `operator`); also `name`, `email`, `pin_hash`, `excluded_from_metrics`. *(Previously listed an `owner` role; the constraint has never allowed it.)* |
| `user_preferences` | `user_id UNIQUE`, `last_company_id`, `preferences jsonb`. |

**Billing is a second RLS layer, not an app check.** Browser-writable tenant tables
carry `billing_gate_*` restrictive policies calling `company_can_write(company_id)`;
a new `company_id` table without the gate silently bypasses billing. Standard + the
CI test that fails on an ungated table: [modules/billing.md](modules/billing.md) §4.

---

### 4. Authentication Flow

Email/password → Supabase Auth → JWT; [`getPostLoginRoute(userId)`](../utils/companyAccess.ts)
redirects: 0 companies → `/no-access`; 1, or 2+ with a still-valid
`last_company_id` → that company's home; 2+ without → `/select-company`. "Home" is
role-dependent (`homePathForRole`): **operator** → `/operator/{companyId}`, everyone
else → `/dashboard/{companyId}`. Tested:
[`homePathForRole.test.ts`](../__tests__/utils/homePathForRole.test.ts) → `describe('homePathForRole')`.

[`AuthGuard.tsx`](../components/auth/AuthGuard.tsx) verifies auth + company access
and stamps `last_company_id` on success. Two invariants it holds (rationale:
[observability.md](observability.md)):

- **"Couldn't check" is never "denied."** `verifyCompanyAccess` returns `false`
  only for PostgREST `PGRST116` (genuinely no membership row) and **throws**
  otherwise. Swallowing a network blip into `false` is how a user *with* access
  was shown "You don't have access to this company".
- **Transient aborts are not failures.** `AbortError: Lock was stolen` from
  `@supabase/auth-js` means *superseded*; `isTransientAbortError` retries once and
  never reports.

---

### 5. Frontend Architecture

Header (company name, user menu) + Sidebar (`SIDEBAR_WIDTH = 240` px,
[`Sidebar.tsx`](../components/layout/Sidebar.tsx)). Nav order: Dashboard, Activity,
Jobs, Quotes, Parts, Storage (`/inventory/locations`, flag `inventory_locations`),
Work Centers, Vendors, Customers, Import data (flag `data_import`), Team (admin),
Settings (admin). *(Previously "Dashboard, Customers, Parts, Quotes, Jobs,
Operations" — Operations became Work Centers, and six items were missing.)*
Providers: `AuthProvider` (`useAuth()`), `ThemeProvider`.

**Theme values, measured from [`lib/theme.ts`](../lib/theme.ts):** primary `#4682B4`
Steel Blue (hover `#6FA3D8`, pressed `#3A6B94`); background `#111439` Deep Indigo;
paper `rgba(32, 38, 82, 0.78)`; secondary text `#C8CCD4`, lightened from `#B0B3B8`
which lost contrast on the lighter end of the gradient; `minHeight: 48` on
buttons/inputs/list items for shop-floor touch. *(Previously claimed primary
`#5a96c9` and background `#0a0e1a`; neither appears in the theme.)* Rationale and
the surface model (office computer vs operator phone vs machine HMI):
[design-system.md](design-system.md) and CLAUDE.md.

---

### 6. Data Access Layer

One `utils/<entity>Access.ts` per entity; every query scoped by `company_id`, and
every list also by `deleted_at IS NULL` (§16).

| Function | Notes |
|---|---|
| `getAllX(companyId)` | Full list, **batched 1000 rows/request** past the PostgREST row cap. |
| `getX(id)` / `getXWithRelations(id)` | By-id — deliberately does **not** filter `deleted_at`. |
| `createX` / `updateX` | Create revives an archived same-name row on `23505` (§16). |
| `softDeleteX` / `bulkSoftDeleteX` | Stamps `deleted_at`; bulk writes chunk at **100 ids**. |

**Server-side pagination exists only where a list is genuinely unbounded** — today
just [`getQuotes(companyId, filters, page, limit, sortField, sortDirection)`](../utils/quotesAccess.ts),
default `limit = 25`. *(Previously shown here as `getCustomers(companyId, options)`,
the standard "paginated list"; no such function exists — customers are `getAllCustomers`.)*

**`ID_CHUNK = 120`** ([`lib/queryLimits.ts`](../lib/queryLimits.ts)) caps ids per
PostgREST `.in()`. **Measured on the local gateway 2026-08-01 with real UUIDs:
200 ids → 200 OK, 220 ids → 414 URI Too Long**; 120 leaves headroom for the select
list and extra filters instead of sitting under the cliff. **Withdrawn:** the old
value of 500 "kept the IN () list well inside PostgREST's URL limits" — wrong by
more than double, so any shop with ~200+ stocked parts got a hard 414 on every
chunk. One home, because four files had independently picked the same wrong number.

**Typed vs untyped client.** `getSupabase()` (untyped, legacy) and
`getTypedSupabase()` (`<Database>`-generic against [`types/database.ts`](../types/database.ts))
share one singleton in [`lib/supabase.ts`](../lib/supabase.ts). New access functions
use the typed getter; conversion is per-file. Regen + CI drift rules: CLAUDE.md.

---

### 7. Database Schema

Tenancy tables are in §3. `grep 'CREATE TABLE' supabase/schema.prod.sql` lists all
57 business tables; only the ones with a rule attached are worth writing down:

| Table(s) | Rule |
|---|---|
| `parts` | Company-wide, no `customer_id`. Absorbed the former `inventory_items`. |
| `part_pricing_tiers` | Quantity break-points with `markup_percent`. **Markup is the source of truth**; unit price derives live as `base_cost × (1 + markup/100)` — base cost from routing/BOM for made parts, from `part_procurement_tiers` for bought parts. |
| `part_procurement_tiers` | Part-level bought-part cost sheet `(part_id, min_quantity) → cost_per_unit`, **independent of vendor**. `parts.preferred_vendor_id` is a supplier *label*, not a cost filter. Multi-vendor sheets / RFQ / POs deferred to a future purchasing module. |
| `routings`, `routing_operations` | 1:1 with parts (unique `part_id`); operations are a linear, sequence-ordered list. Materials are **not** routing-attached — they live on `parts_bom`. The old `routing_materials` table was removed. |
| `parts_bom` | `(parent_part_id, child_part_id, quantity, unit)`; feeds `compute_part_cost_at_qty`. |
| `quote_line_items` | Immutable snapshot of the selected `part_pricing_tiers` (`pricing_basis_snapshot`), with per-quote overrides via `is_quote_override`. |
| `job_materials` | Per-(job, part) BOM snapshot, **expected quantity only** — consumption tracking was retired. |

*(This doc previously listed `operation_types` as a live table in two separate
sections. It was dropped and replaced by `work_centers` — see `COMMENT ON TABLE
public.work_centers` in the baseline migration.)*

**Jobs.** A job comes from converting a quote (`quote_id` set) **or** directly from
a customer PO with no quote (`quote_id` null, `createJobFromPurchaseOrder`). It
owns customer, due date and one `customer_po_number`.

- **A quote converts in several passes** — one job per customer PO, each covering a
  subset of the lines — so many jobs share one `quote_id`. Each line converts at
  most once (`job_parts.source_quote_line_item_id`, enforced by the partial unique
  index `job_parts_one_active_per_quote_line`; `getQuoteConversionState` reports
  what's still open).
- **Numbering.** A quote takes `Q-N` from the shared per-company counter
  (`company_order_counters` + `next_order_number()`); the first conversion keeps
  `J-N`; each later PO on the same quote gets a suffix (`J-N-2`, `J-N-3`, … via
  `nextQuoteJobNumber`) so a quote's jobs stay grouped under one index. A direct-PO
  job draws the next `J-N` from the same counter (`generate_direct_job_number`),
  which is **atomic** — the base J-space stays collision-free without a separate
  prefix and without a re-mint/retry dance. Tested:
  [`quotesAccess.test.ts`](../__tests__/utils/quotesAccess.test.ts) → `describe('nextQuoteJobNumber — quote-indexed job numbers')`.
- **`job_parts`** — one row per physical part: its own status axes, agreed
  `unit_price`/`total_price`, cloned routing operations + materials.
  `job_operations` keys on `job_part_id` (one independent sequence per part).
  `quantity` **is editable after conversion** (`updateJobPartQuantity`, floored at
  `max(shipped, invoiced)`); `total_price` re-derives as `quantity × unit_price`
  and triggers recompute that part's fulfillment, invoicing and operation statuses.
- **Invoicing is job-keyed** (`quickbooks_invoice_links.job_id`), so quote- and
  PO-sourced jobs invoice identically, and both the invoice and AI revenue read
  **current** `job_parts` values, not the quote snapshot. A job has **many**
  invoices (progressive billing, capped at ordered qty — not shipped);
  `quickbooks_invoice_line_items` records the per-part qty + price each billed.
  [modules/invoicing.md](modules/invoicing.md).

**Status is three orthogonal axes, not one field.** *(This doc previously described
a single `jobs.status`: "not_started → in_progress → completed → shipped /
cancelled". There is no `status` column on `jobs` or `job_parts`, and `shipped` was
never a production value — the same shape as the May 2026 `jobs.status` prod
regression.)* Each axis exists on both tables and rolls **up** from parts to job by
trigger (`sync_job_{production,fulfillment,invoicing}_status_from_parts`):

| Axis | Values (CHECK-constrained) |
|---|---|
| `production_status` | `not_started` \| `in_progress` \| `completed` \| `cancelled` |
| `fulfillment_status` | `unshipped` \| `partially_shipped` \| `fully_shipped` |
| `invoicing_status` | `uninvoiced` \| `partially_invoiced` \| `fully_invoiced` |

`quotes.status` is genuinely single: `active` \| `expired` (convertible at any
time; `sweepExpiredQuotes` changes status, never deletes). *(This doc previously
said conversion is marked by `quotes.converted_to_job_id`. **There is no such
column** — absent from both `schema.prod.sql` and `types/database.ts`; it could not
have survived one quote converting into many jobs. Conversion state is read from
the job side, via `job_parts.source_quote_line_item_id` / `getQuoteConversionState`
above.)*

---

### 8. API Architecture Pattern

**Supabase-first.** The browser talks straight to PostgreSQL through PostgREST via
[`utils/*Access.ts`](../utils), secured by RLS. FastAPI ([`api/`](../api)) exists
**only** for work that cannot run in the browser.

#### 8.1 When to Use FastAPI (Backend)

| Criterion | Reason | Example today |
|---|---|---|
| **AI-powered operations** | Needs an Anthropic/OpenAI/Google key that must not reach the browser | CSV column mapping (`/analyze`), insights chat |
| **Supabase service-role key** | Needs `auth.admin.*` or `auth.users`, unreachable with the anon key | Admin company management |
| **Complex multi-step business logic** | Validation pipelines, conflict detection, batch/transactional guarantees beyond one RPC | Import validate/execute |
| **Third-party secret or inbound webhook** | A restricted vendor key can't live client-side, and the vendor must POST to a URL we own | Stripe checkout/portal/webhook, QuickBooks OAuth |

#### 8.2 When to Use Supabase Client (Frontend)

Everything else: single-table CRUD, list queries with search/sort/pagination,
simple joins and filtered queries — anything RLS can authorize on its own.

#### 8.3 Decision Checklist for New Features

Any one of §8.1's four criteria → **FastAPI**. None of them → **Supabase client via
`utils/*Access.ts`**. Additionally, **AI calls require an explicit user action** —
never a `useEffect`, mount, poll or "on read" side effect (rule + incident: CLAUDE.md).

#### 8.4 Current FastAPI Endpoints

Route files, not counts — a count kept away from its file rots. All are registered
in [`api/index.py`](../api/index.py); `grep -n "@router\." api/routes/<file>` gives
the live list.

| Route file | Prefix | Criteria met |
|---|---|---|
| `data_import_routes.py` | `/api/data-import` | AI — `structure`, `narrative`, `suggest-fixes`; the client drives analysis, then posts to the per-entity execute routes |
| `import_routes.py` (customers), `parts_import_routes.py` (also `analyze-unified`), `vendors_import_routes.py`, `work_centers_import_routes.py`, `routings_import_routes.py`, `bom_import_routes.py` | `/api/<entity>/import` | AI + complex logic; each exposes `analyze` / `validate` / `execute` |
| `insights_routes.py` | `/api/insights` | AI. **One route: `POST /{company_id}/chat`.** Saved-insights CRUD is client-side under RLS; low-stock is the shortage lens on the parts page, not an alert feed. *(Previously claimed "Insights (dashboard, refresh, chat) — 3" plus a separate "Chat history — 1".)* |
| `admin_routes.py` | `/api/admin` | Service role + system admin: AI model health, company CRUD, `PATCH /companies/{id}/features` (the flag editor) |
| `quickbooks_routes.py` | `/api/quickbooks` | Third-party OAuth + service role: authorize/callback/status/terms/disconnect, PO-field refresh, invoice preflight + push |
| `quote_email_routes.py` | `/api/quotes` | Transactional email (service role) |
| `stripe_routes.py` | `/api/stripe` | Third-party secret + webhook. *(Missing from this doc entirely until 2026-08-03, though registered since it shipped.)* **Restricted** key `STRIPE_RESTRICTED_KEY` with **no fallback** to `STRIPE_SECRET_KEY` (one authoritative var, so nobody edits the unused one and wonders why nothing changed); API version pinned `2026-06-24.dahlia`; `/webhook` authenticated by `Stripe-Signature`, not a bearer token; cache writes go through the guarded `apply_stripe_subscription` RPC. |
| `operators_routes.py` | `/api/operators` | ⚠️ **Dead but mounted — would 500.** All six call sites query an `operators` table that does not exist, and no frontend code calls it. To be deleted with its two lines in `api/index.py`; operator management is the generic team-member surface on `user_company_access` under RLS. [#668](https://github.com/debola31/Jigged/issues/668). |

#### 8.5 Backend Structure

`routes/` (thin HTTP) → `models/` (Pydantic) → `services/` (`ai/` provider package:
factory + base/claude/openai/gemini + `model_config`; plus `email`,
`insights_service`, `quickbooks`, `uom_normalizer`) → `tools/` (`sql_validator`,
`sql_executor`, `schema_context`, `metric_tools` — the insights SQL sandbox) →
`utils/` (`rate_limiter`, `db_pagination`).

**CSV import flow, identical for every entity:** **Analyze** (AI suggests column
mapping) → **Validate** (conflict detection + preview) → **Execute** (batched
natural-identity upsert).

---

### 9. Environment Variables

**Nothing else in the repo states this contract.** CLAUDE.md's own Environment
Variables section was removed the same day this doc was condensed;
[`docs/runbooks/local-dev-and-testing.md`](runbooks/local-dev-and-testing.md) tells
you to *copy* `.env.local` between worktrees but never says what is in it; and
`.env.local.example` covers only the frontend keys plus the Stripe/QuickBooks
blocks — it does **not** list `SUPABASE_URL`, `ALLOWED_ORIGINS` or any AI key. So
this section is the only place the backend's required vars are written down.

**Frontend (`.env.local`) — inlined at build time, so a change needs a rebuild:**

```bash
NEXT_PUBLIC_SUPABASE_URL=<url>
NEXT_PUBLIC_SUPABASE_ANON_KEY=<publishable key>
NEXT_PUBLIC_SUPABASE_S3_BUCKET=<bucket>        # file attachments
NEXT_PUBLIC_API_URL=http://localhost:8000      # local dev only; unset in prod (same domain, §1)
```

Both `NEXT_PUBLIC_SUPABASE_*` are **required, with no fallback**:
[`lib/supabase.ts`](../lib/supabase.ts) creates the client at module scope, so a
deployment built without them throws during module evaluation and *every* route
renders "Something Went Wrong" — it presents as a total outage, not a broken page.

**Backend (`api/`) — server-only, never `NEXT_PUBLIC_*`:**

```bash
SUPABASE_URL=<url>
SUPABASE_SECRET_KEY=<service-role key>   # falls back to SUPABASE_SERVICE_ROLE_KEY (api/index.py:66)
ALLOWED_ORIGINS=<comma-separated CORS origins>   # defaults to http://localhost:3000
ANTHROPIC_API_KEY=<key>                  # + OPENAI_API_KEY / GOOGLE_AI_API_KEY per provider
AI_READONLY_DATABASE_URL=<url>           # read-only connection for the insights SQL sandbox
```

Feature-scoped groups, each owned by its module doc rather than repeated here:
`STRIPE_RESTRICTED_KEY` / `STRIPE_WEBHOOK_SECRET` / `STRIPE_PRICE_ID` /
`STRIPE_FOUNDING_PRICE_ID` ([modules/billing.md](modules/billing.md); note §8.4 —
the restricted key deliberately has **no** fallback to `STRIPE_SECRET_KEY`),
`QUICKBOOKS_*` + `APP_BASE_URL`, `RESEND_API_KEY` / `QUOTES_FROM_EMAIL`, and
`SENTRY_DSN` ([observability.md](observability.md)).

*(§10 Development Commands was removed 2026-08-03: CLAUDE.md genuinely does own it,
and this copy said `pip install -r requirements.txt` / `python index.py` against the
rule that backend Python runs in the `jigged` conda env and never a per-repo venv.)*

---

### 11. Key Architectural Decisions

| Decision | Rationale |
|---|---|
| Single-DB multi-tenancy | Cost-effective for small shops |
| RLS for data isolation | Enforced at the database, so a missed check in one query can't leak a tenant |
| App Router (not Pages) | Modern Next.js patterns |
| Supabase for auth + DB | Integrated, fast setup |
| FastAPI for the backend | Python AI ecosystem, async |
| AG Grid | Enterprise-grade data tables |
| Single dark theme | Shop-floor visibility |

---

### 12. URL Structure

Every in-app route carries company context, so data isolation, bookmarking and deep
links all follow from the URL. Office routes are `/dashboard/{companyId}/…`,
operator routes `/operator/{companyId}/…`; auth, `/launch` and `/admin` are
unscoped. `ls app/dashboard/[companyId]` and `ls app/operator/[companyId]` are
authoritative for the current set. *(This doc previously listed
`/dashboard/{companyId}/operations`; that module was renamed `work-centers` and the
old path does not exist.)*

---

### 13. Database Structure

Merged into **§3** (tenancy tables) and **§7** (business tables); this section
duplicated both, including the second stale `operation_types` entry. Heading kept
so links and section numbering still resolve.

---

### 14. Session Management

Last accessed company lives in `user_preferences.last_company_id` — **database, not
localStorage** — so it follows the user across devices. Company switching needs no
re-authentication and context survives refresh. JWTs are managed by Supabase Auth
with automatic refresh (see the lock-steal note in §4).

---

### 15. Document Snapshot Standard

**Problem.** Quotes, jobs, shipments/packing slips and invoices are *point-in-time
records*, but the master data they reference (customer name, addresses, contacts,
part names) changes. Reading it live by FK means editing or deleting the master
silently rewrites history — and FKs that block deletion (`ON DELETE RESTRICT`) trap
users who just want to retire an old address. This matches the ERP/accounting norm
(NetSuite freezes the address onto the transaction; an invoice is "a frozen
official legal snapshot").

> A transactional document must store an **immutable copy** of every master-data
> field it renders that should reflect the document's *issue date*. Any retained
> master FK is **nullable** (`ON DELETE SET NULL`) and used only for
> navigation/relinking — never as the read source for the rendered document.

**Decision rule for a new master→document reference:** *"If this master row is
later edited or deleted, must this document still show the original value?"*
Yes → snapshot. No → a live FK is correct (pickers, dashboards, "where-used" and
navigation should always reflect current state).

| Mechanism | Use for | Examples |
|---|---|---|
| Field / JSON snapshot on the document row | Rich data | `quote_line_items.pricing_basis_snapshot`; the party block on `quotes`/`jobs`/`shipments` (`customer_name`, `bill_to_address`, `ship_to_address`, `contact_snapshot`) |
| Denormalized label + `ON DELETE SET NULL` | Simple ledger references | `inventory_transactions.item_name`, `inventory_transactions.location_name` |

**Capture & freeze.** `BEFORE INSERT/UPDATE` triggers write the snapshots —
`snapshot_document_party` (quotes, jobs), `snapshot_shipment_party` (shipments),
`snapshot_transaction_location_name` (inventory transactions). A column is
(re)snapshotted **only when its FK changes to a non-null value**, so clearing an FK
to NULL — including the `ON DELETE SET NULL` fired by deleting the master —
**preserves** the existing snapshot rather than wiping it. Editing the master never
touches the document tables, so the snapshot stays frozen.

**On snapshot, enable deletion.** Flip the document's FK to `ON DELETE SET NULL`
and **backfill every existing row in the same migration** — no "compute live if
missing" read-path fallback (CLAUDE.md, "No silent runtime fallbacks").

#### Snapshot coverage (audit)

| Document | Field | Status |
|---|---|---|
| Quote PDF / view | bill-to & ship-to address, customer name, contact | ✅ `quotes.bill_to_address` / `ship_to_address` / `customer_name` / `contact_snapshot` |
| Quote line items | pricing basis, unit/total price, operation & material names | ✅ pre-existing |
| Job | address block, customer name, contact | ✅ `jobs.*` |
| Job part qty / price | order quantity, unit & total price | ◻️ **intentionally live** — `job_parts.quantity`/`unit_price`/`total_price` are the editable post-conversion source of truth, not identity fields. Invoicing and revenue read them live **by design**; not a snapshot gap. |
| Shipment / packing slip | bill-to & ship-to address, customer name | ✅ `shipments.*` |
| Inventory ledger | part name (`item_name`), location (`location_name`) | ✅ pre-existing |
| **Quote line items / packing slip** | **part name & description** | ⚠️ **gap — rendered live.** Re-confirmed 2026-08-03: `quote_line_items` has no name/description column. |
| **QuickBooks invoice push** | **customer name, part names, billing address** | ⚠️ **gap — rendered live at push** ([`api/services/quickbooks.py`](../api/services/quickbooks.py)) |

Those two are the remaining live-FK reads of identity fields on
customer-facing/financial documents; apply the standard above when closing them.

### 16. Deletion & Archiving Policy

**"Delete" = archive (soft-delete), universally.** Every user-facing entity —
`parts`, `customers`, `customer_contacts`, `customer_carrier_accounts`, `vendors`,
`work_centers`, `jobs`, `quotes` — carries a nullable `deleted_at timestamptz`. The
UI Delete action sets it instead of issuing a SQL `DELETE`, and **never blocks**:
the row survives, so every downstream reference (quote lines, job parts, shipments,
invoices, BOM edges) keeps resolving and no foreign key can trap the user.
**Withdrawn:** the prior model blocked deletion of anything referenced via
`ON DELETE RESTRICT` / `NO ACTION` — wrong because it trapped users completely (the
"Delete (8395)" parts bulk-delete refused every referenced part) while protecting
nothing that archiving doesn't also protect.

**Reads hide archived rows.** Every list / search / picker / count / dashboard query
filters `deleted_at IS NULL` — centralised in the `utils/*Access.ts` read functions
and the dashboard rollups, and indexed (`idx_<entity>_live_by_company` partial
indexes on parts, customers, vendors, work_centers). By-id reads (`getPart`,
`getJob`, …) intentionally do *not* filter, so a direct link or a document's
retained FK still resolves the archived row. **A missing `deleted_at IS NULL` on a
list/metric query is the classic soft-delete correctness bug** — audit every new
query for it.

**Name is the natural identity; reuse revives.** The unique name constraints
(`parts_unique_per_company (company_id, part_name)` and the `(company_id, name)`
equivalents on customers/vendors/work_centers) stay **full** constraints.
**Withdrawn:** making them partial indexes over live rows — wrong because the
import system upserts every entity on its name key (`ON CONFLICT (company_id,
<name>) DO UPDATE`) and **PostgREST cannot target a partial index**. So there is
only ever **one row per name**, and reusing an archived name **revives** it:

- **Import** (`api/routes/*_import_routes.py`): each upsert payload sets
  `deleted_at = None`, so `DO UPDATE` un-archives and updates the row.
- **Manual create** (`createPart` / `createVendor` / `createCustomer` /
  `createWorkCenter`): the `checkXNameExists` pre-check is scoped to **live** rows
  so an archived name doesn't falsely block; on the insert's `23505` the create
  path calls `reviveArchivedXByName`. A collision with a **live** row is still a
  genuine duplicate error.

**Parts also detach BOM edges on archive.** Archiving must honestly change derived
numbers (no silent read-path fallback). The `archive_parts(uuid[])` RPC, in one
transaction, stamps `deleted_at` **and** deletes the part's `parts_bom` rows where
it is the *child*, so every parent's live cost rollup (`compute_part_cost_at_qty`)
recomputes without it. Its own BOM (where it is the *parent*) and its
`part_location_stock` stay in place — hidden with the part, returning if revived.
**Reviving does not re-add BOM memberships it was removed from** — the deliberate
"deleting changes pricing" trade-off.

**Impact warning, never a block.** Deletion is confirmed through
[`DeleteImpactDialog.tsx`](../components/common/DeleteImpactDialog.tsx), which
summarises consequences for single and bulk deletes — for parts, from the
`parts_deletion_impact(uuid[])` RPC (how many quotes/jobs reference them, kept for
history; how many other parts' costs will change). The dialog never prevents the
delete.

**Money/audit records: archive preserves them.** Because the row survives, archiving
a shipped/invoiced job or a converted quote is safe — its shipment/invoice/child-job
history is intact, just hidden. **Withdrawn:** the "kept for recordkeeping" hard
guards on `deleteJob` (`countShipmentsForJob` / invoice checks) — wrong because
archiving already preserves the record, so the guard only blocked a safe action.
Jobs keep an orthogonal `cancelled` **production** status (`cancelJob`/`reopenJob`)
— a shop-floor outcome, not deletion.

**Deferred (not built in v1): restore UX & permanent purge.** v1 archives and
retains; there is intentionally **no** Trash / Restore / Permanent-delete UI.
Restore stays possible (rows are retained; reuse-by-name already brings catalog
entities back). When a permanent purge is added, money/audit rows (shipments,
invoices, and rows referencing them) should be kept-and-reported, and any
retention/purge job must carry the `company_id` tenant predicate under RLS.

| Entity | "Delete" behaviour | Reuse-by-name | Notes |
|---|---|---|---|
| parts | archive; `archive_parts` RPC also strips BOM-child edges | revives | impact dialog shows quote/job/BOM-cost counts |
| customers, vendors, work_centers | archive (`UPDATE deleted_at`) | revives | import upsert + manual create both revive |
| jobs | archive (`UPDATE deleted_at`) | n/a | `cancelled` production status is separate; records-of-value guards removed |
| quotes | archive (`UPDATE deleted_at`) | n/a | `sweepExpiredQuotes` is a status change, not deletion |

Archive behaviour is pinned by the top-level `describe` in each `*Access` suite:
[`partsAccess.test.ts`](../__tests__/utils/partsAccess.test.ts) `describe('partsAccess utilities')`,
[`customerAccess.test.ts`](../__tests__/utils/customerAccess.test.ts) `describe('customerAccess utilities')`,
[`vendorsAccess.test.ts`](../__tests__/utils/vendorsAccess.test.ts) `describe('vendorsAccess')`,
[`workCentersAccess.test.ts`](../__tests__/utils/workCentersAccess.test.ts) `describe('workCentersAccess')`,
[`jobsAccess.test.ts`](../__tests__/utils/jobsAccess.test.ts) `describe('jobsAccess')`,
[`quotesAccess.test.ts`](../__tests__/utils/quotesAccess.test.ts) `describe('quotesAccess utilities')`.
Revive-on-re-import is pinned server-side in
[`test_parts_import_api.py`](../api/tests/integration/test_parts_import_api.py). The
"no list query forgot `deleted_at IS NULL`" invariant has **no automated guard** —
`automation-pending (#367)`.

**Relationship to §15:** complementary. Snapshots keep a document readable if its
master is edited or deleted; archive means the master usually is *not* deleted at
all, so a document's retained FK still resolves. Snapshots remain the correct
belt-and-suspenders for true permanent deletion and for fields that must reflect
the issue date.
