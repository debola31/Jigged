# Inventory Module

> **Journey source of truth:** [`docs/inventory-flow.md`](../inventory-flow.md) — what
> inventory is *for*, the thirteen target journeys (J1–J13), the design decisions, and the
> phasing. **This doc describes what is built today** and the data model behind it. When the
> two disagree, the flow doc describes the target and this one describes reality.
>
> This file also absorbs the inventory-locations spec that PR #414 promised and never wrote.
> There is no separate `inventory-locations.md`.

## Overview

Inventory tracks **how much of a stocked item the shop has, optionally where it is, and the
full history of every change**. It is a filtered view over `parts`, not a separate item
master.

**What it does today:** flexible units with conversion (PRD FR-1, `Must`) · an append-only
transaction ledger (FR-13, `Should`) · derived low-stock status · optional QR-addressable
storage locations with per-location balances and a shop-floor scan flow.

**What it does not do** — see [Boundaries](#boundaries--what-this-module-does-not-do) for the full list, but the headline
absences are: nothing decrements automatically from production, there is no receiving or
purchasing, and there is no counting workflow.

---

## Concepts

Four things, easy to conflate:

| Concept | Table | Meaning |
|---|---|---|
| **Item** | `parts` where `is_stocked = true` | The thing you stock. Same row as the manufacturable part — one unified item master. |
| **Balance** | `parts.quantity`, and `part_location_stock.quantity` when location-tracked | How much you have *now*. Authoritative. |
| **Transaction** | `inventory_transactions` | What changed and why. Append-only, and **never replayed** — it is an audit trail, not the source of the balance. |
| **Location** | `inventory_locations` | A place stock can sit. A nullable-parent tree; QR labels encode the location UUID. |

Concepts that **do not exist yet** and are commonly assumed to: lot / heat number, material
cert, purchase order, on-order quantity, reserved or allocated stock, remnant, count session,
min/max, ABC class, cost-on-hand.

---

## Dependencies

- **Parts** — stockable items are `parts` rows with `is_stocked = true`. Identity fields
  (name, description, primary unit, reorder point, source) are edited on the part's Details
  tab, not in inventory.
- **BOM (`parts_bom`)** — defines the materials a manufactured part consumes. Part-attached
  (one BOM per made part), not routing-attached. The old `routing_materials` table was removed.
- **Jobs** — `job_materials` snapshots a made part's BOM at job creation. See
  [the write-only warning](#job_materials-is-write-only).

---

## Data model

### `parts` (stocked subset)

Full table in the [Parts module](parts.md). Inventory-relevant columns:

| Column | Type | Required | Description |
|---|---|---|---|
| `id` | uuid | Yes | Primary key |
| `company_id` | uuid | Yes | FK to companies |
| `part_name` | text | Yes | Item name (e.g. "4140 Steel Bar"). UNIQUE per `(company_id, part_name)` |
| `description` | text | No | Optional description |
| `is_stocked` | boolean | Yes | `true` marks the part as tracked inventory |
| `source` | text | Yes | `bought` or `made` — both can be stocked |
| `primary_unit` | text | Yes | Unit of measure; the `parts_requires_unit` CHECK makes it non-null |
| `quantity` | numeric | Yes | On hand in `primary_unit` (CHECK ≥ 0). **Only ever changed through a stock function — never the part form.** |
| `reorder_point` | numeric | No | Low-stock threshold; `NULL` disables status |
| `is_location_tracked` | boolean | Yes | When true, on-hand is the rollup of `part_location_stock` rows |
| `preferred_vendor_id` | uuid | No | FK to vendors. A **label only** — it does not gate cost (migration `20260714173443`) |
| `deleted_at` | timestamptz | No | Soft delete — see [Archive](#archive-soft-delete) |

### `parts_unit_conversions`

Secondary units with conversion factors to the part's primary unit. Delivers FR-1.
Replaced the former `inventory_unit_conversions`.

| Column | Type | Required | Description |
|---|---|---|---|
| `id` | uuid | Yes | Primary key |
| `part_id` | uuid | Yes | FK to parts |
| `from_unit` | text | Yes | Secondary unit (e.g. "inches"). UNIQUE per `(part_id, from_unit)` |
| `to_primary_factor` | numeric | Yes | Multiply by this to get primary units (CHECK > 0) |
| `created_at` | timestamptz | Yes | |

**Example:** steel bar tracked in lbs. `from_unit: "inches"`, `to_primary_factor: 0.166` →
1 inch = 0.166 lbs. Standard same-category units are auto-offered in the transaction modal;
this table stores only custom / cross-category factors. Company-defined unit names live in
`company_custom_units`.

### `inventory_transactions`

Append-only ledger. Delivers FR-13. The `restrict_transaction_update_to_notes` trigger makes
`notes` the only mutable column after insert.

| Column | Type | Required | Description |
|---|---|---|---|
| `id` | uuid | Yes | Primary key |
| `company_id` | uuid | Yes | FK to companies (CASCADE) |
| `part_id` | uuid | No | FK to parts (SET NULL) |
| `item_name` | text | Yes | Part-name snapshot — survives part deletion |
| `type` | text | Yes | `addition` \| `depletion` \| `adjustment` (CHECK-enforced) |
| `quantity` | numeric | Yes | Always positive (CHECK ≥ 0); direction lives in `type` |
| `unit` | text | Yes | Unit used for this transaction |
| `converted_quantity` | numeric | Yes | Quantity in the part's primary unit |
| `job_id` | uuid | No | FK to jobs (SET NULL) — **only ever set from the operator bin path** |
| `job_operation_id` | uuid | No | FK to job_operations (SET NULL) |
| `operator_id` | uuid | No | Set when an operator performed the action |
| `notes` | text | No | The only post-insert mutable column |
| `has_discrepancy` | boolean | Yes | True when a graceful depletion clamped to zero |
| `location_id` | uuid | No | FK to inventory_locations (SET NULL) |
| `location_name` | text | No | Location-name snapshot (via `trg_snapshot_txn_location`) |
| `transfer_group_id` | uuid | No | Pairs the two rows of a location-to-location transfer |
| `created_at` | timestamptz | Yes | Transaction timestamp |
| `created_by` | uuid | No | Set when an admin performed the action |

Indexed on `(company_id, created_at DESC)`, `(part_id, created_at DESC)`, and partially on
`job_id`, `job_operation_id`, `location_id`, `transfer_group_id`, and
`WHERE has_discrepancy = true`.

### `inventory_locations`

The storage tree. Adjacency list — **no `path`, `level`, or `ltree` column**; depth and path
are computed client-side on every read.

| Column | Type | Required | Description |
|---|---|---|---|
| `id` | uuid | Yes | Primary key. **This is what a QR label encodes.** |
| `company_id` | uuid | Yes | FK to companies (CASCADE) |
| `parent_id` | uuid | No | Self-FK, `ON DELETE RESTRICT`. `NULL` = top level |
| `name` | text | Yes | CHECK `length(btrim(name)) > 0` |
| `kind` | text | No | Free text — `cabinet`, `row`, `bin`, `shelf`, `system`… |
| `code` | text | No | Human label printed on the tag (e.g. `CAB1-R03-L`). **No uniqueness constraint.** |
| `sort_order` | integer | Yes | Sibling ordering, default 0 |
| `created_at` / `updated_at` | timestamptz | Yes | |

Indexes: `(company_id, parent_id)`, plus a **partial unique index on `(company_id) WHERE
name = 'Unassigned'`** — that index is the entire mechanism behind the auto-created system
bucket, which the RPCs resolve **by name**.

Two caveats worth knowing before changing anything here:

- **Cycle prevention on re-parent is client-side only** (`moveLocation` walks ancestors in
  JS). There is no DB-level constraint. `moveLocation` also has no UI caller today.
- **The "Unassigned" node is identified two different ways** — by the literal string
  `'Unassigned'` in SQL and by `kind === 'system'` in TypeScript.

### `part_location_stock`

Per-location balances. **RLS is SELECT-only** — mutated exclusively through SECURITY DEFINER
RPCs.

| Column | Type | Required | Description |
|---|---|---|---|
| `id` | uuid | Yes | Primary key |
| `company_id` | uuid | Yes | FK to companies (CASCADE) |
| `part_id` | uuid | Yes | FK to parts, `ON DELETE RESTRICT`. UNIQUE with `location_id` |
| `location_id` | uuid | Yes | FK to inventory_locations, `ON DELETE RESTRICT` |
| `quantity` | numeric | Yes | CHECK ≥ 0 |
| `created_at` | timestamptz | Yes | |

### `job_materials` is write-only

Snapshotted at job creation by `create_job_part_operations_from_routing()` and **read by
nothing.** Columns are exactly `job_id`, `job_part_id`, `parts_bom_id`, `material_part_id`,
`expected_quantity`, `unit`, `created_at`, `updated_at`. Consumption columns (`status`,
`actual_quantity`, `consumed_at`, `consumed_by`) were removed by migration
`20260614043526_retire_job_material_consumption`.

`JobPartMaterialsCard` reads the **live BOM** instead, so the job reflects current BOM edits.
Its fate is an open decision — see [`inventory-flow.md`](../inventory-flow.md) §5.9.

> ⚠️ `docs/modules/jobs.md` still documents this table with consumption columns and an
> `inventory_item_id` FK. That section is stale; this one is verified against
> `types/database.ts`.

---

## The two stock engines

**The most important implementation fact in this module.** Which engine runs is decided
per-part by `is_location_tracked`:

| | **Path A — aggregate** | **Path B — location-tracked** |
|---|---|---|
| Condition | `is_location_tracked = false` | `is_location_tracked = true` |
| Functions | `addPartStock` · `removePartStock` · `adjustPartStock` (`utils/partsAccess.ts`) | `add_stock_at_location` · `deplete_stock_at_location` · `adjust_stock_at_location` · `transfer_stock` (SECURITY DEFINER RPCs) |
| Mechanism | Client-side read-modify-write on `parts.quantity`, then a separate ledger insert | Balance upsert + ledger insert in one transaction, under `SELECT … FOR UPDATE` |
| Atomic? | **No.** Concurrent writes can lose an update. | Yes |
| `parts.quantity` | Written directly | Trigger-maintained rollup of `SUM(part_location_stock.quantity)` |

Enforced by triggers:

- `trg_recompute_part_quantity` — `AFTER INSERT/UPDATE/DELETE` on `part_location_stock`,
  recomputes `parts.quantity`.
- `enforce_tracked_part_quantity` — `BEFORE UPDATE` on `parts`, **raises** if a direct
  `parts.quantity` write on a tracked part disagrees with the sum of balances. Path A is
  therefore *refused by the database* for tracked parts, which is why the UI swaps
  affordances.
- `trg_auto_track_stocked_part` — `AFTER INSERT OR UPDATE OF is_stocked` on `parts`,
  auto-enrols stocked parts into location tracking **only** when the company has
  `settings.features.inventory_locations = true`, seeding at "Unassigned". This is why no
  per-part opt-in UI exists.

Consolidating these onto one engine is a recorded intent — see
[`inventory-flow.md`](../inventory-flow.md) §5.4.

---

## UI surfaces

Inventory has **no dedicated item detail, create, edit, or import page.** It is a filtered
view over `parts`; everything else is the Parts UI.

### Inventory list — `/dashboard/{companyId}/inventory`

[`app/dashboard/[companyId]/inventory/page.tsx`](../../app/dashboard/[companyId]/inventory/page.tsx)

AG Grid over `getStockedParts`. Columns: Part Name (pinned), Description, Quantity, Status,
Unit, Updated. Status is derived at render via `deriveStockStatus(quantity, reorder_point)`
and filtered client-side. 300 ms debounced search over name + description. Multi-select →
bulk Delete (archive) and CSV Export.

- **Add Item** → `/parts/new?source=bought&stocked=1&from=inventory`
- **Import** → `/parts/import` (the shared parts CSV importer)
- **Locations** → `/inventory/locations` — only when `inventory_locations` is enabled
- **Row click** → `/parts/{id}?from=inventory`

### Part workspace — Inventory tab

[`components/parts/workspace/tabs/InventoryTab.tsx`](../../components/parts/workspace/tabs/InventoryTab.tsx),
rendered only when `part.is_stocked`.

Current Stock display · a "Below reorder point" chip · unit-conversion editor
(`PartUnitConversionsEditor`) · paginated transaction history
(`PartTransactionHistoryTable`, notes editable in place).

Stock actions depend on the engine: untracked parts get Add / Remove / Adjust via
`PartTransactionModal`; tracked parts get per-location balances via `PartLocationInventory`
with add / remove / adjust / **move**.

> **Known gap:** `PartTransactionModal` has **no job selector**. Issue #59 (validated shop
> feedback: *"link inventory removals to specific jobs"*) shipped in March against the old
> `/inventory/[itemId]` page and was lost when that page was deleted in the May unification.
> An owner cannot tag a removal to a job today; only an operator at a scanned bin can.

### Locations manager — `/dashboard/{companyId}/inventory/locations`

Feature-gated. [`LocationsManager.tsx`](../../components/inventory/locations/LocationsManager.tsx)
renders a recursive indented tree (`LocationTreeView`) with per-node actions: add
sub-location, bulk-generate, print QR, duplicate, edit, delete. All actions are suppressed
for `kind === 'system'`.

Toolbar: **Print all labels** · **New top-level location** · **Build visually**.

**Build visually** ([`VisualLocationBuilder.tsx`](../../components/inventory/locations/builder/VisualLocationBuilder.tsx))
is a two-step modal: pick one of seven storage types, then configure levels
(*"Call them" / "A set number" vs "Specific names" / "How many?"*, max 4 levels) against a
read-only 2D preview, and press *"Create N locations"*. Per-branch fine-tuning is available
after the uniform layout is set. It builds the whole tree client-side and materialises it in
one action via `materializeLocationSpec`.

> **Known gap:** this is a *structure-first* setup flow — a shop must model its storage
> abstractly before any item exists. The redesign is specified in
> [`inventory-flow.md`](../inventory-flow.md) §5.5. `VisualLocationBuilder` accepts
> `parentId`/`parentCode` props for building under an existing node, but `LocationsManager`
> only ever passes `null`, so that path is unreachable.

### Operator surfaces

| Route | Purpose |
|---|---|
| `/operator/{companyId}/inventory` | Warehouse home — browse top-level locations |
| `/operator/{companyId}/inventory/locations/{locationId}` | **The QR scan target.** Parent → drill down; leaf → contents with Add / Remove / Set per part |

Scanning a label opens `/operator/{companyId}/login?location={id}`; the login page reads
`?location=` and routes there post-auth. Operator removals are always **graceful** (clamp to
zero, flag `has_discrepancy`) and stamped with the operator id, and may optionally be tagged
to a job.

QR labels encode the **location UUID**, never the human `code`
(`locationLabelPdf.buildLocationScanUrl`). `utils/locationLabelPdf.ts` emits an A4 sheet,
2 columns × 5 rows, 34 mm QR at error-correction level H. `kind='system'` nodes are excluded
from printing.

---

## API architecture

All inventory operations go through the Supabase client with RLS — **no FastAPI endpoints**.
Both access files use `getTypedSupabase()`.

### `utils/partsAccess.ts`

`getStockedParts` · `addPartStock` · `removePartStock` · `adjustPartStock` ·
`getPartTransactions` · `updateTransactionNotes` · `getPartUnitConversions` ·
`replacePartUnitConversions` · `deletePart` / `bulkDeleteParts` (→ `archive_parts` RPC).

`removePartStockGraceful` exists but has **zero call sites** — the graceful path moved into
the RPC.

### `utils/inventoryLocationsAccess.ts`

Tree CRUD: `getLocations` · `buildLocationTree` · `getLocation` · `createLocation` ·
`updateLocation` · `deleteLocation` (→ `delete_location` RPC) · `bulkGenerateChildren` ·
`materializeLocationSpec` · `duplicateLocation`.

Reads: `getBalancesForPart` · `getLocationContents` · `resolveScan`.

RPC wrappers (each first loads the part's conversion context and passes both display and
converted quantities): `addStockAtLocation` · `depleteStockAtLocation` ·
`adjustStockAtLocation` · `transferStock`.

Unused: `getLocationTree`, `moveLocation` (no UI), `buildLocationUrl` (duplicate),
`enableLocationTracking` / `disableLocationTracking` (superseded by the auto-track trigger).

### `utils/alertsAccess.ts`

`getLowStockPartsAlerts` — stocked, non-deleted parts with a non-null `reorder_point`,
filtered in JS to `quantity <= reorder_point`. Severity: `critical` at 0, `high` at ≤50% of
the reorder point, else `medium`. Feeds the header `AlertBadge`.

---

## Feature flag

**`inventory_locations`** — [`lib/featureFlags.ts`](../../lib/featureFlags.ts), opt-in,
**default off for every tenant**. Stored at `companies.settings → features →
inventory_locations`; toggled per company from `/admin/companies`.

Gates four sites: the inventory-page Locations button · the `/inventory/locations` route
(redirects when off) · the operator bottom-nav Inventory tab · the SQL auto-enrolment
trigger.

Unaffected when off: the inventory list, the part Inventory tab, aggregate add/remove/adjust,
unit conversions, transaction history, stock status, and reorder alerts.

> **Two caveats.** The operator bin-view *route* itself has no flag check — only the nav tab
> is hidden — so a stale printed QR still resolves. And `KNOWN_FEATURES` contains exactly
> three keys: `inventory_locations`, `ai_insights`, `data_import`. **There is no
> `inventory_transactions` flag**, despite earlier versions of this doc referring to one.

---

## Boundaries — what this module does not do

| Not here | Where it lives / why |
|---|---|
| Material **cost** and pricing | Costing — `part_procurement_tiers`, `compute_part_cost_at_qty`. Inventory tracks quantities and identity, never money. |
| Stock checks or reservations on quotes | Deliberate. Quotes are speculative; reserving against them would corrupt on-hand. |
| Automatic depletion from production | Nothing decrements on operation complete, job complete, shipment, or invoice. Every movement is a deliberate human action. |
| Purchase orders, receiving, on-order | Not built. Phase 3 / issue #571. |
| Lots, heat numbers, certs, traceability | Not built. Phase 4, gated on discovery. |
| Remnants and drops | Not built. Phase 4. |
| Count sessions / cycle counting | Not built. *"Cycle count"* appears only as label text on the Adjust action. |
| Inventory valuation, COGS, accounting | QuickBooks. |
| Tool crib / perishable tooling | Different object, different lifecycle. Out of scope. |

---

## Acceptance criteria

Each bullet carries a verification clause: a passing test, a manual procedure, or an explicit
automation-pending tag. **A checked box means the cited test exists and passes.**

**List, search and filter**

- [x] **Given** a stocked part with quantity 0, **when** status renders, **then** it reads
  "Out of stock" (and "Low" at or below `reorder_point`, else "In stock") — *verified by
  `__tests__/components/inventory/StockStatusChip.test.tsx > 'deriveStockStatus'` (5 cases,
  including null/undefined quantity treated as 0)*.
- [x] **Given** the Status chip for `status="out"`, **when** it renders, **then** it reads
  "Out of stock" — *verified by `__tests__/components/inventory/StockStatusChip.test.tsx > 'StockStatusChip'`*.
- [ ] **Given** the inventory list, **when** it loads, **then** it shows only parts with
  `is_stocked = true` and `deleted_at IS NULL` — *manual: `getStockedParts`; automation-pending*.
- [ ] **Given** the list, **when** a user searches, **then** rows filter by name or
  description — *manual: `.or(part_name.ilike / description.ilike)`; automation-pending*.

**Stock movement**

- [ ] **Given** a stocked part, **when** an owner adds stock in the primary unit, **then**
  `parts.quantity` increases and an `addition` row is written — *automation-pending (`addPartStock`)*.
- [ ] **Given** a stocked part, **when** an owner removes stock, **then** quantity decreases
  and a `depletion` row is written; removal is blocked if it would go negative —
  *automation-pending (`removePartStock`)*.
- [ ] **Given** a stocked part, **when** an owner adjusts to a specific quantity, **then**
  quantity is set and an `adjustment` row records the delta — *automation-pending (`adjustPartStock`)*.
- [ ] **Given** a transaction, **when** its notes are edited, **then** reloading shows the
  update, and no other column is mutable — *automation-pending; DB side enforced by `restrict_transaction_update_to_notes`*.

**Flexible units (FR-1)**

- [x] **Given** a part with a custom conversion, **when** stock is added at a location in that
  unit, **then** the converted quantity reflects the factor — *verified by
  `__tests__/utils/inventoryLocationsAccess.test.ts > 'RPC wrappers' > 'addStockAtLocation applies a custom unit conversion…'`*.
- [ ] Same, on the **aggregate** path — *automation-pending. Note the coverage skew: the newer
  location path is tested, the older and more-used aggregate path is not.*

**Delete**

- [x] **Given** any stocked part, referenced or not, **when** a user deletes it, **then** it is
  archived via `archive_parts` and never blocked — *verified by
  `__tests__/utils/partsAccess.test.ts > 'deletePart'`*.
- [x] **Given** several selected parts, **when** a user bulk-deletes, **then** all are archived
  in one RPC call — *verified by `__tests__/utils/partsAccess.test.ts > 'bulkDeleteParts'`*.

**Locations (feature-gated)**

- [x] **Given** a location-tracked part, **when** balances are read, **then** each row joins to
  its location with the full path — *verified by `__tests__/utils/inventoryLocationsAccess.test.ts > 'getBalancesForPart'`*.
- [x] **Given** a depletion at a location, **then** the RPC forwards the graceful flag and job
  tag and returns the discrepancy result — *verified by `…test.ts > 'depleteStockAtLocation forwards graceful flag, job tag, and discrepancy result'`*.
- [x] **Given** an adjustment at a location, **then** the RPC is called with the newly-converted
  quantity — *verified by `…test.ts > 'adjustStockAtLocation calls adjust with the new converted quantity'`*.
- [x] **Given** a new location, **when** an owner creates it, **then** a trimmed,
  company-scoped row is inserted — *verified by `…test.ts > 'createLocation'`*.

**Operator**

- [x] **Given** an operator at a bin, **when** they Remove stock, **then** it depletes
  gracefully and stamps the operator — *verified by `__tests__/components/operator/OperatorBinView.test.tsx`*.
- [x] **Given** an operator at a location, **when** they receive a tracked part, **then** it is
  added at that location — *verified by `__tests__/components/operator/OperatorReceivePartModal.test.tsx`*.

**Known-failing by design** (recorded so they are not mistaken for oversights)

- [ ] **Given** an owner in the dashboard, **when** they remove stock, **then** they can link it
  to a job — **regressed**, see the `PartTransactionModal` note above. Issue #59.
- [ ] **Given** a job, **when** it is viewed, **then** required material is compared to on-hand
  — **not built** (J4).
- [ ] **Given** a completed operation, **when** material was consumed, **then** stock depletes
  — **not built** (J9, issue #550).

---

## Archive (soft delete)

Stocked parts are **archived, never hard-deleted**. `deletePart` / `bulkDeleteParts` call the
`archive_parts` RPC, which stamps `deleted_at` in one transaction. It never blocks on
references.

- The `parts` row is **kept**, just hidden — every list, search, picker and count filters
  `deleted_at IS NULL`, while by-id reads and retained FKs still resolve it.
- `parts_unit_conversions` and `part_location_stock` are **kept** — nothing cascades, because
  the row survives. They return if the part is revived.
- `inventory_transactions` are unaffected: they retain their `item_name` / `location_name`
  snapshots, and the `part_id` FK still resolves the archived part (its `ON DELETE SET NULL`
  only fires on a true `DELETE`, which the UI no longer issues).
- Re-creating or re-importing the same `part_name` **revives** the archived row rather than
  duplicating it.

Locations are different: `delete_location` only removes an **empty** subtree, and
`part_location_stock` holds `ON DELETE RESTRICT` on both FKs. There is no "delete and relocate
stock" action.

See [`docs/architecture.md`](../architecture.md) §16 for the authoritative deletion policy.

---

## Known gaps

Tracked in [`inventory-flow.md`](../inventory-flow.md); summarised here so this doc is honest
on its own.

| Gap | Reference |
|---|---|
| Job-linked depletion missing for owners (regression) | Issue #59 · flow J7 |
| No material check on a job | Flow J4 |
| No count / cycle-count workflow | Flow J10 |
| Opening stock balances not importable, contradicting FR-16 | Flow J1 |
| Per-job consumption removed, re-declared intended, unbuilt | Issue #550 · flow J9 |
| FR-2 reorder alerts are a PRD **`Must`**; only the badge exists — no email, no buy list | Flow J11 |
| Two stock engines, one non-atomic | Flow §5.4 |
| `job_materials` written and never read | Flow §5.9 |
| Storage setup is structure-first | Flow §5.5 |
| No purchasing, receiving, lots, certs, or remnants | Flow phases 3–4 |
| Aggregate stock path has no unit tests; no E2E spec covers inventory at all | — |
