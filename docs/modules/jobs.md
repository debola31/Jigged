# Jobs Module

## Overview

The Jobs module tracks production work through the shop. A **Job** is the project header — it mirrors a quote 1:1 (`Q-0141 → J-0141`) and owns the customer, due date, and aggregate status. Each part on the source quote becomes a child **`job_part`** with its own routing-derived operations + materials, status, and timestamps (a **bought** part has no routing, so its `job_part` has no operations and is production-complete on creation — see "Bought parts on jobs" below). Operators work on one `job_part` at a time.

**Priority:** Must Have (Build Fourth)

**Dependencies:**

- Customers module (jobs have a customer)

- Parts module (each `job_part` references a part; routing is auto-resolved from the part)

- Quotes module (a job can be created by converting an accepted quote) — jobs can also be created directly from a customer PO (see "Job Create — two paths")

**Database Tables:** `jobs`, `job_parts`, `job_operations`, `job_materials`

---

## Job Status Workflow

A job tracks **three independent status axes** (each stored on both `jobs` and `job_parts`, derived from the parts by DB trigger — see Data Model):

- **`production_status`** — `not_started → in_progress → completed`, plus `cancelled` from any non-terminal state.
- **`fulfillment_status`** — `unshipped → partially_shipped → fully_shipped` (advances as shipment records are created).
- **`invoicing_status`** — `uninvoiced → partially_invoiced → fully_invoiced` (advances as invoices are created).

```javascript
production_status:  NOT_STARTED ──► IN_PROGRESS ──► COMPLETED
                         │               │
                         └───────────────┴──────► CANCELLED
```

**Production status definitions:**

- **Not Started** - Job created, no operations have begun
- **In Progress** - Work has begun on the shop floor (first operation completed)
- **Completed** - All operations finished
- **Cancelled** - Job cancelled (can happen from any non-terminal state)

"Shipped" and "Invoiced" are **not** production states — they live on the fulfillment and invoicing axes above. A completed job can be simultaneously `partially_shipped` and `partially_invoiced`.

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
| job_number | Text | Yes | Every job off a quote keeps the quote's index: first mirrors it (`Q-0141` → `J-0141`), each **later PO on the same quote** gets a suffix (`J-0141-2`, `J-0141-3`, …). A direct-PO job (no quote) draws a fresh `J-N` from the shared order counter. Set explicitly by `convertQuoteToJob` / `createJobFromPurchaseOrder`. No manual creation, no auto-numbering trigger |
| quote_id | UUID (FK) | No | Source quote when the job came from one; **null** for jobs created directly from a PO. **Many jobs may share one `quote_id`** — a quote is converted in one or more passes, one job (one customer PO) per pass |
| customer_id | UUID (FK) | Yes | Link to customer |
| production_status | Text | Yes | `not_started` / `in_progress` / `completed` / `cancelled` — DERIVED from `job_parts.production_status` via `compute_job_production_status()` and the sync triggers; never written directly by the dashboard |
| fulfillment_status | Text | Yes | `unshipped` / `partially_shipped` / `fully_shipped` — DERIVED from the parts via `compute_job_fulfillment_status()` as shipment records are created |
| invoicing_status | Text | Yes | `uninvoiced` / `partially_invoiced` / `fully_invoiced` (default `uninvoiced`) — DERIVED from the parts via `compute_job_invoicing_status()` as invoices are created |
| due_date | Date | No | Date the job is due to ship — entered manually at conversion (not derived from lead time) |
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
| quantity | Numeric | Yes | Order qty — copied from the quote line at creation, then **editable** (see "Editing order quantity" below). Fractional allowed. |
| unit_price / total_price | Numeric(12,4) | No | Agreed price per unit and line total — the single source of price for invoicing and revenue. Re-derived on a quantity edit. |
| production_status / fulfillment_status / invoicing_status | Text | Yes | Per-part status on each axis — the source of truth. Updates here trigger an aggregate refresh of the matching column on `jobs` via DB trigger |
| current_operation_sequence | Integer | No | Cursor pointing at the next operation to start |
| started_at / completed_at / shipped_at | Timestamps | No | Per-part lifecycle timestamps |

`job_operations` and `job_materials` carry a `job_part_id` FK so each row belongs to exactly one part of one job. The `(job_part_id, sequence)` unique constraint replaces the old `(job_id, sequence)` so each part has its own independent operations sequence.

**Due date & conversion:** When a quote is converted via `convertQuoteToJob`, the due date is entered **manually** in the Convert-to-Job modal (required, not-in-the-past) and written straight to `jobs.due_date`. It is **no longer derived from lead time**, and the job no longer stores a lead-time snapshot. The job's due date is shared by every part — split-shipping deadlines are a future enhancement.

**Editing order quantity:** Customers commonly change quantity (up or down) after a quote converts, so `job_parts.quantity` is editable from the Job detail page (edit icon next to the "Order qty" chip) via `updateJobPartQuantity(jobPartId, newQty, opts?)`. The job — not the now-read-only quote — is the post-conversion source of truth. Behaviour:

- **Pricing:** defaults to keeping the agreed `unit_price`; if the new qty crosses a price break in the source quote line's frozen tier snapshot, the modal offers the re-resolved price (the user opts in). `total_price` is recomputed at 4 dp. PO-sourced / override / `basis_unknown` lines always keep their price.
- **Guardrails:** quantity must be `> 0` (decimals allowed); cannot drop below `max(already-shipped, already-invoiced)`. **Increases are always allowed even on an invoiced job** — that's how you bill more: raise the order, then invoice the delta on a new invoice. A part's unit price is locked once any quantity of it is invoiced (see [Invoicing](invoicing.md)). Cancelled parts are not editable.
- **Fulfillment & invoicing:** the `trigger_recompute_jp_fulfillment_on_qty` DB trigger recomputes `fulfillment_status` from `compute_job_part_fulfillment_status` after the edit (a part can flip `fully_shipped → partially_shipped` when qty increases); a parallel `trigger_recompute_jp_invoicing_on_qty` does the same for `invoicing_status` (`fully_invoiced → partially_invoiced`). The access layer never writes either status itself.
- **Audit:** the change is logged to the job feed as an `event`-type `job_note` (old → new qty, and any unit-price change).
- The originating quote stays read-only but reflects the live job quantity ("now N on job"); see the Quotes module.

---

## UI Screens

### 1. Jobs List

**Route:** `/dashboard/{companyId}/jobs`

**Features:**

- Table showing: Job #, Customer, Parts (truncated list "ADP-001, ADP-002, +1 more"), Current Op, Status (with an **"At vendor"** chip when parts are out for outside processing), Due, Created. The **Outside processing** queue itself lives on the **Vendors** page (Directory / Outside processing tabs) — outside processing is vendor work, not a job type — see [Outside (external-vendor) operations](#outside-external-vendor-operations).

- Search box (searches job number, customer name)

- Filter dropdown: Status (All Jobs / Not Started / In Progress / Completed / Shipped / Cancelled)

- **New Job from PO** button (top-right) — accept a customer PO and create a job directly, no quote. Jobs also come from the **Convert to Job** action on the quote detail page.

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

### 2. Job Create — two paths

A job can be created two ways:

**(a) Convert a quote.** Build a quote, open its detail page, and use **Convert to Job**; a job is produced with one work cell per `(part, selected quantity)`, carrying the customer PO entered at conversion. A quote can be converted in **several passes** — one job per PO, each covering a subset of the parts — so the same quote may spawn multiple jobs (button relabels to **Create Another Job** while lines remain). This flow lives in [Quotes](quotes.md).

**(b) New Job from PO (direct).** When a customer sends a PO with no prior quote, click **New Job from PO** on the jobs list. The "Accept Purchase Order" modal (a modal, not a `/jobs/new` route) captures the customer, PO #, due date, and one-or-more **existing** parts — each with a quantity and the agreed unit price — plus an optional PO PDF. When a part + quantity are chosen, the modal **pre-fills the expected sell price** (cost + markup at that quantity, resolved by the *same* `getTiersWithComputedPrices` + `resolveTier` path quote line items use — pure DB reads, no AI). The user can override it; if the entered price differs from expected, a non-blocking "Differs from expected $X" hint appears with a one-tap **Reset**. A part with no priced tier just leaves the price blank. On accept, `createJobFromPurchaseOrder` (`utils/jobsAccess.ts`) creates the job (`quote_id` null, job number `J-NNNN` from the shared per-company order counter — same sequence as quotes) and clones each **made** part's routing into operations + materials via the same `create_job_part_operations_from_routing` RPC the quote path uses. v1 is **existing parts only** — every **made** part must already have a routing (the create fails fast otherwise). Bought parts need no routing — see below.

**Bought parts on jobs (no operations).** A **bought** part is purchased, not manufactured, so it has no routing (routing is made-only — see [Parts](parts.md) / [Routings](routings.md)). Both job-creation paths therefore treat bought parts specially: they are **exempt from the routing pre-flight**, and the resulting `job_part` is created with **zero operations** and `production_status = 'completed'` (there is nothing to make), with `started_at`/`completed_at` stamped at creation. It flows straight to **fulfillment (ship) + invoicing** like any other part — the "work" for a bought part is buy → receive → ship, not shop-floor operations. This matches how job-shop ERPs handle purchased / COTS items (JobBOSS "buy-to-job", ProShop COTS): the purchased item rides the same order-to-ship document, it just skips manufacturing. A mixed job (some made, some bought) shows the bought parts already production-complete while the made parts run their routings; the job's rolled-up `production_status` follows `compute_job_production_status` as usual. A future purchasing module can add an explicit "received from vendor" step before shipping; today the bought part is shippable immediately.

Both paths store the agreed price on each `job_part` (`unit_price` / `total_price`), so PO-sourced and quote-sourced jobs invoice identically.

### 3. Job Detail View

**Route:** `/dashboard/{companyId}/jobs/{id}`

**Header:**

- Job number (large)

- Status pill

**Content Sections:**

▸ **Source**

- From Quote: Q-0042 (link), or "Direct PO" (job created from a customer PO; `quote_id` is null)

▸ **Attachments**

- Customer PO PDFs and other reference files — listed with **view (inline)**, download, and delete actions plus an "Upload PDF" button. **View** opens the file in a dialog (an `<iframe>` for PDFs, an `<img>` for images) off a fresh signed URL, so the user can read the PO without leaving the job page; download/delete still work as before. File bytes live in the private `attachments` bucket; metadata in `job_attachments`. Attached during PO intake / quote conversion (optional) or added here later. Backed by `utils/jobAttachmentsAccess.ts` + `components/jobs/JobAttachmentsCard.tsx`.

▸ **Invoicing (QuickBooks)**

- **Create invoice** lives on the job (invoicing is **job-keyed**; see [Architecture](../architecture.md)), and a job can have **many** invoices — progressive billing. The picker defaults each line to the **shipped-but-unbilled** qty and caps it at **ordered-but-unbilled** (billing ahead of shipping is allowed — a packing slip isn't a delivery — just softly flagged). Each invoice snapshots its price, so a part's price locks once any quantity of it is invoiced. Shipments + invoices live under a **Fulfillment** collapsible section; an **Invoices card** lists every created invoice with a "View in QuickBooks" link (replacing the old single "View invoice" button). Quote- and PO-sourced jobs invoice identically, reading price from `job_parts.unit_price`. Full spec: [Invoicing](invoicing.md).

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

| Current production status | Available actions |
|---|---|
| Not Started | Edit; Cancel Job (cancels every part); Delete (only if no shipments/invoices) |
| In Progress | Edit; Cancel Job; Delete (only if no shipments/invoices) |
| Completed | Edit; Create shipment; Create invoice; Cancel Job |
| Cancelled | Reopen (re-derives status from operations); Delete (only if no shipments/invoices) |

There is no "Mark Shipped" / "Start Job" / "Mark Complete" button — shipping is the side effect of creating a shipment record (which advances `fulfillment_status`).

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

`production_status` is **derived**, never set by a dashboard button. Transitions emerge from operator activity on operations and aggregate up via DB trigger:

| From | To | Trigger | Auto-set |
|---|---|---|---|
| Not Started | In Progress | First operation on any part is marked complete | started_at = now |
| In Progress | Completed | Last operation across all parts completed/skipped | completed_at = now |
| any non-terminal | Cancelled | Admin clicks "Cancel Job" (cancels every part) | - |
| Cancelled | (re-derived) | Admin clicks "Reopen" — each part's status recomputed from its operations | - |

Fulfillment (`unshipped → … → fully_shipped`) advances as shipment records are created; invoicing (`uninvoiced → … → fully_invoiced`) advances as invoices are created. Neither is a production transition.

---

## Acceptance Criteria

Each bullet is a Given/When/Then scenario carrying a **verification clause** — a pointer to the test that proves it (`*verified by <file> > 'test name'*`), a manual procedure, or an explicit `automation-pending` tag. Every editable entity has at least one `edit → save → reload → persists` bullet; where no E2E reloads after that save yet, the write path cites its unit test and the reload assertion is tagged `automation-pending` (tracked by #367). Doc-vs-code disagreements this audit surfaced are recorded in the divergence report on [issue #343](https://github.com/debola31/Jigged/issues/343).

**List, search & filter**

- [ ] **Given** a company with more jobs than fit one page, **when** a user opens the jobs list, **then** jobs render 25-per-page with Job #, Customer, Parts, Current Op, Status, Due, and Created columns — *column data exercised by `e2e/quote-to-job.spec.ts > 'Quote to Job workflow' > 'create quote and convert to job'`; pagination automation-pending*.
- [ ] **Given** the jobs list, **when** a user searches by job number, customer name, customer PO, part number, or packing-slip number, **then** matching jobs are returned and a blank query is a no-op — *verified by `__tests__/utils/jobsAccess.test.ts > 'searchJobsByIdentifier' > 'passes the trimmed query to the RPC and returns its rows'` AND `__tests__/utils/jobsAccess.test.ts > 'searchJobsByIdentifier' > 'short-circuits on empty/whitespace queries'`*.
- [ ] **Given** the jobs list with no explicit status filter, **when** it loads, **then** closed jobs (completed/shipped + cancelled) are hidden by default until their stages are selected — *verified by `__tests__/utils/jobsAccess.test.ts > 'getAllJobs' > 'hides closed jobs (done + cancelled) by default'` AND `e2e/jobs-list-status.spec.ts > 'Jobs list — combined status filter' > 'simplified toolbar hides closed jobs by default and selecting their stages reveals them'`*.
- [ ] **Given** the jobs list, **when** a user picks stages in the combined Status multi-select, **then** only jobs in those production/fulfillment stages show — *verified by `e2e/jobs-list-status.spec.ts > 'Jobs list — combined status filter' > 'narrows to a single stage via the combined Status multi-select'` AND `__tests__/utils/jobsAccess.test.ts > 'getAllJobs' > 'applies production/fulfillment status filters server-side via .in()'`*.
- [ ] **Given** a job whose `due_date` is past and which is not completed, shipped, or cancelled, **when** the list and the dashboard overdue count are computed, **then** the same canonical filter flags it overdue — *verified by `__tests__/utils/jobsAccess.test.ts > 'applyOverdueJobsFilter' > 'applies the canonical overdue clauses and returns the same builder'`*.

**Job creation — two paths, no manual create**

- [ ] **Given** an accepted quote whose parts all have routings, **when** a user converts it, **then** one job is created (`Q-NNNN → J-NNNN`) with one `job_part` per (part, selected quantity) and cloned routing operations — *verified by `e2e/quote-to-job.spec.ts > 'Quote to Job workflow' > 'create quote and convert to job'` AND `e2e/fractional-quote-to-job.spec.ts > 'Fractional quote to job workflow' > 'quote a fractional quantity of a length-measured part and convert to job'`*.
- [ ] **Given** a customer PO with no prior quote, **when** a user completes "Accept Purchase Order" with a customer, PO #, and ≥1 existing part (each a positive quantity and non-negative price, no duplicates), **then** a job is created with `quote_id` null and a job number drawn from the shared per-company order counter — *verified by `__tests__/utils/jobsAccess.test.ts > 'createJobFromPurchaseOrder' > 'requires a customer PO (no silent NULL) and writes nothing'`, `__tests__/utils/jobsAccess.test.ts > 'createJobFromPurchaseOrder' > 'requires a customer'`, `__tests__/utils/jobsAccess.test.ts > 'createJobFromPurchaseOrder' > 'requires at least one line'`, `__tests__/utils/jobsAccess.test.ts > 'createJobFromPurchaseOrder' > 'rejects a non-positive or non-integer quantity'`, `__tests__/utils/jobsAccess.test.ts > 'createJobFromPurchaseOrder' > 'rejects a negative unit price'`, and `__tests__/utils/jobsAccess.test.ts > 'createJobFromPurchaseOrder' > 'rejects duplicate parts before any write'`*.
- [ ] **Given** a PO line whose **made** part has no routing, **when** the user tries to accept, **then** creation fails fast before any insert (existing-parts-only gate) — *verified by `__tests__/utils/jobsAccess.test.ts > 'createJobFromPurchaseOrder' > 'fails fast when a part has no routing (existing-parts-only gate)'`*.
- [ ] **Given** a quote/PO line whose part is **bought** (no routing), **when** the job is created, **then** the routing pre-flight is skipped and the `job_part` is created with zero operations and `production_status = 'completed'`, ready to ship + invoice — *manual + DB-validated (rolled-back txn: a completed bought `job_part` with 0 operations rolls the job up to `completed`); full-flow E2E automation-pending.*
- [ ] **Given** the app, **when** a user looks for a "new blank job" route, **then** none exists — jobs come only from Convert-to-Job or New Job from PO — *manual: no `/jobs/new` route under `app/dashboard/[companyId]/jobs/`*.

**Status model — three derived axes**

The `jobs` and `job_parts` tables each carry three independent status columns — `production_status`, `fulfillment_status`, and `invoicing_status` (confirmed in `supabase/schema.prod.sql`). Job-level values are **derived from the parts by DB triggers**; the access layer never writes them directly. (There is no single `jobs.status` column.)

- [ ] **Given** a job with parts, **when** a part's `production_status` changes, **then** `jobs.production_status` is recomputed by `compute_job_production_status()` via trigger and is never set from the dashboard — *manual: `compute_job_production_status` in `supabase/schema.prod.sql`; trigger-cascade E2E automation-pending*.
- [ ] **Given** a not-started job, **when** the first operation on any part is marked complete, **then** the job auto-progresses to `in_progress` — there is no manual "Start Job" — *automation-pending*.
- [ ] **Given** an in-progress job, **when** the last operation across all parts is completed or skipped, **then** the job auto-progresses to `completed` — there is no manual "Mark Complete" — *automation-pending*.
- [ ] **Given** a job with shipped quantities, **when** shipment records are created, **then** `fulfillment_status` advances (`unshipped → partially_shipped → fully_shipped`) as a side effect — there is no "Mark Shipped" production transition (see divergence report) — *automation-pending*.
- [ ] **Given** a job with shipped-but-unbilled quantity, **when** an invoice is created, **then** `invoicing_status` advances and the invoice is listed — *verified by `e2e/job-invoicing.spec.ts > 'Job invoicing (QuickBooks)' > 'creates an invoice for the shipped quantity and lists it'`*.

**Editing a job (edit → save → reload → persists)**

- [ ] **Given** an existing job, **when** an admin edits a part's order quantity and saves, **then** reloading shows the new quantity and a 4dp-recomputed line total, keeping the agreed unit price by default — *write path verified by `__tests__/utils/jobsAccess.test.ts > 'updateJobPartQuantity' > 'keeps the agreed unit price by default and recomputes the total; never writes fulfillment_status'` AND `__tests__/utils/jobsAccess.test.ts > 'updateJobPartQuantity' > 'rounds the line total to 4 decimal places (matching numeric(12,4))'`; reload-persistence E2E automation-pending (#367)*.
- [ ] **Given** a quantity edit that crosses a price break, **when** the user opts into the re-resolved price, **then** the new tier price applies; **when** they don't, the agreed price is kept — *verified by `__tests__/utils/jobsAccess.test.ts > 'updateJobPartQuantity' > 'applies the quantity-break price when the caller opts in and the tier crosses'` AND `__tests__/utils/jobsAccess.test.ts > 'updateJobPartQuantity' > 'keeps the agreed price across a tier when the caller does NOT opt in'`*.
- [ ] **Given** an existing job, **when** an admin edits a part's unit price and saves, **then** reloading shows the new price and recomputed total (zero allowed) — *write path verified by `__tests__/utils/jobsAccess.test.ts > 'updateJobPartPrice' > 'recomputes the total at the new price; never writes fulfillment_status'` AND `__tests__/utils/jobsAccess.test.ts > 'updateJobPartPrice' > 'allows a zero (no-charge) price'`; reload-persistence E2E automation-pending (#367)*.
- [ ] **Given** an existing job, **when** an admin edits the customer PO number or due date and saves, **then** reloading shows the new values and unspecified fields are untouched (`""` clears to null) — *write path verified by `__tests__/utils/jobsAccess.test.ts > 'updateJobDetails' > 'patches only the provided header fields; empty string clears to null'` AND `__tests__/utils/jobsAccess.test.ts > 'updateJobDetails' > 'omits keys that were not provided'`; reload-persistence E2E automation-pending (#367)*.
- [ ] **Given** an existing job, **when** an admin changes the billing address, shipping address, or contact and saves, **then** reloading shows the new links, with `""` translated to null and unspecified FKs left alone — *write path verified by `__tests__/utils/jobsAccess.test.ts > 'updateJobAddressContact' > 'writes the three FKs scoped to job + company, translating "" to null'` AND `__tests__/utils/jobsAccess.test.ts > 'updateJobAddressContact' > 'omits keys left undefined so a partial update does not clobber other FKs'`; reload-persistence E2E automation-pending (#367)*.

**Edit guardrails**

- [ ] **Given** a part with shipped or invoiced quantity, **when** a user tries to reduce the order below that floor, **then** it is blocked — *verified by `__tests__/utils/jobsAccess.test.ts > 'updateJobPartQuantity' > 'blocks reducing below the already-shipped quantity'` AND `__tests__/utils/jobsAccess.test.ts > 'updateJobPartQuantity' > 'blocks reducing below the already-invoiced quantity'`*.
- [ ] **Given** an invoiced part, **when** a user increases its order quantity, **then** it is allowed (bill the delta on a new invoice) — *verified by `__tests__/utils/jobsAccess.test.ts > 'updateJobPartQuantity' > 'allows INCREASING quantity even after the part is invoiced (the 10 -> 15 case)'`*.
- [ ] **Given** a part with any invoiced quantity, **when** a user tries to change its unit price, **then** it is locked; an un-invoiced part on the same job is still repriceable — *verified by `__tests__/utils/jobsAccess.test.ts > 'updateJobPartPrice' > 'locks the price once ANY quantity of the part is invoiced'` AND `__tests__/utils/jobsAccess.test.ts > 'updateJobPartPrice' > 'still allows repricing a part with no invoiced quantity on a partially-invoiced job'`*.
- [ ] **Given** a cancelled part, **when** a user tries to edit its quantity or price, **then** it is refused — *verified by `__tests__/utils/jobsAccess.test.ts > 'updateJobPartQuantity' > 'refuses to edit a cancelled part'` AND `__tests__/utils/jobsAccess.test.ts > 'updateJobPartPrice' > 'refuses to edit a cancelled part'`*.

**Operations**

- [ ] **Given** a job part with a ready operation, **when** it is marked complete, **then** the next-sequence operation becomes ready and the Current Op column updates — *automation-pending (`completeJobOperation`)*.
- [ ] **Given** a completed operation, **when** a user taps Undo, **then** it returns to pending — *automation-pending (`undoJobOperation`)*.
- [ ] **Given** a job, **when** the list computes its Current Op, **then** it shows the in-progress op if any, else the lowest-sequence ready pending op, "Done" for completed/shipped, and "--" for cancelled — *verified by `__tests__/utils/jobsAccess.test.ts > 'getReadyOperationsForJobs' > 'maps RPC rows into a Map<job_id, CurrentOperationInfo>'` AND `__tests__/utils/jobsAccess.test.ts > 'getReadyOperationsForJobs' > 'returns an empty Map when RPC errors (defensive — dashboard tile should not crash)'`*.

**Cancel, reopen, delete**

- [ ] **Given** a job, **when** an admin cancels it with a reason, **then** every `job_part` is set cancelled — *verified by `__tests__/utils/jobsAccess.test.ts > 'bulkCancelJobs' > 'filters out non-string ids and marks job_parts cancelled by job_id'`; single-job cancel-reason capture automation-pending*.
- [ ] **Given** a cancelled job, **when** an admin reopens it, **then** each part's status is re-derived from its operations (bypassing the cancelled skip) — *verified by `__tests__/utils/jobsAccess.test.ts > 'reopenJob' > 'recomputes each part status from its operations (bypassing the cancelled-skip)'`*.
- [ ] **Given** a job with no shipments and no invoices, **when** an admin deletes it, **then** it is removed regardless of production status; **given** shipment or invoice records exist, **then** the delete is rejected and nothing is removed — *verified by `__tests__/utils/jobsAccess.test.ts > 'deleteJob' > 'deletes a job with no shipments or invoice, scoped to company_id (any status)'`, `__tests__/utils/jobsAccess.test.ts > 'deleteJob' > 'rejects when the job has shipment records and never deletes'`, and `__tests__/utils/jobsAccess.test.ts > 'deleteJob' > 'rejects when the job has been invoiced and never deletes'`*.

**Attachments**

- [ ] **Given** a job, **when** an admin uploads, views inline, or deletes a PO PDF, **then** the change persists across reload — *automation-pending (`utils/jobAttachmentsAccess.ts` + `components/jobs/JobAttachmentsCard.tsx`)*.

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

- `status` - pending | in_progress | completed | **sent** (outside op at vendor — see below)

- `estimated_setup_minutes` / `estimated_run_minutes_per_unit` - Copied from routing

- `sent_at` / `sent_by` - When an outside op was sent to the vendor (received reuses `completed_at` / `completed_by`)

- `completed_at` - Completion timestamp

> Note: the shipped operator/admin flow is complete-only (no Start/Skip step and no
> `actual_*`-hours capture); the values above reflect the current schema.

---

## Outside (external-vendor) operations

An operation routed to a work center with `kind='external'` is performed by an outside vendor
(e.g. anodizing, plating, heat-treat). It is a first-class routing step, not paperwork — it
appears everywhere internal steps do, with a distinct identity, and drives whoever ships the
parts out.

**Lifecycle (a send/receive axis on `job_operations.status`):**

- `pending → (Mark Sent Out) sent → (Mark Received) completed`.
- `sent` is an **optional waypoint**: Mark Received also completes directly from `pending` (the
  common after-the-fact case), back-filling `sent_at = completed_at`.
- **Received == completed** (reuses `completed_at` / `completed_by`), so every part/job rollup
  works unchanged; a `sent` op counts as *not completed*, holding the part at `in_progress`.
- An external op can **never** be completed through the internal Mark Complete path
  (`completeOperation` / `completeJobOperation` throw); it is **never auto-skipped** (the
  routing→job snapshot creates it `pending` and nothing advances it without a human action).
- Undo steps back one state: received → `sent` (or → `pending` for a legacy op that never went
  through send); `sent` → `pending`.

**Surfaces:** the admin Job Detail op card, the operator traveler + operation page (Mark Sent
Out / Mark Received, "Outside process" badge + vendor), the printed traveler (light-gray
highlighted band + bold "OUTSIDE" flag, low-ink and grayscale-safe), and the company-wide **Outside processing** queue — a **tab on the Vendors
page** (Directory / Outside processing), grouped **Not sent** / **At vendor**, sorted by job due date
(hot-first), with inline Mark Sent Out / Mark Received (`components/jobs/OutsideWorkPanel.tsx`,
backed by `getOutsideOpsForCompany`). Outside processing is vendor work, so its queue lives
under Vendors rather than as a pseudo job-type on the Jobs list (matches how job-shop ERPs —
SyteLine, Infor, Oracle — surface outside processing in the vendor/purchasing context). No
readiness/predecessor logic — it informs the shipping lead, replacing the hand-highlighted
traveler / paper slip. The queue and each row offer Undo (received → sent → not-sent).

**Audit / activity:** send/receive are **not** logged as `job_notes` — `sent_at`/`sent_by` and
`completed_at`/`completed_by` on the operation are the record, and the **/activity** feed
derives vendor-tagged **"Sent to {vendor}"** and **"Received from {vendor}"** rows under the
**Operations** filter (alongside internal "Operation completed"), from those columns
(`dashboardAccess.fetchOperationActivity`). Undo just clears the stamp, so the activity drops
off on reload — same as internal-completion undo (no tombstone). Operator notes + photos stay
fully enabled on outside ops; they are real user notes, no longer polluted by auto-events.

**Deferred (v1):** vendor lead-time → due-date math, PO generation, per-op cost actuals,
scheduling, and partial/split sends (whole-quantity send/receive only).

---

## Current Operation Column

The jobs list includes a "Current Op" column that shows the next ready operation for each job. Readiness is sequence-based: a pending operation is ready when every earlier-sequence operation on the same job is `completed` or `skipped`.

**Display Logic:**

- **In-progress operation exists:** Shows that operation's name (takes priority over pending/ready ops)

- **Next ready operation:** Shows the lowest-sequence pending operation whose predecessors are all completed or skipped

- **Completed/Shipped job:** Shows "Done" in italic secondary text

- **Outside op at vendor:** a job whose current live step is a `sent` outside op reads as
  incomplete in the standard list; the Jobs list badges those rows **"At vendor"** so they
  don't look stalled, and the **Vendors → Outside processing** tab is the worklist for them.

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
