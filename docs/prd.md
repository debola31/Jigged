# Product Requirements Document

> **Condensed 2026-08-03: 7,498 → ~4,410 words (−41%), for [#634](https://github.com/debola31/Jigged/issues/634).**
>
> **Every `FR-N` id and every `§N` number is preserved** — 20 other files cite them, `§4.3`
> alone 17 times. What changed is that the FR rows stopped being mini-specs: ten of them ran past
> 120 words, restating what a module doc owns. Each now states the requirement and points at the
> doc that specifies it.
>
> **The FR table gained a Status column, verified against the code**, because a requirements table
> with no build status is the thing most likely to mislead. Four rows turned out to describe
> things that do not exist: shipping-label generation, the invoice aging report, reorder emails,
> and quote-PDF emailing. *(The aging report is still one of them: FR-10's 2026-09 payment mirror
> reports a balance per invoice and never buckets it by age.)* **FR-4's acceptance criterion cited
> `converted_to_job_id`, a column
> removed in April 2026.**
>
> The milestone table was removed. Every row read "Not started" against a 2026-01 date, while the
> product has been in pilot at Contour with billing, QuickBooks and 20 module specs shipped.

---

### 1. Overview

Jigged is a web platform for small manufacturing shops whose custom workflows do not fit legacy
ERPs. It centralises jobs, inventory and shop-floor status, then layers AI-assisted insight over
them. A deliberately minimal operator app — record what you finished, write down what you learned
— keeps shop-floor capture cheap enough to actually happen.

**The three problems**, all of which Tangle and E2 JobBoss fail for these shops:

1. **Inflexible inventory** — no easy way to record depletion and addition in both granular and
   bulk measures (3 oz off a 10 lb bar), and no clear signal to reorder before a stockout stops a
   job.
2. **No shop-floor visibility** — no integrated view of work in progress tied to revenue and
   labour; owners cannot see which jobs earn, where the bottleneck is, or how a job is
   progressing through work centres.
3. **Operator compliance gaps** — the non-blocking steps that matter for traceability (logging
   material, recording what was finished, quality checkpoints) do not get done.

**Success looks like** — 10+ admin hours per week saved within 3 months; operator NPS 50+ and
admin NPS 50+ within 6 months; zero job delays from untracked stockouts within 6 months; operator
workflow compliance 0% → 60% within 3 months; 100% inventory accuracy within 3 months.

**Out of scope:** PLC/SCADA integration, direct machine integrations (CNC program upload, machine
monitoring), multi-facility support, and HR/payroll beyond basic operator tracking.

### 1.1 Glossary

| Term | Definition |
|---|---|
| Job | A manufacturing order to produce parts for a customer |
| Routing | The linear sequence of operations that makes a part. Each part has exactly one, edited on the part page |
| Operation | One step in a routing, performed at a work centre |
| Work Center | A station on the floor, or an outside vendor (`kind='external'`). **Replaces "Operation Type"**, whose table was dropped in May 2026 — older docs use the old term |
| Part | A company-wide product. Cost derives from its routing when it has one |
| Pricing Tier | A quantity break-point on a part with its own markup %. Unit price is derived live as `base_cost × (1 + markup/100)` |
| Quote | A cost-plus estimate. Multi-part; one or more quantities per part, each a snapshotted line item. Firm (one qty/part → grand total) or price-options (2+ qtys → break tables, no total) is implicit by quantity count |

### 2. Users and Use Cases

| Role | Does | Needs |
|---|---|---|
| **Owner** | Oversees everything, decides | Dashboards over jobs, inventory and revenue; business insight |
| **Operator** | Executes the steps of a job on the floor | Jobs and instructions on their own phone; record quantity finished; read and write shop-floor notes. **No performance metrics — see §4.3** |
| **Admin / Shipping Clerk** | Receiving, shipping, customer data | Receive materials, ship orders, track shipments, manage customers |
| **Salesperson** | Quotes, and converting them (or a bare PO) into jobs | Create jobs from quotes or POs; attach customer specs; see history |
| **Bookkeeper** | Invoicing and receivables | Invoice against shipped quantities; track payment; export to QuickBooks |
| **Engineer** | Defines a part's routing and materials | Configure a linear routing across work centres; define materials per step; BOMs |
| ~~Quality Checker~~ | **Never built** — the role, the Pass/Fail workflow and the rework queue (FR-19, Flow 2) do not exist | — |

### 2.1 User Roles & Permissions

Three roles, each inheriting the one below: **`Admin > User > Operator`**. This replaced an
earlier six-role list (owner / admin / operator / salesperson / bookkeeper / quality) — "Owner"
folded into Admin, and the rest into User.

- **Admin** — full access, including team management, referrals and company settings. The first
  user to create a company becomes one.
- **User** — every module (Jobs, Quotes, Parts, Customers…), but no team management or referrals.
  This is the role for salespeople, bookkeepers and quality staff.
- **Operator** — shop floor only: pick a work centre, record quantity finished, read and write
  notes. **Cannot reach the admin dashboard.**

Enforced at **two levels**: the DB, where `is_company_admin()` gates team and settings writes and
operators are isolated by `get_operator_access_id()`; and the UI, where the sidebar hides Team and
Settings, `AdminGuard` blocks direct URLs, and `AuthGuard` bounces operators from `/dashboard/*`
to `/operator/{companyId}`.

---

### 4.1 Functional Requirements Table

**Status is verified against the code**, not intent. Where a module doc owns the detail, this row
states the requirement and links there rather than restating it.

| ID | Title | Requirement | Priority | Status |
|---|---|---|---|---|
| FR-1 | Flexible Inventory Units | Multiple units of measure per part; depleting in any supported unit converts and decrements correctly (a steel bar in lbs, depleted 6 inches). See [inventory.md](modules/inventory.md) | Must | **Built** |
| FR-2 | Reorder Threshold Alerts | Visual alert when an item falls below its reorder threshold, **and** email to designated users | Must | **Partial** — the low-stock badge and the parts-page shortage lens ship; **there is no email, no buy list and no on-order concept.** Completes in inventory Phase 3 (§8.1) |
| FR-3 | Job Creation from Quote | Quote → job with no approval ceremony. Conversion captures a **required customer PO** — the authorization — and is blocked without it. An optional PO PDF attaches to the job. See [quotes.md](modules/quotes.md) | Must | **Built** |
| FR-3a | Quote PDF Export | A branded, customer-facing PDF: shop FROM block, Customer · Ship-to (only when it differs) · contact, line items, validity, lead time, payment terms, and an acceptance block telling the customer to **reply with a purchase order** — no signature line. Internal cost, markup and routing are excluded. See [quotes.md](modules/quotes.md#printing) | Must | **Built.** *The emailing half of this row was **descoped** — there is no Email action and no server send; users send the downloaded PDF themselves* |
| FR-3b | Direct Job Creation from PO | When a customer sends a PO with no prior quote: pick the customer, enter the PO #, add existing parts with quantity and agreed price, optionally attach the PDF. `quote_id` null; the job number comes from the same per-company counter quotes use | Must | **Built** (v1: existing parts that already have a routing) |
| FR-4 | Quote Lifecycle | Active until `expiration_date` passes, then Expired — read-only but still convertible with a warning. Converting captures the due date; lead time is free text and does not imply a date. The pending-approval / approved / rejected states were removed in April 2026 | Must | **Built.** *This row's acceptance criterion used to cite `converted_to_job_id`; that column was **removed** in the same April 2026 change — a quote's jobs are found through `quote_line_items.id → jobs.source_quote_line_item_id`* |
| FR-5 | Operator Station Sign-In | Email/password on the operator's own phone (session persists, so effectively one-time per device), then pick the work centre from the in-app selector. Remembered per device, changeable from the header. **No PIN, no badge, and nothing posted at the machine to scan** | Must | **Built** |
| FR-6 | Pick Work from the Station Queue | The station's job list shows every (job, part) ready or in progress there, by due date; an **All Stations** lens covers the roaming operator. Tap a row, record **how many good pieces you finished** — no job entry, no start/stop, no timer (§4.3). Partial quantities are normal | Must | **Built** |
| FR-6a | Outside (External-Vendor) Operations | A step at an `external` work centre is first-class, with **send/receive** instead of quantity capture: `pending → sent → completed`. Unmistakable everywhere it appears, never completable via the internal path, never auto-skipped. The **Vendors → Outside processing** tab is the shipping lead's worklist. *Deferred: vendor lead-time maths, PO generation, cost actuals, scheduling, split sends.* See §4.3 and [jobs.md](modules/jobs.md#outside-external-vendor-operations) | Must | **Built** |
| FR-7 | File Attachment Support | Jobs accept PDFs; parts accept PDF/STEP/DWG on the workspace Files tab, with in-app PDF and STEP 3D viewing (STEP via `online-3d-viewer`). DWG is download-only — Contour standardises on PDF upstream | Must | **Partial** — office side delivered June 2026. **Operator-on-device viewing is not built**, and closing that is what closes this FR |
| FR-8 | Job Status Lifecycle | Three **independent** axes, not one linear status: production (`not_started → in_progress → completed`, plus cancelled), fulfillment (`unshipped → partially_shipped → fully_shipped`), invoicing (`uninvoiced → partially_invoiced → fully_invoiced`). Invoicing is **partial**, not a terminal state — you bill what has shipped as it ships. An outside op's `sent` is an **operation-level** state, separate from all three; it simply holds its part at `in_progress` | Must | **Built** |
| FR-9 | Invoice Generation | **Multiple invoices per job** (progressive billing). The bookkeeper picks the per-part quantity, capped at the **ordered** quantity not yet invoiced; the picker defaults to shipped-but-unbilled and nudges if you bill ahead. See [invoicing.md](modules/invoicing.md) | Must | **Built** |
| FR-10 | Invoice Payment Tracking | Mark invoices paid with date, amount and method; show an aging report of outstanding invoices | Must | **Partial, and deliberately narrowed.** Each QuickBooks **Online** invoice Jigged created shows the balance and state QuickBooks reports — paid / partly paid / open / overdue / voided / deleted — in the job page's Invoices menu, kept current by Intuit webhooks and reconciled when the menu opens. That is a read-only mirror of one question per invoice, not the tracking this row asked for: **Jigged records no payments** (no date, amount or method — those are QuickBooks' own Payment objects), **sends no statements, and has no aging report**, and a customer's credit hold is never derived from a balance. Payment lives in QuickBooks (FR-15), which stays the system of record. **Desktop invoices show no status**, because a Desktop read is a Web Connector round trip to a PC that may be off. See [invoicing.md](modules/invoicing.md#payment-status-quickbooks-online-mirror) |
| FR-11 | Routing Templates | A part's routing is a **linear sequence** of operations — no parallel or DAG branching — with estimated setup/run time and the materials consumed, cloned onto each job. See [routings.md](modules/routings.md) | Should | **Built** |
| FR-12 | ~~Operator Performance Gamification~~ | **Withdrawn, and will not be built.** It specified per-operator metrics — jobs completed, average time per station, on-time streaks, badges. Two things killed it: actual time is **structurally unrepresentable** (`operator_sessions` and `job_operations.actual_*` dropped by [`20260621132129`](../supabase/migrations/20260621132129_drop_operator_time_tracking.sql)), and a **surveillance guardrail** now forbids any operator-facing surface reflecting an operator's pace or standing — asserted by test. What replaced it is *reception*, not performance: an operator sees who read the notes **they wrote**. See [operator-view.md](modules/operator-view.md#surveillance-guardrail-non-negotiable) | — | **Withdrawn** |
| FR-13 | Inventory Transaction History | Every change logged with timestamp, user, job (where applicable) and quantity; users can filter and export | Should | **Partial** — the ledger records all of it with author and photo; **filtering and exporting are not built** |
| FR-14 | Shipping Label Generation | Generate labels for completed jobs via USPS / UPS / FedEx, starting with USPS flat rate | Should | **Not built.** Shipments are recorded manually with carrier and tracking number ([shipments.md](modules/shipments.md)); **no carrier API is integrated** |
| FR-15 | QuickBooks Integration | Invoices created in QBO over OAuth — QBO is the invoice backend, Jigged stores per-invoice line quantities. **Job-keyed** and **progressive**: many invoices per job, each capped at the ordered qty, price read from `job_parts.unit_price` and **snapshotted per invoice**, so a part's price locks once any quantity is invoiced. A later quantity increase is billed by a **new** invoice, never a revision. See [invoicing.md](modules/invoicing.md) | Should | **Built** |
| FR-16 | Legacy Data Migration | Guided CSV import for parts, customers and history, with validation, error flagging and correction before write. See [data-import.md](modules/data-import.md) | Should | **Built** |
| FR-17 | Owner Dashboard with Insights | Key metrics — active jobs, revenue in progress, inventory alerts, **overdue jobs** — with AI-assisted insight. *("Jobs at risk of delay" was retired in August 2026 with the alert bell: the dashboard counts what is actually overdue rather than predicting risk)* | Should | **Built** |
| FR-18 | Natural Language Business Queries | Ask "what was revenue last month?" in plain English and get an answer from the shop's own data, with an optional chart. See [ai-insights.md](modules/ai-insights.md) | Could | **Built** |
| FR-19 | Quality Inspection Workflow | A Quality Checker inspects completed work, marks Pass/Fail and routes failures back with notes | Could | **Not built** — see Flow 2. Operator-side quality/scrap capture is in **discovery**: [operator-view.md](modules/operator-view.md#scrap-and-defect-capture-discovery) frames the options and the questions to answer first |
| FR-20 | Customer Management | Customer records with contacts, addresses and order history, created on first use and editable after. See [customers.md](modules/customers.md) | Should | **Built** |

### 4.2 Flows and Scenarios

**Flow 1: Job Happy Path.** A job carries **three independent axes** (FR-8), so these steps are
ordered by what typically happens, not by a state machine: customer requests a quote → salesperson
quotes it with lead time and expiry → converts it, capturing the required PO and a due date →
operator opens the step from their station queue (or by scanning the traveler's single QR) and
records the quantity finished, repeating across the routing → admin ships some or all and
generates a label → carrier delivers → bookkeeper invoices the shipped quantity through
QuickBooks, possibly several times as it ships → customer pays.

**Flow 2: Quality Rejection / Rework — *not built*.** No Quality Checker role, no Pass/Fail
marking, no rework flag, no QC queue, no `quality_inspections` table. Retained as the written form
of FR-19's intent; its fate is tied to the operator-side scrap/defect discovery — revive, reshape
or drop, but decide there.

**Flow 3: Inventory Reorder.** Operator depletes stock on a job → the item drops below its
threshold → the owner sees it → approves a reorder → an admin orders externally → material
arrives and is received → the alert clears. **Roughly two of these seven steps exist today**;
Phase 3 (§8.1) delivers the rest.

**Flow 4: Operator Station Sign-In.** Operator reaches CNC Lathe #2 → opens the operator view on
their phone (a bookmark, or **Shop floor view** from the dashboard jobs list) → signs in if
needed, effectively once per device → picks the station, remembered on that device → opens a
ready job's step → records how many good pieces they finished. No shift, no clock-in, no timer.

---

### 4.3 Shop-Floor Data Capture Model (Complete-Only)

> **Supersedes** the start→track→complete assumptions in the requirements and flows above. Those
> described a session/timer model; the shipped operator view does not use one. **This subsection
> is the source of truth for how operators record work**, and is cited from 17 places.
>
> **Corrected 2026-08-02** against the code on three points, each marked below: capture is a
> *quantity* entry, not a single tap; the traveler carries *one* QR, not one per operation row;
> and the station guard *warns*, it does not block.

**Decision.** Operators record work with a single **finish** trigger — no pause, resume or exit.

**Amended 2026-08-16 — "no start, and no on-job timer" is withdrawn.**
[`20260816203641`](../supabase/migrations/20260816203641_job_operation_intervals.sql) adds recorded
start/stop time. **The evidence below is not withdrawn with it, and it is what shapes the
replacement.** Those sources say that a *lifecycle the operator must maintain across interruptions*
is unreliable — not that elapsed time cannot be captured. So the model that shipped asks the
operator to maintain nothing: intervals are **chained on the work centre**, the next start closes
the previous one, there is no Stop on the happy path, and nothing is ever auto-closed. Finish
remains the trigger that matters; the clock rides on taps the operator was already making. Full
shape and the decisions behind it:
[operator-view.md § Recording time](modules/operator-view.md#recording-time).

- **Record how many good pieces you finished.** The operator enters a quantity and taps
  `RECORD COMPLETION`; each entry is an append-only `job_operation_completions` row (who, when,
  how many). Status is **derived** from the running total — `pending` → `in_progress` at any
  quantity → `completed` at or above the part's order quantity. Partial completion is the normal
  case: *"3 done, 9 to go"* is data, not a free-text note. Corrections are **void, never edit**
  (`Undo all`), and the status recomputes.
  **Corrected:** written here as a single-tap *Mark Complete* with no quantity. Quantity capture
  shipped in July 2026
  ([`20260721023953`](../supabase/migrations/20260721023953_job_operation_completions.sql)); the
  doc had not caught up. See
  [operator-view.md](modules/operator-view.md#recording-a-completion).
- **Traveler QR** — **exactly one per sheet**, in the header, opening that part's step list; the
  operator taps the step they are working. The scan *is* the capture entry point.
  **Corrected:** previously *"one QR per operation row (not one per job)"*. **Withdrawn:**
  per-operation QRs shipped and were removed — operators could not tell which code they were
  pointing the phone at. Deep links on sheets printed under that revision still resolve.
- **Station guard — warns, never blocks.** If the step's work centre doesn't match the selected
  station a warning shows **and the action still works**, because completion keys off the
  operation id, not the station.
  **Corrected:** previously *"Mark Complete is replaced by a guide offering a one-tap 'switch &
  complete'"* — no such control was ever built.
- **Outside (external-vendor) steps — send/receive, not a quantity.** A step at a
  `kind='external'` work centre is done off-site, so its action is **Mark Sent Out** then **Mark
  Received**, both attributed and timestamped; the station guard is suppressed, since there is no
  operator station. `sent` is optional (Mark Received also completes from `pending`); received ==
  completed. Such a step can **never** be completed via the internal path and is **never
  auto-skipped**. On the traveler it prints as a heavy black-outlined bold row — border only, the
  automatic yellow highlighter, minimal ink — with "OUTSIDE — ship to {vendor}" in the Notes
  column. See FR-6a and [jobs.md](modules/jobs.md#outside-external-vendor-operations).

This is operation-level **milestone confirmation / labor backflush**: confirm the finish, infer
the rest, and **never ask an operator to maintain timer state across interruptions** — the last
clause still binds, and is exactly why the chain has no pause and no Stop.

**Corrected 2026-08-16:** *"Per-operation actual time is not tracked."* It is, in
`job_operation_intervals`. `operator_sessions` and `job_operations.actual_*` stay removed — the new
table is a different shape, not a restoration. **Costing and quoting remain unaffected and that is
still true**: they use only the estimated fields (`estimated_setup_minutes`,
`estimated_run_minutes_per_unit`, `work_centers.labor_rate`), and actuals are reported beside the
estimate rather than substituted into it.

**Rationale and evidence.** Operators reliably handle a completion trigger but not a
start/pause/resume lifecycle; manual real-time tracking is well documented as unreliable, and
completion-only is standard practice:

- Backflush accounting — completion-triggered costing that *"eliminates detailed tracking"*:
  https://en.wikipedia.org/wiki/Backflush_accounting (also Infor labor backflush; Qoblex)
- SAP milestone confirmation — confirm one operation, the system confirms the rest:
  https://www.scribd.com/doc/152034916/SAP-Repetitive-manufacturing-with-reporting-point-backflush
- Manual shop-floor data is unreliable — operators batch-record at breaks and shift-end, and
  forget clock-ins: https://www.machinemetrics.com/blog/manual-data-collection ;
  https://www.globalshopsolutions.com/blog/your-production-data-is-lying-to-you-8-causes-of-poor-real-time-shop-floor-visibility
- Operator cognitive-load reduction as a UI goal: https://www.mdpi.com/2571-5577/3/4/55 ;
  https://arxiv.org/abs/2109.03627

**Gamification — superseded by a harder rule.** FR-12's time-based metrics are out of scope here,
since there is no actual duration to measure. That was the 2026 position; it has been **replaced
by a non-negotiable guardrail** — no operator-facing surface may reflect an operator's pace or
standing back at them, with a test asserting the absence. FR-12 and Open Question 8 are corrected
accordingly.

---

### 5. Non-Functional Requirements (NFRs)

### 5.1 NFR Overview Table

| ID | Category | Requirement | Target |
|---|---|---|---|
| NFR-1 | Performance | Fast enough that operators don't bypass it | 95% of page loads < 2 s; 99% of API requests < 500 ms at 50 concurrent users |
| NFR-2 | Performance | Usable on the phones operators actually own | Functional on a 3-year-old Android over 4G |
| NFR-3 | Security | Encrypted in transit | HTTPS / TLS 1.2+ |
| NFR-4 | Security | Secure without burdening the floor | Supabase Auth, session persists, effectively one-time per device. **No PIN, no badge** (FR-5) |
| NFR-5 | Security | Role-based access | Users see only what their role allows; least privilege |
| NFR-6 | Reliability | Available during shop hours | 99.5% monthly uptime (~3.6 h/month), maintenance off-hours |
| NFR-7 | Reliability | Recoverable | Daily automated backups; RPO < 24 h, RTO < 4 h |
| NFR-8 | Scalability | Small-shop workloads | 1–50 concurrent users, 10,000+ inventory items, 5,000+ jobs |
| NFR-9 | Usability | Intuitive for non-technical users | A new operator productive in 15 minutes with no formal training |
| NFR-10 | Usability | Consistent | Material UI throughout |
| NFR-11 | Usability | Mobile-first for operators | Every operator function usable on a phone |
| NFR-12 | Accessibility | Basic vision support | WCAG 2.1 Level A |
| NFR-13 | Compliance | US data residency | US-based Supabase region |
| NFR-14 | Auditability | Key actions traceable | Audit log for job changes, inventory transactions, logins |

**Why NFR-1 matters more than it looks:** shop-floor work is time-sensitive, and a slow system
does not get used carefully — it gets bypassed, or fed wrong data to save time. Latency is a data
quality risk here, not just a comfort one.

### 6. Data and Integrations

The entity-by-entity data model **lives in the module specs** — [jobs.md](modules/jobs.md),
[quotes.md](modules/quotes.md), [parts.md](modules/parts.md),
[inventory.md](modules/inventory.md), [customers.md](modules/customers.md) and their siblings in
[docs/modules/](modules/) — which are kept against the schema. `supabase/migrations/` is the only
record of what actually exists; there is deliberately no cached prod snapshot.

*(This section used to duplicate that model entity by entity, and drifted: it modelled
`operator_sessions`, `job_templates` and an `operation type` table, all dropped, plus a
`Quality Inspection` entity that was never built. Removed 2026-08-02.)*

| System | Direction | Exchanged | Notes |
|---|---|---|---|
| QuickBooks Online | Outbound, plus a read-back | Out: invoices, customer records. Back: each invoice's balance, total, dates and state (FR-10) | REST + OAuth 2.0 for the push; the read-back is prompted by an Intuit webhook, which says only *that* something changed and never carries a number. The invoice system of record (FR-15) |
| Stripe | Both | Subscriptions, entitlement | Hosted checkout and portal; entitlement enforced in the DB. See [billing.md](modules/billing.md) |
| USPS / UPS / FedEx | Outbound | Labels, tracking | **Not integrated** (FR-14) |
| Supabase Storage (S3) | Both | PDFs, CAD files, photos | Job and part attachments, note media |
| Anthropic API | Outbound | NL queries, insight generation | Powers FR-18. **Never called without an explicit user action** |
| Email (Resend) | Outbound | Invitations, transactional | Reorder alerts (FR-2) are **not** built |

### 7. Technical Constraints

Next.js + TypeScript + Material UI on the front end; FastAPI (Python) for the narrow set of
operations that need it; both on Vercel; PostgreSQL on Supabase with RLS; Supabase Storage for
files; Supabase Auth for identity. **Simple CRUD goes through the Supabase client, not FastAPI** —
see the API architecture rule in [CLAUDE.md](../CLAUDE.md) and
[architecture.md](architecture.md).

**Risks and mitigations:** Supabase lock-in (use standard Postgres patterns, abstract storage) ·
serverless cold starts (keep functions warm, small bundles) · **spotty shop-floor connectivity**
(graceful degradation; offline-first for critical paths remains unbuilt) · brittle third-party
integrations with rate limits (queue-based sync, robust errors, manual fallback) · operator
adoption, which is the real one — a system that is not easier than the current process does not
get used.

**Assumptions:** reliable office internet (shop floor may be spotty) · operators have personal
smartphones with modern browsers · weekday operation, so maintenance can be nights and weekends ·
single-location shops for V1 · English-only for V1 · customers accept SaaS · legacy data exports
to CSV · the pilot owner stays available for feedback.

### 8. Milestones and Release Plan

*(The dated milestone table was removed on 2026-08-03. Every row read "Not started" against a
target in December 2025 or January 2026, while the product had been running at the pilot shop for
months with billing, QuickBooks and 20 module specs shipped. A schedule nobody updates is worse
than no schedule; delivery status now lives in the FR table's Status column, which is checkable.)*

### 8.1 Inventory & Material — phased delivery

Four phases over eleven numbered journeys (J1–J11). **The journeys, the reasoning and the
decisions live in [inventory.md](modules/inventory.md)** — that doc is the source of truth and
this is only the index.

| Phase | Journeys | Delivers |
|---|---|---|
| **1 — close the loop** ✅ **2026-07-28** | J1 opening balances · J9 count sheet · J4 material check · J7 issue-to-job | Numbers get in, get used on a job, stay true. **Zero new tables, zero migrations** |
| **2 — locations reshaped** | J2 | Incremental places, a permanent visual board and fill state; retires the structure-first wizard |
| **3 — purchasing** | J5 POs · J6 receiving · J10 buy list + on-order · J4's shop-wide shortage view | Completes **Flow 3** and satisfies **FR-2** properly. This is issue #571 |
| **4 — debt paydown** | J8 remnants | Remnants, reconciliation, one-stock-engine collapse, `job_materials` drop |

**Already built:** J3 (material cost on a quote, FR-11), J11 (QR scan → bin view), and all of
Phase 1.

> Phase 1's schema cost was budgeted at one table and came in at **zero** — every figure J4 and J7
> needed already existed on `parts_bom`, `parts` and `inventory_transactions`, and J9's count sheet
> turned out not to need a session table. **The module's gap was never schema.**

**Deliberately cut, so they are not re-proposed:** **traceability** (certs, heat numbers, lot
layer) — the pilot shop keeps no certs and serves no regulated customers; reopen only if an
aerospace, defence or medical customer appears. **Customer-supplied material** — real and
frequent, but it never enters stock: it arrives with the job, is worked, and leaves. An attribute
of a job, not of inventory.

### 9. Open Questions

| # | Question | Answer |
|---|---|---|
| 1 | Pricing model? | Per user |
| 2 | Deplete inventory without a job? | Primarily through jobs, but it must be possible elsewhere. **J7 is that answer**, shipped 2026-07-28 |
| 3 | MVP timeline to the pilot? | 6 months |
| 4 | ITAR requirements at the pilot? | No |
| 5 | Which Tangle reports must be replicated? | Excel exports of every data element; no visualisations yet |
| 6 | Offline tolerance on the floor? | Nice to have — **still unbuilt** |
| 7 | Parallel routings, or series only? | **Resolved: linear only**, no parallel or DAG branching. The earlier "parallel is a must have" was reversed for shop-floor simplicity |
| 8 | Which gamification motivates operators? | ~~Leaderboards, badges, customization~~ — **reversed.** Those are exactly the operator-comparative metrics the surveillance guardrail forbids. What survived from the intent — that value should be intrinsic — took a different form: an operator sees who read the notes *they wrote*. See [operator-view.md](modules/operator-view.md#surveillance-guardrail-non-negotiable) |
