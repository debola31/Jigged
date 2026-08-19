# Work Centers Module

> **Condensed 2026-08-03** for [#634](https://github.com/debola31/Jigged/issues/634): **2,410 → 1,618 words**
> (`wc -w`, measured; above the ~1,100 aim because the corrections below *added* material).
> **Cut:** the acceptance-criteria block (51% of the original); the archive/never-blocks policy, restated
> **four** times and owned by [architecture.md §16](../architecture.md); AG Grid column lists that opening the
> page reproduces; AC bullets that only re-described the test they cited; maintenance rationale owned by
> [machine-maintenance.md](machine-maintenance.md). **Kept**, because other docs rely on this doc for them:
> work centre = station, the `operation_types` history, why external work has no setup cost, the kind-toggle
> lock, how an operator reaches their station.
>
> **Six corrections, marked ⚠ where they apply.** *Missing:* the five machine columns, their CHECK, and both
> flag-gated maintenance cards — all shipped. *Wrong:* a migration filename that no longer exists;
> `bulkImportWorkCenters` called "unit-covered" (no tests, no callers); `getWorkCentersFlat` called "no
> non-test callers" (none at all); the E2E spec credited with external costing it never runs; a miscount of
> `workCentersAccess.test.ts`. `#550`, cited as tracking dead-code pruning, is **CLOSED**.

## Overview

A **work center** is a unit of production capacity: **internal** (a machine, station or in-house capability
with an hourly labor rate) or **external** (an outsourced process performed by a vendor). Consumed by
[Routings](routings.md) via `routing_operations.work_center_id`. Built, in production.
**Depends on** [Vendors](vendors.md) — external centres point at one.

## Stations (work centers)

**A "station" in the operator view is a `work_centers` row** — the two words name the same entity. Either kind
qualifies; `kind='external'` simply points at a vendor. [operator-view.md](operator-view.md#stations-work-centers)
covers how one is selected and remembered. A *machine* in
[Machine Maintenance](machine-maintenance.md) is likewise a `work_centers` row, with `kind='internal'`.

> **Terminology.** This module supersedes what older docs called "Operations" (`operation_types`). The
> two-axis design (internal vs external) unified machine and outsourced capabilities into one table; the
> standalone Operations spec was folded in here and its doc removed. The dropping migration was
> `20260502_unify_parts_inventory_add_work_centers_vendors.sql`, but that history is now collapsed into
> [`20260527151536_baseline.sql`](../../supabase/migrations/20260527151536_baseline.sql), which creates
> `work_centers` and carries the rename in three column/table comments.
> *(⚠ Previously cited the `20260502_…` file as if it still existed in `supabase/migrations/`.)*

---

## Data Model — `work_centers`

| Column | Notes |
|---|---|
| `id`, `company_id` | uuid |
| `name` | required; UNIQUE `(company_id, name)` — `work_centers_unique_per_company` |
| `kind` | `internal \| external` (`work_centers_kind_check`), default `internal` |
| `vendor_id` | FK → `vendors`; required when external, NULL when internal — both directions are DB CHECKs (`work_centers_external_requires_vendor`, `work_centers_internal_no_vendor`) |
| `labor_rate` | numeric(10,2); internal only, cleared to NULL when kind flips to external |
| `description` | optional multiline |
| `metadata` | jsonb `{}` — reserved, unused |
| `make`, `model`, `serial_number` | text — **machine details**: internal only, optional, unvalidated |
| `year_built` | integer; `work_centers_year_built_sane` CHECK: NULL or 1900–2200 |
| `purchased_on` | date |
| `deleted_at` | archive marker |
| `created_at`, `updated_at` | |

**External work centres carry no `labor_rate`.** Their cost is one vendor unit price set *per routing
operation* (`routing_operations.external_unit_price`) — per-operation, not per-vendor. External work **bills
once per part, so there is no setup cost**; setup is internal-only, and `external_setup_cost` was dropped in
June 2026. [routings.md](routings.md) defers here for this rule.

**Machine details are optional by design, with no completeness indicator** — asset data entry is a leading
cause of CMMS abandonment, and the machines already exist as work centres, so maintenance starts with a
complete asset list and an empty asset detail. Full reasoning and the pilot kill criterion:
[machine-maintenance.md](machine-maintenance.md).

---

## Pages

### List — `/dashboard/{companyId}/work-centers`

Split by kind into **Internal** and **External** tabs; **there is no combined "All" view**. Switching tabs
re-queries via `getWorkCentersByKind`, clears the search box and the selection, and moves the app-bar title.
Internal shows a **Cost** column (`labor_rate` as `$X.XX/hr`); External shows **Vendor** plus the caption
"External work centers are priced per routing operation, not by an hourly rate."

**Withdrawn:** a cross-kind Cost cell and a comparator pinning external rows — wrong because the two kinds
never share a grid, so neither device has anything to reconcile.

Search filters name (300ms debounce), default sort name asc, pagination 25/50/100. Toolbar: **New Work
Center**, `ExportCsvButton`, and a `Delete (n)` bulk action once rows are selected; the empty state carries
the shared `ImportAllDataLink`. *(The toolbar carried an **Import** button to a work-centre-specific wizard
until that wizard was retired in favour of the one guided importer.)*

### Detail — `/dashboard/{companyId}/work-centers/{workCenterId}`

Header card (name, kind chip, "via {vendor}" for external); Details card (labor rate *or* vendor link +
"Pricing per routing operation"; description; "Used in routing operations" count; timestamps); and — when
`machine_maintenance` is enabled **and** `kind='internal'` — a **Maintenance log** card holding
`MachineManualsManager` above a **read-only** `MachineLogPanel`. Read-only because the pilot's bar counts
*non-founder* authors: manuals and machine details are the office's job, the log is the floor's.

**Nothing about a work centre is printed or posted at the machine.** An operator reaches their station by
signing into the operator view on their own phone and picking it from the list — see FR-5 in
[prd.md](../prd.md) and [operator-view.md](operator-view.md).

Delete archives (`deleted_at`) and **never blocks**, even at `routing_operations_count > 0` — universal policy
in [architecture.md §16](../architecture.md). That count still drives the kind-toggle lock; it no longer gates
deletion.

### Create / Edit — `.../new`, `.../{id}/edit`

One `WorkCenterForm` in `mode="create"` / `"edit"`; edit hydrates from `getWorkCenterWithRelations`, which
supplies `routing_operations_count`.

- **Name** — required, case-insensitively unique per company (`checkWorkCenterNameExists`, excluding the
  current row on edit).
- **Kind toggle** — Internal / External, **locked in edit mode when `routing_operations_count > 0`:** costing
  reads `kind` live, so flipping internal↔external would orphan the pricing on every referencing operation. A
  caption explains the lock and shows the count.
- **Internal:** `labor_rate` **required** and ≥ 0 — an internal routing op with no rate and no per-op override
  cannot be priced. Switching to External hides and clears it.
- **External:** `vendor_id` via `VendorAutocomplete`, required.
- **Machine details** card (flag `machine_maintenance`, internal only): make, model, serial number, year,
  purchased. Sited in the office, not on the floor — filling it is deliberate paperwork.
- **Description** — optional multiline.

### Import

Work centres arrive through the one guided importer at `/dashboard/{companyId}/import` (see
[data-import.md](data-import.md)), which writes via the **FastAPI** route
`api/routes/work_centers_import_routes.py` → `/api/work-centers/import/execute` — a multi-step pipeline with
conflict detection, not Supabase CRUD. External rows resolve `vendor_name` → `vendor_id` server-side;
unresolved names become `unknown_vendor` conflicts, internal rows carrying a vendor become
`vendor_forbidden_for_internal` errors. Execute upserts `ON CONFLICT (company_id, name)`, so re-import
**updates in place** (idempotent) and within-CSV duplicate names collapse into one; it sets
`deleted_at = None`, so re-importing an archived name revives it.

That route is the **only live import path**. *(A `/work-centers/import` wizard with its own `analyze` and
`validate` endpoints existed alongside it, and a `bulkImportWorkCenters` access-layer function mirrored the
same rules with no callers and no tests; both are gone.)*

---

## Access Layer — `utils/workCentersAccess.ts`

| Function | Purpose |
|---|---|
| `getWorkCentersByKind(companyId, kind, search)` | The list page's per-tab query |
| `getWorkCentersForRouting(companyId, kind?)` | `{id, name, kind, labor_rate, vendor_name}` — vendor pre-joined for the routing picker |
| `getWorkCenter(id)` / `getWorkCenterWithRelations(id)` | By-id read (resolves archived rows too) / hydrated with `routing_operations_count` + vendor |
| `checkWorkCenterNameExists(companyId, name, excludeId?)` | Case-insensitive uniqueness for the form |
| `createWorkCenter(companyId, formData)` | External clears `labor_rate`; inserts `metadata: {}`; blank machine details written as NULL. On a `23505` collision with an **archived** row, revives it (`reviveArchivedWorkCenterByName`); a **live** collision re-throws as a duplicate |
| `updateWorkCenter(id, formData)` | Same kind normalization |
| `deleteWorkCenter(id)` / `bulkDeleteWorkCenters(ids)` | Archive via `.update()`, the latter in 100-row batches; neither ever blocks |

**Named gap — dead exports, untracked.** `getAllWorkCenters` has test callers only; `getWorkCentersFlat` has
**zero callers, tests included**; `getWorkCenter` has no non-test callers but is
the by-id read the archive story depends on, so keep it. Pruning was tracked in
[#550](https://github.com/debola31/Jigged/issues/550), now **CLOSED**.
*(⚠ Previously said `getWorkCentersFlat` had "no non-test callers"; it has none whatsoever.)*

---

## Verified behaviour

As-built, verified 2026-08-03; each row names a file + `describe`/class. Divergences found by the original
audit are on [#345](https://github.com/debola31/Jigged/issues/345) (**CLOSED**).

| Behaviour | Enforced by |
|---|---|
| Per-kind + per-company scoping; by-id read; uniqueness lookup incl. `excludeId`; insert normalization (parsed `labor_rate`, nulled `vendor_id`); archive-not-delete single and bulk in 100-row batches; errors surface as a friendly throw | `__tests__/utils/workCentersAccess.test.ts` — `workCentersAccess` (13 `it`s) |
| Blank machine details write as NULL; filled ones are trimmed and parsed | same file — `workCentersAccess machine details` (2 `it`s; 15 in the file) |
| Validation: internal-without-vendor passes, external-without-vendor fails, unknown vendor is a conflict, internal-with-vendor is an error | `api/tests/integration/test_work_centers_import_api.py` — `TestWorkCentersValidate` (4 tests, now calling `validate_import` directly since it is no longer a route) |
| Execute inserts internal rows and resolves `vendor_name` → `vendor_id` for external ones | same file — `TestWorkCentersExecute` (2 tests) |
| Both kinds cost as documented — internal by `labor_rate` × time, external by per-op `external_unit_price` with no setup | `__tests__/utils/routingCostCalculation.test.ts` — `calculateRoutingCost` (groups `internal operations`, `external operations`, `mixed internal + external routings`) |
| Picking a work centre on a routing operation feeds the live part cost end-to-end — **internal only** (the spec selects a fixture named `E2E Internal WC`) | `e2e/parts-and-routing.spec.ts` — `Parts and Routing workflow` |

*(⚠ Previously credited the E2E spec with proving **both** costing kinds; external is unit-only.)*

**Gaps, automation-pending ([#367](https://github.com/debola31/Jigged/issues/367)):** the tab switch clearing
search + selection and swapping columns; the External caption; client-form validation (labor rate required,
vendor required); the kind-toggle lock; reload-persistence after edit; the archived-name revive path; the
external work centre end-to-end. Search (`name.ilike`, whitespace no-op) is tested **only on the dead
`getAllWorkCenters`** — pruning it without moving the test drops that coverage silently.

**Scope.** The only entity edited here is the work centre itself. Routing operations *reference* one — an
operation RUNS AT a work centre — but never edit it.
