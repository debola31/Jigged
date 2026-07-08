# Inventory Module

## Overview

Phase 0 Inventory module providing basic inventory tracking with flexible units of measure and full transaction history. This module enables operators to log material consumption during job completion and provides owners with visibility into stock levels.

**PRD Requirements Addressed:**

- **FR-1 (Must): Flexible Inventory Units** - Multiple units per item with automatic conversion

- **FR-2 (Should): Reorder Alerts** - _Partially delivered._ Visual low-stock status only (In stock / Low / Out of stock, derived from `quantity` + `reorder_point`); threshold email notifications and a dashboard alert list are **pending**. The low-stock / reorder-point implementation is being brought behind the `inventory_transactions` feature flag — reorder-point / low-stock status must not render for a company without that flag. This gating is **Planned (see #550)** and is **not yet built**: the `inventory_transactions` flag does not exist in `lib/featureFlags.ts` today, so status currently shows unconditionally.

- **FR-13 (Should): Transaction History** - Full audit trail of all inventory changes

**Planned (behind the `inventory_transactions` feature flag — see #550):**

- Per-job material *consumption tracking* (operator marks a job's materials consumed → auto-depletion linked to the job). This is a **gap**, not shipped: `job_materials` carries only `expected_quantity`/`unit` today (no `status`/`actual_quantity`/`consumed_at`/`consumed_by`), and depletion is currently a deliberate manual stock transaction. See #550 and the Material Consumption Flow section.

- Reorder-point / low-stock status **gating** behind this flag (see FR-2 above).

## Dependencies

- **Parts module** - Stockable inventory items are `parts` rows with `is_stocked = true`. Inventory is not a separate item table (see Data Model).

- **BOM (parts_bom)** - `parts_bom` defines the materials (child parts) that a manufactured part consumes. The BOM is part-attached (one BOM per made part), not routing-attached.

- **Jobs module** - `job_materials` snapshots a made part's BOM at job creation.

**Build Order:**

1. Inventory module (marks `parts` as `is_stocked`, tracks on-hand `quantity` and `inventory_transactions`)

2. Parts / BOM (defines `parts_bom` — the child-part materials for each made part)

3. Jobs module (creates jobs; `create_job_part_operations_from_routing()` snapshots each `parts_bom` row into `job_materials`)

**Material Definitions:**

- Materials are the `parts_bom` edges of a manufactured part (see Parts / BOM). Each edge references a `child_part_id`, a `quantity`, and a `unit`.

- `parts_bom` is a dedicated relational table — there is no JSONB column for materials.

---

## User Stories

**Owner Stories:**

- As an owner, I want to add inventory items with primary and secondary units so I can track materials in any unit

- As an owner, I want to view current stock levels so I know what materials are available

- As an owner, I want to manually adjust inventory quantities so I can correct errors or record receipts

- As an owner, I want to view transaction history for any item so I have a full audit trail

- As an owner, I want to export inventory and transaction reports so I can analyze usage patterns

**Operator Stories:**

- As an operator, I want to log materials used when completing an operation so inventory stays accurate

---

## Data Model

There is **no** standalone `inventory_items` table. Stockable inventory items are `parts` rows flagged `is_stocked = true` — the `parts` table is the unified item master that replaced the former split between manufacturable parts and stockable inventory items. Unit conversions live in `parts_unit_conversions`. Only the ledger table (`inventory_transactions`) still carries the `inventory_` prefix.

### parts (stocked subset)

Inventory items are the subset of `parts` with `is_stocked = true`. Relevant columns (see the Parts module for the full table):

| Column | Type | Required | Description |
|---|---|---|---|
| id | uuid | Yes | Primary key |
| company_id | uuid | Yes | FK to companies |
| part_name | text | Yes | Item name (e.g., "4140 Steel Bar") |
| description | text | No | Optional description |
| is_stocked | boolean | Yes | `true` marks the part as tracked inventory |
| source | text | Yes | `bought` or `made` (both can be stocked) |
| primary_unit | text | Yes | Primary unit of measure (e.g., "lbs"); a CHECK requires it to be non-null |
| quantity | numeric | Yes | Current quantity on hand in `primary_unit` (CHECK: >= 0) |
| reorder_point | numeric | No | Low-stock threshold used to derive stock status |
| is_location_tracked | boolean | Yes | When true, on-hand is split across `part_location_stock` rows |
| created_at | timestamptz | Yes | Record creation |
| updated_at | timestamptz | Yes | Last update |

### parts_unit_conversions

Secondary units with conversion factors to the part's primary unit. Enables FR-1 (Flexible Inventory Units). Replaces the former `inventory_unit_conversions`.

| Column | Type | Required | Description |
|---|---|---|---|
| id | uuid | Yes | Primary key |
| part_id | uuid | Yes | FK to parts |
| from_unit | text | Yes | Secondary unit (e.g., "inches") |
| to_primary_factor | numeric | Yes | Multiply by this to get primary units (CHECK: > 0) |

**Example:** Steel bar tracked in lbs (primary). from_unit: "inches", to_primary_factor: 0.166 means 1 inch = 0.166 lbs. (Standard same-category units are auto-available in the transaction modal; `parts_unit_conversions` only stores custom / cross-category factors.)

### inventory_transactions

Full audit trail of all stock changes. Enables FR-13 (Transaction History). The FK was renamed from `inventory_item_id` to `part_id` when the item tables were unified, and the row now snapshots `item_name` for audit purposes even after the part is deleted.

| Column | Type | Required | Description |
|---|---|---|---|
| id | uuid | Yes | Primary key |
| company_id | uuid | Yes | FK to companies |
| part_id | uuid | No | FK to parts (nulled if the part is deleted) |
| item_name | text | Yes | Part name snapshot (survives part deletion) |
| type | text | Yes | "addition", "depletion", "adjustment" (CHECK-enforced) |
| quantity | numeric | Yes | Amount changed (positive value; CHECK: >= 0) |
| unit | text | Yes | Unit used for this transaction |
| converted_quantity | numeric | Yes | Quantity in primary unit |
| job_id | uuid | No | FK to jobs (SET NULL on delete) |
| job_operation_id | uuid | No | FK to job_operations (SET NULL on delete) |
| operator_id | uuid | No | FK to operators (if operator action) |
| notes | text | No | Optional notes (editable post-hoc) |
| has_discrepancy | boolean | Yes | True when a graceful depletion clamped to zero (recorded usage exceeded on-hand) |
| location_id | uuid | No | FK to inventory_locations (location-tracked parts; SET NULL on delete) |
| location_name | text | No | Location name snapshot |
| transfer_group_id | uuid | No | Groups the two rows of a location-to-location transfer |
| created_at | timestamptz | Yes | Transaction timestamp |
| created_by | uuid | No | FK to users (if admin action) |

---

## UI Screens

Inventory has **no dedicated item detail/create/edit pages** — it is a filtered view over `parts`, and stock management lives on the part workspace. The `/inventory` route renders a list of stocked parts; everything else is the Parts UI.

### 1. Inventory List

**Route:** /dashboard/{companyId}/inventory (`app/dashboard/[companyId]/inventory/page.tsx`)

- AG Grid columns: Part Name, Description, Quantity, Status, Unit, Updated

- Status is derived at render time from `quantity` + `reorder_point` (In stock / Low / Out of stock) via `deriveStockStatus`; a Status filter narrows the grid client-side. _Currently shown unconditionally; **Planned (see #550)** to gate this reorder-point/low-stock status behind the `inventory_transactions` feature flag so it does not render for companies without the flag._

- Search by name and description (`getStockedParts`, `is_stocked = true`)

- "Add Item" button → `/dashboard/{companyId}/parts/new?source=bought&stocked=1&from=inventory` (create-mode part workspace, seeded stocked + bought)

- "Import" button → `/dashboard/{companyId}/parts/import`

- "Locations" button (only when the `inventory_locations` company feature is enabled) → `/dashboard/{companyId}/inventory/locations`

- Multi-select → bulk Delete and CSV Export (client-side, selection-scoped)

- Row click → `/dashboard/{companyId}/parts/{id}?from=inventory` (part workspace)

### 2. Part Workspace — Inventory Tab

**Route:** /dashboard/{companyId}/parts/{id} (Inventory tab; component `components/parts/workspace/tabs/InventoryTab.tsx`)

This tab replaces the old standalone item detail/edit screens.

- Current Stock (large display) + a "Below reorder point" chip when `quantity <= reorder_point` (this low-stock indicator is **Planned (see #550)** to be gated behind the `inventory_transactions` flag; it currently renders unconditionally)

- Non-location-tracked parts: Add Stock / Remove Stock / Adjust buttons open `PartTransactionModal`

- Location-tracked parts (`is_location_tracked = true`): the aggregate buttons are hidden and `PartLocationInventory` shows per-location balances with add/remove/adjust/transfer

- Unit conversions: inline-editable list (`PartUnitConversionsEditor`) writing `parts_unit_conversions`

- Transaction History table (`PartTransactionHistoryTable`): Date, Type, Quantity, Unit, Job/Operation, Notes; paginated via `getPartTransactions`; notes editable via `updateTransactionNotes`

Item identity fields (name, description, primary unit, reorder point, source) are edited on the part's Details tab, not here.

### 3. Add/Remove/Adjust Modal (`PartTransactionModal`)

Modal dialog for aggregate (non-location) stock changes.

- Select action type: Add / Remove / Adjust

- Quantity input (Adjust uses "New Quantity")

- Unit dropdown: primary + standard same-category units + custom `parts_unit_conversions`

- Live conversion preview and after-transaction on-hand preview; Remove is blocked when it would go negative

- Notes field

- On submit, calls `addPartStock` / `removePartStock` / `adjustPartStock` (auto-converts to primary unit, updates `parts.quantity`, writes an `inventory_transactions` row)

---

## API Architecture

### Direct Supabase Operations

All inventory operations use the Supabase client with RLS policies (no backend API needed):

- **List items:** `getStockedParts` — query `parts` where `is_stocked = true`, with RLS
- **Create item:** Insert into `parts` (`is_stocked = true`) with RLS (via the part workspace)
- **Update item:** Update `parts` with RLS
- **Delete item:** Delete from `parts` with RLS (hard delete; conversions cascade, transactions keep the `item_name` snapshot)
- **Add / remove / adjust stock:** `addPartStock` / `removePartStock` / `removePartStockGraceful` / `adjustPartStock` — update `parts.quantity` and insert an `inventory_transactions` row
- **Location stock (opt-in):** `addStockAtLocation` / `depleteStockAtLocation` / `adjustStockAtLocation` / `transferStock` — Postgres RPCs that update `part_location_stock`, roll up `parts.quantity`, and write `inventory_transactions`
- **Get transactions:** `getPartTransactions` — query `inventory_transactions` (joined to job/operation) with RLS; `updateTransactionNotes` edits notes
- **Export:** Client-side CSV generation from the fetched list (`ExportCsvButton`)

See `utils/partsAccess.ts` (stock + transaction functions) and `utils/inventoryLocationsAccess.ts` (location RPCs) for implementation details.

> **Note:** No FastAPI backend endpoints are needed for inventory CRUD operations. The Supabase client handles all data access with row-level security policies ensuring proper multi-tenant isolation.

---

## Acceptance Criteria

Each bullet is a Given/When/Then scenario carrying a verification clause — a pointer to the test that proves it, a manual procedure, or an explicit automation-pending tag. Every editable entity has at least one edit -> save -> reload -> persists bullet. Doc-vs-code disagreements this audit surfaced are recorded in the divergence report on issue #341.

**List, search & filter**

- [ ] **Given** the inventory list, **when** it loads, **then** it shows only `parts` with `is_stocked = true` (both bought materials and made sub-assemblies) with columns Part Name, Description, Quantity, Status, Unit, Updated — *write path verified by `__tests__/utils/partsAccess.test.ts > 'getAllParts' > 'returns parts for a company with routing data'` (shared `parts` read layer); the `is_stocked` filter is manual: `getStockedParts` in `utils/partsAccess.ts` (automation-pending)*.

- [ ] **Given** the list, **when** a user types in the search box, **then** rows are filtered by part name or description — *manual: `getStockedParts` `.or(part_name.ilike / description.ilike)`; cf. `__tests__/utils/partsAccess.test.ts > 'getAllParts' > 'applies search filter correctly'`*.

- [ ] **Given** a stocked part, **when** its quantity is 0, **then** its Status renders "Out of stock" (and "Low" at/below `reorder_point`, else "In stock") — *verified by `__tests__/components/inventory/StockStatusChip.test.tsx > 'deriveStockStatus' > 'returns "out" when quantity is 0, regardless of reorder point'` AND `__tests__/components/inventory/StockStatusChip.test.tsx > 'deriveStockStatus' > 'returns "low" when quantity > 0 but at or below the reorder point'` AND `__tests__/components/inventory/StockStatusChip.test.tsx > 'deriveStockStatus' > 'returns "in_stock" when quantity > reorder point'`*.

- [ ] **Given** the Status chip, **when** it renders for `status="out"`, **then** it reads "Out of stock" — *verified by `__tests__/components/inventory/StockStatusChip.test.tsx > 'StockStatusChip' > 'renders "Out of stock" label for status="out"'`*.

**Create**

- [ ] **Given** the inventory list, **when** a user clicks "Add Item", **then** they land on the part workspace create route seeded stocked + bought (`/parts/new?source=bought&stocked=1&from=inventory`) — there is no `/inventory/new` route — *manual: navigation target in `app/dashboard/[companyId]/inventory/page.tsx`; part insert covered by `__tests__/utils/partsAccess.test.ts > 'createPart' > 'inserts part and returns data'`*.

**Edit (edit -> save -> reload -> persists)**

- [ ] **Given** an existing stocked part, **when** an owner edits item fields (name, description, reorder point) on the part Details tab and saves, **then** reloading shows the new values — *write path verified by `__tests__/utils/partsAccess.test.ts > 'updatePart' > 'updates part and returns data'`; reload-persistence E2E automation-pending (#367)*.

- [ ] **Given** a stocked part, **when** an owner adds a secondary unit + conversion factor and saves, **then** reloading the Inventory tab shows the conversion and it is offered in the transaction modal's unit dropdown — *write path automation-pending (`upsertPartUnitConversions` / `PartUnitConversionsEditor` writing `parts_unit_conversions`); reload-persistence E2E automation-pending (#367)*.

- [ ] **Given** a stocked part, **when** an owner adds stock in the primary unit via the transaction modal, **then** reloading shows `parts.quantity` increased and a new `addition` row in the history — *write path automation-pending (`addPartStock`); reload-persistence E2E automation-pending (#367)*.

- [ ] **Given** a stocked part, **when** an owner removes stock, **then** `parts.quantity` decreases and a `depletion` row is written — *write path automation-pending (`removePartStock`); reload-persistence E2E automation-pending (#367)*.

- [ ] **Given** a stocked part, **when** an owner adjusts to a specific quantity (e.g. after a physical count), **then** `parts.quantity` is set to that value and an `adjustment` row records the delta — *write path automation-pending (`adjustPartStock`); reload-persistence E2E automation-pending (#367)*.

- [ ] **Given** a transaction in the history, **when** a user edits its notes, **then** reloading shows the updated note — *write path automation-pending (`updateTransactionNotes`); reload-persistence E2E automation-pending (#367)*.

**Flexible units (FR-1)**

- [ ] **Given** a part with a secondary unit, **when** a user records a transaction in that unit, **then** the system converts to the primary unit before updating `parts.quantity` and stores `converted_quantity` — *conversion at a location verified by `__tests__/utils/inventoryLocationsAccess.test.ts > 'RPC wrappers' > 'addStockAtLocation applies a custom unit conversion to the converted quantity'`; aggregate `addPartStock`/`removePartStock` conversion automation-pending*.

- [ ] **Given** any transaction, **when** the quantity is displayed, **then** on-hand is shown in the part's primary unit — *manual: `InventoryTab` renders `part.quantity` + `part.primary_unit`*.

**Delete**

- [ ] **Given** a stocked part not referenced by quotes/jobs/BOMs, **when** a user deletes it, **then** it is permanently removed (hard delete) and its `inventory_transactions` remain with `item_name` preserved — *write path verified by `__tests__/utils/partsAccess.test.ts > 'deletePart' > 'deletes part by ID'`; FK-guard message by `__tests__/utils/partsAccess.test.ts > 'deletePart' > 'throws user-friendly error on FK constraint violation'`*.

- [ ] **Given** several selected stocked parts, **when** a user bulk-deletes, **then** all are removed (or a friendly FK error is shown) — *verified by `__tests__/utils/partsAccess.test.ts > 'bulkDeleteParts' > 'deletes multiple parts by IDs'` AND `__tests__/utils/partsAccess.test.ts > 'bulkDeleteParts' > 'throws user-friendly error on FK constraint violation'`*.

**Transaction history (FR-13)**

- [ ] **Given** a stocked part, **when** a user opens its Inventory tab, **then** the history lists transactions newest-first with type, quantity, unit, linked job/operation, and notes, paginated — *manual: `getPartTransactions` in `utils/partsAccess.ts` (order `created_at` desc, `range` pagination) rendered by `PartTransactionHistoryTable` (automation-pending)*.

- [ ] **Given** the inventory list with rows selected, **when** a user clicks Export, **then** a CSV of the selected rows downloads client-side — *manual: `ExportCsvButton` on `app/dashboard/[companyId]/inventory/page.tsx` (automation-pending)*.

**Location-tracked inventory (opt-in `inventory_locations` feature)**

- [ ] **Given** a location-tracked part, **when** balances are read, **then** each `part_location_stock` row is joined to its location with the full location path — *verified by `__tests__/utils/inventoryLocationsAccess.test.ts > 'getBalancesForPart' > 'joins each balance to its location and computes the full path'`*.

- [ ] **Given** a location-tracked part, **when** stock is depleted at a location, **then** the RPC forwards the graceful flag and job tag and returns the discrepancy result — *verified by `__tests__/utils/inventoryLocationsAccess.test.ts > 'RPC wrappers' > 'depleteStockAtLocation forwards graceful flag, job tag, and discrepancy result'`*.

- [ ] **Given** a location-tracked part, **when** stock is adjusted at a location, **then** the RPC is called with the newly-converted quantity — *verified by `__tests__/utils/inventoryLocationsAccess.test.ts > 'RPC wrappers' > 'adjustStockAtLocation calls adjust with the new converted quantity'`*.

- [ ] **Given** a location, **when** an owner creates it, **then** a trimmed, company-scoped row is inserted — *verified by `__tests__/utils/inventoryLocationsAccess.test.ts > 'createLocation' > 'inserts a trimmed, company-scoped row (no parent → no parent check)'`*.

- [ ] **Given** a part, **when** an owner enables location tracking, **then** the opt-in RPC runs with the optional initial location — *verified by `__tests__/utils/inventoryLocationsAccess.test.ts > 'RPC wrappers' > 'enableLocationTracking calls the opt-in RPC with the optional initial location'`*.

**Operator integration**

- [ ] **Given** an operator at a bin, **when** they Remove stock, **then** it depletes gracefully and stamps the operator id on the transaction — *verified by `__tests__/components/operator/OperatorBinView.test.tsx > 'OperatorBinViewPage' > 'Remove depletes gracefully and stamps the operator'`*.

- [ ] **Given** an operator at a location, **when** they receive a tracked part, **then** the part is added at that location — *verified by `__tests__/components/operator/OperatorReceivePartModal.test.tsx > 'OperatorReceivePartModal' > 'adds the chosen part at this location'`*.

- [ ] **Given** the job page, **when** a user views a job part's materials, **then** the list is read-only and sourced live from the part's BOM — today there is no per-job "mark consumed / skipped" action and no auto-depletion on job completion; per-job consumption tracking is **Planned (see #550)** behind the `inventory_transactions` feature flag — *manual: `JobPartMaterialsCard` reads `getBomForPart`; no consumption function exists (automation-pending)*.

---

## Material Consumption Flow

> **Note:** Per-job material *consumption tracking* is **not implemented today** and is **Planned (see #550)** behind the `inventory_transactions` feature flag. As shipped, `job_materials` has only `expected_quantity`/`unit` (no `status`, `actual_quantity`, `consumed_at`, or `consumed_by` columns), there is no operator "mark consumed / skipped" action, and stock depletion is a deliberate manual transaction (Remove Stock) rather than an automatic side effect of job completion. When the planned flag ships, an operator will be able to mark a job's materials consumed and auto-create a job-linked depletion; that behavior must stay gated behind the flag until then. The steps below describe the material *definitions* that flow today, not an auto-depletion pipeline.

Material definitions flow from a part's BOM → job:

1. **BOM setup.** A designer defines the materials a manufactured part consumes in `parts_bom` (see Parts / BOM). Each edge specifies a `child_part_id`, `quantity`, and `unit`. The BOM is part-attached (one BOM per made part).

2. **Job creation.** When a job part is created for a part with a routing, `create_job_part_operations_from_routing(p_job_part_id, p_routing_id)` snapshots every `parts_bom` edge of the routing's part into `job_materials` (recording `parts_bom_id`, `material_part_id`, `expected_quantity`, `unit`). The snapshot is idempotent on `parts_bom_id`.

3. **Job display.** On the job page, `JobPartMaterialsCard` shows a **read-only** materials list sourced **live from the part's BOM** (`parts_bom`), not from the `job_materials` snapshot — so the job reflects the current BOM. Quantities are per unit of the part.

4. **Depletion (manual).** To decrement inventory, a user records a Remove Stock transaction on the material part (`removePartStock` / `removePartStockGraceful`, or `depleteStockAtLocation` for location-tracked parts), which writes a `depletion` `inventory_transactions` row. This is a deliberate action, not triggered by marking the job done.

Materials live at the part/job level — not per operation. A job part has a single materials list, regardless of how many operations the routing has.

---

## Additional Requirements

### Quantity Validation Rules

The system must enforce the following validation rules:

- Quantity cannot go negative - Depletion transactions that would result in negative inventory must be rejected with an error message

- Zero quantity allowed - Items can have zero stock (indicates out of stock)

- Adjustment transactions - Can set quantity to any non-negative value (used for corrections/reconciliation)

### Hard Delete (No Soft Delete)

Inventory items (stocked `parts`) use hard delete (no deleted_at column). When an item is deleted:

- The `parts` record is permanently removed

- Associated `parts_unit_conversions` are cascade deleted

- `inventory_transactions` remain for audit purposes with `part_id` nulled (SET NULL) and the `item_name` / `location_name` snapshots preserved
