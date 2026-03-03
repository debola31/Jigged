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
  PENDING
     │
     ▼
IN_PROGRESS ◄──► ON_HOLD
     │
     ▼
 COMPLETED
     │
     ▼
  SHIPPED
```

**Status Definitions:**

- **Pending** - Job created, not yet started

- **In Progress** - Work has begun on the shop floor

- **On Hold** - Job paused (can resume back to In Progress)

- **Completed** - All work finished, ready to ship

- **Shipped** - Job shipped to customer

- **Cancelled** - Job cancelled (can happen from any status)

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
| status | Text | Yes | pending, in_progress, on_hold, completed, shipped, cancelled |
| started_at | Timestamp | No | When job moved to in_progress |
| completed_at | Timestamp | No | When job moved to complete |
| shipped_at | Timestamp | No | When job moved to shipped |
| notes | Text | No | Internal notes |

---

## UI Screens

### 1. Jobs List

**Route:** `/dashboard/{companyId}/jobs`

**Features:**

- Table showing: Job #, Customer, Part, Current Op, Description, Status, Created

- Search box (searches job number, customer name, part number)

- Filter dropdown: Status (All / Pending / In Progress / On Hold / Completed / Shipped)

- "+ New Job" button

- Click row to view detail

- Pagination (25 per page)

**Status Pills:**

- Pending = Gray

- In Progress = Blue

- On Hold = Yellow/Warning

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

- Create Job → Creates job in Pending status, redirects to detail

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
| Pending | Start Job, Edit, Cancel Job |
| In Progress | Put On Hold, Update Progress, Mark Complete, Cancel Job |
| On Hold | Resume Job (back to In Progress), Cancel Job |
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
| Pending | In Progress | User clicks "Start Job" | started_at = now |
| Pending | Cancelled | User clicks "Cancel Job" | - |
| In Progress | Complete | User clicks "Mark Complete" | completed_at = now |
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

- [ ] Can start a pending job (moves to in_progress)

- [ ] Can update progress (completed/scrapped quantities)

- [ ] Can mark in_progress job as complete

- [ ] Can mark complete job as shipped

- [ ] Can reopen a complete job back to in_progress

- [ ] Can cancel a job from pending or in_progress

- [ ] Timestamps auto-set on status transitions

- [ ] Jobs created from quotes show link back to quote

- [ ] Jobs created from quotes show attachments added to quote

- [ ] Part is required when creating a job (no ad-hoc jobs without a part)

- [ ] Part must have a routing to create a job (routing auto-resolved from part)

- [ ] No routing dropdown in job form — routing is auto-resolved

- [ ] Customer and part selection are independent (not cascading)

- [ ] Quote-to-job conversion requires the part to have a routing; blocked with link to create one if missing

- [ ] Jobs list shows "Current Op" column with DAG-aware next operation

- [ ] Current Op column shows in-progress operation name when one is active

- [ ] Current Op column shows parallel ready ops with "+N" notation

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

- `sequence` - Execution order (10, 20, 30...)

- `operation_name` - Name from operation type

- `routing_node_id` - FK to routing_nodes, links back to the DAG node this operation was created from

- `status` - pending | in_progress | completed | skipped

- `estimated_setup_hours` / `estimated_run_hours_per_unit` - Copied from routing

- `actual_setup_hours` / `actual_run_hours` - Recorded when completing

- `started_at` / `completed_at` - Timestamps for tracking

---

## Current Operation Column

The jobs list includes a "Current Op" column that shows the next ready operation for each job. This is DAG-aware, meaning it respects the routing's dependency graph to determine which operations are ready.

**Display Logic:**

- **In-progress operation exists:** Shows that operation's name (takes priority over pending/ready ops)

- **Single ready operation:** Shows the operation name

- **Multiple parallel ready operations:** Shows the first operation name alphabetically, plus a "+N" chip indicating additional parallel operations (e.g., "CNC Mill +2")

- **Completed/Shipped job:** Shows "Done" in italic secondary text

- **Cancelled job or no routing data:** Shows "--"

**DAG Readiness Logic:**

A pending operation is considered "ready" when all of its predecessor nodes in the routing graph have corresponding job_operations in `completed` or `skipped` status. Start nodes (no incoming edges) are ready immediately if they are `pending`.

**Implementation:** Uses the `get_ready_operations_batch()` database function for efficient batch querying across all visible jobs.

---

## Material Tracking on Job Operations

Job operations include expected material definitions copied from the routing when the job is created. This enables operators to know what materials are expected for each operation.

### job_operations.materials Column

Add the following column to the job_operations table:

Column: materials | Type: jsonb | Required: No | Description: Expected materials for this operation (copied from routing_node.materials)

### materials JSONB Structure

The materials field is an array of material specifications:

```json
[
  {
    "inventory_item_id": "uuid",
    "quantity": 0.5,
    "unit": "lbs",
    "inventory_item_name": "4140 Steel Bar"
  }
]
```

### Job Creation from Routing

When a job is created with a routing:

- For each routing_node, create a job_operation

- Copy routing_node.materials to job_operation.materials

- Include inventory_item_name snapshot in case item is later deleted

- Operators can then log actual materials used when completing the operation
