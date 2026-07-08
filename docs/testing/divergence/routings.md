# Divergence report — Routings (#339)

Method: compared `docs/modules/routings.md` against the live schema (`supabase/schema.prod.sql`), the access layer (`utils/routingsAccess.ts`, `utils/routingCostCalculation.ts`), the UI (`components/routings/*`, `components/parts/PartRoutingPanel.tsx`, `components/parts/workspace/tabs/WorkspaceTab.tsx`), the FastAPI import pipeline (`api/routes/routings_import_routes.py`), and the tests (`__tests__/utils/routingsAccess.test.ts`, `__tests__/utils/routingCostCalculation.test.ts`, `e2e/parts-and-routing.spec.ts`, `api/tests/integration/test_routings_import_api.py`).

## Fixed in this PR

- **Table renamed `routing_nodes` → `routing_operations`.** Doc said the operation-step table was `routing_nodes` throughout (Terminology, Dependencies, Data Model). Schema has `routing_operations` (schema comment: "Renamed from routing_nodes"). Renamed everywhere and noted the former name.

- **`routing_materials` table removed; materials are now part-attached (`parts_bom`).** Doc had a whole `routing_materials` table, a "Routing Materials" section, a materials list in the builder, and material snapshotting from the routing. The table no longer exists (schema comment: "Replaces routing_materials — BOM is now part-attached"). Rewrote the Data Model, the materials section (now "Materials — part-attached BOM"), the builder description, Dependencies, and the cost roll-up to source materials from `parts_bom` child parts.

- **Operations reference a `work_center`, not an `operation_type`.** Doc's FK was `operation_type_id → operation_types` and cost used `operation_type.labor_rate`. Real FK is `work_center_id → work_centers`; internal work centers carry `labor_rate` (with an optional per-op `labor_rate_override`), external ones price by a per-unit `external_unit_price`. Fixed the column, the Terminology, the cost formulas, and the edge-case table.

- **Operation column names.** `setup_time` → `setup_minutes` (numeric(8,2)); `run_time_per_unit` → `cycle_minutes_per_unit` (numeric(8,4)). Added the real extra columns: `labor_rate_override`, `external_unit_price`, `metadata`. Added the `routings` columns the doc omitted (`description`, `created_by`, `created_at`, `updated_at`).

- **Save function name.** Doc referenced `saveRoutingWithOperationsAndMaterials`; the actual (post-materials-removal) function is `saveRoutingWithOperations` (`utils/routingsAccess.ts`). Fixed.

- **Components list was wrong.** Doc listed `RoutingBuilder`, `RoutingMaterialsList`, `RoutingMaterialRow`, `AddOperationModal`, `AddMaterialModal` — none exist. Real components: `RoutingOperationsList`, `RoutingOperationRow`, `RoutingOperationRowEditor`, `RoutingViewer` (+ `index.ts`) and `components/parts/PartRoutingPanel.tsx` (mounted from `WorkspaceTab.tsx`). Fixed the list.

- **"Add Operation opens a modal" → inline editor row.** Both the code (`RoutingOperationsList` expands `RoutingOperationRowEditor` in place) and the E2E spec ("opens an inline editor row … no dialog") confirm there is no modal. Fixed the builder prose and the user story.

- **"dragging to reorder" (Overview).** Overview said users drag to reorder; the builder uses up/down arrow buttons only (no drag-and-drop) — the builder section already said so, but the Overview contradicted it. Fixed.

- **Delete is behind a confirm dialog.** Doc implied a bare trash click. `RoutingOperationsList` gates deletion behind a "Remove operation?" dialog (the removal is otherwise silent/unrecoverable). Noted in the builder prose and AC.

- **Work center is locked in edit mode.** Doc said each row "supports inline editing of the operation type." The editor disables the work-center picker when editing an existing row (`disabled={isEdit}`); changing it requires delete + re-add. Added.

- **Routing name uniqueness claim.** Doc's Validation Rules said the auto-generated name "must be unique within the company." There is no such constraint — only `routings_part_id_unique`. Also the name is derived from `part_name` (`Routing - {part_name}`), not the part number. Corrected the rule and the Data Model example.

- **Cost edge-case table + setup handling.** Rewrote the table to match `calculateRoutingCost`: internal empty-op → `empty_operation`; internal no-rate → `missing_labor_rate`; external no-price → `missing_external_pricing` (was missing entirely); BOM child unpriced → `missing_material_cost` with `materials_complete = false` nulling the totals; zero ops → `no_operations`. Setup now lives in a separate `total_setup_cost` (not amortized at this layer). Also noted the `qty` parameter and the "returns null when no routing AND no BOM" behavior.

## Resolved (owner decision)

- **Work-centers framing — add a short explainer + link.** The module's conceptual center of gravity moved from "operation types" to "work centers" (internal machine priced by time, or external vendor priced per unit). **Decision:** the Routings doc keeps a short "Work centers" explainer paragraph stating that a routing operation runs AT a work center, and links to [`docs/modules/work-centers.md`](../../modules/work-centers.md) (which owns creation, the internal/external split, and vendor linkage). Added as a "### Work centers" subsection under the Overview; the concept remains owned by the Work Centers module and is only referenced here.

- **Routing CSV import subsystem — document it.** `api/routes/routings_import_routes.py` (prefix `/api/routings/import`, `POST /analyze` → `/validate` → `/execute`, AI column mapping, `MISCELLANEOUS` fallback, per-kind field validation) is registered (`api/index.py`) and covered by `api/tests/integration/test_routings_import_api.py`. **Decision:** document it in the Routings module doc. The "Bulk Import (CSV)" section now describes the real three-endpoint flow and behavior, and the AC section already cites the integration tests. (The dedicated front-end import UI entry is out of scope for this doc — the backend + tests are the documented contract.)

- **`external_setup_cost` prose bug (importer #549).** The doc's Bulk Import section listed `external_setup_cost` as a valid external field. That column was **dropped** from `routing_operations` by migration `20260623022617_drop_external_setup_cost.sql` (external work bills once per part → setup is internal-only); the only external cost field is `external_unit_price`. Removed `external_setup_cost` from the field list and added a note that the stale importer reference (`routings_import_routes.py`, `routings_import_models.py`, still mapping/validating the dropped field) is tracked in **#549**.

## Decision needed

- _None outstanding._ Both items previously listed here have been resolved by owner decision (see above).

## Informational / aligned

- **1:1 part↔routing, inline-on-part-page, auto-save, no standalone routings page.** All still accurate and confirmed by `routings_part_id_unique`, `PartRoutingPanel`, and the absence of any `routings` dir under `app/dashboard/[companyId]/`.

- **Linear-only, no DAG / edges / parallel branches.** Still accurate (PRD FR-11 + Q7 resolution); `sequence` in steps of 10 with a `(routing_id, sequence)` unique constraint and a two-phase re-sequence on reorder — all confirmed in `saveRoutingWithOperations`.

- **Routing panel only renders for made parts.** `WorkspaceTab.tsx` gates `PartRoutingPanel` on `part.source === 'made'`; captured in an AC bullet.

- **Cost integration with Parts/Quotes.** `calculateRoutingCost(partId)` feeding `PartCostBreakdown` and pricing tiers (no Recalculate button), and quote-time snapshots (`quote_operations`, `quote_materials`), are consistent with the code; left as-is aside from the operation-model fixes above.
