# Routings Module

## Overview

The Routings module provides a **visual workflow diagram builder** for defining manufacturing processes. Unlike traditional linear operation lists, routings in Jigged are **node-based workflow diagrams** where operations can run in **parallel** or **series**.

Each part has **exactly one routing** (1:1 relationship). Routings are managed from the **part detail page**, not a standalone routings page. There is no separate "Routings" entry in the sidebar navigation.

Users build routings by dragging operations onto a canvas and connecting them with edges to define execution flow. This enables complex manufacturing processes where multiple operations can happen simultaneously on different machines, reducing total production time.

**Priority:** Must Have (Build after Operations, before Jobs)

**Dependencies:**

- Parts module (each part has exactly one routing; routings are accessed from the part detail page)

- Operations module (routings reference operation types)

**Database Tables:** `routings`, `routing_nodes`, `routing_edges`

---

## Terminology

| Term | Description |
|---|---|
| **Routing** | A workflow diagram defining how a part is manufactured, consisting of nodes (operations) and edges (connections) |
| **Workflow Node** | An operation represented as a card on the canvas, containing run time, materials, and resource assignment |
| **Edge/Connection** | A link between nodes showing execution dependency - the source must complete before the target starts |
| **Parallel Branch** | Multiple nodes that can execute simultaneously because they have no dependencies on each other |
| **Series Path** | Nodes that execute sequentially, one after another, where each depends on the previous |
| **Start Node** | The entry point of the workflow - operations with no incoming edges |
| **End Node** | The final operation(s) before completion - operations with no outgoing edges |

---

## Visual Workflow Builder

The routing editor provides a drag-and-drop canvas for building manufacturing workflows:

- **Canvas** - Drag and drop operations as nodes onto an infinite canvas

- **Operations Toolbar** - Select operations from your operations library to add to the workflow

- **Node Cards** - Each node displays operation name, resource group, and estimated time

- **Connections** - Draw edges between nodes by dragging from output to input handles

- **Parallel Patterns** - Create branches by connecting one node to multiple targets

- **Validation** - System ensures valid workflow (no cycles, all nodes connected)

- **Minimum Operations** - At least one operation is required to save a routing

---

## Workflow Examples

### Series Workflow (Sequential Operations)

Operations execute one after another. Total time = sum of all operation times.

```plain text
[Start] → [CNC Mill] → [Deburr] → [Inspect] → [End]
```

### Parallel Workflow (Simultaneous Operations)

Multiple operations run at the same time on different machines, then converge.

```plain text
              ┌→ [CNC Mill Op1] ─┐
[Start] ──────┼→ [CNC Mill Op2] ─┼→ [Deburr] → [Inspect] → [End]
              └→ [Manual Drill] ─┘
```

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

Node positions are **auto-calculated** using a DAG layout algorithm (dagre) when rendering. Positions are presentation-layer, not business logic - the workflow is defined by edges.

| Column | Type | Required | Description |
|---|---|---|---|
| id | uuid | Yes | Primary key |
| routing_id | uuid | Yes | FK to routings |
| operation_type_id | uuid | Yes | FK to operation_types |
| cycle_time | float | No | Run time per unit in minutes |
| materials | jsonb | No | Array of materials needed for this operation [{inventory_item_id, quantity, unit}] |
| metadata | jsonb | No | Optional JSON (can store position hints for custom layouts) |

### Routing Edges Table (`routing_edges`)

| Column | Type | Required | Description |
|---|---|---|---|
| id | uuid | Yes | Primary key |
| routing_id | uuid | Yes | FK to routings |
| source_node_id | uuid | Yes | FK to routing_nodes (start of edge) |
| target_node_id | uuid | Yes | FK to routing_nodes (end of edge) |

---

## User Stories

| As a... | I want to... | So that... |
|---|---|---|
| Owner/Admin | Build a routing for a part by dragging operations onto a canvas | I can visually design manufacturing workflows |
| Owner/Admin | Connect operations with edges to define execution order | I can specify which operations depend on others |
| Owner/Admin | Create parallel branches for simultaneous operations | Multiple operations can run at the same time |
| Owner/Admin | View estimated total time (sum of all operations) | I can accurately quote jobs |
| Owner/Admin | Access the routing editor from the part detail page | I can manage the routing in context of the part |
| Owner/Admin | Validate my workflow has no cycles | I avoid invalid routing configurations |

---

## Validation Rules

- Routing name is auto-generated from the part number and must be unique within the company

- Each part can have at most one routing (enforced by unique constraint on part_id)

- At least one operation (node) is required to save a routing. An error is shown if no operations have been added.

- Workflow must have no cycles (DAG only)

---

## Routes

Routings are accessed from the part detail page. There is no standalone routings list page.

- **Create routing:** `/dashboard/{companyId}/parts/{partId}/routing/new` -- Opens the workflow builder directly (no Step 1 name/part selection; the routing name is auto-generated from the part number)
- **Edit routing:** `/dashboard/{companyId}/parts/{partId}/routing/edit` -- Opens the workflow builder for the existing routing

The routing wizard skips Step 1 (name and part selection) and goes straight to the workflow builder (Step 2), since the part context is already known and the routing name is auto-generated.

---

## Material Definitions per Routing Node

Routing nodes can optionally define expected materials for each operation. This enables:

- Routing designers to specify expected materials per operation step

- Operator View to pre-populate material logging when completing operations

- Actual vs expected material consumption comparison

### routing_nodes.materials Column

Add the following column to the routing_nodes table:

| Column | Type | Required | Description |
|---|---|---|---|
| materials | jsonb | No | Expected materials for this operation |

### materials JSONB Structure

The materials field is an array of material specifications:

```json
[
  {
    "inventory_item_id": "uuid",
    "quantity": 0.5,
    "unit": "lbs"
  },
  {
    "inventory_item_id": "uuid",
    "quantity": 12,
    "unit": "inches"
  }
]
```

**Field Descriptions:**

- `inventory_item_id` - UUID FK to inventory_items table

- `quantity` - Expected quantity to be consumed

- `unit` - Unit of measure (must be primary or configured secondary unit)

### UI Addition: Material Input

When editing a routing node, add a "Materials" section:

- "+Add Material" button opens inventory item picker

- For each material: inventory item dropdown, quantity input, unit dropdown

- Materials can be reordered or removed

### User Story Addition

- As a routing designer, I want to specify expected materials for each operation so that operators know what materials to log when completing work
