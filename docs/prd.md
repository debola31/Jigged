# Product Requirements Document

### 1. Overview

Jigged is a web-based data platform for small manufacturing shops that struggle to manage their custom workflows in existing legacy systems. It centralizes jobs, inventory tracking, and shop-floor status into focused tabs, then layers on AI-assisted insights to surface bottlenecks and recommend actions to preserve operational efficiency. A deliberately minimal operator app — record what you finished, write down what you learned — keeps shop-floor capture cheap enough to actually happen, so owners get reliable visibility into their production. (An earlier gamification premise — operator metrics, streaks, achievements — was **withdrawn**; see §4.3.)

**Problem Statement**

Small machine shop owners face three core challenges that legacy ERP systems fail to address:

1. **Inflexible Inventory Management**: They cannot easily record material depletion and additions in both granular and bulk measurements (e.g., depleting 3 oz from a 10 lb bar of steel), and they lack clear signals for when items should be reordered before stockouts impact production.

2. Limited Visibility into Shop-Floor Operations: They lack an integrated view of work in progress tied to revenue and labor. Owners cannot see which jobs are generating revenue, where bottlenecks exist, or how individual jobs are progressing through work centers.

3. Operator Compliance Gaps: They struggle to get operators to consistently follow process steps that aren't blocking but are essential for optimization and traceability—such as logging material usage, recording what they finished at each work center, or following quality checkpoints.

Today, these shops rely on legacy ERP systems like Tangle and E2 JobBoss, which are rigid, hard to customize, and do not provide flexible inventory handling, restock insights, or intuitive, actionable views of shop-floor status and operator compliance.

**Goals and Objectives**

Success looks like:

1. **Reduce admin workload by 10+ hours per week** across shop administrative staff within 3 months of adoption

2. **Achieve operator NPS of 50+** within 6 months of deployment

3. **Achieve administrative staff NPS of 50+** within 6 months of deployment

4. Zero job delays attributable to untracked inventory stockouts within 6 months of adoption

5. **Increase operator workflow compliance from 0% to 60%** within 3 months of adoption

6. **Achieve 100% inventory accuracy** (system counts match physical counts) within 3 months of adoption by enabling frictionless granular inventory updates

**Out of Scope**

1. Integrations with automated factory systems (PLCs, SCADA)

2. Direct machine integrations (CNC program uploads, machine monitoring)

3. Multi-facility/multi-location support (V1 is single-shop focus)

4. Advanced HR/payroll features beyond basic operator tracking

---

### 1.1 Glossary

| Term | Definition |
|---|---|
| Job | A manufacturing order to produce parts for a customer. |
| Routing | A workflow diagram defining how a part is manufactured. Each part has exactly one routing (1:1). Managed from the part detail page. |
| Operation | A single step in a routing (e.g., CNC Turning), performed at a work center. |
| Work Center | A station on the shop floor (a machine, a bench) or an outside vendor (`kind='external'`). **Replaces "Operation Type"**, whose table was dropped in May 2026 — older docs use the old term. |
| Part | A company-wide product with name and description. Cost derived from routing when one exists. Not tied to a specific customer. |
| Pricing Tier | A quantity break-point on a part with its own markup % (e.g., "Qty 4 @ 25%"). Unit price is derived live as `base_cost × (1 + markup/100)` — base cost comes from the routing for made parts and from the part's procurement tiers for bought parts. |
| Quote | A cost-plus price estimate. Multi-part; the salesperson quotes one or more quantities per part (each a snapshotted line item, with optional per-line overrides), and each quantity's price is resolved from the part's tiers. Firm (one qty/part → grand total) or price-options (2+ qtys → per-part break tables, no total) is implicit by quantity count. Convert produces one job, one work cell per (part, selected quantity). |

### 2. Users and Use Cases

**Target Users / Personas**

| Role | Description | Primary Goals | Capabilities Needed |
|---|---|---|---|
| Owner | Business owner who oversees all operations, makes strategic decisions. | Maximize revenue, minimize waste, ensure on-time delivery, maintain quality | Dashboard views of jobs, inventory, and revenue. Approve material replenishment. Access business insights. |
| Operator | Manual machine operators who execute the steps in a job to build parts. May operate CNC machines, lathes, grinders, or perform assembly work. | Complete jobs efficiently, know what to work on next, understand job requirements | Access jobs and instructions on their own phone. Record quantity finished at a work center. Write and read shop-floor notes. **No performance metrics — see §4.3.** |
| Admin / Shipping Clerk | Administrative staff who handle material receiving, shipping, customer data management, and general office operations. | Keep inventory accurate, ship orders on time, maintain clean data | Receive inbound materials. Generate shipping labels. Track shipment status. Manage customer records. |
| Salesperson | Handles customer relationships, creates quotes, and converts them into jobs — or creates a job directly from a customer PO when no quote is needed. | Win customer business, ensure quotes become profitable jobs | Create jobs from quotes or directly from a PO. Attach customer specs (PDFs, CAD files). View customer history and order status. |
| Bookkeeper | Manages invoicing, accounts receivable, and financial record-keeping. Often uses QuickBooks for accounting. | Invoice promptly, track payments, keep books accurate | Generate invoices against shipped quantities. Track payment status. Export to QuickBooks. |
| ~~Quality Checker~~ | **Never built** — the role, the Pass/Fail workflow and the rework queue (FR-19, Flow 2) do not exist. Retained here as the written intent, pending the scrap/defect discovery. | — | — |
| Engineer | Defines a part's routing and material requirements. | Create accurate estimates, optimize manufacturing flow | Configure a part's linear routing across work centers. Define material requirements by step. Create BOMs. |

### 2.1 User Roles & Permissions

Jigged uses a simplified 3-role permission model. Each role inherits all capabilities of the roles below it.

### Role Definitions

**Admin** - Full access. Can manage team, create referrals, configure company settings. Inherits all User capabilities. The first user to create a company is automatically an Admin (owner).

**User** - Can interact with all modules (Jobs, Quotes, Parts, Customers, etc.) but cannot manage team members or create referrals. Inherits all Operator capabilities. Use this role for salespeople, bookkeepers, and quality staff.

**Operator** - Shop floor access only. Picks a work center, records the quantity finished on a step, reads and writes shop-floor notes. No time tracking (§4.3). Cannot access the admin dashboard.

### Permission Hierarchy

**`Admin > User > Operator`** (each role inherits capabilities of roles below it)

### Capability Matrix

| Capability | Admin | User | Operator |
|---|---|---|---|
| Access Admin Dashboard | Yes | Yes | No |
| Create/Edit Jobs, Quotes, Parts | Yes | Yes | No |
| View Jobs | Yes | Yes | Assigned only |
| Manage Team Members | Yes | No | No |
| Create Referral Links | Yes | No | No |
| Invite Team Members | Yes | No | No |
| Configure Company Settings | Yes | No | No |
| Access Operator View | Yes | Yes | Yes |
| Record Quantity Finished at a Work Center | Yes | Yes | Yes |

> 💡 Note: This REPLACES the previous role list (owner/admin/operator/salesperson/bookkeeper/quality). "Owner" is consolidated into Admin. Salesperson, Bookkeeper, and Quality roles are replaced with "User" access.

### Enforcement

Role restrictions are enforced at **two levels**:

1. **Database (RLS):** The `is_company_admin()` function gates write access to team management and company settings to `owner`/`admin` only. Operators are isolated to their own sessions via `get_operator_access_id()`.
2. **UI:** The sidebar hides Team and Settings from non-admin users. Page-level `AdminGuard` components block direct URL access. Operators accessing `/dashboard/*` are redirected to `/operator/{companyId}` by `AuthGuard`.

---

### 4.1 Functional Requirements Table

| ID | Title | Description | Priority | Acceptance Criteria |
|---|---|---|---|---|
| FR-1 | Flexible Inventory Units | System must support multiple units of measurement per inventory item (e.g., a steel bar can be measured in both pounds and inches). When depleting inventory, users can specify the quantity in any supported unit and the system converts accordingly. | Must | Given a steel bar tracked in lbs, when an operator depletes 6 inches, then the system converts to lbs and decrements inventory correctly. |
| FR-2 | Reorder Threshold Alerts | System must display visual alerts when inventory items fall below their configured reorder threshold. Alerts appear on the inventory dashboard and can trigger email notifications to designated users. | Must | Given an item with reorder threshold of 50 units, when quantity drops to 49, then a reorder alert is displayed and optional email sent. |
| FR-3 | Job Creation from Quote | Salesperson can create a quote by selecting a customer and part, reviewing cost and markup (or entering them manually), setting lead time and expiration, and attaching files. Quotes are created as "Active" and can be converted directly to jobs — there is no approval ceremony. Converting captures a **required customer PO** (the work-order authorization); conversion is blocked until it is entered. An optional PO PDF can be attached to the resulting job. | Must | Given a new customer order, when salesperson creates quote with cost, markup, and lead time, then it appears in the quotes pipeline with an expiration date and can be converted to a job once a customer PO is supplied. |
| FR-3b | Direct Job Creation from Purchase Order | When a customer sends a PO with no prior quote, the salesperson can create a job directly via **New Job from PO** on the jobs list: pick the customer, enter the PO #, add one or more **existing** parts (each with a quantity and the agreed unit price), optionally attach the PO PDF, and accept. No quote is involved (`quote_id` null; job number `J-NNNN` drawn from the shared per-company order counter — same sequence quotes use, so a direct job just takes the next number). v1 supports existing parts that already have a routing. | Must | Given a customer PO for existing parts, when the salesperson completes "Accept Purchase Order", then a job is created with the PO #, the agreed price on each part, cloned routing operations, and the optional PO PDF attached. |
| FR-3a | Quote PDF Export | Salesperson can export any quote as a branded, customer-facing PDF that includes the shop's FROM block (company name/logo/address/contact), a Customer · Ship-to (only when it differs from billing) · Customer-contact row, part/quantity/unit price/total, validity (Valid Until), lead time (a single quote-level line, or per-item under each part when items differ), payment terms, and an acceptance block instructing the customer to **reply with a purchase order referencing the quote** (no signature/date line) plus a "Prepared by" line. Internal details (routing, cost breakdown, markup, internal status) are excluded. The **Email** action opens a dialog that downloads the PDF and drafts a To/Cc message in the user's mail client (reminding them to attach the PDF). Shop contact info is configured in Settings → Company Profile; logo in Settings → Company Branding. | Must | Given an active quote, when salesperson exports the PDF, then a `Quote-{number}.pdf` downloads with the shop FROM block, the customer/ship-to/contact row, Valid Until + Lead Time + Payment Terms, and a reply-with-a-PO acceptance block — with no signature line and no routing or markup visible. |
| FR-4 | Quote Lifecycle | A quote is "Active" until its expiration date passes, at which point it flips to "Expired" (read-only but still convertible with a warning). A quote becomes a job via the Convert action, at which the owner enters the job's due date (lead time is free-text and no longer implies a date). The pending-approval / approved / rejected states were removed in April 2026. | Must | Given an active quote, when the owner converts it and enters a due date, then a job is created with that due_date and the quote links to that job via converted_to_job_id. |
| FR-5 | Operator Station Sign-In | Operators sign in with **email/password** on their own phone (the Supabase session persists, so sign-in is effectively one-time per device), then pick the work center they're standing at from the in-app **station selector**. The choice is remembered per device (`localStorage`) and can be changed any time from the header station dropdown. No PIN, no badge. *(Posted station-QR placards were removed in July 2026 — they were never deployed to a floor, and in-app selection plus the dashboard's "Shop floor view" button cover the same entry.)* | Must | Given an operator who signs in and picks CNC Lathe #2 from the station selector, then their station is set to CNC Lathe #2, they land on that station's job list, and the choice survives a browser restart. |
| FR-6 | Pick Work from the Station Queue | The operator's station job list shows every (job, part) with an operation ready or in progress at that station, sorted by due date. An **All Stations** lens shows the whole plant grouped by station, for a roaming operator or a lead. The operator taps a row to open the step and records **how many good pieces they finished** — no job entry, no start/stop, no timer (see §4.3). Partial quantities are normal; the step completes when the running total reaches the order quantity. | Must | Given an operator at CNC Lathe #2 with ready work, when they open the job list, then they see the ready (job, part) rows, and recording 3 of 12 leaves the step in progress with 9 remaining. |
| FR-6a | Outside (External-Vendor) Operations | A routing step at an **external** work center (a vendor, e.g. coating) is a first-class operation with a **send/receive** lifecycle instead of quantity capture: `pending → (Mark Sent Out) sent → (Mark Received) completed` (`sent` optional; received == completed). It is unmistakable everywhere it appears (operator page + traveler badge with vendor; heavy black-outlined bold row + "OUTSIDE — ship to {vendor}" in the Notes column on the printed traveler), can never be completed via the internal path, and is never auto-skipped. A company-wide **Outside processing** tab on the **Vendors** page (outside processing is vendor work, matching job-shop ERP convention) is the worklist (Not sent / At vendor) for whoever ships. *Deferred (v1): vendor lead-time→due-date math, PO generation, cost actuals, scheduling, partial/split sends.* See §4.3 and [modules/jobs.md](modules/jobs.md#outside-external-vendor-operations). | Must | Given a part with a coating step routed to an external work center, when the operator opens that step, then they see Mark Sent Out / Mark Received (not Mark Complete) with the vendor named, and the step prints as a heavy black-outlined bold row with "OUTSIDE — ship to {vendor}" in the Notes column on the traveler. |
| FR-7 | File Attachment Support | Work orders and **parts** support PDF and CAD (STEP/DWG) file attachments. Jobs accept PDF attachments; parts accept PDF/STEP/DWG on the part workspace Files tab. **Status (June 2026): admin/office-side delivered** — attachments + in-app PDF and STEP 3D viewing live in the admin-only part/job workspaces (STEP via `online-3d-viewer`, with occt-import-js fetched from the jsdelivr CDN at runtime). DWG is download-only (Contour standardizes on PDF upstream). **Not yet delivered:** operator-on-device viewing — the part workspace is not the operator shop-floor view, so surfacing attachment viewing in the operator view is a separate future step that closes this FR. | Must | Given a part with an attached PDF drawing, when an office user opens it from the part's Files tab, then it renders inline. *(Operator-on-device acceptance pending the operator-view step.)* |
| FR-8 | Job Status Lifecycle | A job tracks three **independent** axes rather than one linear status: production (not_started → in_progress → completed, plus cancelled), fulfillment (unshipped → partially_shipped → fully_shipped), and **invoicing (uninvoiced → partially_invoiced → fully_invoiced)**. Invoicing is a *partial* axis — a job can be partially invoiced while still in production (you bill what has shipped as it ships), not a single terminal "Invoiced" state. Status changes are logged with timestamp and user. *Note:* an outside op's send/receive state (FR-6a) is an **operation-level** lifecycle on `job_operations`, separate from these three job-level axes — a `sent` op simply holds its part at `in_progress`. | Must | Given a job with 9 of 10 shipped and invoiced, when the owner views it, then production, fulfillment, and invoicing statuses each reflect their own progress. |
| FR-9 | Invoice Generation | A job can have **multiple invoices** (progressive billing). When creating an invoice the bookkeeper picks the **per-part quantity to bill**, capped at the **ordered** quantity not yet invoiced (the picker defaults to the shipped-but-unbilled qty and nudges if you bill ahead; see FR-15). Each invoice records the parts + quantities + price it billed. | Must | Given a job that has shipped 9 of 10, when the bookkeeper creates an invoice for 9 and later ships + invoices the last 1, then the job has two invoices totaling the full order. |
| FR-10 | Invoice Payment Tracking | Bookkeeper can mark invoices as Paid and record payment date, amount, and method. System shows aging report of outstanding invoices. | Must | Given an outstanding invoice, when bookkeeper marks as paid with $500, then invoice status updates and aging report reflects the change. |
| FR-11 | Routing Templates | Owner/Engineer can define a part's routing as a **linear sequence** of operations (no parallel/DAG branching), with estimated setup/run time per operation and the materials consumed. Routings speed up job creation for repeat parts. | Should | Given a routing for "Custom Reamer", when a job is created for that part, then its operations and material estimates are cloned onto the job. |
| FR-12 | ~~Operator Performance Gamification~~ — **withdrawn** | **Not built, and will not be.** This specified real-time per-operator metrics (jobs completed, average time per station, on-time streaks, achievement badges). Two things killed it: actual time is **structurally unrepresentable** (`operator_sessions` and `job_operations.actual_*` were dropped by [`20260621132129`](../supabase/migrations/20260621132129_drop_operator_time_tracking.sql)), and a surveillance guardrail now forbids **any** operator-facing surface reflecting an operator's pace or standing back at them — no counts, streaks, averages, points, badges or leaderboards, asserted by test. What replaced it is *reception*, not performance: an operator sees who read the notes **they wrote**. See §4.3 and [modules/operator-view.md](modules/operator-view.md#surveillance-guardrail-non-negotiable). | — | Given My work rendered with any data, then no completion count, streak, average, pace or rank appears anywhere on the page. |
| FR-13 | Inventory Transaction History | All inventory changes (additions, depletions, adjustments) are logged with timestamp, user, job (if applicable), and quantity. Users can filter and export transaction history. | Should | Given an inventory item, when user views history, then all transactions are listed chronologically with full details. |
| FR-14 | Shipping Label Generation | Admin can generate shipping labels for completed jobs. Integration with USPS, UPS, and FedEx APIs. Focus on USPS flat rate boxes for initial release. | Should | Given a job ready to ship, when admin clicks Generate Label, then a USPS label is created and tracking number is stored. |
| FR-15 | QuickBooks Integration | Invoices are created in QuickBooks Online via OAuth connection (QBO is the invoice backend; Jigged stores per-invoice line quantities). Invoicing is **job-keyed**, initiated from the job detail page (quote- and PO-sourced jobs invoice the same way), and **progressive**: many invoices per job, each billing a chosen quantity capped at the **ordered** qty (the picker defaults to shipped-but-unbilled and allows billing ahead), with price read from `job_parts.unit_price` and **snapshotted per invoice** — so a part's price is locked once any quantity of it is invoiced. A quantity increase after invoicing is billed by a **new** invoice, never a revision. See [modules/invoicing.md](modules/invoicing.md). | Should | Given a job with 9 shipped, when the bookkeeper creates a QuickBooks invoice for 9, then a QBO invoice is created and Jigged records 9 of that part as invoiced. |
| FR-16 | Legacy Data Migration | System supports CSV upload for inventory items, customers, and job history. Upload wizard validates data, flags errors, and allows user correction before import. | Should | Given a CSV export from Tangle, when owner uploads to migration wizard, then data is validated and imported with error report. |
| FR-17 | Owner Dashboard with Insights | Dashboard displays key metrics: active jobs, revenue in progress, inventory alerts, operator compliance rate, and **overdue jobs**. AI-powered insights highlight bottlenecks. *("Jobs at risk of delay" was retired in August 2026 along with the alert bell — the dashboard counts what is actually overdue rather than predicting risk.)* | Should | Given current shop data, when owner views dashboard, then they see WIP value, 3 inventory alerts, and the overdue job count. |
| FR-18 | Natural Language Business Queries | Owner can type questions like "What was revenue last month?" or "Which customer has the most open orders?" and receive AI-generated answers based on system data. | Could | Given the question "What's my average order value this quarter?", when owner submits, then AI returns calculated answer with source data. |
| FR-19 | Quality Inspection Workflow | *(Not built. Flow 2 below describes the same unbuilt workflow.)* A future Quality Checker role would inspect completed work and mark Pass/Fail, routing failures back with notes. Operator-side quality/scrap capture is in **discovery** — see [modules/operator-view.md](modules/operator-view.md#scrap-and-defect-capture-discovery), which frames the options and the questions to answer before anything is built. | Could | Given a job awaiting QC, when the checker marks Fail with notes "Tolerance out of spec", then the job routes back to the operator with notes visible. |
| FR-20 | Customer Management | System maintains customer records with contact info, shipping addresses, and order history. New customers are created when the first job is entered. Admin can edit/delete customer records. | Should | Given a new job for "Acme Corp", when submitted, then Acme Corp customer record is created if not exists with contact details. |

### 4.2 Flows and Scenarios

**Flow 1: Job Happy Path**

A job carries **three independent axes**, not one linear status (FR-8): production,
fulfillment and invoicing each advance on their own. The steps below are ordered by
what typically happens, not by a state machine.

1. Customer requests a quote from the Salesperson

2. Salesperson creates the quote with lead time & expiration (status: Active)

3. Salesperson/Owner converts the quote directly into a job, capturing the required customer PO and entering the due date

4. Operator opens the step — from their station's job queue, or by scanning the single QR on the job traveler, which opens that part's step list — and records the quantity finished (production → In Progress)

5. Operator repeats step 4 across the routing until every step's total reaches the order quantity (production → Completed)

6. Admin ships some or all of the order and generates a label (fulfillment → Partially / Fully shipped)

7. Carrier delivers, tracking updates

8. Bookkeeper invoices the shipped quantity via QuickBooks; a job may carry **several** invoices as it ships (invoicing → Partially / Fully invoiced)

9. Customer pays, bookkeeper marks the invoice paid

> **Corrected 2026-08-02.** This flow previously ran `Quality Checked → Shipped →
> Delivered → Invoiced → Complete` as a single linear status, contradicting FR-8 in the
> same document, and `types/job.ts` (`not_started | in_progress | completed |
> cancelled`). It also had a **blank step 6** and a *"Quality Checker inspects and
> approves"* step for a role and workflow that were **never built** (FR-19, Flow 2).

**Flow 2: Quality Rejection / Rework — *not built***

> Nothing in this flow exists: no Quality Checker role, no Pass/Fail marking, no rework
> flag, no QC queue, no `quality_inspections` table. It is retained as the written form
> of FR-19's intent, and its fate is tied to the operator-side scrap/defect discovery —
> revive, reshape, or drop, but decide there rather than assuming this shape. See
> [modules/operator-view.md](modules/operator-view.md#scrap-and-defect-capture-discovery).

1. Quality Checker inspects job output

2. QC marks as Fail with notes ("Dimension out of tolerance")

3. Job routes back to "In Progress" with a rework flag

4. Operator sees the rework notification with QC notes

5. Operator completes the rework and records the quantity

6. Job returns to the QC queue

7. QC re-inspects and approves

**Flow 3: Inventory Reorder**

1. Operator depletes inventory during job execution

2. Inventory drops below reorder threshold

3. System displays alert on Owner dashboard

4. Owner reviews and approves reorder

5. Admin places order with supplier (manual, external)

6. Material arrives, Admin logs receipt to increment inventory

7. Reorder alert clears

**Flow 4: Operator Station Sign-In**

1. Operator arrives at a work center (e.g., CNC Lathe #2)

2. Operator opens the operator view on their own phone (a bookmark, or **Shop floor view** from the dashboard jobs list)

3. If not already signed in, they sign in with email/password (effectively one-time per device)

4. They pick CNC Lathe #2 from the station selector — remembered on that device, changeable any time from the header dropdown — and land on that station's job list

5. Operator picks a ready job and opens the step

6. Operator records how many good pieces they finished — no start/stop, no timer (see §4.3)

---

### 4.3 Shop-Floor Data Capture Model (Complete-Only)

> **Supersedes** the start→track→complete assumptions in the requirements and flows
> above. Those described a session/timer model; the shipped operator view does not
> use one. This subsection is the source of truth for how operators record work.
>
> **Corrected 2026-08-02** against the code, on three points: capture is a *quantity*
> entry, not a single tap; the traveler carries *one* QR, not one per operation row;
> and the station guard *warns*, it does not block. Each is marked below.

**Decision.** Operators record work with a single **finish** trigger — there is no
start, pause, resume, or exit, and no on-job timer. The operator view exposes:

- **Record how many good pieces you finished.** The operator enters a quantity and
  taps `RECORD COMPLETION`; each entry is an append-only `job_operation_completions`
  row (who, when, how many). The operation's status is *derived* from the running
  total — `pending` → `in_progress` at any quantity → `completed` at or above the
  part's order quantity. Partial completion is the normal case, not an exception:
  *"3 done, 9 to go"* is data rather than a free-text note. Corrections are **void,
  never edit** (`Undo all`), and the status recomputes.
  **Corrected 2026-08-02:** this was written as a single-tap *Mark Complete* with no
  quantity. That shipped in July 2026 as quantity capture
  ([`20260721023953`](../supabase/migrations/20260721023953_job_operation_completions.sql));
  the doc had not caught up. See
  [modules/operator-view.md](modules/operator-view.md#recording-a-completion).
- **Traveler QR** — the printed job traveler carries **exactly one QR**, in the header,
  which opens that part's step list; the operator taps the step they are working. The
  scan *is* the data-capture entry point.
  **Corrected 2026-08-02:** previously *"one QR **per operation row** (not one per
  job)"*. **Withdrawn:** per-operation QRs shipped and were removed — operators could
  not tell which code they were pointing the phone at. Deep links on sheets printed
  under that revision still resolve.
- **Station guard — warns, never blocks.** The operator selects their station once; if
  the step's work center doesn't match, a warning is shown **and the action still
  works**, because completion keys off the operation id, not the station.
  **Corrected 2026-08-02:** previously *"Mark Complete is replaced by a guide offering
  a one-tap 'switch & complete' or a way back"* — no such control was ever built.
- **Outside (external-vendor) steps — send/receive, not complete.** A step routed to
  a work center with `kind='external'` (e.g. coating) is performed off-site, so its
  operator action is **Mark Sent Out** then **Mark Received** (both attributed +
  timestamped) rather than a quantity; the station guard is suppressed (no operator
  station). `sent` is an optional waypoint (Mark Received also completes from
  `pending`); received == completed. Such a step can **never** be completed via the
  internal completion path and is **never auto-skipped**. On the printed traveler it
  renders as a heavy black-outlined, bold row (border only — the automatic yellow highlighter, minimal ink) with "OUTSIDE — ship to {vendor}" in the Notes column, and
  the **Vendors → Outside processing** tab is the shipping lead's worklist. See FR-6a and
  [modules/jobs.md](modules/jobs.md#outside-external-vendor-operations).

This is operation-level **milestone confirmation / labor backflush**: confirm the
finish, infer the rest, and do not burden the operator with maintaining timer state
across interruptions. Per-operation **actual time is not tracked** — the
`operator_sessions` table and the `job_operations.actual_*` columns were removed.
**Costing and quoting are unaffected**: they use only the *estimated* fields
(`estimated_setup_minutes`, `estimated_run_minutes_per_unit`, `work_centers.labor_rate`).

**Rationale / evidence.** Shop operators reliably handle a completion trigger but not
a start/pause/resume lifecycle; manual real-time tracking is well-documented as
unreliable, and the completion-only pattern is standard practice:

- Backflush accounting — completion-triggered costing that *"eliminates detailed
  tracking"*: https://en.wikipedia.org/wiki/Backflush_accounting (also Infor labor
  backflush; Qoblex).
- SAP milestone confirmation — confirm one operation, the system confirms the rest:
  https://www.scribd.com/doc/152034916/SAP-Repetitive-manufacturing-with-reporting-point-backflush
- Manual shop-floor data is unreliable (operators batch-record at breaks/shift-end;
  forgotten clock-ins): https://www.machinemetrics.com/blog/manual-data-collection ;
  https://www.globalshopsolutions.com/blog/your-production-data-is-lying-to-you-8-causes-of-poor-real-time-shop-floor-visibility
- Operator cognitive-load reduction as a UI goal: https://www.mdpi.com/2571-5577/3/4/55 ;
  https://arxiv.org/abs/2109.03627

**Gamification impact — superseded by a harder rule.** FR-12's time-based metrics are
out of scope under this model, since there is no actual duration to measure. That was
the 2026 position. It has since been **replaced by a non-negotiable guardrail**: no
operator-facing surface may reflect an operator's pace or standing back at them — no
completion counts, streaks, averages, points, badges or leaderboards anywhere, with a
test asserting the absence. See
[modules/operator-view.md](modules/operator-view.md#surveillance-guardrail-non-negotiable).
FR-12 and Open Question 8 are both corrected below.

---

### 5. Non‑Functional Requirements (NFRs)

### 5.1 NFR Overview Table

| ID | Category | Requirement | Measurement / Target | Notes |
|---|---|---|---|---|
| NFR-1 | Performance | Page load and API response times must be fast enough for shop floor use | 95% of page loads < 2 seconds, 99% of API requests < 500ms under 50 concurrent users | Operators on shop floor need quick response to maintain workflow |
| NFR-2 | Performance | Mobile experience must be responsive on low-end devices | Functional on 3-year-old Android phones with 4G connection | Operators often use personal phones, not latest models |
| NFR-3 | Security | All data in transit must be encrypted | HTTPS/TLS 1.2+ for all connections | Standard security baseline |
| NFR-4 | Security | Authentication must be secure but not burdensome for shop floor | Supabase Auth with session persistence; sign-in is effectively one-time per device. **No PIN, no badge** (FR-5) | Balance security with operator convenience |
| NFR-5 | Security | Role-based access control | Users see only data/actions appropriate to their role (Owner, Operator, Admin, etc.) | Enforce least-privilege principle |
| NFR-6 | Reliability / Availability | System must be highly available during shop operating hours | 99.5% monthly uptime (allows ~3.6 hours downtime/month) | Scheduled maintenance during off-hours (nights/weekends) |
| NFR-7 | Reliability / Availability | Data must be backed up and recoverable | Daily automated backups, RPO < 24 hours, RTO < 4 hours | Supabase provides automated backups |
| NFR-8 | Scalability | System must support typical small shop workloads | Support 1-50 concurrent users, 10,000+ inventory items, 5,000+ jobs | Designed for small shops; enterprise scale is out of scope for V1 |
| NFR-9 | Usability | Interface must be intuitive for non-technical users | New operator productive within 15 minutes, no formal training required | Shop workers may have limited software experience |
| NFR-10 | Usability | Follow Material Design principles for consistency | Use Material UI component library throughout | Provides professional, consistent UX |
| NFR-11 | Usability | Mobile-first design for operator interfaces | All operator functions fully usable on mobile devices | Operators use personal phones on shop floor |
| NFR-12 | Accessibility | Basic accessibility for vision-impaired users | WCAG 2.1 Level A compliance | Good contrast, keyboard navigation, screen reader basics |
| NFR-13 | Compliance | Data residency in United States | All data stored in US-based data centers | Supabase region selection |
| NFR-14 | Auditability | Key actions must be logged for traceability | Audit log for job changes, inventory transactions, user logins | Supports quality compliance and dispute resolution |

### 5.2 Additional NFR Details

**Performance Considerations**

Shop floor operations are time-sensitive. If the system is slow, operators will bypass it or enter incorrect data to save time. Target sub-2-second page loads and responsive UI interactions. Consider offline capability for critical functions if connectivity is unreliable.

**Security Model**

Role-based access ensures Operators can only access the Operator View (not admin dashboard), and Users cannot manage team members or company settings.

**Usability for Shop Environment**

Shop floors are noisy, dirty, and workers may have gloves on. UI elements should be large touch targets. QR codes enable login without typing. Consider voice input for future iterations.

---

### 6. Data and Integrations

**Data Model Notes**

**Core Entities:**

- **Customer**: id, name, email, phone, address, created_at, updated_at

- **Inventory Item**: id, name, description, unit_of_measure, quantity, reorder_threshold, cost_per_unit, location, created_at, updated_at

- **Inventory Transaction**: id, item_id, quantity_change, unit, transaction_type (add/deplete/adjust), job_id, user_id, notes, created_at

- **Part**: id, company_id, part_name, description, created_at, updated_at (company-wide entity, no customer_id). Pricing is cost-plus and lives on `part_pricing_tiers`: each tier carries its own quantity + markup %; unit price is derived live as `base_cost × (1 + markup/100)`, where base cost comes from the routing/BOM for made parts and from the part's procurement tiers (`compute_part_cost_at_qty`) for bought parts. Quotes snapshot one `quote_line_items` row per quoted (part, quantity) — the price resolved from these tiers and frozen by default — and may carry per-line price overrides.

- **Part Pricing Tier**: id, part_id, company_id, sequence, quantity, base_cost_per_unit, markup_percent, unit_price, created_at, updated_at. Markup % is the source of truth; typing a unit price back-calculates markup. No per-tier "lock" — for stable customer prices, override at the quote line item.

- job: id, customer_id, part_id, created_by, status, estimated_price, actual_price, priority, due_date, created_at, updated_at (routing auto-resolved from part)

- Job Attachment: id, job_id, file_name, file_url, file_type, uploaded_by, created_at

- Part Attachment: id, company_id, part_id, storage_path, file_name, kind (pdf|step|dwg|other), mime_type, size_bytes, uploaded_by, created_at (engineering files on a part; bytes in the `attachments` bucket under `{companyId}/parts/{partId}/...`)

- **Work Center** (`work_centers`): id, company_id, name, kind (`internal`|`external`), vendor_id, labor_rate, deleted_at, created_at. A "station" on the shop floor. **Supersedes the `operation_types` table**, dropped by the May 2026 parts/inventory unification.

- **Job Operation** (`job_operations`): id, job_part_id, sequence, operation_name, instructions, work_center_id, status (`pending`|`in_progress`|`completed`|`sent`), completed_at, completed_by, sent_at, sent_by, estimated_setup_minutes, estimated_run_minutes_per_unit. Status is **derived from recorded quantity**, not set by hand (§4.3).

- **Operation Completion** (`job_operation_completions`): id, company_id, job_operation_id, job_part_id, quantity_good, completed_by, completed_at, note, voided_at, voided_by. Append-only; corrections are void-and-recreate, never edit.

> **Removed 2026-08-02** — three entities modelled here no longer exist: **Job Template**
> (`operation type_routing (JSON)`, damage from a find-replace; routings live on the part,
> not on a template), **operation type** (dropped, superseded by Work Center; its `qr_code`
> was the station placard, also removed), and **Operator Session** (dropped by
> [`20260621132129`](../supabase/migrations/20260621132129_drop_operator_time_tracking.sql)
> — there is no time tracking, per §4.3, which said so while §6 kept modelling it).

- **Invoice** (`quickbooks_invoice_links`): id, job_id, company_id, realm_id, qb_request_id, qb_invoice_id, qb_invoice_doc_number, qb_invoice_url, status (pending/created/error), voided_at, created_at. **Many per job.**
- **Invoice Line** (`quickbooks_invoice_line_items`): id, invoice_link_id, job_part_id, quantity, unit_price (snapshot), total_price — the per-part quantity each invoice billed; the source of truth for "how much of a part is invoiced".

- **User**: id, email, name, role (admin/user/operator), created_at

- **Shipment**: id, job_id, carrier, tracking_number, label_url, status, shipped_at, delivered_at, freight_terms, customer_carrier_account_id, freight_account_snapshot

- ~~**Quality Inspection**~~ — **never built** (FR-19 / Flow 2). No `quality_inspections` table exists.

**Key Relationships:**

- Part → Routing (one-to-one; each part has exactly one routing)

- Part → Part Pricing Tier (one-to-many; quantity break-points with markup % per tier)

- Part → Company (many-to-one; parts are company-wide, not customer-specific)

- Quote → Quote Line Item (one-to-many; one snapshot per (part, quantity), reconciled on edit with pricing frozen by default)

- Quote Line Item → Job (one-to-one on conversion via `jobs.source_quote_line_item_id`)

- Job → Customer (many-to-one)

- Job → Part (many-to-one; routing auto-resolved from part)

- Job → Job Part → Job Operation → Operation Completion (one-to-many at each level; routing cloned from the part at job creation)

- Job → Attachments (one-to-many)

- Job → Invoice (one-to-many; progressive/partial billing — each invoice has one-to-many Invoice Lines by job_part)

- Job → Shipment (one-to-many; partial shipments)

- Job Operation → Work Center (many-to-one; an `external` work center points at a Vendor)

- Inventory Transaction → Item (many-to-one)

- Inventory Transaction → Job (many-to-one, optional)

**External Systems / Integrations**

| System | Type | Direction | Data Exchanged | Protocol / Interface | Notes |
|---|---|---|---|---|---|
| QuickBooks Online | 3rd party | Outbound | Invoices, customer records | REST API, OAuth 2.0 | Sync invoices for bookkeeping; should priority |
| USPS Web Tools | 3rd party | Outbound | Shipping label requests, tracking | REST API | Primary carrier for flat rate boxes |
| UPS APIs | 3rd party | Outbound | Shipping labels, tracking | REST API, OAuth | Secondary carrier option |
| FedEx APIs | 3rd party | Outbound | Shipping labels, tracking | REST API, OAuth | Secondary carrier option |
| Supabase Storage (S3) | Internal | Both | PDF drawings, CAD files, shipping labels | S3-compatible API | File storage for job and part attachments |
| OpenAI / Anthropic API | 3rd party | Outbound | Natural language queries, insight generation | REST API | Powers AI insights and NL queries (Could priority) |
| Email Service (SendGrid/Resend) | 3rd party | Outbound | Invoice emails, reorder alerts, notifications | REST API | Transactional email for notifications |

---

### 7. Technical Constraints

1. **Frontend**: Next.js with TypeScript, Material UI component library and iconography

2. **Backend**: FastAPI (Python) for API endpoints

3. **Hosting**: Frontend and Backend hosted on Vercel (backend as serverless functions)

4. **Database**: PostgreSQL hosted on Supabase

5. **File Storage**: Supabase Storage (S3-compatible) for PDFs, CAD files, labels

6. **Authentication**: Supabase Auth (email/password; no PIN — see FR-5)

**Risks**

1. **Supabase Vendor Lock-in**: Heavy reliance on Supabase for DB, auth, and storage. Mitigation: Use standard PostgreSQL patterns, abstract storage layer.

2. **Serverless Cold Starts**: Vercel serverless functions may have latency on first request. Mitigation: Keep functions warm, optimize bundle size.

3. **Shop Connectivity**: Manufacturing floors may have spotty WiFi/cellular. Mitigation: Design for graceful degradation, consider offline-first for critical paths.

4. **Integration Complexity**: QuickBooks, shipping carrier APIs have rate limits and can be brittle. Mitigation: Queue-based sync, robust error handling, manual fallbacks.

5. **User Adoption**: Operators may resist new system if not easier than current process. Mitigation: Focus on UX, gamification, involve users in testing.

**Assumptions**

1. Target customers have reliable internet connectivity in their office (may be spotty on shop floor)

2. Operators have access to personal smartphones with modern web browsers (Chrome, Safari)n browsers

3. Shops operate primarily during weekday business hours (maintenance windows available nights/weekends)

4. Initial target is single-location shops (multi-location is V2)

5. English-only interface for V1 (localization is future consideration)

6. Customers are comfortable with SaaS/cloud-based tools (no on-premise requirement)

7. Legacy data from Tangle/E2 JobBoss can be exported to CSV for migration

8. Pilot shop owner available for feedback during development

---

### 8. Milestones and Release Plan

| Milestone | Description | Owner | Target Date | Status |
|---|---|---|---|---|
| Discovery complete | PRD finalized, technical architecture approved, design mockups reviewed | Debola | 2025-12-29  | In progress |
| MVP ready | Core features: Work orders, inventory, operator stations, basic invoicing. Deployed to pilot customer. | Debola | 2026-01-04  | Not started |
| Pilot feedback incorporated | Pilot customer uses system for 60 days, feedback collected and addressed | Debola / pilot shop owner | 2026-04-30  | Not started |
| GA release | Public launch with integrations (QuickBooks, shipping carriers), marketing site live | Debola | 2026-07-31  | Not started |

### 8.1 Inventory & Material — phased delivery

Inventory is delivered in four phases against eleven numbered journeys (J1–J11). **The
journeys, the reasoning behind each phase, and the decisions that shaped them live in
[docs/modules/inventory.md](modules/inventory.md)** — that doc is the source of truth and
this table is the index, so keep it short and keep it pointing there.

| Phase | Journeys | Delivers | Schema cost |
|---|---|---|---|
| **1 — close the loop** ✅ **done 2026-07-28** | **J1** import balances · **J9** count session · **J4** material check (per job; the shop-wide roll-up moves to Phase 3, where a shortage has a buy list to land on) · **J7** issue-to-job (incl. consumption) | Numbers get in, get used on a job, and stay true. Closes FR-1/FR-13 gaps and delivers FR-16's inventory half. | **None** — no new tables, no migrations |
| **2 — locations reshaped** | **J2** | Incremental places, permanent visual board, photos + fill state, retire the structure-first wizard. PWA basics + iOS scanner spike. | None expected |
| **3 — purchasing** | **J5** POs · **J6** receiving · **J10** buy list + on-order · **J4's shop-wide shortage view** (built 2026-07-28, deferred here — git `87df208`) | Completes **Flow 3 (Inventory Reorder)** below, and satisfies **FR-2** properly. **This is issue #571** — merge, don't run in parallel. | POs, receipts |
| **4 — debt paydown** | **J8** remnants | Remnants, reconciliation, one-stock-engine collapse, `job_materials` drop. | Removals, mostly |

**Already built:** J3 (material cost on a quote, FR-11), J11 (find it — QR scan → bin view),
and all of Phase 1 as of 2026-07-28.

> Phase 1's schema cost was budgeted at one table and came in at zero: every figure J4 and J7
> needed already existed on `parts_bom`, `parts` and `inventory_transactions`, and J9's count
> sheet turned out not to need a session table. The module's gap was never schema.

**Deliberately cut, with reasons recorded** so they are not re-proposed:

- **Traceability** (certs, heat numbers, lot layer) — the pilot shop keeps no certs and serves
  no regulated customers. Reopen only if an aerospace / defense / medical customer appears.
- **Customer-supplied material** — real and frequent, but it never enters stock: it arrives
  with the job, is worked, and leaves. An attribute of a job, not of inventory.

**Corrections this phasing makes to requirements written above:**

- **FR-2 is a `Must`** and is only partially delivered (a low-stock badge; no email, no buy
  list, no on-order concept). It completes in Phase 3, not Phase 1.
- **Flow 3 (Inventory Reorder)** has roughly two of its seven steps implemented. Phase 1
  delivers step 1 and Phase 3 the remainder.
- **Open Question 2** — *"should operators be able to deplete inventory without a job?"* —
  was answered *"primarily deplete through jobs"* and then never built. J7 is that answer.

---

### 9. Open Questions

1. What is the pricing model? (Per-user? Per-shop? Tiered by job volume?)
  1. The pricing model is per user

2. Should operators be able to deplete inventory without associating to a job? (For shop supplies, maintenance materials?)
  1. Yes, you should primarily deplete inventory through jobs but for many other reasons you should be able to do it elsewhere

3. What is the target timeline for MVP deployment to the pilot customer?
  1. 6 months

4. Does the pilot customer have ITAR compliance requirements that would affect data handling?
  1. No

5. What specific reports or exports does the pilot shop owner currently use from Tangle that must be replicated?
  1. Exports to excel for all the data elements, no visualizations yet

6. What is the tolerance for offline operation on the shop floor? (Must-have or nice-to-have?)
  1. Nice to have

7. Should a routing support parallel operations (e.g., two operations happen simultaneously) or only a series?
  1. Resolved (2026): routings are a **linear sequence only** — no parallel/DAG branching. The earlier "parallel is a must have" was reversed in favor of shop-floor simplicity.

8. What gamification elements are most motivating for operators? (Leaderboards? Badges? Cash bonuses tied to achievements?)
  1. ~~Leaderboards, badges and customization. no cash bonuses as all value should be intrinsic to the app~~
  2. **Reversed 2026.** None of them. Leaderboards and badges are exactly the operator-comparative metrics the surveillance guardrail forbids, and no operator-facing surface may reflect an operator's pace or standing back at them. **What was kept from the intent** — that value should be intrinsic — took a different form: an operator sees who read the notes *they wrote*, which is reception, not ranking. See [modules/operator-view.md](modules/operator-view.md#surveillance-guardrail-non-negotiable).



