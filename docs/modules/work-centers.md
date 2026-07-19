# Work Centers Module

## Overview

A **work center** is a unit of production capacity. It can be **internal** (a machine, station, or in-house capability with an hourly labor rate) or **external** (an outsourced process performed by a vendor). Work centers are referenced by routing operations (`routing_operations.work_center_id`).

> **Note on terminology.** This module supersedes what older docs called "Operations" (`operation_types` table). Migration `20260502_unify_parts_inventory_add_work_centers_vendors.sql` dropped `operation_types` and introduced `work_centers`. The two-axis design (internal vs external) unified machine capabilities and outsourced capabilities into one table. The old standalone Operations spec was folded into this module and its separate doc removed.

**Priority:** Built; in production.

**Dependencies:** [Vendors](vendors.md) (external work centers point at a vendor). Consumed by [Routings](routings.md) (via `routing_operations.work_center_id`).

---

## Data Model

### `work_centers` table

| Column | Notes |
|---|---|
| `id` | uuid PK |
| `company_id` | FK |
| `name` | required |
| `kind` | enum: `internal | external` |
| `vendor_id` | FK → `vendors`; required when `kind='external'` (DB CHECK), null when `kind='internal'` |
| `labor_rate` | numeric; used when `kind='internal'`; cleared to null when `kind='external'` |
| `description` | optional multiline |
| `metadata` | jsonb; defaults to `{}` (reserved for future per-work-center attributes) |
| `created_at`, `updated_at` | |

External work centers do **not** carry a labor_rate on the work-center row. Their cost is a single **vendor unit price** set per routing operation (`routing_operations.external_unit_price`) — pricing is per-operation, not per-vendor. External (vendor) work **bills once per part, so there is no setup cost** — setup is an internal-only concept (the `external_setup_cost` column was dropped in June 2026).

---

## Pages

### List — `/dashboard/{companyId}/work-centers`

The list is split by kind into two **tabs** — **Internal** and **External** (there is no combined "All" view; switching tabs re-queries via `getWorkCentersByKind`, clears the search box, and clears the selection). The active tab is reflected in the app-bar title ("Work Centers — Internal" / "— External"). Each tab renders its own AG Grid column set:

**Internal tab columns:**

- **Name** (pinned left)
- **Cost** — `labor_rate` formatted as `$X.XX/hr` (or `—` if null); sortable via a `valueGetter` on `labor_rate`.
- **Description** (not sortable)
- **Updated**

**External tab columns:**

- **Name** (pinned left)
- **Vendor** — the joined vendor name (or `—`)
- **Description** (not sortable)
- **Updated**

The external tab shows no Cost column; instead a caption above the grid reads "External work centers are priced per routing operation, not by an hourly rate." (There is no cross-kind Cost cell and no comparator pinning external rows — the two kinds never share a grid.)

Search filters across name (300ms debounce). Default sort: name asc. Pagination: 25 / 50 / 100. Toolbar actions: bulk export CSV and bulk delete (shown once rows are selected), **Import**, and **New Work Center**. The internal tab additionally shows a **Print Placards ({count})** button that generates one A4 station-QR placard per internal work center in a single PDF (`generateStationPlacards`).

### Detail — `/dashboard/{companyId}/work-centers/{workCenterId}`

Sections:

- **Header card** — name, kind chip (icon + text), "via {vendor}" link (external only).
- **Details card** — labor rate (internal) **or** vendor link + "Pricing per routing operation" note (external); description; "Used in routing operations" count; created/updated timestamps.
- **Station QR Code card** (internal only) — `StationQRCode` component. The scan URL is keyed off the work-center **id** (there is no station-code field: `StationQRCode`'s optional `operationCode` caption prop is left unset, so no code prints under the QR).

The **Delete** button archives the work center (sets `deleted_at`) and is **never disabled or blocked** — even when `routing_operations_count > 0`. The row survives the archive, so every referencing routing operation still resolves it; the work center just disappears from the list tabs and routing pickers (which filter `deleted_at IS NULL`). Reusing the name later revives it. (The `routing_operations_count` shown here still drives the **Kind-toggle lock in edit mode** — see Edit below — but no longer gates deletion.) See [architecture.md §16](../architecture.md) for the universal archive (soft-delete) policy.

### Create — `/dashboard/{companyId}/work-centers/new`

Renders `WorkCenterForm` in `mode="create"`. Fields:

- **Name** — required (case-insensitive uniqueness checked per company via `checkWorkCenterNameExists`).
- **Kind toggle** — Internal (FactoryIcon) / External (LocalShippingIcon).
- **Internal-only:** `labor_rate` (number, ≥ 0) — **required** for internal work centers (an internal routing op with no rate and no per-op override cannot be priced). Switching to External hides and clears it.
- **External-only:** `vendor_id` via `VendorAutocomplete` (required).
- **Description** — optional multiline.

Form validation requires `vendor_id` when `kind='external'` and requires a non-negative `labor_rate` when `kind='internal'`; the DB also enforces the vendor/kind pairing via CHECK constraints (`work_centers_external_requires_vendor`, `work_centers_internal_no_vendor`).

In **edit** mode, when `routing_operations_count > 0` the **Kind toggle is locked** (disabled): costing reads `kind` live, so flipping internal↔external would orphan the pricing on every referencing routing operation. A caption explains the lock and the operation count.

### Edit — `/dashboard/{companyId}/work-centers/{workCenterId}/edit`

Renders the same `WorkCenterForm` in `mode="edit"`, hydrated from `getWorkCenterWithRelations` (which also supplies `routing_operations_count` for the kind-lock). On save it calls `updateWorkCenter` and routes back to the detail page. A "Back to Work Center" button sits at top left (no inline page title — the Header supplies it).

### Import — `/dashboard/{companyId}/work-centers/import`

CSV upload → AI-assisted column mapping → conflict/validation review → execute. This flow goes through the **FastAPI** import router (`api/routes/work_centers_import_routes.py`, prefix `/api/work-centers/import`) with `/analyze`, `/validate`, and `/execute` endpoints — it is a multi-step import pipeline with conflict detection, not a Supabase-client CRUD call. External rows resolve `vendor_name` → `vendor_id` server-side against the company's vendors; unresolved vendors surface as `unknown_vendor` conflicts and internal rows carrying a vendor surface as `vendor_forbidden_for_internal` errors. Execute upserts `ON CONFLICT (company_id, name)`, so a work center already in the company **updates in place** rather than being skipped — re-importing is idempotent; within-CSV duplicate names collapse into one. The client-side `bulkImportWorkCenters` in `workCentersAccess.ts` implements the same name/vendor resolution rules and is unit-covered as the reference logic.

---

## Access Layer

`utils/workCentersAccess.ts`:

| Function | Purpose |
|---|---|
| `getWorkCentersByKind(companyId, kind, search)` | Filter by kind (the list page's per-tab query) |
| `getWorkCentersForRouting(companyId, kind?)` | `{id, name, kind, labor_rate, vendor_name}` — vendor name pre-joined for the routing picker |
| `getWorkCenterWithRelations(workCenterId)` | Hydrates with `routing_operations_count` and vendor |
| `createWorkCenter(companyId, formData)` | `kind='external'` clears `labor_rate` to null; inserts `metadata: {}`. On a `23505` name collision with an **archived** work center, revives that row instead (un-archive + apply form values via `reviveArchivedWorkCenterByName`); a live collision re-throws as a duplicate |
| `updateWorkCenter(workCenterId, formData)` | Same kind logic |
| `deleteWorkCenter(workCenterId)` | **Archive** — sets `deleted_at` via `.update()` (not a SQL `DELETE`); never blocks even when `routing_operations` reference it (the row survives so they keep resolving) |
| `bulkDeleteWorkCenters(workCenterIds)` | **Archive** in 100-row batches; same never-blocks semantics |
| `bulkImportWorkCenters(companyId, rows)` | Vendor-name resolution for external rows; de-dupe by name |

`getAllWorkCenters` and `getWorkCentersFlat` still exist in `workCentersAccess.ts` but have no non-test callers (the list page queries per tab via `getWorkCentersByKind`, and routing pickers use `getWorkCentersForRouting`). They are dead and slated for removal — pruning is tracked in **#550**.

---

## Acceptance Criteria

Each bullet is a Given/When/Then scenario carrying a verification clause — a pointer to the test that proves it, a manual procedure, or an explicit automation-pending tag. Every editable entity has at least one edit -> save -> reload -> persists bullet. Doc-vs-code disagreements this audit surfaced are recorded in the divergence report on issue #345.

The only editable entity in this module is the **work center** (`name`, `kind`, `vendor_id`, `labor_rate`, `description`). It is *referenced by* routing operations (an operation RUNS AT a work center) but never edited from them.

**List, search & filter**

- [ ] **Given** the work-centers list, **when** it loads, **then** rows are scoped to the current company and queried by the active kind tab — *verified by `__tests__/utils/workCentersAccess.test.ts > 'workCentersAccess' > 'getWorkCentersByKind' > 'filters by kind in addition to company'` (the live list uses the per-kind query, which covers company + kind scoping)*.
- [ ] **Given** the Internal / External tabs, **when** the user switches tabs, **then** the grid re-queries that kind, shows kind-specific columns (Internal → Cost; External → Vendor), clears the search box, and clears the selection — *manual: toggle the two tabs on `/dashboard/{companyId}/work-centers` and confirm columns + cleared search/selection (UI in `app/dashboard/[companyId]/work-centers/page.tsx`; automation-pending)*.
- [ ] **Given** a non-empty search term, **when** the list queries, **then** a `name.ilike.%term%` filter is applied, and a whitespace-only term applies no filter — *the name-ilike / whitespace behavior is currently tested only on the soon-pruned `getAllWorkCenters` (see #550); search coverage for the live per-kind query is automation-pending*.
- [ ] **Given** the External tab, **when** it renders, **then** no Cost column appears and a caption states external work centers are priced per routing operation — *manual: open the External tab and confirm the caption + absence of a Cost column (automation-pending)*.
- [ ] **Given** the Internal tab, **when** the user clicks **Print Placards**, **then** a single PDF with one A4 station-QR placard per internal work center downloads — *manual: click Print Placards on the Internal tab (calls `generateStationPlacards`); automation-pending*.

**Create**

- [ ] **Given** the create form with kind=Internal, **when** the user submits a name and labor rate, **then** a work center is inserted with the parsed `labor_rate`, `vendor_id=null`, `metadata={}`, and a trimmed description — *verified by `__tests__/utils/workCentersAccess.test.ts > 'workCentersAccess' > 'createWorkCenter' > 'inserts a work center with parsed labor_rate and nulled vendor_id for internal kind'`*.
- [ ] **Given** the create form with kind=Internal, **when** the user leaves labor rate blank (or negative), **then** submit is blocked with "Labor rate is required for internal work centers" / a non-negative error — *manual: form validation in `components/work-centers/WorkCenterForm.tsx`; automation-pending*.
- [ ] **Given** the create form with kind=External, **when** the user submits without a vendor, **then** submit is blocked with "Vendor is required for external work centers" and the DB CHECK (`work_centers_external_requires_vendor`) also guards it — *validate-endpoint parity verified by `api/tests/integration/test_work_centers_import_api.py > 'TestWorkCentersValidate' > 'test_external_requires_vendor'`; client-form validation automation-pending (`WorkCenterForm.validateForm`)*.
- [ ] **Given** a company that already has a work center of a given name, **when** the user tries to create another with the same name (case-insensitive), **then** it is rejected as a duplicate — *lookup path verified by `__tests__/utils/workCentersAccess.test.ts > 'workCentersAccess' > 'checkWorkCenterNameExists' > 'returns true when one or more rows match'`; DB backstop is the `work_centers_unique_per_company` unique constraint*.

**Edit (edit -> save -> reload -> persists)**

- [ ] **Given** an existing internal work center, **when** an admin changes the name, labor rate, or description and saves, **then** reloading the detail page shows the new values and a bumped `updated_at` — *write path verified by `__tests__/utils/workCentersAccess.test.ts > 'workCentersAccess' > 'createWorkCenter' > 'inserts a work center with parsed labor_rate and nulled vendor_id for internal kind'` (shared insert/normalization shape; `updateWorkCenter` applies the same kind logic); reload-persistence E2E automation-pending (#367)*.
- [ ] **Given** an existing external work center, **when** an admin changes the vendor and saves, **then** reloading shows the new "via {vendor}" link and `labor_rate` stays null — *write path: `updateWorkCenter` sets `vendor_id` and forces `labor_rate=null` for `kind='external'` (defensive normalization in `WorkCenterForm.handleSubmit`); reload-persistence E2E automation-pending (#367) (`updateWorkCenter`)*.
- [ ] **Given** a work center referenced by ≥1 routing operation, **when** it is opened in edit mode, **then** the Kind toggle is disabled (locked) so internal↔external cannot be flipped — *manual: open a referenced work center's edit page and confirm the locked toggle + caption (`kindLocked` in `WorkCenterForm.tsx`); automation-pending*.
- [ ] **Given** an edit where kind stays internal, **when** the user re-checks uniqueness against a name owned by *another* row, **then** the current row is excluded from the conflict check — *verified by `__tests__/utils/workCentersAccess.test.ts > 'workCentersAccess' > 'checkWorkCenterNameExists' > 'excludes a specific id when excludeId is set'`*.

**Delete (= archive)**

- [ ] **Given** any work center, **when** the user confirms delete, **then** it is **archived** — `deleted_at` is stamped via `.update()` (no SQL `DELETE`) — and it disappears from the list tabs and routing pickers, while a by-id link (`getWorkCenter`) still resolves it — *verified by `__tests__/utils/workCentersAccess.test.ts > 'workCentersAccess' > 'deleteWorkCenter' > 'archives the work center by stamping deleted_at instead of hard-deleting'`*.
- [ ] **Given** a work center referenced by routing operations, **when** delete is attempted, **then** the archive still **succeeds — it never blocks** — and the row survives so every referencing operation keeps resolving (the Delete button/dialog is never disabled, and there is no `23503` FK-guard branch any more) — *same archive path as above; the former FK-guard test was removed. A Supabase failure surfaces a friendly error — `__tests__/utils/workCentersAccess.test.ts > 'workCentersAccess' > 'deleteWorkCenter' > 'throws when supabase returns an error'`*.
- [ ] **Given** selected rows on the list, **when** the user bulk-deletes, **then** they are archived (`deleted_at` set) in batches of 100, never blocked by references — *verified by `__tests__/utils/workCentersAccess.test.ts > 'workCentersAccess' > 'bulkDeleteWorkCenters' > 'archives each id by stamping deleted_at instead of hard-deleting'`*.
- [ ] **Given** an archived work center's name, **when** a user re-creates or re-imports that name, **then** the archived row is **revived** (un-archived + updated) rather than duplicated — *insert-collision revive path in `createWorkCenter` (`reviveArchivedWorkCenterByName`); import upsert sets `deleted_at=None`; automation-pending*.

**Import**

- [ ] **Given** a CSV with an internal row (no vendor), **when** it is validated, **then** it reports no conflicts and a valid row count — *verified by `api/tests/integration/test_work_centers_import_api.py > 'TestWorkCentersValidate' > 'test_internal_no_vendor_ok'`*.
- [ ] **Given** a CSV external row whose `vendor_name` doesn't match any company vendor, **when** it is validated, **then** an `unknown_vendor` conflict is reported — *verified by `api/tests/integration/test_work_centers_import_api.py > 'TestWorkCentersValidate' > 'test_external_unknown_vendor'`*.
- [ ] **Given** a CSV internal row that carries a vendor, **when** it is validated, **then** a `vendor_forbidden_for_internal` error is reported — *verified by `api/tests/integration/test_work_centers_import_api.py > 'TestWorkCentersValidate' > 'test_internal_with_vendor_rejected'`*.
- [ ] **Given** a valid internal CSV row, **when** import executes, **then** a `work_centers` row is inserted with `kind='internal'`, the parsed `labor_rate`, and `vendor_id=null` — *verified by `api/tests/integration/test_work_centers_import_api.py > 'TestWorkCentersExecute' > 'test_execute_internal'`*.
- [ ] **Given** a valid external CSV row whose `vendor_name` matches a company vendor, **when** import executes, **then** the vendor name is resolved to `vendor_id` and the row is inserted with `kind='external'` — *verified by `api/tests/integration/test_work_centers_import_api.py > 'TestWorkCentersExecute' > 'test_execute_external_resolves_vendor'`*.

**Consumed by routings (referenced, not edited here)**

- [ ] **Given** a routing operation, **when** a work center is picked and the part cost is computed, **then** the chosen work center drives the routing cost (internal → `labor_rate`; external → per-op `external_unit_price`) — this exercises the work center only from the routing side (not via work-center CRUD), *verified by `e2e/parts-and-routing.spec.ts > 'Parts and Routing workflow' > 'create part, add routing with operations, verify cost'`*.

---

## See also

- [Routings](routings.md) — `routing_operations.work_center_id` is the consumer.
- [Vendors](vendors.md) — external work centers reference a vendor.

The former "Operations" module (`operation_types`) was folded into this one and its standalone doc removed — see the terminology note at the top.
