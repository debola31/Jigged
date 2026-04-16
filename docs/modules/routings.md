# Routings Module

## Overview

The Routings module provides a **linear, reorderable operation list** for defining manufacturing processes. A routing is an ordered sequence of operations (plus a routing-level list of materials) that describes how a part is manufactured.

Each part has **exactly one routing** (1:1 relationship). Routings are managed from the **part detail page**, not a standalone routings page. There is no separate "Routings" entry in the sidebar navigation.

Users build routings by adding operations to a list and dragging to reorder them. Each operation row supports inline editing of the operation type, setup time, and run time per unit. Materials needed for the whole routing are defined once in a separate routing-level list — not per operation.

**Priority:** Must Have (Build after Operations, before Jobs)

**Dependencies:**

- Parts module (each part has exactly one routing; routings are accessed from the part detail page)

- Operations module (routings reference operation types)

- Inventory module (routing materials reference inventory items)

**Database Tables:** `routings`, `routing_nodes`, `routing_materials`

---

## Terminology

| Term | Description |
|---|---|
| **Routing** | The ordered list of operations plus the list of materials that defines how a part is manufactured |
| **Routing Operation (Node)** | A single operation step in the routing, stored in `routing_nodes` with a `sequence` that determines its position in the list |
| **Sequence** | Integer that defines linear execution order. Saved in steps of 10 (10, 20, 30, ...) so new rows can be inserted between existing ones without renumbering everything |
| **Routing Material** | An inventory item expected to be consumed for the whole routing, stored in `routing_materials` |

---

## Linear Routing Builder

The routing editor is a two-section page, not a canvas:

- **Operations list** - A sortable list of operation rows. Each row is editable inline (operation type, setup time, run time per unit, instructions). Rows are drag-to-reorder; reordering updates each row's `sequence`.

- **Materials list** - A separate sortable list of materials for the routing. Each row picks an inventory item, quantity, and unit. Materials are routing-level — not attached to individual operations.

- **Add / remove** - Each section has an "Add" button. Rows can be removed individually.

- **Minimum Operations** - At least one operation is required to save a routing.

Components live under `components/routings/`: `RoutingBuilder`, `RoutingOperationsList`, `RoutingOperationRow`, `RoutingMaterialsList`, `RoutingMaterialRow`, and `RoutingViewer` (read-only display used outside the editor).

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
| name | text | Yes | Auto-generated from part number (e.g., "Routing - AE36589E-RT") |

### Routing Nodes Table (`routing_nodes`)

Each row is one operation step in the routing. Position in the list is defined by the `sequence` column; there is no stored x/y position because the UI is a list, not a canvas.

| Column | Type | Required | Description |
|---|---|---|---|
| id | uuid | Yes | Primary key |
| routing_id | uuid | Yes | FK to routings |
| operation_type_id | uuid | Yes | FK to operation_types |
| sequence | integer | Yes | Linear order (steps of 10). Unique within a routing. |
| setup_time | numeric | No | Setup time in minutes |
| run_time_per_unit | numeric | No | Run time per unit in minutes |
| instructions | text | No | Optional per-operation instructions |

A deferrable unique constraint on `(routing_id, sequence)` allows reorder operations to be performed inside a single transaction without tripping on intermediate duplicates.

### Routing Materials Table (`routing_materials`)

Materials needed to manufacture the part. Routing-level, not per-operation. Think "job-level shopping list".

| Column | Type | Required | Description |
|---|---|---|---|
| id | uuid | Yes | Primary key |
| routing_id | uuid | Yes | FK to routings (cascade delete) |
| inventory_item_id | uuid | Yes | FK to inventory_items (restricted delete) |
| quantity | numeric | Yes | Expected quantity per job (must be > 0) |
| unit | text | Yes | Unit of measure (primary or configured secondary unit of the inventory item) |
| sequence | integer | Yes | Display order in the materials list (steps of 10) |
| created_at | timestamptz | Yes | Record creation |
| updated_at | timestamptz | Yes | Last update |

---

## User Stories

| As a... | I want to... | So that... |
|---|---|---|
| Owner/Admin | Build a routing for a part as a list of operations | I can define how the part is manufactured |
| Owner/Admin | Drag operations to reorder them | I can adjust the sequence as my process evolves |
| Owner/Admin | Inline-edit operation, setup time, and run time per unit on each row | I can make small changes without opening a dialog |
| Owner/Admin | Define a single list of materials for the whole routing | I can see the "shopping list" for the job without hunting through operations |
| Owner/Admin | View estimated total time (sum of all operations) | I can accurately quote jobs |
| Owner/Admin | Access the routing editor from the part detail page | I can manage the routing in context of the part |

---

## Validation Rules

- Routing name is auto-generated from the part number and must be unique within the company

- Each part can have at most one routing (enforced by unique constraint on `part_id`)

- At least one operation is required to save a routing. An error is shown if no operations have been added.

- Sequence values must be unique within a routing (enforced by deferrable unique constraint on `(routing_id, sequence)`)

- Routing material quantity must be greater than zero

---

## Routes

Routings are accessed from the part detail page. There is no standalone routings list page.

- **Create routing:** `/dashboard/{companyId}/parts/{partId}/routing/new` -- Opens the routing builder directly (no name/part selection step; the routing name is auto-generated from the part number)
- **Edit routing:** `/dashboard/{companyId}/parts/{partId}/routing/edit` -- Opens the routing builder for the existing routing

---

## Routing Materials

Routing materials define the list of inventory items expected to be consumed for the whole job. They replace the earlier per-operation materials approach, which proved awkward both for routing designers (figuring out which operation "owns" a material) and for operators (materials don't neatly map to single operation steps in practice).

### Behavior

- Routing designers add material rows with `(inventory_item_id, quantity, unit)`.

- When a job is created from a part with a routing, each `routing_materials` row is **snapshotted** into `job_materials` — see [Jobs Module — Material Tracking](jobs.md#material-tracking).

- If a routing material is later edited or deleted, existing jobs are **not** retroactively updated; they keep their snapshot in `job_materials`. Deleting a routing material sets `job_materials.routing_material_id` to `NULL` via `ON DELETE SET NULL`.

### User Story

- As a routing designer, I want to specify the materials needed for the whole routing so that operators and cost calculations have a single, authoritative shopping list per job.

---

## Cost Calculation from Routing

Routings serve as the source of truth for part costing when available. The routing's cost rolls up from individual operation labor plus routing-level materials into a total that feeds directly into the quoting system.

### Labor Cost

Summed across all operations in the routing:

```
operation_labor_cost = (run_time_per_unit / 60) × operation_type.labor_rate
total_labor_cost = Σ all operation_labor_costs
```

Where:
- `run_time_per_unit` is in minutes (from `routing_nodes.run_time_per_unit`)
- `operation_type.labor_rate` is the hourly rate in dollars (from `operation_types.labor_rate`)

Setup time can optionally be included if the quote amortizes setup across the job quantity.

### Material Cost

Summed across routing materials:

```
total_material_cost = Σ (routing_material.quantity × inventory_item.cost_per_unit)
```

### Total Routing Cost

```
total_routing_cost = total_labor_cost + total_material_cost
```

### Integration with Parts

When a routing exists for a part:
- The part's `cost_source` is set to `'routing'`
- The part's effective base cost = `total_routing_cost` (calculated on demand from the routing, not stored redundantly on the parts table)
- The part's `manual_cost` field is ignored in favor of the routing calculation

### Integration with Quotes

When creating a quote for a part with a routing:
1. Fetch the routing, its operations, and its materials
2. For each operation, join to `operation_types` for `labor_rate`
3. For each routing material, join to `inventory_items` for `cost_per_unit`
4. Calculate `total_labor_cost` and `total_material_cost`
5. Set `quote.base_cost = total_routing_cost`
6. Set `quote.estimated_labor_cost = total_labor_cost`
7. Set `quote.estimated_material_cost = total_material_cost`
8. Set `quote.cost_source = 'routing'`
9. Pre-fill `quote.markup_percent` from part's category `default_markup_percent`

These values are **snapshots** — frozen at quote creation time. See [Quotes Module — Snapshot Behavior](quotes.md#data-model).

### Edge Cases

| Scenario | Behavior |
|---|---|
| Operation has no `run_time_per_unit` | Skip labor for that operation. Show "Missing run time" warning on cost breakdown. |
| Operation type has no `labor_rate` | Skip labor for that operation. Show "Missing labor rate for {operation_name}" warning. |
| Routing has no materials defined | $0 material cost. Normal — no warning needed. |
| Material has no `cost_per_unit` in inventory | Skip that material's cost. Show "Missing cost for {material_name}" warning. |
| Routing has 0 operations | Cost = $0. Show "Routing has no operations" warning on quote form. |
| Any warnings present | Quote form shows banner: "Cost may be incomplete — {N} items missing data" with expandable details listing each warning. |

Warnings are informational — they do **not** block quote creation. The user can proceed with incomplete cost data and enter a manual override.
