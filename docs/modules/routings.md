# Routings Module

## Overview

The Routings module provides a **linear, reorderable operation list** for defining manufacturing processes. A routing is an ordered sequence of operations (plus a routing-level list of materials) that describes how a part is manufactured.

Each part has **exactly one routing** (1:1 relationship). Routings are managed from the **part detail page**, not a standalone routings page. There is no separate "Routings" entry in the sidebar navigation.

Users build routings by adding operations to a list and reordering them with up/down arrow buttons (no drag-and-drop). Each operation row points at a **work center** (internal or external) and, for internal work, holds setup time and cycle (run) time per unit; external work carries a per-unit vendor price instead. Materials are **not** part of the routing — the bill of materials lives on the part itself (`parts_bom`) and is edited by a separate BOM panel.

### Work centers

A routing operation always **runs AT a work center** (`routing_operations.work_center_id`). A work center is the unit of production capacity that performs the step — either **internal** (an in-house machine, station, or capability priced by an hourly `labor_rate`) or **external** (an outsourced process performed by a vendor, priced by a per-unit `external_unit_price`). Work centers are defined and owned by their own module; the routing only references them and reads their pricing kind to decide how to cost each step. See the [Work Centers module](work-centers.md) for how they are created, the internal/external split, and vendor linkage.

**Priority:** Must Have (Build after Operations, before Jobs)

**Dependencies:**

- Parts module (each part has exactly one routing; routings are accessed from the part detail page)

- Work Centers module (each routing operation points at a `work_center`, internal or external)

- Parts / BOM (materials live on the part as `parts_bom`, not on the routing)

**Database Tables:** `routings`, `routing_operations` (materials are no longer routing-attached — see `parts_bom`)

---

## Terminology

| Term | Description |
|---|---|
| **Routing** | The ordered list of operations that defines how a part is manufactured |
| **Routing Operation** | A single operation step in the routing, stored in `routing_operations` with a `sequence` that determines its position in the list. Each row points at a `work_center`. |
| **Sequence** | Integer that defines linear execution order. Saved in steps of 10 (10, 20, 30, ...) so new rows can be inserted between existing ones without renumbering everything |
| **Work Center** | The internal machine/station or external vendor an operation runs on. Internal work centers carry a `labor_rate` and are priced by time; external ones belong to a vendor and are priced by a per-unit price. |
| **BOM (materials)** | The bill of materials needed to make the part. Lives on the part (`parts_bom`), **not** on the routing — see the [Parts module](parts.md). |

---

## Linear Routing Builder

Routings are edited **inline on the part detail page** via the `PartRoutingPanel` component — there is no separate `/routing/new` or `/routing/edit` page. The panel renders the Operations list and **auto-saves every change to the database** (no "Save Routing" button). It appears only for **made** parts (`part.source === 'made'`); bought parts have no routing. Materials are edited separately by the part's BOM panel — they are not part of this component.

- **Operations list** — Compact one-line rows: work-center name + an Internal/External chip + setup/run (or vendor price) as subtle text (amber when missing, red with an inline message when the operation can't be priced). Reorder via up/down arrow buttons. Click the pencil to edit the row in place; click the trash to delete (behind a "Remove operation?" confirm dialog — the removal is otherwise silent and unrecoverable). The "Add Operation" button expands an **inline editor row** (`RoutingOperationRowEditor`) at the bottom of the list — not a modal — asking for the work center and its time/price fields on one screen.

- **Work center is locked in edit mode** — the editor's work-center picker is disabled when editing an existing row. To change which work center a step uses, delete the row and re-add it.

- **Internal vs external fields** — an internal work center's editor shows setup minutes, cycle minutes per unit, and an optional labor-rate override (pre-filled from the work center's default). An external work center's editor shows a per-unit vendor price and no setup (external work bills once per part). At least one of setup/cycle (internal) or a unit price (external) is required before the row will save.

- **Auto-save** — Each row-editor save, reorder click, or delete persists the whole operations list immediately via `saveRoutingWithOperations`, then refetches so new temp IDs become real DB IDs. A subtle "Saving…" / "All changes saved" indicator (`SaveStatus`) appears above the list. The first add implicitly creates the routing record if the part doesn't have one yet.

- **No minimum** — A routing can be saved with zero operations during editing (it just won't be useful for jobs). The cost breakdown surfaces a `no_operations` warning; the job-creation flow surfaces a missing routing if needed.

Components live under `components/routings/` (`RoutingOperationsList`, `RoutingOperationRow`, `RoutingOperationRowEditor`, `RoutingViewer`, plus the barrel `index.ts`) and `components/parts/PartRoutingPanel.tsx` (the auto-save wrapper that embeds the operations list on the part page, mounted from `components/parts/workspace/tabs/WorkspaceTab.tsx`).

---

## Execution Order

Operations run one after another in ascending `sequence` order. Total estimated time is the sum of setup + (run time per unit × quantity) across all operations in the routing.

```plain text
Seq 10: [CNC Mill] → Seq 20: [Deburr] → Seq 30: [Inspect]
```

There is no DAG, no edges, no parallel branches, and no dependency graph. If two operations should "run in parallel" in real life, shop-floor scheduling is handled at the job/operator level, not in the routing structure.

---

## Data Model

### Routings Table (`routings`)

| Column | Type | Required | Description |
|---|---|---|---|
| id | uuid | Yes | Primary key |
| company_id | uuid | Yes | FK to companies |
| part_id | uuid | Yes | FK to parts (unique — one routing per part) |
| name | text | Yes | Auto-generated from the part name (e.g., "Routing - Custom Reamer") |
| description | text | No | Optional free-text description |
| created_by | uuid | No | User who created the routing |
| created_at | timestamptz | No | Record creation (DEFAULT `now()`) |
| updated_at | timestamptz | No | Last update (DEFAULT `now()`) |

### Routing Operations Table (`routing_operations`)

Each row is one operation step in the routing. Position in the list is defined by the `sequence` column; there is no stored x/y position because the UI is a list, not a canvas. (This table was previously named `routing_nodes`.)

| Column | Type | Required | Description |
|---|---|---|---|
| id | uuid | Yes | Primary key |
| routing_id | uuid | Yes | FK to routings |
| work_center_id | uuid | Yes | FK to work_centers (internal machine/station or external vendor) |
| sequence | integer | Yes | Linear order (steps of 10). Unique within a routing. Defaults to 0. |
| setup_minutes | numeric(8,2) | No | Internal: setup time in minutes (DEFAULT 0) |
| cycle_minutes_per_unit | numeric(8,4) | No | Internal: cycle (run) time per unit in minutes |
| labor_rate_override | numeric(10,2) | No | Internal: overrides the work center's `labor_rate` for this step |
| external_unit_price | numeric(12,4) | No | External: per-unit price the vendor charges for this step |
| instructions | text | No | Optional per-operation instructions |
| metadata | jsonb | No | Extensible metadata (DEFAULT `{}`) |
| created_at | timestamptz | No | Record creation (DEFAULT `now()`) |
| updated_at | timestamptz | No | Last update (DEFAULT `now()`) |

A unique constraint on `(routing_id, sequence)` enforces that no two operations in the same routing share a position. The data-access layer handles reorders with a two-phase update (parks existing rows at sequences 100000+ before assigning their final values) so no intermediate duplicate ever exists.

### Materials (no longer a routing table)

Materials are **no longer stored on the routing**. The old `routing_materials` table was removed: the bill of materials is now attached to the **part** (`parts_bom`, one BOM per manufactured part) and edited by the part's BOM panel. Cost roll-up pulls material cost from `parts_bom` child parts, not from a routing-level material list. See the [Parts module](parts.md) for `parts_bom` details.

---

## User Stories

| As a... | I want to... | So that... |
|---|---|---|
| Owner/Admin | Build a routing for a part as a list of operations | I can define how the part is manufactured |
| Owner/Admin | Reorder operations with up/down arrow buttons | I can adjust the sequence without learning drag-and-drop |
| Owner/Admin | Add an operation via an inline editor that asks for the work center and its setup/run time (or vendor unit price) at once | I can't accidentally save an operation with missing time or price data |
| Owner/Admin | Route a step to either an internal work center or an external vendor | I can cost both in-house machining and outsourced steps in one routing |
| Owner/Admin | View estimated total time (sum of all operations) | I can accurately quote jobs |
| Owner/Admin | Edit the routing directly on the part page without leaving | I can manage the routing in context with everything else about the part |
| Owner/Admin | See changes auto-save as I make them | I never lose work because I forgot to click save |

---

## Validation Rules

- Routing name is auto-generated from the part name (`Routing - {part_name}`); there is no separate name-uniqueness constraint (the `part_id` unique constraint already limits a part to one routing)

- Each part can have at most one routing (enforced by unique constraint on `part_id`)

- Sequence values must be unique within a routing (enforced by unique constraint on `(routing_id, sequence)`)

- An operation must be saved with pricing data: an internal step needs at least setup or cycle time (and a labor rate, from the work center default or a per-step override); an external step needs a per-unit price

---

## Routes

Routings have **no dedicated UI routes**. They live inline on the part detail page (`/dashboard/{companyId}/parts/{partId}`) via the `PartRoutingPanel` component, which auto-saves every change. There is no standalone routings list page either.

---

## Bulk Import (CSV)

Routings can also be created in bulk from a CSV via a **FastAPI** import pipeline (`api/routes/routings_import_routes.py`, prefix `/api/routings/import`) — this is one of the sanctioned backend endpoints because it does AI-powered column mapping and multi-step conflict detection. The pipeline is a three-step handshake, one endpoint per step:

- `POST /analyze` — reads the uploaded CSV's headers/sample rows and uses AI column mapping to propose which column feeds which `routing_operations` field (work center, setup/cycle time, labor-rate override, external unit price, instructions), returning the suggested mapping for the user to confirm.
- `POST /validate` — applies the confirmed mapping to every row, resolves work centers, runs per-kind field validation, and reports per-row conflicts (`unknown_work_center`, invalid numeric fields, external-field-on-internal, …) **without writing anything**.
- `POST /execute` — on a clean (or user-accepted) validation, creates one `routings` row per part and **upserts** the `routing_operations` on their unique key `(routing_id, sequence)`.

Behavioral details:

- **One CSV row per operation**, grouped by `part_name`. The importer creates one `routings` row per part (respecting the `routings.part_id` UNIQUE constraint) and **upserts** `routing_operations` on `(routing_id, sequence)`.
- **Idempotent re-import.** Because operations upsert on `(routing_id, sequence)`, re-importing the same file updates the existing steps in place rather than colliding — the response reports `imported_operations_count` (new) vs `updated_count` (updated in place). The existing-operation lookup is paged past PostgREST's 1000-row cap, so a re-import of thousands of operations no longer leaves most rows undetected and 500-ing on a plain insert (the batch-level "N errors" a full re-import used to show). Assumes a stable `sequence` per row (routing exports carry one); rows auto-numbered because the CSV had no `sequence` column are the exception.
- **Work-center resolution** — `work_center_name` is matched against existing `work_centers`. Rows with no `work_center_name` fall back to a work center literally named `MISCELLANEOUS` (case-insensitive) if one exists; otherwise the row fails validation as `unknown_work_center`. Work centers are **not** auto-created from the CSV — the user imports work centers first.
- **Per-kind field validation** — the cost fields allowed on a row depend on the resolved work center's kind: internal → `setup_minutes` / `cycle_minutes_per_unit` / `labor_rate_override`; external → `external_unit_price`. Supplying an external-only field on an internal row is rejected.

> **Known importer bug (#549):** the import pipeline (`api/routes/routings_import_routes.py`, `api/models/routings_import_models.py`) still maps and validates an `external_setup_cost` field, but that column was dropped from `routing_operations` (migration `20260623022617_drop_external_setup_cost.sql` — external work bills once per part, so setup is internal-only). The stale importer reference is tracked in #549.

---

## Materials (part-attached BOM, not routing-attached)

Materials are **no longer part of the routing**. The earlier per-operation and then routing-level materials approaches were both replaced: the bill of materials is now attached to the **part** (`parts_bom`, one BOM per manufactured part) and edited by the part's BOM panel — see the [Parts module](parts.md).

### Behavior

- BOM lines are `parts_bom` rows on the part, each linking a child part with a quantity and unit.

- When a job is created, each `parts_bom` line is **snapshotted** into `job_materials` — see [Jobs Module — Material Tracking](jobs.md#material-tracking).

- If a BOM line is later edited or deleted, existing jobs are **not** retroactively updated; they keep their snapshot in `job_materials`. Deleting the source BOM line sets the snapshot's source-row FK to `NULL` (`ON DELETE SET NULL`).

---

## Cost Calculation from Routing

Routings serve as the source of truth for part costing when available. `calculateRoutingCost(partId, qty = 1)` (in `utils/routingCostCalculation.ts`) rolls a part's routing operations up with its `parts_bom` materials into a per-unit breakdown that feeds the quoting system. It returns `null` when the part has neither a routing nor a BOM.

### Labor & operation cost

Each operation contributes based on its work center's kind:

**Internal** (priced by time):

```
run_cost   = (cycle_minutes_per_unit / 60) × labor_rate     # per unit
setup_cost = (setup_minutes / 60) × labor_rate              # one-time per batch
labor_rate = labor_rate_override ?? work_center.labor_rate
```

**External** (priced by unit):

```
op_cost = external_unit_price     # per unit; external work has no setup cost
```

Where:
- `cycle_minutes_per_unit` / `setup_minutes` come from `routing_operations`
- `labor_rate` is the hourly rate in dollars — the per-operation `labor_rate_override` if set, else the `work_centers.labor_rate` default

Setup costs are collected separately in `total_setup_cost` (one-time per parent batch) and are **not** amortized at this layer — callers like `calculateTierPricing` divide setup by the tier quantity to spread it.

### Material cost

Summed across the part's BOM (`parts_bom`), not the routing:

```
total_material_cost = Σ (bom_line.quantity × child_part.cost_per_unit)
```

Child costs come from `compute_part_cost_at_qty` at the cascaded quantity. If **any** BOM line can't be priced, `materials_complete` is `false` and both `total_material_cost` and `total_cost` become `null` (mirroring the SQL NULL-propagation), so the UI never renders a tier built on a silently-missing material.

### Total cost

```
total_cost = total_labor_cost + total_setup_cost + total_material_cost   # null if materials incomplete
```

### Integration with Parts

The routing drives the live `Cost Breakdown` card on the part detail page (`calculateRoutingCost(partId)` recomputes on every load and after every routing auto-save). Each `part_pricing_tier` derives its `base_cost_per_unit` and `unit_price` from this calculation; routing edits propagate to all tiers automatically — no Recalculate button.

### Integration with Quotes

Quotes reference parts via `quote_line_items.part_id`. At `createQuote`, per-part cost snapshots (`quote_operations`, `quote_materials`) are written once per distinct part on the quote so the breakdown survives later routing edits. The quote line item itself snapshots `quantity`, `unit_price`, `markup_percent`, and `base_cost_per_unit` from the selected pricing tier (or the salesperson's per-quote override). See [Quotes Module — Snapshotted Line Items](quotes.md#snapshotted-line-items-quote_line_items).

### Edge Cases

| Scenario | Behavior |
|---|---|
| Internal op has no `cycle_minutes_per_unit` and no `setup_minutes` | Skip — `empty_operation` warning on cost breakdown. |
| Internal op has setup but no cycle time (e.g. Engineering) | First-class — `run_cost = 0`, `setup_cost > 0`. Setup amortizes across tier quantity. |
| Internal op's work center has no `labor_rate` and no `labor_rate_override` | Skip — `missing_labor_rate` warning for that operation. |
| External op has no `external_unit_price` | Skip — `missing_external_pricing` warning for that operation. |
| Part has no BOM lines | $0 material cost. Normal — no warning. |
| A BOM child part has no priced cost | `missing_material_cost` warning; `materials_complete = false`, so `total_material_cost` and `total_cost` become `null`. |
| Routing has 0 operations | $0 labor. `no_operations` warning. |
| Any warnings present | Surfaced inline at the top of `PartCostBreakdown`. |

Warnings are informational — they do **not** block quote creation. The user can proceed with incomplete cost data and enter a manual override.

---

## Acceptance Criteria

Each bullet is a Given/When/Then scenario carrying a verification clause — a pointer to the test that proves it, a manual procedure, or an explicit automation-pending tag. Every editable entity has at least one edit -> save -> reload -> persists bullet. Doc-vs-code disagreements this audit surfaced are recorded in the divergence report on issue #339.

**List, view & summary**

- [ ] **Given** a part with a routing, **when** the routing is fetched by id, **then** its row (with the joined part) is returned — *verified by `__tests__/utils/routingsAccess.test.ts > 'routingsAccess' > 'getRouting' > 'returns the row when found'`*.
- [ ] **Given** a routing id that doesn't exist, **when** it's fetched, **then** the access layer returns `null` (PGRST116) rather than throwing — *verified by `__tests__/utils/routingsAccess.test.ts > 'routingsAccess' > 'getRouting' > 'returns null on PGRST116'`*.
- [ ] **Given** a part whose routing has several operations, **when** its summary is loaded, **then** the op count and the sum of `cycle_minutes_per_unit` are returned — *verified by `__tests__/utils/routingsAccess.test.ts > 'routingsAccess' > 'getRoutingSummaryForPart' > 'sums cycle_minutes_per_unit across operations'`*.
- [ ] **Given** a part with no routing, **when** its summary is loaded, **then** `null` is returned (not an empty shell) — *verified by `__tests__/utils/routingsAccess.test.ts > 'routingsAccess' > 'getRoutingSummaryForPart' > 'returns null when no routing exists for the part'`*.

**Create**

- [ ] **Given** a made part with no routing, **when** the first operation is added via the inline editor, **then** the routing record is created implicitly and the operation persists — *end-to-end verified by `e2e/parts-and-routing.spec.ts > 'Parts and Routing workflow' > 'create part, add routing with operations, verify cost'`; the single-operation write path is verified by `__tests__/utils/routingsAccess.test.ts > 'routingsAccess' > 'createRoutingOperation' > 'parses numeric form fields and falls back to 0 for setup_minutes'`*.
- [ ] **Given** the operation editor, **when** setup is left blank but a cycle time is entered, **then** `setup_minutes` is saved as `0` and the trimmed instructions/parsed numbers are written — *verified by `__tests__/utils/routingsAccess.test.ts > 'routingsAccess' > 'createRoutingOperation' > 'parses numeric form fields and falls back to 0 for setup_minutes'`*.
- [ ] **Given** a bought part (`source` ≠ 'made'), **when** the part page loads, **then** no routing panel is shown — *manual: `components/parts/workspace/tabs/WorkspaceTab.tsx` gates `PartRoutingPanel` on `part.source === 'made'`*.

**Edit (edit -> save -> reload -> persists)**

- [ ] **Given** an existing routing operation, **when** its setup/cycle/rate/instructions are edited in the row editor and saved, **then** the panel auto-saves the whole list and a reload shows the new values — *write path via `saveRoutingWithOperations` (which calls `updateRoutingOperation` semantics inline); reload-persistence E2E automation-pending (#367) — the existing E2E only asserts add-then-persist, not edit-after-reload (`updateRoutingOperation`)*.
- [ ] **Given** an operation being edited, **when** the editor is open in edit mode, **then** the work-center picker is locked (change requires delete + re-add) — *manual: `RoutingOperationRowEditor` disables the work-center Autocomplete when `initial` is supplied (`disabled={isEdit}`); `RoutingOperationsList.handleEditorSave` never rewrites `workCenterId` in the edit branch*.
- [ ] **Given** a routing with several operations, **when** a row is moved with the up/down arrows and auto-saved, **then** the new order persists without ever tripping the `(routing_id, sequence)` unique constraint (two-phase re-sequence) — *automation-pending (`saveRoutingWithOperations`)*.
- [ ] **Given** an internal operation whose work center has no `labor_rate` and no per-op override, **when** the routing is edited, **then** the row shows an inline "Missing labor rate" error and the operation is skipped in the cost roll-up — *cost-side verified by `__tests__/utils/routingCostCalculation.test.ts > 'calculateRoutingCost' > 'internal operations' > 'emits missing_labor_rate warning when neither override nor wc.labor_rate is set'`; row-level UI copy automation-pending (`RoutingOperationRow`)*.
- [ ] **Given** an external operation with no unit price, **when** the routing is edited, **then** the row shows an inline "Missing pricing" error and the operation is skipped in the cost roll-up — *cost-side verified by `__tests__/utils/routingCostCalculation.test.ts > 'calculateRoutingCost' > 'external operations' > 'emits missing_external_pricing when there is no unit price'`; row-level UI copy automation-pending (`RoutingOperationRow`)*.

**Delete**

- [ ] **Given** a routing operation, **when** the trash icon is confirmed, **then** the operation is deleted by id and the list re-saves — *write path verified by `__tests__/utils/routingsAccess.test.ts > 'routingsAccess' > 'deleteRoutingOperation' > 'deletes the operation by id'`; the "Remove operation?" confirm-dialog gate is automation-pending (`RoutingOperationsList`)*.
- [ ] **Given** a delete that fails at the DB, **when** `deleteRoutingOperation` runs, **then** it throws a friendly error rather than silently succeeding — *verified by `__tests__/utils/routingsAccess.test.ts > 'routingsAccess' > 'deleteRoutingOperation' > 'throws when supabase returns an error'`*.
- [ ] **Given** a routing, **when** it is deleted, **then** it is removed by id and its operations cascade — *write path verified by `__tests__/utils/routingsAccess.test.ts > 'routingsAccess' > 'deleteRouting' > 'deletes by id'`*.

**Cost roll-up (drives Parts pricing)**

- [ ] **Given** an internal operation with cycle + setup time, **when** cost is computed, **then** it prices both at the work center's `labor_rate` (per-unit run cost + one-time setup cost) — *verified by `__tests__/utils/routingCostCalculation.test.ts > 'calculateRoutingCost' > 'internal operations' > 'prices cycle + setup at the work_center labor_rate when no override'`*.
- [ ] **Given** an operation with a `labor_rate_override`, **when** cost is computed, **then** the override wins over the work center default — *verified by `__tests__/utils/routingCostCalculation.test.ts > 'calculateRoutingCost' > 'internal operations' > 'labor_rate_override takes precedence over the work_center default'`*.
- [ ] **Given** an external operation, **when** cost is computed, **then** it prices as a per-unit `external_unit_price` with zero setup — *verified by `__tests__/utils/routingCostCalculation.test.ts > 'calculateRoutingCost' > 'external operations' > 'prices external ops as per-unit unit_price with zero setup'`*.
- [ ] **Given** a routing mixing internal and external steps, **when** cost is computed, **then** per-op contributions sum correctly across kinds — *verified by `__tests__/utils/routingCostCalculation.test.ts > 'calculateRoutingCost' > 'mixed internal + external routings' > 'sums per-op contributions correctly across kinds'`*.
- [ ] **Given** a routing with zero operations, **when** cost is computed, **then** a `no_operations` warning is emitted — *verified by `__tests__/utils/routingCostCalculation.test.ts > 'calculateRoutingCost' > 'routing edge cases' > 'emits no_operations warning when routing has zero operations'`*.
- [ ] **Given** a part with a BOM child that has no priced cost, **when** cost is computed, **then** `materials_complete` is false and base/unit price are blanked — *verified by `__tests__/utils/routingCostCalculation.test.ts > 'calculateRoutingCost' > 'BOM materials' > 'calculateTierPricing returns null base + unit price when materials incomplete'`*.
- [ ] **Given** a routing edit, **when** it auto-saves, **then** the part's Cost Breakdown and pricing tiers recompute (no Recalculate button) — *manual: `PartRoutingPanel.onRoutingSaved` triggers the parent refresh; `calculateRoutingCost(partId)` is called by `PartPricing.tsx` and `partPricingTiersAccess.ts`*.

**Bulk CSV import (FastAPI)**

- [ ] **Given** a routing CSV whose work-center names all resolve, **when** it is validated, **then** validation passes with grouped operations — *verified by `api/tests/integration/test_routings_import_api.py > 'TestRoutingsValidate' > 'test_happy_path'`*.
- [ ] **Given** a row whose `work_center_name` matches no work center and has no fallback, **when** it is validated, **then** it fails as `unknown_work_center` — *verified by `api/tests/integration/test_routings_import_api.py > 'TestRoutingsValidate' > 'test_unknown_work_center_fails'`*.
- [ ] **Given** rows with no `work_center_name` and a `MISCELLANEOUS` work center present, **when** validated, **then** they route to it — *verified by `api/tests/integration/test_routings_import_api.py > 'TestRoutingsValidate' > 'test_miscellaneous_fallback_when_present'`*; **and** absent that work center they fail — *verified by `api/tests/integration/test_routings_import_api.py > 'TestRoutingsValidate' > 'test_miscellaneous_fallback_fails_when_absent'`*.
- [ ] **Given** an external-only cost field supplied on an internal row, **when** validated, **then** it is rejected — *verified by `api/tests/integration/test_routings_import_api.py > 'TestRoutingsValidate' > 'test_external_field_on_internal_rejected'`*.
- [ ] **Given** a valid internal row with a `labor_rate_override`, **when** the import executes, **then** the override is written onto the created operation — *verified by `api/tests/integration/test_routings_import_api.py > 'TestRoutingsExecute' > 'test_execute_internal_with_labor_rate_override'`*.
- [ ] **Given** a valid external row, **when** the import executes, **then** the external cost fields (unit price / setup cost) are used — *verified by `api/tests/integration/test_routings_import_api.py > 'TestRoutingsExecute' > 'test_execute_external_uses_external_fields'`*.

**Structure & routes**

- [ ] **Given** the app, **when** a user looks for a standalone routings page or a `/routing/new`|`/routing/edit` route, **then** none exists — routings are edited inline on the part page — *manual: no routings dir under `app/dashboard/[companyId]/`; `PartRoutingPanel` is the only editor*.
