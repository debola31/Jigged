# Parts Module

## Overview

The Parts module manages the catalog of products/parts that a company manufactures. Parts are **company-wide entities** and are not tied to a specific customer. The customer relationship is expressed through quotes and jobs, not parts.

A part owns three layers of information that drive quoting:

1. **Routing** — the linear sequence of operations that defines how the part is made (see [Routings](routings.md)). Materials consumed are a separate layer: the part **BOM** (`parts_bom`, edited by `PartBomPanel`), no longer attached to the routing.
2. **Cost breakdown** — labor + setup + materials, derived live from the routing + BOM. It renders as a summary at the top of the Pricing card (there is no standalone "Cost Breakdown" card) and reloads automatically every time the routing/BOM auto-saves; there is no Recalculate button.
3. **Pricing** — quantity break-points (e.g., 1, 2, 4 pieces) each with their own markup %. Markup % is the source of truth on a tier; unit price is always *derived* as `base_cost × (1 + markup/100)` and is not stored. Typing a unit price directly back-calculates the markup. Tiers persist on the part (markup % only); quotes snapshot the resolved tier prices as immutable line items.

This three-layer split mirrors how real shops already think: cost the part once, set quantity break-points once, then point quotes at the tiers that apply to a given customer conversation.

**Priority:** Must Have (Build Second)

**Dependencies:** None (parts are independent company-wide entities)

**Database Tables:** `parts`, `part_pricing_tiers`, `part_attachments`, plus `parts_bom` (the part BOM), `part_procurement_tiers` (bought-part vendor costs), `parts_unit_conversions`, and `part_comments` (renamed from `part_notes` in [`20260728040701`](../../supabase/migrations/20260728040701_notes_subjects_and_view_logging.sql) to free the `notes` name for shop-floor knowledge — the table itself is unchanged, and is **not** the operator notes feed; see [operator-view.md](operator-view.md#data-model))

---

## User Stories

| As a... | I want to... | So that... |
|---|---|---|
| Owner/Admin | View a list of all parts | I can see our product catalog |
| Owner/Admin | Search parts by part name or description | I can quickly find a specific part |
| Owner/Admin | Create a new part (made in-house or bought) | I can quote and track new products |
| Owner/Admin | Edit part information | I can update descriptions or other details |
| Owner/Admin | Delete a part | I can remove parts we no longer manufacture |
| Owner/Admin | Bulk import parts from CSV | I can migrate from my legacy system |
| Owner/Admin | Create or edit a routing from the part detail page | I can define the manufacturing process for a part |
| Owner/Admin | See a cost breakdown for a part (run labor + one-time setup + materials, summarized on the Pricing card) | I can sanity-check the routing economics without leaving the part |
| Salesperson | Add multiple quantity tiers (e.g. 1, 2, 4) to a part, each with its own markup % | I can quote price breaks the customer asked for |
| Salesperson | Type a unit price directly on a tier | The markup back-calculates automatically; I don't have to do the math |
| Salesperson | See cost breakdown and tier prices update live as I edit the routing | I trust the numbers without clicking a refresh button |
| Salesperson | Adjust a price for a single quote (one-off concession) | I can cut a deal without changing the part's standing prices |

---

## Data Model

### `parts`

| Field | Type | Required | Description |
|---|---|---|---|
| id | UUID | Yes | Primary key (auto-generated) |
| company_id | UUID (FK) | Yes | Link to company (multi-tenant isolation) |
| part_name | Text | Yes | Part number (e.g., "AE36589E-RT") |
| description | Text | No | What the part is (e.g., "Recess Tool Bit") |
| source | Text | Yes | `made` \| `bought` (CHECK, default `made`). Made parts get a routing + BOM; bought parts get procurement tiers |
| is_stocked | Boolean | Yes | Whether the part carries on-hand inventory (default false) |
| primary_unit | Text | Yes | Stocking/costing unit. NOT NULL via the `parts_requires_unit` CHECK |
| quantity | Numeric | Yes | On-hand count (default 0); only ever changed through `inventory_transactions`, never the part form |
| reorder_point | Numeric | No | Low-stock threshold |
| preferred_vendor_id | UUID (FK) | No | Default vendor for a bought part's procurement cost |
| is_location_tracked | Boolean | Yes | Whether stock is tracked per QR-addressable location (default false) |
| created_at | Timestamp | Yes | Auto-generated |
| updated_at | Timestamp | Yes | Auto-updated on changes — **including edits to the part's satellite data** (routing, pricing tiers, BOM, procurement tiers), which bump it via AFTER triggers (`touch_parts_updated_at_on_satellite_writes` migration). Before that, editing a routing/pricing/BOM left `updated_at` stale, so recency-sort missed the parts people actually worked on. |

**Unique Constraint:** `(company_id, part_name)` — part names must be unique within a company. This is the identity key the CSV importer upserts on (`ON CONFLICT (company_id, part_name)`), so re-importing the same export updates parts in place rather than duplicating them.

**Removed in April 2026:** `category_id` and the `part_categories` table. Categories were anemic (one number — `default_markup_percent`); rather than a shared default, each part now owns its markup directly on its own `part_pricing_tiers` rows.

### Part Pricing Tiers (`part_pricing_tiers`)

Quantity price break-points that live on the part. One row per tier; selected tiers are snapshotted into `quote_line_items` at quote creation. Only tier metadata is stored — `quantity` (the break) and `markup_percent` (the source of truth). Base cost and unit price are **not columns**; they are recomputed live on every read (`getTiersWithComputedPrices` / `calculateTierPricing`) so the stored data can never drift from the routing + BOM.

| Field | Type | Required | Description |
|---|---|---|---|
| id | UUID | Yes | Primary key |
| part_id | UUID (FK) | Yes | Part the tier belongs to (cascade delete) |
| company_id | UUID (FK) | Yes | Multi-tenant isolation |
| sequence | Integer | Yes | Display order within the part (10, 20, 30...) |
| quantity | Numeric | Yes | Tier quantity, must be > 0. Decimal-capable (up to 4 dp) so parts sold by length/weight/volume can set a fractional break |
| markup_percent | Numeric(10,6) | No | **Source of truth.** User-typed markup % for this tier |
| created_at | Timestamp | Yes | Auto-generated |
| updated_at | Timestamp | Yes | Auto-updated on changes |

> **Dropped columns:** `base_cost_per_unit` and `unit_price` were removed (migration `20260514`). Both are now derived at read time, never persisted — see `PartPricing.tsx` and `replaceTiersForPart`.

**Unique Constraint:** `part_pricing_tiers_unique_seq` on `(part_id, sequence)`

**Single-direction data flow:**

- `markup_percent` is the source of truth.
- `unit_price` is always recomputed against the current cost basis (routing + BOM for made parts; procurement tiers for bought parts). Cost change → unit prices drift to reflect it. There is no lock concept on the part; if you need a stable price across routing changes, lock it on the quote (see [Quotes — Per-quote overrides](quotes.md#per-quote-price-overrides)).
- Typing in the unit-price input is shorthand for "compute the markup % that would yield this price"; the editor back-calculates and stores the markup as the source of truth (there is no stored `unit_price` to keep in lockstep).

### File Attachments (`part_attachments`)

Engineering files attached to a part — drawings (PDF), CAD models (STEP), and legacy CAD (DWG). The file bytes live in the private `attachments` storage bucket under `{companyId}/parts/{partId}/{uuid}_{filename}`; this table is the metadata index. Mirrors `job_attachments`, widened to multiple file kinds. Managed by `utils/partAttachmentsAccess.ts`.

| Field | Type | Required | Description |
|---|---|---|---|
| id | UUID | Yes | Primary key |
| company_id | UUID (FK) | Yes | Multi-tenant isolation (cascade delete) |
| part_id | UUID (FK) | Yes | Part the file belongs to (cascade delete) |
| storage_path | Text | Yes | Object path in the `attachments` bucket |
| file_name | Text | Yes | Original filename (shown in the UI) |
| kind | Text | Yes | `pdf` \| `step` \| `dwg` \| `other` (CHECK). Computed from the file extension at upload; drives viewer dispatch |
| mime_type | Text | No | Browser-reported MIME (advisory; STEP/DWG often report `application/octet-stream`) |
| size_bytes | Bigint | No | File size |
| uploaded_by | UUID (FK) | No | Uploader's `user_company_access` row; `ON DELETE SET NULL` |
| created_at | Timestamp | Yes | Auto-generated |

**Index:** `(part_id, created_at DESC)` — the newest-first list query.

**RLS** (mirrors `part_comments`):
- **SELECT** — any company member can read the company's attachments.
- **INSERT** — a member can upload, but only as themselves (`uploaded_by = get_operator_access_id(company_id)`).
- **DELETE** — the uploader **or** a company admin (`uploaded_by = get_operator_access_id(company_id) OR is_company_admin(company_id)`).

**SET NULL consequence:** once an uploader's access row is removed, their name shows as "Unknown" and only admins can delete that attachment. Acceptable — admins retain control.

**Per-kind size caps:** PDF 25 MB; STEP/DWG 100 MB (CAD models run large).

---

## UI Screens

### 1. Parts List

**Route:** `/dashboard/{companyId}/parts`

**Features:**

- AG Grid showing: **Part Name** (with an inline ⚠ marker on parts not yet priceable), **Description**, **On hand**, **Status**, **Source** (Made/Bought chip), **Updated**. There is no Category column (categories were removed) and no Cost column — engineering/cost signals live on the detail page.

- **Parts is now the single item master, including stock** — the separate `/dashboard/{companyId}/inventory` list was folded in on 2026-07-30 and redirects here. It was `parts WHERE is_stocked` with three extra columns and no unique capability; its own module doc had described it as *"a filtered view over `parts`"* since it was written. See [inventory.md §5.12](inventory.md#512-two-nouns-parts-is-what-we-have-storage-is-where-it-lives--2026-07-30).

  - **On hand** folds the unit into the cell (`40 ea`) rather than spending a column on it, and shows `—` for a non-stocked part: a made-to-order part has no stock level, and printing `0` would read as *"we're out"* rather than *"not applicable"*.
  - **Status** is derived at render from `quantity + reorder_point` via `deriveStockStatus` — never stored, so it cannot drift.
  - A **Stock** filter (All / Stocked / Low stock / Out of stock) is seeded from `?status=`, which makes this page the **shop-wide shortage lens**: `JobPartMaterialsCard`'s *"N short"* chip links to `/parts?status=low`. Stock filters only ever narrow to stocked parts — a non-stocked part is neither low nor out, and including it would invent a shortage for a made-to-order part.
  - With the `inventory_locations` flag **off**, this page also carries **Count Inventory**, since it is then the only stock surface.

- **Default sort is most-recently-updated first** (the Updated column, descending) — users care about the parts they just worked on, not the alphabetical top. Alphabetical is one click away on the Part Name header. Sorting is server-side for the real columns (`part_name`, `source`, `updated_at`). This pairs with the `updated_at` accuracy fix below, so a part whose routing/pricing/BOM was just edited rises to the top.

- Search box (searches part name and description)

- **Source** filter (All / Made / Bought) and **Completeness** filter (All / Complete / Incomplete), both applied client-side

- "**Add Part**" button and an "**Import**" button

- Bulk actions when rows are selected: **Delete (N)** and Export CSV

- Click row to open the part workspace (`/parts/{id}`)

- Pagination (25 per page)

**Empty State:**

"No parts yet. Add your first part — made in-house or bought from a vendor." (with Import CSV + Add Part actions). A filtered-but-empty grid shows "No parts match these filters." instead.

### 2. Part Create

**Route:** `/dashboard/{companyId}/parts/new` (there is **no** `/parts/{id}/edit` route — editing happens in place on the detail workspace)

`/parts/new` renders the same `PartWorkspace` as the detail page, in **create mode**: the identity fields render directly on the page (the create view *is* the saved view), so there is no separate create modal.

▸ **Identity fields (`PartIdentitySection`)**

- Part Name (required, unique within the company)
- Description
- Source (Made / Bought), Primary unit (required), and stocking options

**Actions:**

- **Create part** → inserts the row and redirects into the live `/parts/{id}` page (preserving quote-return + list-origin context). Cost breakdown, pricing, routing, BOM, and files are all edited there.
- Cancel / Back → returns to the list.

### 3. Part Detail (workspace)

**Route:** `/dashboard/{companyId}/parts/{id}`

An **editable, maturity-adaptive workspace** (`PartWorkspace`) — not a read-only view. There is no "Edit" mode and no Edit button; identity fields auto-save on blur (`updatePart`). Tabs are URL-addressable via `?tab=`:

- **Workspace** (default) — how the part is made and priced (identity, cost/pricing, routing, BOM).
- **Inventory** — shown only when the part is stocked; stock level + transactions.
- **Usage** — jobs and quotes that reference this part.
- **Files** — engineering attachments (`?tab=files`, always visible).
- **Activity** — the part Notes + transaction feed (its slug stays `history` for back-compat).

A sticky header shows the part name and a completeness/priceability chip. Delete lives in the header; it **archives** the part (never disabled, never blocked — even when quotes/jobs/BOM parents reference it) and detaches it from other parts' BOMs so their costs recompute. See `docs/architecture.md` §16.

▸ **Inline Routing Editor (`PartRoutingPanel`)**

The Workspace tab embeds the routing editor directly — there's no separate page to navigate to. The panel shows the linear list of **Operations** (materials are a separate **Materials/BOM** panel — `PartBomPanel`) with auto-save: each modal save, reorder click, or delete persists immediately via `saveRoutingWithOperations`, and a "Saving…" / "All changes saved" indicator appears in the panel header. The first add implicitly creates the routing record if the part doesn't yet have one. See `docs/modules/routings.md` for the full editor behavior.

▸ **Cost build-up + Pricing (`PartPricing`)**

Cost breakdown and pricing are a **single card** (`PartPricing`) — there are no separate `PartCostBreakdown` / `PartPricingTiers` components. The cost build-up is a summary above the tier table, pulling live cost from the routing + BOM via `calculateRoutingCost(partId)`:

- Cost summary rows: **run labor / unit**, **setup (one-time)** (amortized across tier qty), **materials / unit**. (There are no per-operation / per-material tables and no `@ qty 1` / `@ qty 10` preview rows.)
- Surfaces routing warnings (`empty_operation`, `missing_labor_rate`, `missing_material_cost`) inline — a missing-material warning links to the offending BOM child — so data quality issues catch the salesperson's eye before quoting.

The tier table (`part_pricing_tiers`) is a single, always-editable list of quantity-break tiers — editable rows with Qty, Base / unit (derived, read-only), Markup %, Unit price, and a delete icon; header **Add tier** button. **This table is identical for made and bought parts** — bought parts show the same Base / unit + Unit price columns, with the base cost coming from the part's procurement tiers (via `getComputedPartCost`, the same engine made parts use) rather than the routing/BOM. (Bought parts previously hid those two columns on the theory that cost depended on "which vendor wins"; since PR #567 collapsed procurement to deterministic part-level tiers, the final unit-price-after-markup is well-defined and is now shown.) A **new part opens with one unfilled pricing row** (Min qty 1, Markup blank) for the user to fill in — nothing is auto-applied on create, and the part stays not-priceable until a tier carries a markup %.

Editing model — markup % is the source of truth:

- Editing **quantity** recomputes the displayed base cost (setup amortization changes); unit price follows from the current markup.
- Editing **markup %** recomputes the displayed unit price directly.
- Editing **unit price** back-calculates the markup % and stores it as the new source of truth. There is no lock concept; subsequent routing changes still propagate.

**Explicit save** (not auto-save): pricing feeds quotes (financial data), so tier edits are committed via a **Save pricing** button with an "Unsaved changes" hint — mirroring the bought-part Cost card. Each save also auto-logs a `pricing` note to the Activity feed.

**Live updates from routing**: the card watches the part-page-level `refreshKey` counter. When the routing/BOM panel auto-saves, the parent bumps `refreshKey`, which reloads the breakdown and recomputes every tier's displayed base cost and unit price against the new cost basis.

▸ **Bought-part Cost card (`PartProcurementPricingPanel`)**

For **bought** parts, the workspace shows a **Cost** card with a single **Preferred vendor** picker (the *only* preferred-vendor control — it is no longer duplicated on the part-details/identity card; that field now appears only in the create flow) and a per-vendor qty-break cost-tier sheet (Min qty / Unit cost).

- **Explicit Save** — cost is financial data, so edits are committed via a **Save costs** button (with an "Unsaved changes" hint), not auto-saved on blur, matching the made-part Pricing card. Deletes and additions are reconciled against the persisted sheet on save.
- **No-cost state** — when the selected vendor has no saved tier yet, the sheet shows **one empty starter row highlighted red** plus a short red prompt ("Add at least one cost tier so this part can be priced and quoted."), replacing the previous yellow banner/"Add first tier" bubble. The red styling uses the theme `error` palette (never a hardcoded hex).
- **Indicator clears on save** — the panel calls an `onSaved` callback so the workspace re-derives priceability immediately; the "Needs cost" chip (and the red prompt) clear on Save **without a page reload**. (Previously the chip lingered until reload because the panel had no refresh callback.)

▸ **Files tab (`FilesTab`)**

A workspace tab (`?tab=files`, always visible) for engineering file attachments. This surface is part of the **office/admin dashboard** — it is not the operator shop-floor view, so nothing here is operator-facing.

- **Upload**: a multi-file picker accepting `.pdf,.step,.stp,.dwg`. Each file is validated client-side (allowlist + per-kind size cap) before upload; rejected files surface a clear message and are not stored. Uploads are immediate (no draft staging).
- **List**: newest-first, each row showing the filename, a **kind chip** (PDF / STEP / DWG), size, and the uploader + date.
- **Row actions**:
  - **Open** — PDF opens inline in a viewer modal (`AttachmentViewerModal`, native `<iframe>` off a fresh signed URL); STEP opens an in-app 3D viewer (`online-3d-viewer`, lazy-loaded); DWG downloads.
  - **Download** — available for every kind (fresh signed URL).
  - **Delete** — shown only to the uploader or a company admin (RLS enforces the same rule). Removes the row and the stored file.

**Upload-after-creation:** part creation has no draft row — the part id exists only after the **Create part** button (`createPart` → redirect to `/parts/{id}`). So files are uploaded on the live detail page; the redirect supports `?tab=files` to land directly on the Files tab. There is no temp-path staging.

**Viewer dispatch by kind:**
| Kind | Viewer | Notes |
|---|---|---|
| PDF | Native `<iframe>` + signed URL | No library; renders inline |
| STEP (.step/.stp) | In-app 3D viewer | `online-3d-viewer` (three.js + occt-import-js WASM), lazy-loaded via `next/dynamic({ ssr: false })`. In v0.18 the engine fetches occt-import-js from the jsdelivr CDN at runtime (no self-hosting hook); single-threaded build, so no COOP/COEP headers needed |
| DWG | Download-only | No in-browser render; Contour standardizes on PDF, so DWG is converted upstream. See #411 for an experimental in-browser DWG viewer |

---

## Cost Determination Logic

A part's cost flows in four layers:

1. **Routing cost** — derived live by `calculateRoutingCost(partId)`. Returns per-op run + setup costs and per-material line costs, plus warnings.
2. **Tier cost** — `calculateTierPricing(breakdown, quantity, markup)` adds setup amortization at the tier's quantity:
   ```
   base_cost_per_unit = run_labor_per_unit + material_per_unit + (total_setup / quantity)
   unit_price        = base_cost_per_unit × (1 + markup / 100)
   ```
3. **Quote line item** — a frozen snapshot of `(part_id, quantity, unit_price, total_price, markup_percent, base_cost_per_unit, is_quote_override)` taken at quote creation. See [Quotes Module — Snapshotted Line Items](quotes.md#snapshotted-line-items).
4. **Job part** — created at quote→job conversion by copying the quote line's `(quantity, unit_price, total_price)`. Unlike the quote line, `job_parts.quantity` is **editable** post-conversion (with fulfillment guardrails) and `total_price` is re-derived as `quantity × unit_price` at edit time. Invoicing and revenue read the `job_part`, not the quote snapshot — so the job part is the post-conversion source of truth. See [Jobs Module — Editing order quantity](jobs.md).

**Bought parts** have no routing, so their base cost comes from the part's **procurement tiers** (the Cost card) via `compute_part_cost_at_qty` instead of `calculateRoutingCost`. The shared resolver `getTiersWithComputedPrices` falls back to that procurement cost when a part has no routing/BOM, so a bought part's pricing tiers still resolve a sell price = `procurement_cost(qty) × (1 + markup/100)`. A made part with no routing/BOM yet shows an "Add operations or materials to calculate pricing" empty state in the Pricing card; the user can still add tiers and type unit prices manually (the back-calculated markup will look unusual until a cost basis exists).

---

## AI-Powered Bulk Import

**Route:** `/dashboard/{companyId}/parts/import`

Uses the same AI-powered import infrastructure as Customers (see Customers PRD for full details).

### Parts-Specific Flow

1. **Upload CSV** - Parse file, extract headers + first 5 rows

2. **AI Analysis** - AI suggests column mappings with confidence scores

3. **Review Mappings** - Display with confidence indicators

4. **Validate** - Resolve units, flag within-CSV duplicate part names, check references

5. **Execute** - Upsert with results summary (created / updated / skipped / errors)

### Conflict Detection

- **Duplicate part_name *within the same CSV*** (`csv_duplicate`) → the second and later rows collapse into one (they don't import twice).
- **A part_name that already exists in the company** is **not** a conflict — it is an **update**. Execute upserts `ON CONFLICT (company_id, part_name)`, so re-importing the same export updates parts in place rather than duplicating or skipping them (idempotent). No `legacy_id` is involved.

### API Endpoints

- `POST /api/parts/import/analyze` - AI mapping suggestions

- `POST /api/parts/import/validate` - Conflict detection

- `POST /api/parts/import/execute` - Perform import

### Validation Rules

- part_name is required

- part_name must be unique within the company

---

## Acceptance Criteria

Each bullet is a Given/When/Then scenario carrying a verification clause — a pointer to the test that proves it, a manual procedure, or an explicit automation-pending tag. Every editable entity has at least one edit → save → reload → persists bullet. Doc-vs-code disagreements this audit surfaced are recorded in the divergence report on issue #334.

**List, search & filter**

- [ ] **Given** the Parts list, **when** it loads, **then** every company part (made + bought, stocked or not) shows in a paginated AG Grid with Part Name / Description / Source / Updated columns — *verified by `__tests__/utils/partsAccess.test.ts > 'getAllParts' > 'returns parts for a company with routing data'`; grid rendering + pagination E2E automation-pending (`getAllParts`)*.
- [ ] **Given** a search term, **when** it is typed into "Search parts…", **then** the list filters by part name or description — *verified by `__tests__/utils/partsAccess.test.ts > 'getAllParts' > 'applies search filter correctly'` AND end-to-end by `e2e/parts-and-routing.spec.ts > 'Parts and Routing workflow' > 'create part, add routing with operations, verify cost'`*.
- [ ] **Given** the Source filter, **when** "Made" or "Bought" is selected, **then** only parts with that `source` remain (applied client-side after the fetch) — *manual: Source dropdown on `app/dashboard/[companyId]/parts/page.tsx`*.
- [ ] **Given** a part that is not yet priceable, **when** the list renders, **then** an inline ⚠ "incomplete — needs setup" marker appears next to its name and the Completeness filter can isolate it — *verified by `__tests__/utils/partPricingTiersAccess.test.ts > 'getTiersWithComputedPrices — bought parts (no routing/BOM)' > 'leaves unit_price null when the base cost cannot resolve (no procurement tier)'` (drives the priceability set); marker/filter render automation-pending (`getPriceablePartIds`)*.

**Create (part row)**

- [ ] **Given** the "Add Part" button, **when** clicked, **then** it opens `/parts/new` (the workspace in create mode — there is no create modal) — *verified by `e2e/parts-and-routing.spec.ts > 'Parts and Routing workflow' > 'create part, add routing with operations, verify cost'` (end-to-end)*.
- [ ] **Given** the create form with an empty name, **when** the user submits, **then** creation is blocked with an inline error — *verified by `__tests__/components/parts/PartIdentitySection.test.tsx > 'PartIdentitySection' > 'create mode' > 'requires a part name (submitting empty shows an error, no create)'`*.
- [ ] **Given** a name that already exists in the company, **when** the user submits, **then** the duplicate is rejected — *verified by `__tests__/components/parts/PartIdentitySection.test.tsx > 'PartIdentitySection' > 'create mode' > 'blocks a duplicate part name'` AND write-path guard `__tests__/utils/partsAccess.test.ts > 'checkPartNameExists' > 'returns true when part name exists'`*.
- [ ] **Given** a valid name + unit, **when** the user clicks "Create part", **then** the row is inserted and the app redirects into the live `/parts/{id}` page — *verified by `__tests__/components/parts/PartIdentitySection.test.tsx > 'PartIdentitySection' > 'create mode' > 'creates the part and calls onCreated on success'` AND `__tests__/utils/partsAccess.test.ts > 'createPart' > 'inserts part and returns data'`; redirect end-to-end by `e2e/parts-and-routing.spec.ts > 'Parts and Routing workflow' > 'create part, add routing with operations, verify cost'`*.

**Edit — identity (edit → save → reload → persists)**

- [ ] **Given** an existing part, **when** the user edits an identity field (name/description/etc.) and blurs, **then** it auto-saves via `updatePart` and reloading shows the change — *write path verified by `__tests__/components/parts/PartIdentitySection.test.tsx > 'PartIdentitySection' > 'existing mode' > 'auto-saves an edited field on blur via updatePart'` AND `__tests__/utils/partsAccess.test.ts > 'updatePart' > 'updates part and returns data'`; reload-persistence E2E automation-pending (#367)*.
- [ ] **Given** the part detail page, **when** it renders in existing mode, **then** it is an editable workspace (no read-only view, no "Edit" button) with fields pre-filled — *verified by `__tests__/components/parts/PartIdentitySection.test.tsx > 'PartIdentitySection' > 'existing mode' > 'pre-fills from the part and has no Create button'`*.

**Edit — pricing tiers (edit → save → reload → persists)**

- [ ] **Given** a made part, **when** the user adds/edits tier quantity + markup % and clicks **Save pricing**, **then** the tiers persist (markup % is the stored source of truth; `unit_price`/`base_cost_per_unit` are recomputed live, not stored) and reloading shows them — *write path verified by `__tests__/utils/partPricingTiersAccess.test.ts > 'getTiersWithComputedPrices — made parts (routing/BOM) unchanged' > 'prices made parts from the routing breakdown and never calls compute_part_cost_at_qty'`; explicit-Save (not auto-save) + reload E2E automation-pending (`replaceTiersForPart`)*.
- [ ] **Given** the Pricing card, **when** the user types a unit price, **then** the markup % is back-calculated from the live base cost and stored as the source of truth — *automation-pending (`handleUnitPriceChange` in `PartPricing.tsx` / `calculateMarkupFromUnitPrice`)*.
- [ ] **Given** the routing changes, **when** the part page bumps `refreshKey`, **then** every tier's displayed base cost and unit price recompute against the new cost basis — *automation-pending (`PartPricing` `refreshKey` reload / `calculateTierPricing`)*.
- [ ] **Given** a bought part with a procurement tier, **when** a tier is priced, **then** its sell price resolves as `procurement_cost(qty) × (1 + markup/100)` through the shared resolver — *verified by `__tests__/utils/partPricingTiersAccess.test.ts > 'getTiersWithComputedPrices — bought parts (no routing/BOM)' > 'prices a bought part as procurement cost × markup (the $55.74 case)'`*.
- [ ] **Given** a part deletion, **when** the part row is removed, **then** its `part_pricing_tiers` rows are removed by cascade — *manual: `part_pricing_tiers.part_id` FK ON DELETE CASCADE in `supabase/schema.prod.sql`*.

**New-part pricing (unfilled row)**

- [ ] **Given** a newly created part, **when** the Pricing card first renders, **then** it shows one unfilled pricing row (Min qty 1, Markup blank) with nothing auto-applied, and the part stays not-priceable until a tier carries a `markup_percent` — *automation-pending (`createPart`; priceability via `get_priceable_part_ids`)*.

**Cost build-up (inside the Pricing card)**

- [ ] **Given** a made part with a routing, **when** the Pricing card renders, **then** it shows run labor / unit, one-time setup, and materials / unit summary rows above the tier table — *manual: `PartPricing.tsx` `SummaryRow`s off `calculateRoutingCost`*.
- [ ] **Given** a routing with data-quality gaps, **when** the card renders, **then** warnings (`empty_operation`, `missing_labor_rate`, `missing_material_cost`) surface inline, linking to the offending BOM child where applicable — *manual: `breakdown.warnings` block in `PartPricing.tsx`*.
- [ ] **Given** a made part with no routing/BOM yet, **when** the card renders, **then** it shows an "Add operations or materials to calculate pricing" empty state rather than a fabricated $0 — *manual: no-breakdown branch in `PartPricing.tsx`*.

**Bought-part Cost card (`PartProcurementPricingPanel`)**

- [ ] **Given** a bought part whose selected vendor has no cost tier, **when** the Cost card renders, **then** it shows one empty red starter row + a red prompt, with Save disabled until edited — *verified by `__tests__/components/parts/PartProcurementPricingPanel.test.tsx > 'PartProcurementPricingPanel — explicit save + red no-cost state' > 'shows the red no-cost prompt + an empty starter row, with Save disabled until edited'`*.
- [ ] **Given** a typed cost tier, **when** the user clicks **Save costs**, **then** it persists on the button (not on blur) and fires `onSaved` so the "Needs cost" chip clears without a reload — *verified by `__tests__/components/parts/PartProcurementPricingPanel.test.tsx > 'PartProcurementPricingPanel — explicit save + red no-cost state' > 'saves a typed tier via the Save button (not on blur) and fires onSaved'`*.

**Delete (part row) — archive (soft-delete), never blocks**

Deletion is **archive**: the row is hidden (`deleted_at` set) but kept, so quotes/jobs/BOM
parents that reference it still resolve. It is **never** disabled or refused for referenced
parts. Archiving also detaches the part as a BOM child (via the `archive_parts` RPC) so
dependent parts' costs recompute. See `docs/architecture.md` §16.

- [ ] **Given** any part (referenced or not), **when** the user confirms Delete, **then** the part is archived via the `archive_parts` RPC and never blocked — *verified by `__tests__/utils/partsAccess.test.ts > 'deletePart' > 'archives the part via the archive_parts RPC (never a hard delete, never blocks)'`*.
- [ ] **Given** several parts selected, **when** the user confirms bulk delete, **then** all are archived in one RPC call — *verified by `__tests__/utils/partsAccess.test.ts > 'bulkDeleteParts' > 'archives multiple parts via the archive_parts RPC'`*.
- [ ] **Given** a delete is requested, **when** the confirm dialog opens, **then** it shows an impact summary (quotes/jobs referencing the parts — kept for history — and how many other parts' costs will change) and never prevents the delete — *impact counts verified by `__tests__/utils/partsAccess.test.ts > 'getPartsDeletionImpact'`*.
- [ ] **Given** an archived part's name, **when** the user re-creates or re-imports it, **then** the archived row is revived (un-archived + updated) rather than duplicated — *revive-on-collision verified by `__tests__/utils/partsAccess.test.ts > 'createPart'`; import revive by the parts-import integration suite*.

**File attachments (edit → save → reload → persists)**

- [ ] **Given** the always-visible Files tab (`?tab=files`), **when** the user uploads one or more `.pdf`/`.step`/`.stp`/`.dwg` files, **then** each is stored with its computed kind + uploader and appears in the newest-first list with a kind chip — *write path verified by `__tests__/utils/partAttachmentsAccess.test.ts > 'uploadPartAttachment' > 'uploads, inserts the computed kind + operator uploaded_by, and returns the mapped row'`; list render by `__tests__/components/parts/FilesTab.test.tsx > 'FilesTab' > 'lists attachments with kind chips'`*.
- [ ] **Given** a disallowed type (e.g. `.png`), **when** it is selected, **then** it is rejected with a clear message and nothing is stored — *verified by `__tests__/components/parts/FilesTab.test.tsx > 'FilesTab' > 'surfaces a validation error and does not upload a rejected file'` AND `__tests__/utils/partAttachmentsAccess.test.ts > 'validatePartAttachmentFile' > 'rejects a disallowed extension'`*.
- [ ] **Given** an over-cap file, **when** it is selected, **then** a PDF over 25 MB or a STEP/DWG over 100 MB is rejected with a size message — *verified by `__tests__/utils/partAttachmentsAccess.test.ts > 'validatePartAttachmentFile' > 'rejects a PDF over the 25 MB cap'` AND `> 'validatePartAttachmentFile' > 'rejects a STEP over the 100 MB cap'` AND `> 'validatePartAttachmentFile' > 'allows a STEP up to 100 MB (above the PDF cap)'`*.
- [ ] **Given** a PDF row, **when** "Open" is clicked, **then** it renders inline in the viewer modal off a fresh signed URL — *verified by `__tests__/components/parts/FilesTab.test.tsx > 'FilesTab' > 'opens a PDF inline in the viewer modal'` AND `__tests__/components/parts/workspace/tabs/AttachmentViewerModal.test.tsx > 'AttachmentViewerModal — parent key-remount fetches a fresh URL per attachment' > 'refetches the signed URL for a DIFFERENT attachment on key change (no stale URL/loading)'`*.
- [ ] **Given** a STEP row, **when** "Open" is clicked, **then** it opens in the in-app 3D viewer — *verified by `__tests__/components/parts/FilesTab.test.tsx > 'FilesTab' > 'opens a STEP file in the 3D viewer'`*.
- [ ] **Given** a DWG row, **when** "Open" is clicked, **then** it downloads instead of opening a viewer (no in-browser DWG render) — *verified by `__tests__/components/parts/FilesTab.test.tsx > 'FilesTab' > 'downloads a DWG instead of opening the viewer'`*.
- [ ] **Given** any attachment, **when** the user is the uploader or a company admin, **then** the delete affordance shows (and is hidden otherwise) — *verified by `__tests__/components/parts/FilesTab.test.tsx > 'FilesTab' > 'shows the delete affordance only on rows the user uploaded (non-admin)'` AND `> 'FilesTab' > 'shows delete on every row for an admin'`*.
- [ ] **Given** a delete, **when** confirmed, **then** the metadata row is removed first and only then the stored file (and a row-delete failure leaves the file intact) — *verified by `__tests__/utils/partAttachmentsAccess.test.ts > 'deletePartAttachment' > 'deletes the row first, then the file (row-first)'` AND `> 'deletePartAttachment' > 'throws and does NOT delete the file when the row delete fails'`*.

**AI-powered import**

- [ ] **Given** a CSV, **when** it is uploaded, **then** the AI suggests column mappings, duplicates within the company are detected, valid rows import, and a results summary is shown — *verified by `e2e/csv-import.spec.ts > 'CSV Import workflow' > 'import parts from CSV file'` (end-to-end; local-only, `test.skip` under CI — needs the FastAPI backend for AI column analysis)*.

---

## Delete Behavior — archive (soft-delete), never blocks

"Delete" **archives** the part: `deletePart`/`bulkDeleteParts` call the `archive_parts` RPC, which sets `parts.deleted_at` and detaches the part as a BOM child (deletes `parts_bom` rows where it's the child) in one transaction. It is **never** disabled or refused — a part on quotes/jobs or used in another part's BOM archives like any other. The row and its pricing tiers, attachments, and files are all **kept** (nothing cascades away), so every quote line item / job / document that references the part still resolves; the part is simply hidden from lists, search, and pickers (reads filter `deleted_at IS NULL`).

The delete dialog (`DeleteImpactDialog`) surfaces an impact summary from `parts_deletion_impact` — how many quotes and jobs reference the parts (kept for history) and how many **other** parts have them as a BOM component and will thus have their cost recomputed — but it never prevents the delete.

Because name is the part's natural identity, re-creating or re-importing an archived part's `part_name` **revives** the archived row (un-archives + updates it) rather than duplicating it. Quote line items remain immutable historical records regardless. See `docs/architecture.md` §16 for the full standard.
