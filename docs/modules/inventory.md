# Inventory Module

## Overview

Phase 0 Inventory module providing basic inventory tracking with flexible units of measure and full transaction history. This module enables operators to log material consumption during job completion and provides owners with visibility into stock levels.

**PRD Requirements Addressed:**

- **FR-1 (Must): Flexible Inventory Units** - Multiple units per item with automatic conversion

- **FR-13 (Should): Transaction History** - Full audit trail of all inventory changes

**NOT in Phase 0:**

- FR-2: Reorder Alerts (deferred to future phase)

## Dependencies

- **Operator View** - Material consumption logging creates inventory transactions (Inventory must be built first)

- **Routings module** - `routing_materials` defines the expected materials for each routing

- **Jobs module** - `job_materials` tracks expected and actual consumption per job

**Build Order for Material Consumption Flow:**

1. Inventory module (tracks `inventory_items` referenced by routings and jobs)

2. Routings module (defines `routing_materials` — one list per routing)

3. Jobs module (creates jobs; job creation snapshots `routing_materials` into `job_materials`)

4. Operator View (operator marks `job_materials` consumed → creates inventory_transactions)

**Material Definitions:**

- Materials are defined once per routing in the `routing_materials` table (see Routings module)

- Each row references an `inventory_item_id` from this module

- `routing_materials` is a dedicated relational table — there is no JSONB column for materials

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

### inventory_items

Core inventory item records with primary unit tracking.

| Column | Type | Required | Description |
|---|---|---|---|
| id | uuid | Yes | Primary key |
| company_id | uuid | Yes | FK to companies |
| name | text | Yes | Item name (e.g., "4140 Steel Bar") |
| description | text | No | Optional description |
| primary_unit | text | Yes | Primary unit of measure (e.g., "lbs") |
| quantity | numeric | Yes | Current quantity in primary unit |
| cost_per_unit | numeric | No | Cost per primary unit |
| created_at | timestamptz | Yes | Record creation |
| updated_at | timestamptz | Yes | Last update |

### inventory_unit_conversions

Secondary units with conversion factors to primary unit. Enables FR-1 (Flexible Inventory Units).

| Column | Type | Required | Description |
|---|---|---|---|
| id | uuid | Yes | Primary key |
| inventory_item_id | uuid | Yes | FK to inventory_items |
| from_unit | text | Yes | Secondary unit (e.g., "inches") |
| to_primary_factor | numeric | Yes | Multiply by this to get primary units |

**Example:** Steel bar tracked in lbs (primary). from_unit: "inches", to_primary_factor: 0.166 means 1 inch = 0.166 lbs

### inventory_transactions

Full audit trail of all inventory changes. Enables FR-13 (Transaction History).

| Column | Type | Required | Description |
|---|---|---|---|
| id | uuid | Yes | Primary key |
| company_id | uuid | Yes | FK to companies |
| inventory_item_id | uuid | Yes | FK to inventory_items |
| type | text | Yes | "addition", "depletion", "adjustment" |
| quantity | numeric | Yes | Amount changed (positive value) |
| unit | text | Yes | Unit used for this transaction |
| converted_quantity | numeric | Yes | Quantity in primary unit |
| job_id | uuid | No | FK to jobs (if from job completion) |
| operator_id | uuid | No | FK to operators (if operator action) |
| notes | text | No | Optional notes |
| created_at | timestamptz | Yes | Transaction timestamp |
| created_by | uuid | No | FK to users (if admin action) |

---

## UI Screens

### 1. Inventory List

**Route:** /dashboard/{companyId}/inventory

- Table columns: Item Name, Description, Quantity, Unit, Last Updated

- Search by name and description

- "+Add Item" button → Create screen

- Row click → Item Detail screen

### 2. Inventory Item Create/Edit

**Routes:** /dashboard/{companyId}/inventory/new, /dashboard/{companyId}/inventory/{id}/edit

Form Fields:

- Name (required)

- Description

- Primary Unit (required) - e.g., lbs, kg, pcs

- Current Quantity (required)

- Cost per Unit

- Unit Conversions section: Add secondary units with conversion factors

### 3. Inventory Item Detail

**Route:** /dashboard/{companyId}/inventory/{id}

- Item details card (name, description, unit)

- Current quantity (large display)

- Quick actions: Add Stock, Remove Stock, Adjust

- Edit button → Edit screen

- Transaction History table: Date, Type, Quantity, Unit, Job, User, Notes

- Pagination for transaction history

### 4. Add/Remove/Adjust Modal

Modal dialog for inventory adjustments.

- Select action type: Add Stock / Remove Stock / Adjust

- Quantity input

- Unit dropdown (primary + configured secondary units)

- Notes field

- System auto-converts to primary unit and updates quantity

---

## API Architecture

### Direct Supabase Operations

All inventory operations use the Supabase client with RLS policies (no backend API needed):

- **List items:** Query `inventory_items` table with RLS
- **Create item:** Insert into `inventory_items` with RLS
- **Update item:** Update `inventory_items` with RLS
- **Delete item:** Delete from `inventory_items` with RLS
- **Create transaction:** Insert into `inventory_transactions` with RLS
- **Get transactions:** Query `inventory_transactions` with RLS
- **Export:** Client-side CSV generation from fetched data

See `utils/inventoryAccess.ts` for implementation details.

> **Note:** No FastAPI backend endpoints are needed for inventory CRUD operations. The Supabase client handles all data access with row-level security policies ensuring proper multi-tenant isolation.

---

## Acceptance Criteria

**Inventory CRUD:**

- [ ] Owner can create inventory items with name, unit, quantity

- [ ] Owner can view list of all inventory items

- [ ] Owner can edit inventory item details

- [ ] Owner can delete inventory items

**Flexible Units (FR-1):**

- [ ] Owner can add secondary units with conversion factors

- [ ] When depleting inventory, user can specify any configured unit

- [ ] System converts to primary unit automatically

- [ ] Quantity display shows primary unit

**Transaction History (FR-13):**

- [ ] All inventory changes create transaction records

- [ ] Transactions show: timestamp, type, quantity, unit, user

- [ ] Transactions linked to job show job number

- [ ] History is filterable and exportable

**Operator Integration:**

- [ ] Operator material logging creates depletion transactions

- [ ] Transactions from operators link to job_id and operator_id

---

## Material Consumption Flow

Material tracking flows from routing → job → inventory:

1. **Routing setup.** A designer defines the materials needed for a part in `routing_materials` (see Routings module). Each row specifies an `inventory_item_id`, expected `quantity`, and `unit`.

2. **Job creation.** When a job is created for a part with a routing, `create_job_operations_from_routing()` copies every `routing_materials` row into `job_materials` with `status = 'pending'` and `expected_quantity` snapshotted from the routing. The snapshot lets the job keep its original shopping list even if the routing is later edited.

3. **Operator consumption.** On the shop floor, an operator opens the job and, via the `JobMaterialsCard`, marks each `job_materials` row as `consumed` (recording `actual_quantity`, which may differ from `expected_quantity`) or `skipped` (with a reason). Marking a row `consumed` records `consumed_at` and `consumed_by`.

4. **Inventory depletion.** Marking a `job_materials` row as `consumed` creates a corresponding `inventory_transactions` row of type `depletion`, linked back to the job via `job_id`, so the inventory balance stays in sync with the shop floor.

Materials live at the job (and routing) level — not per operation. A job has a single materials list, regardless of how many operations the routing has.

---

## Additional Requirements

### Quantity Validation Rules

The system must enforce the following validation rules:

- Quantity cannot go negative - Depletion transactions that would result in negative inventory must be rejected with an error message

- Zero quantity allowed - Items can have zero stock (indicates out of stock)

- Adjustment transactions - Can set quantity to any non-negative value (used for corrections/reconciliation)

### Hard Delete (No Soft Delete)

Inventory items use hard delete (no deleted_at column). When an item is deleted:

- The inventory_items record is permanently removed

- Associated inventory_unit_conversions are cascade deleted

- inventory_transactions remain orphaned for audit purposes (store item_name snapshot)
