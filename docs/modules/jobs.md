# Jobs Module

## Overview

The Jobs module tracks production work through the shop. Jobs represent actual work to be done - they're created from accepted quotes (or directly) and tracked through to completion and shipping.

**Priority:** Must Have (Build Fourth)

**Dependencies:**

- Customers module (jobs have a customer)

- Parts module (jobs reference parts; routing is auto-resolved from the part)

- Quotes module (jobs are typically created from quotes)

**Database Table:** `jobs`

---

## Job Status Workflow

```javascript
NOT_STARTED ──► IN_PROGRESS ──► COMPLETED ──► SHIPPED
     │              │
     └──────────────┴──────► CANCELLED
```

**Status Definitions:**

- **Not Started** - Job created, no operations have begun
- **In Progress** - Work has begun on the shop floor
- **Completed** - All work finished, ready to ship
- **Shipped** - Job shipped to customer
- **Cancelled** - Job cancelled (can happen from any status)

### Overdue (derived)

A job is considered **overdue** when `due_date < today` and the job is not yet `completed`, `shipped`, or `cancelled`. Overdue is *not stored* as a status — it's derived at read time via `isJobOverdue(job)` in `types/job.ts`. This preserves the real progress state (a job can be both "in progress" and "overdue" simultaneously) and avoids a cron job to flip statuses.

Overdue surfaces as:
- A red "Overdue" chip next to the normal status chip on the jobs list, job detail header, and job cards.
- The `overdue_jobs` dashboard metric tile (counted via `getOverdueJobsCount`).

---

## User Stories

| As a... | I want to... | So that... |
|---|---|---|
| Owner | View all active jobs | I can see what's in production |
| Owner | Filter jobs by status, customer | I can focus on specific work |
| Owner | Create a job directly (without quote) | I can handle rush orders or internal work |
| Operator | See what jobs are pending | I know what to work on next |
| Operator | Mark a job as in progress | Others know I'm working on it |
| Operator | Mark a job as complete | It moves to the shipping queue |
| Admin | Mark a job as shipped | I can track what's been sent out |

---

## Data Model

| Field | Type | Required | Description |
|---|---|---|---|
| id | UUID | Yes | Primary key (auto-generated) |
| job_number | Text | Auto | Auto-generated: J-0001, J-0002, etc. |
| quote_id | UUID (FK) | No | Link to source quote (if created from quote) |
| customer_id | UUID (FK) | Yes | Link to customer |
| part_id | UUID (FK) | Yes | Link to part (routing is auto-resolved from the part's routing) |
| description | Text | No | Job/part description |
| status | Text | Yes | not_started, in_progress, completed, shipped, cancelled |
| due_date | Date | No | Date the job is due to ship. Used to derive the "Overdue" badge |
| lead_time_days | Integer | No | Lead time in days, typically copied from the source quote. Editable on the job |
| started_at | Timestamp | No | When job moved to in_progress |
| completed_at | Timestamp | No | When job moved to complete |
| shipped_at | Timestamp | No | When job moved to shipped |
| notes | Text | No | Internal notes |

**Due date & conversion:** When a quote is converted to a job via `convert_quote_to_job()`, the caller can pass `p_lead_time_days` to override the quote's value. If a lead time is present, `jobs.due_date = CURRENT_DATE + lead_time_days`. Both fields remain editable on the job after creation.

---

## UI Screens

### 1. Jobs List

**Route:** `/dashboard/{companyId}/jobs`

**Features:**

- Table showing: Job #, Customer, Part, Current Op, Description, Status, Created

- Search box (searches job number, customer name, part number)

- Filter dropdown: Status (All Jobs / Not Started / In Progress / Completed / Shipped / Cancelled)

- "+ New Job" button

- Click row to view detail

- Pagination (25 per page)

**Status Pills:**

- Not Started = Gray

- In Progress = Blue

- Completed = Green

- Shipped = Purple

- Cancelled = Red strikethrough

**Empty State:**

"No jobs yet. Create a job or convert a quote to get started."

### 2. Job Create

**Route:** `/dashboard/{companyId}/jobs/new`

**Note:** Jobs are usually created via quote conversion, but direct creation is supported.

**Form Sections:**

▸ **Customer** (required)

- Customer dropdown with search with quick create option similar to quotes

▸ **Part** (required)

- Part dropdown (all company parts, independent of selected customer). A part must be selected to proceed. If the selected part has no routing, a warning is shown with a link to create one from the part detail page.

**Note:** Routing is auto-resolved from the selected part. There is no routing dropdown. The part must have a routing defined for the job to be created.

▸ **Notes**

- Notes (multiline)

**Actions:**

- Create Job → Creates job in Not Started status, redirects to detail

- Cancel → Returns to list

### 3. Job Detail View

**Route:** `/dashboard/{companyId}/jobs/{id}`

**Header:**

- Job number (large)

- Status pill

**Content Sections:**

▸ **Source**

- From Quote: Q-0042 (link) - or "Direct entry"

▸ **Customer**

- Customer name (link to customer)

- Contact info

▸ **Part**

- Part number (link to part if exists)

- Description

▸ **Timeline**

- Created: Dec 28, 2025

- Started: Dec 29, 2025 (or "-")

- Completed: - (or date)

- Shipped: - (or date)

▸ **Notes**

- Notes text

**Actions (based on status):**

| Current Status | Available Actions |
|---|---|
| Not Started | Start Job, Edit, Cancel Job |
| In Progress | Update Progress, Mark Complete, Cancel Job |
| Completed | Mark Shipped, Reopen (back to In Progress) |
| Shipped | (read only) |
| Cancelled | (read only) |

### 4. Cancel Job Confirmation

**Trigger:** Click "Cancel Job"

**Modal Content:**

- "Are you sure you want to cancel job J-0042?"

- "This action cannot be undone."

- Cancellation Reason (required text input)

**Actions:**

- Cancel Job → Sets status to cancelled, saves reason in notes

- Keep Job → Closes modal

---

## Status Transition Rules

| From | To | Trigger | Auto-set |
|---|---|---|---|
| Not Started | In Progress | User clicks "Start Job" (or first operation starts) | started_at = now |
| Not Started | Cancelled | User clicks "Cancel Job" | - |
| In Progress | Complete | User clicks "Mark Complete" (or all operations done) | completed_at = now |
| In Progress | Cancelled | User clicks "Cancel Job" | - |
| Complete | Shipped | User clicks "Mark Shipped" | shipped_at = now |
| Complete | In Progress | User clicks "Reopen" | completed_at = null |

---

## Acceptance Criteria

- [ ] Can view paginated list of jobs

- [ ] Can search jobs by number, customer, part

- [ ] Can filter by status

- [ ] Can filter by customer

- [ ] Can sort by created date and other fields in table

- [ ] Can create new job directly

- [ ] Job number auto-generates (J-0001 format)

- [ ] Can view job detail with all information

- [ ] Can start a not started job (moves to in_progress)

- [ ] Can update progress (completed/scrapped quantities)

- [ ] Can mark in_progress job as complete

- [ ] Can mark complete job as shipped

- [ ] Can reopen a complete job back to in_progress

- [ ] Can cancel a job from not started or in_progress

- [ ] Timestamps auto-set on status transitions

- [ ] Jobs created from quotes show link back to quote

- [ ] Jobs created from quotes show attachments added to quote

- [ ] Part is required when creating a job (no ad-hoc jobs without a part)

- [ ] Part must have a routing to create a job (routing auto-resolved from part)

- [ ] No routing dropdown in job form — routing is auto-resolved

- [ ] Customer and part selection are independent (not cascading)

- [ ] Quote-to-job conversion requires the part to have a routing; blocked with link to create one if missing

- [ ] Jobs list shows "Current Op" column with sequence-aware next operation

- [ ] Current Op column shows in-progress operation name when one is active

- [ ] Current Op column shows the next ready (lowest-sequence pending) operation when no op is in progress

- [ ] Current Op column shows "Done" for completed/shipped jobs and "--" for cancelled jobs

---

## Job Operations Tracking

Jobs automatically have operations copied from the part's routing when created. These operations can be stepped through on the Job Detail page with Start, Complete, Skip, and Undo actions.

**Operation Status Workflow:**

- **Pending** - Operation not yet started

- **In Progress** - Operation currently being worked on (only one at a time)

- **Completed** - Operation finished successfully (can record actual hours)

- **Skipped** - Operation skipped (with optional reason)

**Auto-Progression Rules:**

- When first operation starts → Job auto-transitions from Pending to In Progress

- When all operations are completed/skipped (with at least one completed) → Job auto-completes

- Manual Start/Complete buttons are hidden when operations exist (auto-progression handles these transitions)

**Database Table: **`job_operations`

- `sequence` - Execution order (10, 20, 30...), copied from `routing_nodes.sequence`

- `operation_name` - Name from operation type

- `routing_node_id` - FK to routing_nodes, links back to the routing operation this was created from

- `status` - pending | in_progress | completed | skipped

- `estimated_setup_minutes` / `estimated_run_minutes_per_unit` - Copied from routing

- `actual_setup_minutes` / `actual_run_minutes` - Recorded when completing

- `started_at` / `completed_at` - Timestamps for tracking

---

## Current Operation Column

The jobs list includes a "Current Op" column that shows the next ready operation for each job. Readiness is sequence-based: a pending operation is ready when every earlier-sequence operation on the same job is `completed` or `skipped`.

**Display Logic:**

- **In-progress operation exists:** Shows that operation's name (takes priority over pending/ready ops)

- **Next ready operation:** Shows the lowest-sequence pending operation whose predecessors are all completed or skipped

- **Completed/Shipped job:** Shows "Done" in italic secondary text

- **Cancelled job or no routing data:** Shows "--"

**Sequence-Based Readiness Logic:**

A pending operation is considered "ready" when no earlier-sequence `job_operation` on the same job is still `pending` or `in_progress` — that is, every op with a lower `sequence` is already `completed` or `skipped`. The first operation in a routing (lowest sequence) is ready immediately if it is `pending`.

**Implementation:** Uses the `get_ready_operations_batch()` database function for efficient batch querying across all visible jobs. The station-side variant `get_ready_operations_for_station()` uses the same sequence-based rule.

---

## Job Creation from Routing

When a job is created for a part that has a routing, the DB function `create_job_operations_from_routing(p_job_id, p_routing_id)` runs and:

1. Inserts one `job_operations` row per `routing_nodes` row, ordered by `routing_nodes.sequence`. The new rows get fresh sequences of 10, 20, 30, ... and carry over `operation_type_id`, `instructions`, `setup_time`, and `run_time_per_unit`.

2. Copies the routing's materials into `job_materials` — one row per `routing_materials` row — capturing each material as a snapshot for this job.

3. Sets `jobs.current_operation_sequence = 10` so the job is primed to start at the first operation.

If the routing is later edited, existing jobs are not retroactively updated. They keep their snapshot in `job_operations` and `job_materials`.

---

## Material Tracking

Jobs carry a routing-level materials list (not per-operation). When a job is created, each routing material is snapshotted into `job_materials`. Operators mark materials as consumed (or skipped) and can record an actual quantity that differs from the expected quantity.

### `job_materials` Table

| Column | Type | Required | Description |
|---|---|---|---|
| id | uuid | Yes | Primary key |
| job_id | uuid | Yes | FK to jobs (cascade delete) |
| routing_material_id | uuid | No | FK to routing_materials; set to NULL if the source routing material is deleted |
| inventory_item_id | uuid | Yes | FK to inventory_items (restricted delete) |
| expected_quantity | numeric | Yes | Snapshot of `routing_materials.quantity` at job creation (>= 0) |
| actual_quantity | numeric | No | Quantity actually consumed, recorded by the operator on consumption. NULL until consumed. |
| unit | text | Yes | Unit of measure (snapshot from routing material) |
| status | text | Yes | `pending`, `consumed`, or `skipped` |
| consumed_at | timestamptz | No | Timestamp when status moved to `consumed` |
| consumed_by | uuid | No | FK to `auth.users` — who marked it consumed |
| created_at | timestamptz | Yes | Record creation |
| updated_at | timestamptz | Yes | Last update |

### UI

The Job Detail page includes a `JobMaterialsCard` (`components/jobs/JobMaterialsCard.tsx`) that lists the job's materials with their expected quantity, actual quantity, and status, and exposes the actions to mark a material consumed or skipped.

### User Flow

- Designer defines materials once on the routing (`routing_materials`).
- Job creation copies those materials into `job_materials` with `status = 'pending'` and `expected_quantity` snapshotted from the routing.
- Operator marks each material `consumed` (recording `actual_quantity` and optionally differing from expected) or `skipped` (with a reason). This is what drives the inventory depletion transaction — see [Inventory Module — Material Consumption Flow](inventory.md#material-consumption-flow).
