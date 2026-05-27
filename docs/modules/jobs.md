# Jobs Module

## Overview

The Jobs module tracks production work through the shop. A **Job** is the project header — it mirrors a quote 1:1 (`Q-0141 → J-0141`) and owns the customer, due date, and aggregate status. Each part on the source quote becomes a child **`job_part`** with its own routing-derived operations + materials, status, and timestamps. Operators work on one `job_part` at a time.

**Priority:** Must Have (Build Fourth)

**Dependencies:**

- Customers module (jobs have a customer)

- Parts module (each `job_part` references a part; routing is auto-resolved from the part)

- Quotes module (jobs are created exclusively by converting an accepted quote — no manual job creation)

**Database Tables:** `jobs`, `job_parts`, `job_operations`, `job_materials`

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
| Operator | See ready operations at my station across all jobs and parts | I know what to work on next |
| Operator | Scan a job QR code, then pick which part I'm holding | I can drill into the correct routing |
| Operator | Mark an operation complete | The next operation on that part becomes ready |
| Operator | See when every operation on a part is done | I know that part is finished |
| Admin | Mark a fully-completed job as shipped | I can track what's been sent out |

---

## Data Model

### `jobs` (project header)

| Field | Type | Required | Description |
|---|---|---|---|
| id | UUID | Yes | Primary key |
| job_number | Text | Yes | Mirrors source quote (`Q-0141` → `J-0141`); set explicitly by `convertQuoteToJob`. No manual creation, no auto-numbering trigger |
| quote_id | UUID (FK) | Yes | Source quote (1:1 with the job) |
| customer_id | UUID (FK) | Yes | Link to customer |
| status | Text | Yes | Aggregate status (`not_started` / `in_progress` / `completed` / `shipped` / `cancelled`) — DERIVED from `job_parts.status` via the `compute_job_status()` function and the `trigger_sync_job_status_from_parts_*` triggers |
| due_date | Date | No | Date the job is due to ship |
| lead_time_days | Integer | No | Lead time in days, typically copied from the source quote |
| started_at | Timestamp | No | First time any part on the job moved to in_progress |
| completed_at | Timestamp | No | When all parts hit completed/shipped |
| shipped_at | Timestamp | No | When all parts moved to shipped |

### `job_parts` (one row per physical part)

| Field | Type | Required | Description |
|---|---|---|---|
| id | UUID | Yes | Primary key |
| job_id | UUID (FK) | Yes | Parent job |
| part_id | UUID (FK) | Yes | Link to the master part record |
| source_quote_line_item_id | UUID (FK) | No | The quote line that spawned this part |
| sequence | Integer | Yes | Display order within the job |
| quantity | Integer | Yes | Order qty (copied from the quote line) |
| status | Text | Yes | Per-part status — same enum as `jobs.status`, but owned at this level. Updates here trigger an aggregate refresh on `jobs.status` |
| current_operation_sequence | Integer | No | Cursor pointing at the next operation to start |
| started_at / completed_at / shipped_at | Timestamps | No | Per-part lifecycle timestamps |

`job_operations` and `job_materials` carry a `job_part_id` FK so each row belongs to exactly one part of one job. The `(job_part_id, sequence)` unique constraint replaces the old `(job_id, sequence)` so each part has its own independent operations sequence.

**Due date & conversion:** When a quote is converted via `convertQuoteToJob`, the caller can pass `leadTimeDays` to override the quote's value. If a lead time is present, `jobs.due_date = CURRENT_DATE + lead_time_days`. The job's due date is shared by every part — split-shipping deadlines are a future enhancement.

---

## UI Screens

### 1. Jobs List

**Route:** `/dashboard/{companyId}/jobs`

**Features:**

- Table showing: Job #, Customer, Parts (truncated list "ADP-001, ADP-002, +1 more"), Current Op, Status, Due, Created

- Search box (searches job number, customer name)

- Filter dropdown: Status (All Jobs / Not Started / In Progress / Completed / Shipped / Cancelled)

- No "create" button — jobs are produced exclusively by converting an accepted quote (Convert to Job button on the quote detail page)

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

Jobs are **only** created via quote conversion. There is no standalone "New Job" form. The `/dashboard/{companyId}/jobs/new` route and "New Job" button were removed in commit d9b7e98; the spec previously here described that flow.

To create a job today:
1. Build a quote with the desired customer / part / pricing tier.
2. Open the quote detail page.
3. Use the **Convert to Job** action; one job is produced per `(part, selected tier)` line on the quote.

The Convert flow lives in [Quotes](quotes.md) — see the "Convert to Job" section there for current behavior.

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

**Actions (based on aggregate status):**

| Current Status | Available Actions |
|---|---|
| Not Started | Cancel Job (cancels every part) |
| In Progress | Cancel Job |
| Completed | Mark Shipped, Cancel Job |
| Shipped | (read only) |
| Cancelled | (read only) |

Status transitions for `not_started → in_progress → completed` are NOT manual on the dashboard — they emerge from operator activity on individual `job_parts`, then aggregate up via the trigger. Manual "Start Job" / "Mark Complete" buttons were removed.

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

- [ ] Can cancel a job (cancels every job_part)

- [ ] `jobs.status` aggregates from `job_parts.status` via the database trigger — never manually set on the dashboard

- [ ] Jobs created from quotes show link back to quote

- [ ] Job number mirrors the source quote (`Q-NNNN → J-NNNN`)

- [ ] Every part on the source quote produces exactly one `job_part`

- [ ] Each `job_part` requires its part to have a routing — convert-to-job aborts before any insert if any part is missing one

- [ ] No manual "create job" UI exists

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
