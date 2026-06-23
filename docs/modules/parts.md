# Parts Module

## Overview

The Parts module manages the catalog of products/parts that a company manufactures. Parts are **company-wide entities** and are not tied to a specific customer. The customer relationship is expressed through quotes and jobs, not parts.

A part owns three layers of information that drive quoting:

1. **Routing** — operations and materials that define how the part is made (see [Routings](routings.md)).
2. **Cost breakdown** — labor + setup + materials, derived live from the routing. The Cost Breakdown card on the part detail page reloads automatically every time the routing auto-saves; there is no Recalculate button.
3. **Pricing** — quantity break-points (e.g., 1, 2, 4 pieces) each with their own markup %. Markup % is the source of truth on a tier; unit price is always derived as `base_cost × (1 + markup/100)`. Typing a unit price directly back-calculates the markup. Tiers persist on the part; quotes snapshot tiers as immutable line items.

This three-layer split mirrors how real shops already think: cost the part once, set quantity break-points once, then point quotes at the tiers that apply to a given customer conversation.

**Priority:** Must Have (Build Second)

**Dependencies:** None (parts are independent company-wide entities)

**Database Tables:** `parts`, `part_pricing_tiers`

---

## User Stories

| As a... | I want to... | So that... |
|---|---|---|
| Owner/Admin | View a list of all parts | I can see our product catalog |
| Owner/Admin | Search parts by part name or description | I can quickly find a specific part |
| Owner/Admin | Create a new part and assign it to a category | I can quote and track new products with default markups |
| Owner/Admin | Edit part information | I can update descriptions or other details |
| Owner/Admin | Delete a part | I can remove parts we no longer manufacture |
| Owner/Admin | Bulk import parts from CSV | I can migrate from my legacy system |
| Owner/Admin | Create or edit a routing from the part detail page | I can define the manufacturing process for a part |
| Owner/Admin | See a cost breakdown for a part (labor + setup + materials, with previews at qty 1 and qty 10) | I can sanity-check the routing economics without leaving the part |
| Salesperson | Add multiple quantity tiers (e.g. 1, 2, 4) to a part, each with its own markup % | I can quote price breaks the customer asked for |
| Salesperson | Type a unit price directly on a tier | The markup back-calculates automatically; I don't have to do the math |
| Salesperson | Copy pricing from another part | I can reuse the same markup curve across similar parts without retyping |
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
| created_at | Timestamp | Yes | Auto-generated |
| updated_at | Timestamp | Yes | Auto-updated on changes |

**Unique Constraint:** `(company_id, part_name)` — part names must be unique within a company.

**Removed in April 2026:** `category_id` and the `part_categories` table. Categories were anemic (one number — `default_markup_percent`) and were replaced by the **Copy pricing from another part** action. New tier markups are blank by default and the user types them.

### Part Pricing Tiers (`part_pricing_tiers`)

Quantity price break-points that live on the part. One row per tier; selected tiers are snapshotted into `quote_line_items` at quote creation. Setup amortizes into `base_cost_per_unit` at the tier's quantity.

| Field | Type | Required | Description |
|---|---|---|---|
| id | UUID | Yes | Primary key |
| part_id | UUID (FK) | Yes | Part the tier belongs to (cascade delete) |
| company_id | UUID (FK) | Yes | Multi-tenant isolation |
| sequence | Integer | Yes | Display order within the part (10, 20, 30...) |
| quantity | Integer | Yes | Tier quantity, must be > 0 |
| base_cost_per_unit | Decimal(12,4) | No | Cache of `run_labor + materials + (total_setup / qty)` against the current routing |
| markup_percent | Decimal(5,2) | No | **Source of truth.** User-typed markup % for this tier |
| unit_price | Decimal(12,4) | No | Always derived: `base_cost × (1 + markup/100)`. Typing a unit price back-calculates markup before save |
| created_at | Timestamp | Yes | Auto-generated |
| updated_at | Timestamp | Yes | Auto-updated on changes |

**Unique Constraint:** `(part_id, sequence)`

**Single-direction data flow:**

- `markup_percent` is the source of truth.
- `unit_price` is always recomputed against the current routing. Routing change → unit prices drift to reflect the new cost basis. There is no lock concept on the part; if you need a stable price across routing changes, lock it on the quote (see [Quotes — Per-quote overrides](quotes.md#per-quote-price-overrides)).
- Typing in the unit-price input is shorthand for "compute the markup % that would yield this price"; the editor back-calculates and stores the markup, then keeps `unit_price` in lockstep.

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

**RLS** (mirrors `part_notes`):
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

- Table showing: Part Name, Description, Category, Cost (from routing if available)

- Search box (searches part name and description)

- "+ New Part" button

- Click row to view/edit

- Pagination (25 per page)

**Empty State:**

"No parts yet. Create your first part or import from CSV."

### 2. Part Create/Edit

**Route:** `/dashboard/{companyId}/parts/new` or `/dashboard/{companyId}/parts/{id}/edit`

**Form Sections:**

▸ **Basic Information**

- Part Name (required, unique within the company)
- Description

That's it for the metadata form. Routing, cost breakdown, and pricing all live on the part **detail** page (auto-saving as you edit) — there's no separate "Routing" or "Pricing" form.

**Actions:**

- Save → Returns to list
- Cancel → Returns to list without saving
- Delete (edit mode only) → Confirmation dialog

### 3. Part Detail

**Route:** `/dashboard/{companyId}/parts/{id}`

Read-only view showing:

- All part fields

- Related quotes (future)

- Related jobs (future)

- Edit button

▸ **Inline Routing Editor (`PartRoutingPanel`)**

The part detail page embeds the routing editor directly — there's no separate page to navigate to. The panel shows Operations and Materials side-by-side with auto-save: each modal save, reorder click, or delete persists immediately and a "Saving…" / "All changes saved" indicator appears in the panel header. The first add implicitly creates the routing record if the part doesn't yet have one. See `docs/modules/routings.md` for the full editor behavior.

▸ **Cost Breakdown Card (`PartCostBreakdown`)**

A read-only summary that pulls live cost from the routing via `calculateRoutingCost(partId)`:

- Operations table: run min/unit, setup min, rate, run $/unit, setup $ (one-time).
- Materials table: per-unit qty, unit, cost/unit, line/unit.
- Build-up: run labor / unit, one-time setup, materials / unit, **unit cost @ qty 1** (full setup), **unit cost @ qty 10** (setup ÷ 10). The two preview rows make setup amortization visible without committing to a tier yet.
- Surfaces routing warnings (`empty_operation`, `missing_labor_rate`, `missing_material_cost`) inline so data quality issues catch the salesperson's eye before quoting.

▸ **Pricing Card (`PartPricingTiers`)**

Interactive editor for `part_pricing_tiers`. One row per tier with: Qty, Base / unit, Markup %, Unit price, Line total, and a delete icon. Header buttons:

- **+ Add tier** — appends a blank row.
- **Copy from another part** — opens a part picker; on confirm, copies the source part's tiers (qty + markup) onto this part. Unit prices are recomputed against this part's own routing.

Editing model — markup % is the source of truth:

- Editing **quantity** recomputes `base_cost_per_unit` (setup amortization changes); `unit_price` follows from the current markup.
- Editing **markup %** recomputes `unit_price` directly.
- Editing **unit price** back-calculates the markup % and stores it as the new source of truth. There is no lock concept; subsequent routing changes still propagate.

**Auto-save**: every edit triggers a debounced save (~600ms after the last keystroke) via `replaceTiersForPart(companyId, partId, tiers)`. A "Saving… / All changes saved" indicator next to the card title mirrors the routing panel's pattern.

**Live updates from routing**: the card watches the part-page-level `refreshKey` counter. When the routing panel auto-saves, the parent bumps `refreshKey`, which reloads the breakdown and recomputes every tier's `base_cost_per_unit` and `unit_price` against the new cost basis.

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

A part's cost flows in three layers:

1. **Routing cost** — derived live by `calculateRoutingCost(partId)`. Returns per-op run + setup costs and per-material line costs, plus warnings.
2. **Tier cost** — `calculateTierPricing(breakdown, quantity, markup)` adds setup amortization at the tier's quantity:
   ```
   base_cost_per_unit = run_labor_per_unit + material_per_unit + (total_setup / quantity)
   unit_price        = base_cost_per_unit × (1 + markup / 100)
   ```
3. **Quote line item** — a frozen snapshot of `(part_id, quantity, unit_price, total_price, markup_percent, base_cost_per_unit, is_quote_override)` taken at quote creation. See [Quotes Module — Snapshotted Line Items](quotes.md#snapshotted-line-items).

Parts without a routing show "No cost data" in the cost breakdown card; the user can still add tiers and type unit prices manually (the back-calculated markup will look unusual until a routing exists).

---

## AI-Powered Bulk Import

**Route:** `/dashboard/{companyId}/parts/import`

Uses the same AI-powered import infrastructure as Customers (see Customers PRD for full details).

### Parts-Specific Flow

1. **Upload CSV** - Parse file, extract headers + first 5 rows

2. **AI Analysis** - AI suggests column mappings with confidence scores

3. **Review Mappings** - Display with confidence indicators

4. **Validate** - Check for duplicate part names within company

5. **Execute** - Import with results summary

### Conflict Detection

- **Duplicate part_name** within company → Conflict

### API Endpoints

- `POST /api/parts/import/analyze` - AI mapping suggestions

- `POST /api/parts/import/validate` - Conflict detection

- `POST /api/parts/import/execute` - Perform import

### Validation Rules

- part_name is required

- part_name must be unique within the company

---

## Acceptance Criteria

### Core CRUD

- [ ] Can view paginated list of parts
- [ ] Can search parts by number or description
- [ ] Can create new part (basic info only — name + description)
- [ ] Can edit existing part
- [ ] Parts without routings show "No cost data" indicator on the cost breakdown card
- [ ] Can delete a part (hard delete with confirmation)
- [ ] Part name is unique within company
- [ ] Part detail page shows routing panel + cost breakdown + pricing card
- [ ] Form shows validation errors inline

### Cost Breakdown Card

- [ ] Operations table renders one row per routing op with run/setup/rate/$ columns
- [ ] Materials table renders one row per routing material with qty/unit/cost columns
- [ ] Summary shows run labor / unit, one-time setup, materials / unit
- [ ] Preview rows show unit cost at qty 1 and qty 10 (illustrating setup amortization)
- [ ] Routing warnings (`empty_operation`, `missing_labor_rate`, `missing_material_cost`) surface inline
- [ ] **Live updates**: editing the routing immediately reloads the breakdown — no Recalculate button

### Pricing Card

- [ ] Can add a new tier — markup field is blank by default
- [ ] Tier base cost recomputes when quantity changes
- [ ] Editing markup recomputes unit price live
- [ ] Editing unit price back-calculates and stores markup % (markup is the source of truth)
- [ ] **Live updates**: routing edits propagate to every tier's `base_cost_per_unit` and `unit_price` automatically (within ~600ms of routing save)
- [ ] **Auto-save**: every edit persists with a "Saving… / All changes saved" indicator; no Save button
- [ ] **Copy from another part**: opens a part picker; on confirm, source qty + markup are copied; unit prices recompute against this part's routing; subsequent edits to the source do not affect the copy
- [ ] Tiers belonging to a part are deleted when the part is deleted (cascade)

### File Attachments

- [ ] Files tab is always visible on the part workspace (`?tab=files`)
- [ ] Can upload one or more `.pdf`/`.step`/`.stp`/`.dwg` files; each appears in the list with a kind chip, size, and uploader
- [ ] Uploading a `.png` (or other disallowed type) is rejected with a clear message and nothing is stored
- [ ] Uploading a PDF over 25 MB (or a STEP/DWG over 100 MB) is rejected with a size message
- [ ] Opening a PDF renders it inline in the viewer modal
- [ ] Opening a STEP file renders a rotatable 3D model in the viewer modal; a parse/load failure shows an error with a download fallback
- [ ] Opening a DWG downloads it (no in-browser preview)
- [ ] Download is available for every attachment kind
- [ ] The delete affordance is shown only to the uploader or a company admin
- [ ] Deleting an attachment removes both the metadata row and the stored file
- [ ] Deleting a part removes its attachment rows (cascade) and best-effort removes the stored files
- [ ] After creating a part, the user can immediately add files (the Files tab works on the live detail page)

### AI-Powered Import

- [ ] Can upload CSV file and see preview

- [ ] AI analyzes CSV and suggests column mappings

- [ ] Confidence scores displayed with color coding

- [ ] Detects duplicate part names within company

- [ ] Can skip conflicts and import valid rows

- [ ] Shows import results: imported, skipped, orphaned

---

## Delete Behavior

A part can be deleted only when no quote line items or jobs reference it. The delete dialog surfaces the related-record counts; if any exist, the Delete button is disabled. Pricing tiers are removed by cascade when the part is deleted.

Attachment metadata rows cascade with the part, but the stored files do not — so `deletePart` captures the attachment storage paths first, deletes the part row, and only then best-effort removes the files. (Capture-then-clean, not clean-then-delete: a part blocked by FK references must keep its files when the delete is refused.)

Quote line items are immutable historical records — deleting a part that's been quoted requires first removing the dependent quotes (or accepting that the historical record stays).
