> **Condensed 2026-08-03 (#634).** 4,274 → 3,303 words (`wc -w`), with new verified content
> added — see below. **Cut:** the 1,319-word Given/When/Then acceptance block (now a table
> citing file + `describe`/class + it-count, never an `it` title — the old E2E citation had
> already rotted by truncation); the duplicate Materials section (one fact, stated twice as
> two full sections); the User Stories table (7 rows, 100% restatement of the builder
> section); work-centers prose that [work-centers.md](work-centers.md) owns; and the
> `parts_bom` → `job_materials` snapshot prose that [jobs.md](jobs.md#material-tracking) owns.
> **Kept deliberately:** every superseded mechanic *with its reason* (new **Superseded
> mechanics** table — this doc's dead mechanics were previously scattered and unexplained),
> the #549 importer bug verbatim, all cost formulas + the edge-case table, and the
> "linear, no DAG" statement other docs point at.
> **Corrected (4):** the material-cost formula was 5 versions out of date (see
> [Material cost](#material-cost)); the `total_cost` formula wrongly added `total_setup_cost`,
> contradicting the sentence above it (see [Total cost](#total-cost)); the warnings renderer
> is the **Cost** card in `PartPricing.tsx`, not a `PartCostBreakdown` component (never
> existed); `RoutingViewer` is dead code, not "used by ViewRoutingModal".
> Anchor `#cost-calculation-from-routing` is linked from [quotes.md](quotes.md) and preserved.

# Routings Module

## Overview

A routing is a **linear, reorderable list of operations** describing how a part is
manufactured. Each part has **exactly one** routing (1:1, `routings.part_id` UNIQUE).

**Priority:** Must Have (build after Work Centers, before Jobs). **Dependencies:** Parts
(routing lives on the part page), Work Centers (`routing_operations.work_center_id`),
Parts/BOM (materials live on the part). **Tables:** `routings`, `routing_operations`.

| Term | Meaning |
|---|---|
| **Routing** | The ordered operation list for one part |
| **Routing Operation** | One step (`routing_operations`), positioned by `sequence`, pointing at a work center |
| **Sequence** | Integer execution order, saved in steps of 10 so rows insert between existing ones without renumbering |
| **Work Center** | Where the step runs. **Internal** = in-house, priced by time at an hourly `labor_rate`. **External** = outsourced to a vendor, priced by a per-unit `external_unit_price`. Owned by [work-centers.md](work-centers.md); the routing only references one and reads its kind to decide how to cost the step. |
| **BOM (materials)** | Bill of materials, on the **part** (`parts_bom`), **not** the routing — see [parts.md](parts.md) |

**No dedicated routes.** Routings are edited inline on `/dashboard/{companyId}/parts/{partId}`.
There is no standalone routings page, no `/routing/new`, no `/routing/edit`, and no sidebar
entry.

---

## Superseded mechanics

Each of these is **dead**; the row records why, so it does not get rebuilt.

| Dead mechanic | Replaced by | Why |
|---|---|---|
| `routing_materials` table (routing-level materials) | `parts_bom` on the part | One BOM per manufactured part; cost roll-up pulls material cost from BOM child parts, not a routing list. (An earlier *per-operation* materials model preceded the routing-level one — both are gone.) |
| `routing_nodes` table name | `routing_operations` | The UI is a list, not a canvas — hence no stored x/y position either |
| `routing_operations.external_setup_cost` column | nothing | External work bills once per part, so setup is internal-only. Dropped by `20260623022617_drop_external_setup_cost.sql`. **Still referenced by the importer — see [#549 below](#known-importer-bug-549).** |
| Server-side per-batch `sequence` auto-numbering on import | client-side `numberRoutingOpsInFileOrder` | It reset each 500-row batch, renumbering any part whose steps straddled a batch boundary. (Per-entity `/execute` keeps it as a fallback when called directly with no `sequence` mapping.) |
| Drag-and-drop reordering | up/down arrow buttons | DnD **was** built (`@dnd-kit/sortable`) and torn out in `03f4a76`: arrows are more familiar than drag for small-shop users |
| "Save Routing" button | auto-save on every change | Nothing to forget to click — a routing edited and left unsaved was lost work. See [Linear Routing Builder](#linear-routing-builder) |
| Modal add/edit (`AddOperationModal`) | inline editor row (`RoutingOperationRowEditor`) | Same one-screen field set without a cramped modal over the list |

---

## Linear Routing Builder

Edited inline via `components/parts/PartRoutingPanel.tsx`, mounted from
`components/parts/workspace/tabs/WorkspaceTab.tsx`. Shown only for **made** parts
(`part.source === 'made'`); bought parts have no routing. Materials are a separate
`PartBomPanel`.

- **Rows** (`components/routings/RoutingOperationRow.tsx`) — one line: work-center name +
  Internal/External chip + setup/run (or vendor price) as subtle text. Amber border when a
  field is merely missing; **red border + inline message** when the op can't be priced
  ("Missing labor rate…", "Missing pricing…"). Reorder with up/down arrows. Pencil edits in
  place; trash deletes behind a **"Remove operation?"** confirm — the removal is otherwise
  silent and unrecoverable.
- **Add** — expands an **inline editor row** (`RoutingOperationRowEditor`) at the bottom, not
  a modal: work center + its time/price fields on one screen.
- **Work center is locked in edit mode** (`disabled={isEdit}` on the Autocomplete). Changing
  which work center a step uses = delete + re-add.
- **Internal vs external fields** — internal: setup minutes, cycle minutes per unit, optional
  labor-rate override (pre-filled from the work center default). External: per-unit vendor
  price, **no setup**. At least one of setup/cycle (internal) or a unit price (external) is
  required to save.
- **Auto-save** — every row save, reorder, or delete persists the whole list via
  `saveRoutingWithOperations` ([`utils/routingsAccess.ts`](../../utils/routingsAccess.ts)),
  then refetches so temp IDs become real DB IDs. `components/common/SaveStatus.tsx` shows
  "Saving…" / "All changes saved". The first add implicitly creates the `routings` row, named
  `Routing - {part_name}`.
- **Part recency** — each write bumps the owning part's `updated_at` via AFTER triggers
  (`20260720191253_touch_parts_updated_at_on_satellite_writes.sql`), so a just-edited part
  rises in the recency-sorted parts list and picker. See [parts.md](parts.md).
- **No minimum** — zero operations saves fine (it just won't be useful for jobs); the cost
  breakdown emits `no_operations`. A made part with **no routing at all** is different: it
  hard-blocks job creation — `createJobFromPurchaseOrder` ([`utils/jobsAccess.ts`](../../utils/jobsAccess.ts))
  throws *"No routing defined for N made parts. Add a routing on the part before creating a
  job from a PO."*

**Gap:** `components/routings/RoutingViewer.tsx` is exported from the barrel but imported
nowhere — dead read-only component. *(CLAUDE.md's `components/routings/` map is stale: of the
8 files it lists, only `RoutingOperationsList` / `RoutingOperationRow` / `RoutingViewer`
exist — `RoutingBuilder`, `RoutingMaterialsList`, `RoutingMaterialRow`, `AddOperationModal`,
`AddMaterialModal` are all gone, and the `ViewRoutingModal` it claims uses `RoutingViewer`
exists in no source file.)*

---

## Execution Order

Operations run one after another in ascending `sequence` (10 → 20 → 30). Total estimated
time = Σ setup + (run time per unit × quantity).

**There is no DAG, no edges, no parallel branches, and no dependency graph.** If two
operations "run in parallel" in real life, that is shop-floor scheduling at the job/operator
level, not routing structure.

---

## Data Model

### `routings`

| Column | Type | Req | Notes |
|---|---|---|---|
| id | uuid | Yes | PK |
| company_id | uuid | Yes | FK companies |
| part_id | uuid | Yes | FK parts — `routings_part_id_unique` (one routing per part) |
| name | text | Yes | Auto-generated `Routing - {part_name}`; no separate uniqueness constraint (the `part_id` UNIQUE already caps a part at one) |
| description | text | No | Free text |
| created_by | uuid | No | |
| created_at / updated_at | timestamptz | No | DEFAULT `now()` |

### `routing_operations`

| Column | Type | Req | Notes |
|---|---|---|---|
| id | uuid | Yes | PK |
| routing_id | uuid | Yes | FK routings |
| work_center_id | uuid | Yes | FK work_centers |
| sequence | integer | Yes | Linear order, steps of 10. DEFAULT 0. `routing_operations_routing_sequence_unique (routing_id, sequence)` |
| setup_minutes | numeric(8,2) | No | Internal. DEFAULT 0 |
| cycle_minutes_per_unit | numeric(8,4) | No | Internal |
| labor_rate_override | numeric(10,2) | No | Internal; overrides the work center's `labor_rate` for this step |
| external_unit_price | numeric(12,4) | No | External, per unit |
| instructions | text | No | |
| metadata | jsonb | No | DEFAULT `{}` |
| created_at / updated_at | timestamptz | No | DEFAULT `now()` |

**Reorder invariant.** The unique `(routing_id, sequence)` would trip mid-reorder, so
`saveRoutingWithOperations` does a **two-phase update**: park existing rows at sequences
100000+, then assign final values. No intermediate duplicate ever exists.

---

## Validation Rules

- One routing per part (`routings_part_id_unique`).
- Sequence unique within a routing (`routing_operations_routing_sequence_unique`).
- An operation must be priceable to save: internal needs setup **or** cycle time (plus a
  labor rate, from the work-center default or a per-step override); external needs a per-unit
  price.

---

## Bulk Import (CSV)

FastAPI pipeline (`api/routes/routings_import_routes.py`, prefix `/api/routings/import`) —
sanctioned as backend because it does AI column mapping + multi-step conflict detection.
Three-step handshake:

| Step | Does |
|---|---|
| `POST /analyze` | Reads headers/sample rows, AI-proposes which column feeds which `routing_operations` field (work center, setup/cycle time, labor-rate override, external unit price, instructions), returns the mapping to confirm |
| `POST /validate` | Applies the confirmed mapping to every row, resolves work centers, runs per-kind field validation, reports per-row conflicts (`unknown_work_center`, invalid numerics, external-field-on-internal, …) — **writes nothing** |
| `POST /execute` | Creates one `routings` row per part and **upserts** `routing_operations` on `(routing_id, sequence)` |

- **One CSV row per operation**, grouped by `part_name`.
- **Idempotent re-import.** Upserting on `(routing_id, sequence)` means re-importing the same
  file updates steps in place; the response reports `imported_operations_count` (new) vs
  `updated_count`. The existing-operation lookup is **paged past PostgREST's 1000-row cap** —
  unpaged, it saw only the first 1000, so a re-import of thousands of ops fell through to a
  plain insert and 500'd the batch (the "N errors" a full re-import used to show).
- **Sequence when the CSV has no step-order column.** A stable `sequence` is what makes the
  upsert idempotent. A mapped step/operation-number column is used directly; otherwise
  `lib/dataImportIngest.ts` → `numberRoutingOpsInFileOrder` numbers each part's operations by
  their order across the **whole file**, on the client, *before* the 500-row batch split
  (`BATCH_SIZE = 500`), and sends an explicit `sequence`. The Review step shows a
  `sequence_inferred` info notice (`lib/dataImportAnalyzer.ts`) pointing at the Map step.
- **Work-center resolution** — `work_center_name` matched against existing `work_centers`.
  Rows with no name fall back to a work center literally named `MISCELLANEOUS`
  (case-insensitive) if one exists, else fail as `unknown_work_center`. Work centers are
  **not** auto-created — import work centers first.
- **Per-kind field validation** — allowed cost fields follow the resolved work center's kind:
  internal → `setup_minutes` / `cycle_minutes_per_unit` / `labor_rate_override`; external →
  `external_unit_price`. An external-only field on an internal row is rejected.

### Known importer bug (#549)

> **Known importer bug (#549):** the import pipeline (`api/routes/routings_import_routes.py`,
> `api/models/routings_import_models.py`) still maps and validates an `external_setup_cost`
> field, but that column was dropped from `routing_operations` (migration
> `20260623022617_drop_external_setup_cost.sql` — external work bills once per part, so setup
> is internal-only). The stale importer reference is tracked in #549.

Still true as of 2026-08-03: the column is absent from `types/database.ts` and
`supabase/migrations/`, yet the importer maps, validates
(`invalid_external_setup_cost`), and writes it. The covering test mocks Supabase, so it
passes on a column that does not exist. The same stale reference also survives in
`api/routes/parts_import_routes.py`, `api/services/insights_service.py`,
`api/tools/metric_tools.py`, and `api/tools/schema_context.py` — the last two feed the AI's
schema context, so the model is told about a dropped column.

---

## Materials

Materials are **not** routing-attached. BOM lines are `parts_bom` rows on the part (child
part + quantity + unit), edited by `PartBomPanel` — see [parts.md](parts.md). At job
creation each line snapshots into `job_materials`; edits/deletes never retro-update existing
jobs, and deleting the source line NULLs the snapshot's FK
(`job_materials_parts_bom_id_fkey ON DELETE SET NULL`). Full snapshot semantics:
[jobs.md — Material Tracking](jobs.md#material-tracking).

---

## Cost Calculation from Routing

The routing is the **source of truth for a part's cost** whenever it has one.
`calculateRoutingCost(partId, qty = 1)`
([`utils/routingCostCalculation.ts`](../../utils/routingCostCalculation.ts)) rolls a part's
routing operations up with its `parts_bom` materials into a per-unit breakdown that feeds
quoting. Returns `null` when the part has **neither** a routing **nor** a BOM. A non-finite
or ≤ 0 `qty` is coerced to 1 (`safeQty`).

### Labor & operation cost

```
# Internal (priced by time)
labor_rate = labor_rate_override ?? work_center.labor_rate     # $/hour
run_cost   = (cycle_minutes_per_unit / 60) × labor_rate        # per unit
setup_cost = (setup_minutes / 60) × labor_rate                 # one-time per batch

# External (priced by unit)
op_cost    = external_unit_price                               # per unit; no setup
```

Setup is collected separately in `total_setup_cost` and is **not** amortized at this layer —
callers such as `calculateTierPricing` divide it by the tier quantity.

### Material cost

*(This doc previously stated `total_material_cost = Σ (bom_line.quantity ×
child_part.cost_per_unit)`. That predates yield/batch-pinning costing: the code never reads
`cost_per_unit` here, and unit conversion, whole-unit ceiling, and made-child batch pinning
all move the number. Corrected 2026-08-03 against `utils/routingCostCalculation.ts`.)*

Per BOM line, summed:

```
qty_in_primary  = bom.quantity × conversion(child, bom.unit → child.primary_unit)
                  # empty bom.unit is treated as already-primary
units_consumed  = consume_whole_units ? ceil(qty × qty_in_primary)   # discrete stock
                                      : qty × qty_in_primary
child_val_qty   = child.source == 'made' ? (child.costing_batch_quantity ?? 1)  # pinned to
                                         : units_consumed                      # the lot size
child_unit_cost = compute_part_cost_at_qty(child.id, child_val_qty)

line_cost_per_parent_unit =
    (!consume_whole_units && child.source != 'made')
      ? qty_in_primary × child_unit_cost            # LEGACY expression, kept textually
                                                    # identical so pre-existing BOM lines
                                                    # stay byte-identical
      : (units_consumed × child_unit_cost) / qty
```

A **made** child is valued at its standard-costing lot size (the run its cost amortizes
over), fixed regardless of order size; a **bought** child at what is actually consumed
(procurement tier / floor). This mirrors `compute_part_cost_at_qty` exactly — including
sub-assembly setup, which that function amortizes as `setup_minutes / p_qty`, i.e. over
`child_val_qty` (the child's pinned lot size when made), **not** over the parent's quantity.

If **any** BOM line can't be priced, `materials_complete = false` and both
`total_material_cost` and `total_cost` become `null` (mirroring SQL NULL propagation), so
the UI can never render a tier built on a silently-missing material.

### Total cost

```
total_cost = total_labor_cost + total_material_cost      # null if materials incomplete
```

*(Corrected 2026-08-03: every prior revision wrote `+ total_setup_cost` into this line, which
contradicted the "setup is not amortized at this layer" rule above it.
`utils/routingCostCalculation.ts` sums **run labor + materials only**; setup rides along in
`total_setup_cost` for the caller to amortize. Adding it here would double-count it against
`calculateTierPricing`.)*

### Edge cases

| Scenario | Behavior |
|---|---|
| Internal op with no `cycle_minutes_per_unit` and no `setup_minutes` | Skip — `empty_operation` warning |
| Internal op with setup but no cycle time (e.g. Engineering) | First-class — `run_cost = 0`, `setup_cost > 0`; setup amortizes across tier quantity |
| Internal op whose work center has no `labor_rate` and no override | Skip — `missing_labor_rate` |
| External op with no `external_unit_price` | Skip — `missing_external_pricing` |
| BOM line whose unit ≠ child's `primary_unit` with no `parts_unit_conversions` row | `missing_material_cost`; `materials_complete = false` |
| BOM child with no priced cost (or a cost lookup that throws) | `missing_material_cost` carrying `child_part_id` / `child_part_name` / deepest offending leaf hint (via the explain RPC) so the BOM panel can link it; `materials_complete = false` |
| Part has no BOM lines | $0 material cost. Normal — no warning |
| Routing has 0 operations | $0 labor — `no_operations` |
| Any warnings present | One "Heads up:" `Alert` above the **Cost** card (`components/parts/PartPricing.tsx`); `missing_material_cost` renders the child part name as a link, other types as plain text (they point at no navigable target) |

Warnings are informational — they do **not** block quote creation. The user can proceed with
incomplete cost data and enter a manual override.

### Integration with Parts and Quotes

- **Parts** — drives the live **Cost** card on the part page (`components/parts/PartPricing.tsx`
  — *this doc previously named a `PartCostBreakdown` component and a "Cost Breakdown" card;
  neither exists, and a stale comment in `PartRoutingPanel.tsx` still says so*).
  `calculateRoutingCost(partId)` recomputes on load and after every routing auto-save. Each
  `part_pricing_tier` derives its `base_cost_per_unit` and `unit_price` from it, so routing
  edits propagate to all tiers — **no Recalculate button**.
- **Quotes** — at `createQuote`, per-part cost snapshots (`quote_operations`,
  `quote_materials`) are written once per distinct part so the breakdown survives later
  routing edits. See [quotes.md — Snapshotted Line Items](quotes.md#quote_line_items).

---

## Acceptance Criteria

Verification citations are **file + `describe`/class**, never an `it`/test title (those rot —
the previous revision cited an E2E test title that had already drifted). Every editable
entity carries at least one **edit → save → reload → persists** row, even where that row is
still automation-pending. Doc-vs-code divergences from the earlier audit are on issue #339.

**A** = `__tests__/utils/routingsAccess.test.ts` › `routingsAccess`.
**C** = `__tests__/utils/routingCostCalculation.test.ts`.
**I** = `api/tests/integration/test_routings_import_api.py`.

| Behaviour | Verified by |
|---|---|
| Fetch by id returns the row (joined part); missing id returns `null` on PGRST116 not a throw; other errors throw | **A** › `getRouting` (3 it) |
| Summary returns op count + Σ `cycle_minutes_per_unit`; `null` when the part has no routing (not an empty shell); `null` total when the sum is zero | **A** › `getRoutingSummaryForPart` (3 it) |
| First operation on a made part creates the routing implicitly and persists; blank setup saves as `0`, instructions trimmed, numerics parsed | **A** › `createRoutingOperation` (1 it); e2e `e2e/parts-and-routing.spec.ts` › `Parts and Routing workflow` (1 test) |
| Operation delete by id, and a DB error throws a friendly message rather than silently succeeding; routing delete by id cascades its operations | **A** › `deleteRoutingOperation` (2 it), `deleteRouting` (1 it) |
| Internal ops price cycle + setup at the work-center `labor_rate`; `labor_rate_override` wins; `missing_labor_rate` + `empty_operation` emit | **C** › `calculateRoutingCost` › `internal operations` (4 it) |
| External ops price per-unit with zero setup; `missing_external_pricing` with no price | **C** › `calculateRoutingCost` › `external operations` (2 it) |
| Mixed kinds sum correctly | **C** › `calculateRoutingCost` › `mixed internal + external routings` (1 it) |
| Zero operations emits `no_operations`; neither routing nor BOM returns `null` | **C** › `calculateRoutingCost` › `routing edge cases` (1 it), `returns null when there is nothing to cost` (1 it) |
| BOM child cost rolls into `total_material_cost`; unit fallbacks; `missing_material_cost` blanks base + unit price via `materials_complete = false` | **C** › `calculateRoutingCost` › `BOM materials` (7 it), `combined routing + BOM` (1 it) |
| Yield: whole-unit ceiling, made-child batch pinning, fractional-unpinned legacy path unchanged, documented diamond-BOM over-consumption limit | **C** › `calculateRoutingCost — yield / ceiling / batch pinning` (8 it) |
| Setup amortizes across tier quantity; qty ≤ 0 → 1; `null` unit price when markup is null; per-unit base qty-invariant apart from setup | **C** › `calculateTierPricing` (4 it) |
| Validate: happy path groups ops; unknown work center fails; `MISCELLANEOUS` routes when present, fails when absent; external-only field on an internal row rejected | **I** › `TestRoutingsValidate` (5 tests) |
| Execute: internal `labor_rate_override` written; external cost fields used; re-import upserts `(routing_id, sequence)` instead of 500-ing | **I** › `TestRoutingsExecute` (3 tests) — the external test asserts `external_setup_cost`, the dropped column ([#549](#known-importer-bug-549)) |
| Bought parts show no routing panel | manual: `WorkspaceTab.tsx` (`showRoutingPanel = part.source === 'made'`) |
| Work-center picker locked in edit mode | manual: `RoutingOperationRowEditor` (`disabled={isEdit}`); `RoutingOperationsList.handleEditorSave` never rewrites `workCenterId` in the edit branch |
| No standalone routings page or `/routing/new`\|`/routing/edit` route | manual: no routings dir under `app/dashboard/[companyId]/`; `PartRoutingPanel` is the only editor |
| Auto-save recomputes the part's Cost card + pricing tiers (no Recalculate button) | manual: `PartRoutingPanel.onRoutingSaved` refreshes the parent; `calculateRoutingCost(partId)` is called by `components/parts/PartPricing.tsx` and `utils/partPricingTiersAccess.ts` |
| Edit → save → **reload** → persists | **automation-pending (#367)** — the E2E asserts add-then-persist only. Write path is `saveRoutingWithOperations`, which applies `updateRoutingOperation`'s semantics inline (the standalone `updateRoutingOperation` export is not what the panel calls) |
| Reorder persists without tripping `(routing_id, sequence)` | **automation-pending (#367)** (`saveRoutingWithOperations`) |
| "Remove operation?" confirm gates the delete | **automation-pending (#367)** (`RoutingOperationsList`) |
| Row-level "Missing labor rate" / "Missing pricing" inline copy renders | **automation-pending (#367)** (`RoutingOperationRow`) — the cost-side warnings are covered above |
