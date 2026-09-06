# Jobs Module

> **As-built, verified 2026-08-03 (issue #634).** Condensed 6,118 → 4,717 words (`wc -w`); the
> cut would have been deeper but ~1,100 words of *corrections and restorations* were added,
> because this doc was wrong in fourteen places. Checked against `supabase/migrations/`,
> `utils/jobsAccess.ts`, `app/dashboard/[companyId]/jobs/**`, `components/jobs/**`,
> `types/job.ts` and `__tests__/utils/jobsAccess.test.ts`.
>
> **Cut:** the ASCII status diagram, per-status prose the CHECK constraint already states, UI copy
> transcribed from JSX, the User Stories table, and acceptance bullets whose Given/When/Then only
> re-read the test they cited. Test citations were converted from `describe > 'it title'` (which
> rots) to file + `describe` + it-count.
>
> **Kept deliberately:** every withdrawn argument, the bought-parts ERP precedent (JobBOSS/ProShop),
> the reason the outside-processing queue lives under Vendors, the outside-ops deferral list, the
> two `_on_qty` trigger names, the local-vs-UTC midnight trap on `due_date`, and every named gap.
>
> **Restored by the 2026-08-03 adversarial pass** (the condensation had dropped them): the
> PO-sourced / `is_quote_override` / `basis_unknown` reprice-eligibility rule; the `started_at` /
> `completed_at` stamping rule, including the NULL-out on regression; the `job_materials` column
> shape (`inventory.md` §5.9 owns the *decision to drop it*, not its shape, and
> [routings.md](routings.md) links here for it); the ad-hoc **Remove stock** path that coexists
> with the job-tagged take; the `edit → save → reload → persists` acceptance convention; and the
> `automation-pending` rows for auto-progression, `completeJobOperation` / `undoJobOperation`,
> and shipment-driven fulfillment.
>
> **Fourteen corrections**, each marked inline as *(This doc previously said …)*. The two largest:
> a `skipped` operation status described in six places that has never existed in
> `job_operations_status_check`, and a hard-delete-blocked-by-records-of-value rule that was
> replaced by unconditional archive. One live defect found and **not** fixed here — see
> [SUSPECTED CODE BUG](#suspected-code-bug--the-delete-gate-on-the-detail-page).

A **Job** is the project header — customer, due date, aggregate status. Each part on it is a
child **`job_part`** with its own routing-derived operations + materials, status and timestamps.
Operators work one `job_part` at a time.

**Tables:** `jobs`, `job_parts`, `job_operations`, `job_materials`, `job_attachments`.
**Depends on:** [Customers](customers.md), [Parts](parts.md), [Quotes](quotes.md).
Priority: Must Have (Build Fourth).

---

## Status model — three derived axes

Each axis exists on **both** `jobs` and `job_parts`. The **part** is the source of truth; the job
value is recomputed by DB trigger. **The access layer never writes a job-level status.** There is
no single `jobs.status` column.

| Axis | Values (CHECK constraint) | Job-level function | Advances when |
|---|---|---|---|
| `production_status` | `not_started` \| `in_progress` \| `completed` \| `cancelled` | `compute_job_production_status()` | operator activity on operations |
| `fulfillment_status` | `unshipped` \| `partially_shipped` \| `fully_shipped` | `compute_job_fulfillment_status()` | a shipment record is created |
| `invoicing_status` | `uninvoiced` \| `partially_invoiced` \| `fully_invoiced` | `compute_job_invoicing_status()` | an invoice is created |

Part-level mirrors: `compute_job_part_production_status()` (all ops completed → `completed`; any
op ≠ `pending` → `in_progress`; a `cancelled` part is returned unchanged, and a part with **zero**
operations keeps its current status), plus the `_fulfillment_` / `_invoicing_` pair.
`compute_job_production_status()` ignores cancelled parts: all-cancelled → `cancelled`, all
*remaining* completed → `completed`.

**"Shipped" is not a production status.** *(This doc previously listed Shipped as a production
state and gave it a purple pill; `jobs_production_status_check` has only the four values above.)*
A completed job can be simultaneously `partially_shipped` and `partially_invoiced`.

**No manual production transitions.** There is no Start Job / Mark Complete / Mark Shipped button.
`not_started → in_progress → completed` emerges from operator activity and aggregates up.
Only `cancelled` (Cancel Job → every part cancelled) and its reversal (Reopen → each part
re-derived from its operations, bypassing the cancelled-skip) are admin actions.

### Lifecycle stage (what the UI actually shows)

The list and detail chips render **one** combined stage, not two chips — `getJobLifecycleStage`
in [`types/job.ts`](../../types/job.ts) collapses production × fulfillment in this precedence
order: `cancelled` → `completed` (fully shipped) → `partially_shipped` → `ready_to_ship`
(production done, nothing shipped) → `in_progress` → `not_started`. `STAGE_TO_JOB_FILTERS` is its
inverse, used for querying; the two must stay in lockstep. `completed` and `cancelled` are the
`closed: true` stages and are **hidden by default** in the list.

### Overdue (derived, never stored)

Overdue = `due_date` set and past **and** production is not `cancelled` **and** fulfillment is not
`fully_shipped`. Derived at read time so a job can be both "in progress" and "overdue", and so no
cron has to flip statuses.

**A finished job that has not shipped IS overdue.** Delivery is the promise: a customer whose parts
are sitting done on a bench is waiting exactly as long as one whose parts are still on the mill, and
the overdue list is where you go to find out who to call. Changed 2026-08-27; until then the rule
also cleared `production_status = 'completed'`, which is what made the jobs list show 6 overdue on a
demo company where the insights chat said 7.

**The definition is [`public.is_job_late()`](../../supabase/migrations/20260827114506_shared_late_job_predicate.sql),
and it has three callers, in two dialects.**

| Caller | How |
|---|---|
| `search_jobs_by_identifier` (the list's `overdue` filter) | calls the function |
| The insights AI | calls the function — `public.is_job_late(due_date, production_status, fulfillment_status, $2)` |
| [`applyOverdueJobsFilter`](../../utils/jobsAccess.ts) (list + `overdue_jobs` tile) | a clause list, because PostgREST cannot call a function inside a filter |
| [`isJobOverdue`](../../types/job.ts) (per-row badge) | a TypeScript mirror, because a badge has no round trip to spend |

The last two are pinned to the function by a shared golden-case fixture,
[`__tests__/fixtures/lateJobCases.json`](../../__tests__/fixtures/lateJobCases.json), read by both a
Vitest suite and `api/tests/integration/test_late_job_parity.py`. Neither side can be edited into
agreement alone. **Change the migration first.**

**The day boundary is the CALLER's, everywhere.** Postgres runs in UTC, so a job due Thursday would
go overdue at 8pm Wednesday for a US shop if anything read the server clock. Nothing does: the RPC
takes `p_today`, the AI binds `$2` (and its validator refuses `CURRENT_DATE` and `now()` outright),
and the browser builds the date with [`todayLocalISODate`](../../lib/localDate.ts) — never
`toISOString().slice(0, 10)`, which converts to UTC first and is the same bug in one line.

Surfaces: an "Overdue" chip on the job detail header (`JobOverdueBadge`), and a trailing
`Overdue by N days` icon on the list's **Due** cell. *(This doc previously said the chip also
appeared on the jobs list and on "job cards", and cited a `getOverdueJobsCount` function. The list
shows an icon, there are no job cards, and no such function exists — the metric is computed
through `applyOverdueJobsFilter` in `utils/dashboardAccess.ts`.)*

---

## Data model

### `jobs`

| Field | Notes |
|---|---|
| `job_number` | A job off a quote keeps the quote's index (`Q-0141` → `J-0141`); each **later PO on the same quote** gets a suffix (`J-0141-2`, …). A direct-PO job draws a fresh `J-N` from the shared per-company order counter (`generate_direct_job_number` → `next_order_number`, atomic, so it can never collide with a quote's reserved number). Set explicitly at creation — no auto-numbering trigger. |
| `quote_id` | Null for direct-PO jobs. **Many jobs may share one `quote_id`** — a quote converts in passes, one job (one customer PO) per pass. |
| `due_date` | Entered **manually** in the Convert-to-Job modal (required, not in the past). **Not derived from lead time**, and no lead-time snapshot is stored. Now **per part**: quote conversion creates one job per part, so a quote whose parts carry different lead times converts into jobs genuinely due on different days. (It was previously shared by every part on one job, and per-part deadlines were a named gap; that gap closes for anything new, and still applies to legacy multi-part jobs.) |
| `production_status` / `fulfillment_status` / `invoicing_status` | See above. Derived. |
| `started_at` / `completed_at` | Stamped by the part→job sync trigger, not by the app: `started_at` the first time the rolled-up status reaches `in_progress` **or** `completed` (never overwritten after), `completed_at` when it reaches `completed`. **`completed_at` is reset to NULL when the job falls back to `in_progress`** — so undoing an operation on a finished job clears the completion date rather than leaving a stale one. The same pair on `job_parts` follows the same rule. **There is no `shipped_at`** on `jobs` or `job_parts` — *(this doc previously listed one on both)*; use `public.job_part_last_ship_date(job_part_id)`. |
| `customer_po_number`, `billing_address_id`, `shipping_address_id`, `contact_id`, `freight_terms`, `ship_via`, `payment_terms`, `deleted_at` | Header/edit fields. **There is no `notes` column** — *(this doc previously described a Notes section on the detail page and a cancellation reason "saved in notes"; job-level notes live in the `notes` table, step-tagged, and cancel captures no reason)*. |

### `job_parts` (one row per physical part)

`job_id`, `part_id`, `source_quote_line_item_id`, `sequence` (10, 20, 30…), `quantity` (numeric,
CHECK `> 0`, fractional allowed), `unit_price` / `total_price` `numeric(12,4)` (the single source
of price for invoicing and revenue), `true_cost_per_unit` (the single source of **cost** — see below),
the three status columns, `current_operation_sequence`, `started_at` / `completed_at`.

A partial unique index — `job_parts_one_active_per_quote_line` on `source_quote_line_item_id`
WHERE not cancelled — stops one quote line spawning two live job parts.

#### The cost snapshot

`true_cost_per_unit` is the all-in TRUE cost of one unit — labour + materials + the whole nested BOM —
taken from `compute_part_cost_at_qty` by a `BEFORE INSERT OR UPDATE OF quantity` trigger
([`20260811233748`](../../supabase/migrations/20260811233748_job_cost_snapshot.sql)). Revenue has been
denormalised onto the job since 20260621162024; this is the same move on the cost side, and for the same
reason: **a job that shipped is history.** Re-deriving its cost from the part's current routing means last
year's profit changes whenever someone re-rates a work centre.

- **A trigger, not a step in the conversion path**, because job_parts arrive by several roads — quote
  conversion, a job built by hand with no quote at all, the importer — and the routing-clone RPC only runs
  for *made* parts, so a bought part would never be costed.
- **Re-taken on a quantity change**, because cost genuinely depends on quantity (amortised setup,
  procurement tiers). Deliberately **not** symmetric with price, which `updateJobPartQuantity` keeps sticky:
  a price is an agreement with the customer, a cost is a measurement of us.
- **NULL means "could not be determined"**, never zero. The rollup raises on an incomplete part rather than
  costing an unpriced operation at $0; the trigger catches that so an incomplete part can still go on a job.
  Readers must exclude those rows and say so — see [ai-insights.md](ai-insights.md).

### `job_operations`

`job_id`, `job_part_id`, `sequence`, `operation_name` (snapshot, immune to work-centre renames),
`work_center_id`, `routing_operation_id`, `estimated_setup_minutes`,
`estimated_run_minutes_per_unit`, `work_center_kind_snapshot` / `labor_rate_snapshot` /
`external_unit_price_snapshot` (the rates frozen beside the minutes, so labour stays itemisable without
reading a live `work_centers` row), `status`, `completed_at` / `completed_by`, `sent_at` / `sent_by`,
`instructions`, `notes`.

**Materials are not costed per line anywhere.** `job_materials` freezes quantities only. Per-unit material
cost is `job_parts.true_cost_per_unit` minus the labour summed from the rates above — costing one BOM line
would mean re-deriving the unit conversion and made-vs-bought valuation rules that live inside
`part_rollup_at_qty`, which is a second copy of a money rule. (That list named a whole-unit ceiling too
until 2026-09-06, when `consume_whole_units` was removed. The argument now rests on two rules rather than
three; it was re-examined at the time and still holds.)

`(job_part_id, sequence)` is unique — each part has its own independent sequence.

**`job_operations_status_check` is `pending | in_progress | completed | sent`.**
*(This doc previously described a `skipped` status in six places — including the readiness rule,
the auto-progression rule and the status-transition table — and named the FK `routing_node_id` →
`routing_nodes`. There has never been a `skipped` value in this constraint; `routing_nodes` was
renamed `routing_operations` and the FK with it. The doc also listed `actual_*` hour columns,
`started_at` and `assigned_to`; none exist.)*

The completion model — append-only `job_operation_completions` rows, status derived from summed
`quantity_good`, over-completion warns rather than blocks, corrections are void-not-edit — is
owned by [operator-view.md](operator-view.md#status-model) and
[§Recording a completion](operator-view.md#recording-a-completion). Two consequences bind here:
raising `job_parts.quantity` **re-opens** an op whose good total no longer reaches the new target,
and that now applies to outside steps too. *(⚠ Corrected 2026-09-03: this said outside steps were
**exempt** from the recompute. They were, and are not any more — quantities drive an outside op's
status exactly as they drive an in-house one. See below.)*

---

## Creating a job — two paths, no blank-job route

There is no `/jobs/new`. Both paths store the agreed price on each `job_part`, so PO-sourced and
quote-sourced jobs invoice identically.

**(a) Convert a quote** — **Convert to Job** on the quote detail page (`convertQuoteToJobs`,
`utils/quotesAccess.ts`); **one job per checked part**, each owning exactly one `job_part` and
carrying the PO entered at conversion. One pass can therefore create several jobs, and a quote
converts in **several passes** besides (button relabels to **Create Another Job** while lines
remain). Because each part is its own job, each also gets **its own due date**, collected per part
in the modal. Owned by [Quotes](quotes.md). This is the *only* path that offers the price-break
opt-in (`ConvertToJobModal`: if the chosen quantity crosses a break, the user may take the
re-resolved tier price).

**(b) New Job from PO (direct)** — the **Accept Purchase Order** modal (a modal, not a route) on
the jobs list captures customer, PO #, due date, an optional PO PDF, and one-or-more
**existing** parts with quantity + agreed unit price. Choosing part + quantity **pre-fills the
expected sell price** through the *same* `getTiersWithComputedPrices` + `resolveTier` path quote
lines use (pure DB reads, no AI); overriding it shows a non-blocking "Differs from expected $X"
hint with a one-tap Reset, and a part with no priced tier leaves the price blank.
`createJobFromPurchaseOrder` then creates the job (`quote_id` null) and clones each **made**
part's routing via the same `create_job_part_operations_from_routing` RPC.

Every guard runs **before any write** (PO # rejected rather than coerced to NULL — no silent
fallbacks; no duplicate parts; every **made** part must already have a routing — the
existing-parts-only gate). **This path also requires a whole-number quantity** (`Number.isInteger`)
even though the column and the quote path both accept fractions — an inconsistency, not a decision.

### Bought parts on jobs (no operations)

A **bought** part is purchased, not manufactured, so it has no routing (routing is made-only).
Both paths therefore **exempt it from the routing pre-flight** and create its `job_part` with
**zero operations**, `production_status = 'completed'`, and `started_at`/`completed_at` stamped at
creation. It flows straight to ship + invoice — the "work" is buy → receive → ship. This matches
how job-shop ERPs handle purchased/COTS items (JobBOSS "buy-to-job", ProShop COTS): the item rides
the same order-to-ship document, it just skips manufacturing. On a legacy **mixed** job the bought
parts show production-complete while the made parts run their routings; quote conversion no longer
produces one, since each part becomes its own job.
**Gap:** no "received from vendor" step — a bought part is shippable immediately. A purchasing
module would add one.

---

## Editing a job

`job_parts.quantity` is editable post-conversion because customers routinely change quantity after
a quote converts. **The job — not the now-read-only quote — is the post-conversion source of
truth**; the quote still reflects the live figure ("now N on job").

Entry point: **Edit** on the job detail page → [`JobEditForm`](../../components/jobs/JobEditForm.tsx),
one full-page form covering quantity, unit price, PO #, due date, and billing/shipping/contact
with a single Save. *(An earlier inline "edit icon next to the Order qty chip" is gone —
`updateJobPartQuantity` has exactly one caller.)*

| Rule | Detail |
|---|---|
| Quantity floor | `> 0`; cannot drop below `max(already-shipped, already-invoiced)`. Invoiced can exceed shipped only when a shipment was voided after invoicing. |
| Increases always allowed | Even on an invoiced job — **that is how you bill more**: raise the order, then invoice the delta on a new invoice. |
| Price lock | A part's unit price locks once **any** quantity of it is invoiced (each invoice froze its own price snapshot, so the order total must stay a faithful revenue figure). Un-invoiced parts on the same job stay repriceable. Repricing an invoiced part is a QuickBooks credit/reissue. |
| Cancelled parts | Not editable, quantity or price. |
| Totals | `total_price` recomputed at 4 dp, matching `numeric(12,4)`. |
| Manual price | `job_parts` carries **no override flag** (unlike quote lines' `is_quote_override`), so a manual price is just stored as `unit_price`. A later quantity edit keeps it by default. |
| Which lines can ever reprice | **PO-sourced, `is_quote_override`, and `basis_unknown` lines always keep their price** — there is no tier curve to re-resolve against. `getJobPartPricingBasis` returns `null` outright when the part has no `source_quote_line_item_id` (the PO case), and `resolveJobPartUnitPrice` returns no tier price for an override or unknown-basis line. So the opt-in below is only ever offerable on a quote-sourced, tier-priced line. |
| Status recompute | `trigger_recompute_jp_fulfillment_on_qty` → `compute_job_part_fulfillment_status`, and `trigger_recompute_jp_invoicing_on_qty` → `compute_job_part_invoicing_status`, both `AFTER UPDATE OF quantity`. A part can flip `fully_shipped → partially_shipped` (or `fully_invoiced → partially_invoiced`) when quantity rises. **The access layer never writes either status itself.** |

**Gap — price-break opt-in on edit is not built.** `updateJobPartQuantity` accepts
`opts.useNewTierPrice` and `getJobPartPricingBasis` resolves the frozen tier snapshot, but
**no UI passes it**: `JobEditForm` calls `updateJobPartQuantity(p.id, newQty)` with no opts, so a
quantity edit always keeps the agreed price and the user retypes the price by hand.
*(This doc previously described a modal that "offers the re-resolved price" on a quantity edit.
That behaviour exists only in `ConvertToJobModal`, at conversion.)*

**Gap — no audit trail on the edit.** *(This doc previously said the change is logged to the job
feed as an `event`-type `job_note`. There is no `job_notes` table — the table is `notes`, with
`note_type` `'user' | 'event'` — and neither `updateJobPartQuantity` nor `JobEditForm` writes
one.)* This is a **product gap with no tracking issue**, not a test gap — do not read it as
`automation-pending (#367)`, which covers only the missing reload-persistence E2E.

---

## UI surfaces

### Jobs list — `/dashboard/{companyId}/jobs`

AG Grid: **Job #, Customer, Parts, Status, Due, Created**. Parts renders up to two sorted names
then `+N more`. Status is the single combined lifecycle chip, with an **"At vendor"** chip added
when the job has an outside op at a vendor (`getOutsideOpsForCompany`). Pagination defaults to 25
with a 25/50/100 selector.

Toolbar: search (job number, customer name, customer PO, part number, packing-slip number via
`searchJobsByIdentifier`), a **multi-select** Status control over lifecycle stages, an
overdue-only toggle, a customer filter, and **New Job from PO**. The Status selection is persisted
**per company, device-locally**; the default selection is every open stage, which counts as
"unfiltered" for the empty state. Empty selection legitimately shows no rows.

**Search is capped, and the cap announces itself.** `search_jobs_by_identifier` returns at most
[`JOB_SEARCH_LIMIT`](../../lib/queryLimits.ts) rows because `getAllJobs` sends the matching ids
back through a PostgREST `.in()` URL, which has a measured ~8 KB ceiling — a bigger number would
turn a truncated list into a hard 414. Three properties make that cap honest, and all three were
added in #688:

- **Every filter goes into the RPC** (stage pairs via `stagesToStatusPairs`, customer, overdue),
  so the cap applies to the set the user actually ends up looking at. They used to be applied by
  the caller *after* the cap, which meant they cut into an already-arbitrary subset.
- **The retained rows are the newest** — not `ORDER BY job_id`, which existed only to serve
  `DISTINCT ON` and made the survivors a UUID lottery. A rush tier sorted above the date until
  [`20260906151902`](../../supabase/migrations/20260906151902_remove_hot_job_flag.sql) retired it.
- **Archived jobs are excluded** rather than consuming cap slots and being discarded downstream,
  and the RPC returns an exact `total_matches` counted *before* the cap. When it cuts, the list
  says so: *"Showing the 120 newest matches out of 843."*

If the cap ever genuinely constrains a shop, the escalation is a pager, not a bigger number — see
the inventory count page for that pattern.
*(This doc previously described a single-choice dropdown reading "All Jobs / Not Started / In
Progress / Completed / Shipped / Cancelled", six colour-coded pills, and the empty-state string
"No jobs yet. Create a job or convert a quote to get started." All three were replaced by the
combined multi-select, the single stage chip, and "No jobs found".)*

**There is no "Current Op" column.** See [Current Operation Column](#current-operation-column).

### Job detail — `/dashboard/{companyId}/jobs/{id}`

Header: job number, `JobStatusBlock` (production chip + fulfillment chip with a shipped-quantity
breakdown, created date, due date), overdue badge. Body: Job Details card (customer,
customer PO, source — quote link or "Direct PO" — and Attachments), billing/shipping card, and
per-part cards with operations, live materials and shipment/invoice summaries.

Actions, left to right: Edit · Print Traveler (per part; acts directly on a
single-part job, opens a picker otherwise) · **Shipments** and **Invoices** dropdowns (view
existing + create, so both are reachable without scrolling) · **Activity** (toggles the rail
below) · Reopen *or* Cancel · Delete.
Cancel is offered while production is neither `completed` nor `cancelled`; Reopen only when
`cancelled`; shipping is gated by `canShip` (not cancelled, not fully shipped, has parts).
*(This doc previously gave a per-status action table gating Edit and Create shipment/invoice on
production status; only Cancel, Reopen and `canShip` are status-gated.)*

**The activity rail.** Everything that has happened to the job, newest first, in a column docked
to the right of the page from `lg` up and an overlay drawer below it
([`JobActivityRail`](../../components/jobs/activity/JobActivityRail.tsx)). **It is open by
default**, remembered per browser under `jigged-job-activity-rail-open`: being discoverable
without being summoned is the reason it is a rail rather than an on-demand drawer, and
`activity rail toggled` is the number that says whether that was right.

Three row kinds, merged by a pure module
([`jobActivityTimeline.ts`](../../components/jobs/activity/jobActivityTimeline.ts)):

| Row | Source | On the row |
|---|---|---|
| **Note** (± photos/video) | `notes`, via `getJobNotes` — job-subject *and* durable part-subject notes captured on this job | Edit / delete, gated exactly as RLS is: author edits, author or admin deletes, `note_type = 'user'` only |
| **Completion** | `job_operation_completions`, via `getJobCompletionsForOffice` | **Void**. The note typed into the Complete dialog renders here, on the event it describes |
| **Outside movement** | `outside_shipments` + receipts | The `VPS-` slip number, opening the same preview the step card used to offer |

One slip fans out to a `sent` row, one `received` row per receipt, and a `short_closed` row when
something was retired — never one row that rewrites itself, the same call the operator feed makes
for interval start/finish. Voided slips, receipts and completions stay in the list struck through:
this is an audit surface, so the rule is show-struck-through rather than the usual
`filter-it-out`.

**The office can post here** — a plain text-only composer writing `subject_kind: 'job'` with no
step, which is what the operator traveler renders, so it is a real channel to the floor. Photos
are deliberately absent: that pipeline solves a phone-camera problem the office does not have.

**What the rail deliberately cannot show is recorded TIME.** `job_operation_intervals` has no
admin SELECT policy at all — [`20260816203641`](../../supabase/migrations/20260816203641_job_operation_intervals.sql)
argues a row-returning policy exposing `operator_id` would *be* a per-person report — and
[`20260825170421`](../../supabase/migrations/20260825170421_drop_per_person_time_reporting.sql)
removed the one audited exception. The operator feed has start/finish rows; this one has none, and
that asymmetry is the guardrail rather than an oversight. Office time stays aggregate and
identity-free on the step card (`get_operation_actuals`).

**A `?op=` deep link** scroll-highlights the step *and* narrows the rail to it, so arriving from
the outside-work drawer lands on a highlighted step with its history already showing.

**Step cards carry a note count, not a history.** Completion history, vendor slips and operator
notes all used to live behind an expand chevron on
[`OperationCard`](../../components/jobs/OperationCard.tsx) — three chronological histories sorted
into per-step buckets, only one of which could be open at a time. They moved here; the chevron is
gone, and the count that remains is a control that filters the rail to that step
(`activity step filtered`).

**Attachments.** Customer PO PDFs and reference files. **View** opens the file in a dialog
(`<iframe>` for PDFs, `<img>` for images) off a fresh signed URL, so the PO is readable without
leaving the job. Bytes live in the private `attachments` bucket, metadata in `job_attachments`.
Add/remove happens on the Edit screen; the detail card is `readOnly embedded` — view + download.
[`utils/jobAttachmentsAccess.ts`](../../utils/jobAttachmentsAccess.ts) +
[`JobAttachmentsCard.tsx`](../../components/jobs/JobAttachmentsCard.tsx).

**Invoicing.** Job-keyed, and a job can have **many** invoices (progressive billing). The picker
defaults each line to shipped-but-unbilled and caps at ordered-but-unbilled — billing ahead of
shipping is allowed (a packing slip isn't a delivery) and only softly flagged. Full spec:
[Invoicing](invoicing.md).

**Each QuickBooks Online invoice in the Invoices menu carries a payment chip** — paid, partly paid,
open, overdue, voided or deleted in QuickBooks, with the balance. It refreshes when the menu opens,
and only when something says it is out of date; there is no button, because the person opening the
menu cannot know whether the number is current. Desktop rows carry no chip. Rules, and what happens
to invoiced quantity when QuickBooks voids an invoice:
[Payment status](invoicing.md#payment-status-quickbooks-online-mirror).

**Cancel dialog:** "Every part on the job will be marked cancelled. You can reopen the job later."
No reason field. *(This doc previously specified a required Cancellation Reason input and the copy
"This action cannot be undone" — neither is true; `cancelJob(jobId)` takes no reason and Reopen
exists.)*

### Delete is archive — and the UI still blocks it

`deleteJob` stamps `deleted_at` and returns. **The records-of-value guards were removed**: its own
comment reads *"No shipment/invoice guards: archiving preserves the row and its history, so it can
never orphan a record."* Reads filter `deleted_at IS NULL`; every downstream reference keeps
resolving. *(This doc previously said "Delete (only if no shipments/invoices)" in three places and
cited two `deleteJob` tests asserting rejection. Those tests were replaced by
`'archives even when the job has shipments and an invoice (records-of-value guards removed)'`.)*

See **SUSPECTED CODE BUG** below: the detail page has not followed.

---

## Job operations on the admin side

Operations are snapshotted from the routing at job-part creation and stepped through on the job
detail page. The **only** admin actions are **Mark Complete** (opens a quantity dialog defaulting
to the remaining balance), **Mark Sent Out** / **Mark Received** for outside ops, and **Undo**.
*(This doc previously listed Start and Skip actions and an "only one in progress at a time" rule.
Neither `startJobOperation` nor `skipJobOperation` exists, and nothing enforces exclusivity —
`in_progress` is derived from partial completion quantity, not asserted.)*

`completeJobOperation` and `undoJobOperation` both **throw for an outside op**, routing
the user to the send/receive controls instead.

### Mark Complete is the untimed path, and first write wins

Rewritten 2026-08-28 after J-0001, where the office and the shop floor each had a half-picture of
one step and neither could see the other's.

**It records `capture_source: 'office'` and opens no interval** — the same shape as the operator's
`Complete without timing`. The office was not standing at the machine and has no duration to report,
so it writes none rather than a guess. The completion appears in the operator's job feed marked
`recorded in the office` ([operator-view.md](operator-view.md#recording-a-completion)); before this
it appeared nowhere on the floor at all.

**If a timer is running on that step, Mark Complete discards it.** Closing someone else's interval
would stamp an end time nobody in the office witnessed, and a fabricated duration is worse than a
missing one because the estimating loop reads it back as measurement. So the interval is voided:
better no data than bad data. The dialog says so *before* the click when
`get_operation_actuals` reports an open interval, and the snackbar says how many were discarded
after. The completion is written **first** — it is the durable production fact — so a failed discard
leaves an orphan the dashboard's Still-running **Stop** can clear, rather than destroying an
operator's measured minutes and then failing to record the work they were measuring.

**A second completion against work someone already recorded is refused, not added.** Completions are
additive, so two people each recording "the remaining 2" on a 2-piece step silently produces 4 good
on an order of 2 — over-completion the UI warns about when you *type* it, arriving with nobody
having typed it. Both surfaces pass the `qty_good` they were showing as `expectedQtyGood`;
`createOperationCompletion` re-reads the live sum immediately before inserting and throws
`CompletionConflictError` if it has **grown**, writing nothing. Grown, not merely changed: a sum
that *shrank* means somebody undid work, and banking against a smaller base is a correct outcome
rather than a double-count. Symmetry was the wrong instinct — the operator step screen reloads the
job and the summary together after an undo, and there is a render between the two where its own
`qty_good` is still the pre-undo figure, so `!==` refused writes that were never dangerous. The losing screen re-reads and shows where
the step actually stands, with Undo beside it if the winner got it wrong.

That check is a compare-then-write rather than a constraint, and the limit is stated rather than
hidden: **the database cannot tell a legitimate partial from a stale duplicate** — additivity is the
feature — so only the caller can, by saying what it believed was there. It closes the window that
matters, which is minutes long (a dialog left open while the floor finishes the step), and not a
sub-second double-submit. Making it atomic would mean moving the insert into an RPC, which is a
Supabase-first violation for a race whose damage is one click of Undo. `operation completion
conflicted` measures whether that trade stays right.

---

## Outside (external-vendor) operations

An operation carrying a `vendor_service_id` is performed by an outside vendor (anodizing, plating,
heat-treat). It is a first-class routing step, not paperwork.

> **⚠ Corrected 2026-08-23.** This section previously identified an outside op by
> `work_centers.kind='external'`. That column is **dropped** — an op is outside work iff it targets a
> vendor service. See [vendor-services.md](vendor-services.md).

> **⚠ Rewritten 2026-09-03.** The send used to be a *status*, written straight onto the operation
> by a Mark Sent Out button. It is a **row** now — `outside_shipments`, one per send, carrying a
> quantity — and `job_operations.status` / `sent_at` / `sent_by` are **derived from it**. A
> hand-written status on an outside op is refused by a trigger, so paperwork and status cannot
> drift. Full module: [outside-processing.md](outside-processing.md).

**Lifecycle — quantities, exactly like an in-house op, plus `sent` for what is away:**

| Reading | When |
|---|---|
| `completed` | received good ≥ `job_parts.quantity`. **Tested first**, so 120 sent / 100 good back / 20 never returned is done, not held open over 20 pieces nobody wants |
| `sent` | live shipment quantity exceeds received good-plus-scrapped — i.e. pieces are physically at a vendor |
| `in_progress` | everything that went out has come back and it was not enough (98 good + 2 scrapped of 100) |
| `pending` | nothing has gone out |

- **An operation may have MANY shipments.** Send 50 now, 50 next week; each mints its own
  `VPS-{jobBase}-{n}` slip. That is the whole reason the quantity picker exists.
- **`quantity_scrapped` is separate from `quantity_good` and both are needed.** Together they
  retire the vendor's outstanding balance, so the step stops reading "at the vendor". Only `good`
  counts toward the step being done. 98 + 2 of 100 therefore closes the slip and leaves the op
  `in_progress` — the same answer an in-house op gives at 98 good. **There is deliberately no
  "close this out" flag**: it would be a second mechanism for a fact these two numbers already
  carry, and the two would eventually disagree.
- **Undo steps back one MOVEMENT** — the newest live receipt, else the newest live shipment. Never
  both, never skipped.
- Never completable through the internal path (`completeJobOperation` / `createOperationCompletion`
  still throw); **never auto-skipped**.
- **The 2026-08-23 exemption is gone, and its hazard is closed by construction.** That exemption
  existed because `recompute_job_ops_status_from_part_qty()` runs the status function over every op
  on a part, and a `sent` op with no completions reset to `pending`. It cannot now: the outside arm
  reads shipments and receipts, and a quantity edit writes neither.

**Surfaces:** the admin job-detail op card; the operator traveler + operation page (**Mark Sent
Out** / **Mark Received** there too — the shop floor drives the send, not just the office —
plus the "Outside process" badge + vendor); the printed traveler (heavy black outline + bold text, border-only and
low-ink after a shop-owner ink complaint, with `OUTSIDE — ship to {vendor}` in the Notes column,
where in-house steps show setup·cycle).

> **⚠ Corrected 2026-08-23 — the company-wide queue is gone.** There was an **Outside processing**
> tab on the Vendors page (`OutsideWorkPanel.tsx`) carrying inline Mark Sent Out / Mark Received /
> Undo across every job, and this doc argued at length for siting it under Vendors "because outside
> processing is vendor work". Both the tab and the component are **deleted**. The argument was
> answering the wrong question: the actions were never exclusive to it — the job operation card has
> carried all three at full fidelity throughout — so the tab was a *duplicate* action surface, and a
> second place to act on the same row is a liability rather than a convenience. What it uniquely
> offered was a cross-job worklist, and the Jobs list already answers that with its **At vendor**
> chip on any job whose parts are out. Vendors keeps the vendor-shaped half of the question, read
> only: `Services`, `Out now` and `Oldest out` columns on the list, and an **Open jobs** card on the
> vendor, whose rows deep-link to `?op=` on the job so acting is one click rather than a hunt.
> `getOutsideOpsForCompany` survives — it backs all of the above.
>
> **Still true after 2026-09-03, and worth saying because that change adds a cross-job page.**
> `/dashboard/{companyId}/outside-work` lists SLIPS, not operations, and is read-and-reprint only:
> send, receive and undo stay exclusively on the operation, and Void is reachable only inside a
> slip's own preview. The deleted tab's liability was a second place to **act** on the same row;
> a numbered, printable, voidable document is a thing an operation row cannot represent at all,
> which is why the register is not a re-litigation of that decision.

**Audit:** send/receive are **not** written as notes — the `outside_shipments` and
`outside_shipment_receipts` rows *are* the record, and `sent_at`/`completed_at` mirror them. The **/activity** feed derives vendor-tagged
**"Sent to {vendor}"** and **"Received from {vendor}"** rows under the Operations filter from those
columns (`dashboardAccess.fetchOperationActivity`). Undo voids the movement, so the row drops off on
reload — same as internal-completion undo. The slip itself keeps its number, marked voided: the
vendor may still be holding the printed copy. Operator notes + photos stay fully
enabled on outside ops; they are real user notes, no longer polluted by auto-events.

The **job activity rail** derives its own `sent` / `received` / `short_closed` rows from the same
`outside_shipments` columns, in a pure function rather than by writing `note_type = 'event'` rows:
the ledger already owns those facts, and a second copy in `notes` would eventually disagree with
it.

**Deferred:** vendor lead-time → due-date math, per-op cost actuals, and scheduling.
*(⚠ Two items left this list on 2026-09-03. **Partial/split sends** shipped — that is what the
whole outside-processing module is. **PO generation** was not deferred but* dropped: *the slip is
the outside-work document, and it works with no accounting system connected, which the purchase-
order plan could not.)*

---

## Current Operation Column

*The jobs-list column of this name was removed; this section survives under its original heading
because [operator-view.md](operator-view.md) links this anchor for the **readiness rule**, which is
still owned here.*

**Readiness rule.** A pending operation is ready when **no earlier-`sequence` operation on the
same `job_part` is anything other than `completed`**. The lowest-sequence pending op is ready
immediately. *(This doc previously scoped the rule to the same **job** and allowed a predecessor to
be `completed` **or skipped**. Both are wrong: the RPCs key on `prev.job_part_id`, and the
predicate is `prev.status <> 'completed'` — so a `sent` outside op blocks its successors, which is
the intended behaviour.)*

Two RPCs implement it identically, so "ready" has one definition:

| RPC | Caller | Returns |
|---|---|---|
| `get_ready_operations_batch(p_job_ids)` | `getReadyOperationsForJobs` — **no production caller**; dead code kept only by its test | one row per job: the in-progress op if any, else the lowest-sequence ready pending op + a ready count |
| `get_ready_operations_for_station(p_company_id, p_work_center_id)` | `operatorAccess` (My Station, and All Stations fanned out once per station) | ready-or-active ops at that station, running steps first |

Out-of-order work is **warned, not blocked** (`predecessors_incomplete`) — see
[operator-view.md](operator-view.md#routing--readiness).

---

## Job creation from routing

`create_job_part_operations_from_routing(p_job_part_id, p_routing_id)`:

1. Inserts one `job_operations` row per `routing_operations` row (ordered by `sequence`, then
   `created_at`), assigning fresh sequences 10, 20, 30…, carrying `work_center_id`, the work
   centre's name as `operation_name`, `instructions`, `setup_minutes` →
   `estimated_setup_minutes`, `cycle_minutes_per_unit` → `estimated_run_minutes_per_unit`, and
   `routing_operation_id` — plus the **rates** the operation will be costed at:
   `work_center_kind_snapshot`, and either `labor_rate_snapshot`
   (`COALESCE(labor_rate_override, work_centers.labor_rate)`, internal) or
   `external_unit_price_snapshot` (external). Idempotent on `(job_part_id, routing_operation_id)`.
2. Copies the **part's BOM** into `job_materials`, one row per `parts_bom` edge, idempotent on
   `parts_bom_id`.
3. Sets **`job_parts.current_operation_sequence` = `MIN(sequence)`** of the rows it wrote.
   *(This doc previously said it sets `jobs.current_operation_sequence = 10`. `jobs` has no such
   column, the cursor is per-part, and it is the computed minimum rather than a literal 10.)*

The snapshot is not retroactive: editing a routing later leaves existing jobs untouched.

---

## Material Tracking

Materials are **part-attached** (`parts_bom`), not routing-attached — `routing_materials` was
removed. A job part has one materials list regardless of how many operations its routing has.

`job_materials` is **write-only**: written by `create_job_part_operations_from_routing`, read by
nothing since `20260614043526_retire_job_material_consumption` dropped its consumption columns.
Its full shape is nine columns — `id`, `job_id`, `job_part_id`, `parts_bom_id` (nullable; the
source edge, and the snapshot is idempotent on it — deleting the BOM line NULLs it via
`job_materials_parts_bom_id_fkey ON DELETE SET NULL`), `material_part_id`, `expected_quantity`
(numeric, CHECK `>= 0` — the BOM quantity at job-part creation), `unit`, `created_at`,
`updated_at`. **There are no `status`, `actual_quantity`, `consumed_at` or `consumed_by`
columns**, and no `inventory_item_id` FK — older copies of this doc showed both.
The decision to **drop the table** and back consumption onto the ledger is owned by
[`inventory.md`](inventory.md) §5.9.

Per-job consumption **is** tracked, as of 2026-07-28, **on the ledger**: journey J7 records an
`inventory_transactions` depletion tagged with `job_id` when the operator takes material on the
traveler. `job_materials` was not revived. The tagged take is the **primary** path, not the only
one — an ad-hoc **Remove stock** against the material part (`PartLocationActionModal` /
`OperatorLocationActionModal`) stays available for every draw that isn't a job take, and simply
records an untagged depletion.
**Stock never decrements as a side effect of completing an operation — the take is the event, not
the completion.**

The job page renders [`JobPartMaterialsCard`](../../components/jobs/JobPartMaterialsCard.tsx),
read-only, showing **required** from the **live BOM** (`getBomForPart`, so the job reflects the
current BOM), **on-hand** from `parts.quantity`, and **issued** from this job's depletion rows.
There is no mark-consumed or mark-skipped action.

**Known limitation (deliberate):** "issued" is job-level, not job-part-level — two parts drawing
one material show the same figure, hence the label *"issued to this job"*. One nullable
`job_part_id` column plus an index fixes it; omitted to keep Phase 1 migration-free.

<!-- Linked by section number, not an anchor. The old link pointed at a `#### job_materials is
     write-only` heading that the 2026-07-31 condensation folded into §3's data-model table, and a
     heading kept alive purely to satisfy an anchor is the kind of bloat that condensation removes.
     §5.9 is the section that actually owns this decision. -->

---

## Acceptance Criteria

Every row cites a **file + `describe`** with its `it` count, or carries an explicit
`automation-pending` tag. **The standing convention: every editable entity gets at least one
`edit → save → reload → persists` row.** Where no E2E reloads after the save yet, the row cites
the write path's unit tests and tags the reload assertion `automation-pending` — that is why so
many rows below carry `(#367)`. Doc-vs-code disagreements from the earlier audit are on
[issue #343](https://github.com/debola31/Jigged/issues/343); missing reload-persistence E2E is
tracked by [#367](https://github.com/debola31/Jigged/issues/367).

Unit tests live in [`__tests__/utils/jobsAccess.test.ts`](../../__tests__/utils/jobsAccess.test.ts)
unless stated.

| Behaviour | Verification |
|---|---|
| Search over job number, customer, customer PO, part number, packing slip; blank is a no-op; filters + `JOB_SEARCH_LIMIT` forwarded to the RPC | `describe('searchJobsByIdentifier')` — 7 it |
| Search restricts the main query by id, mixes in `match_source`, reports `total`/`truncated`, and drops nothing client-side | `describe('getAllJobs — search path')` — 6 it |
| The cap applies after every filter, keeps the newest, excludes archived jobs, clamps `p_limit`, and stays SECURITY INVOKER | [`api/tests/integration/test_jobs_search_cap.py`](../../api/tests/integration/test_jobs_search_cap.py) — 17 tests. Needs >`JOB_SEARCH_LIMIT` jobs, which `seed.sql` deliberately does not have |
| Stage → status-pair mapping is exact, total and disjoint (the banner's count depends on it) | [`__tests__/types/job.test.ts`](../../__tests__/types/job.test.ts) `describe('stagesToStatusPairs')` — 9 it |
| Closed stages hidden by default; stage filters applied server-side via `.in()` | `describe('getAllJobs')` — 5 it; [`e2e/jobs-list-status.spec.ts`](../../e2e/jobs-list-status.spec.ts) `test.describe('Jobs list — combined status filter')` — 2 tests |
| Overdue uses one canonical clause set on the same builder | `describe('applyOverdueJobsFilter')` — 1 it |
| Quote → job: one `job_part` per (part, qty) with cloned ops; fractional qty survives | [`e2e/quote-to-job.spec.ts`](../../e2e/quote-to-job.spec.ts) `test.describe('Quote to Job workflow')` — 1 test; [`e2e/fractional-quote-to-job.spec.ts`](../../e2e/fractional-quote-to-job.spec.ts) `test.describe('Fractional quote to job workflow')` — 1 test |
| PO path validates everything before any write, and fails fast on a made part with no routing | `describe('createJobFromPurchaseOrder')` — 7 it |
| Bought part → 0 operations, `production_status = 'completed'`, job rolls up to `completed` | manual + DB-validated in a rolled-back txn; full-flow E2E `automation-pending` |
| No blank-job route exists | manual: no `/jobs/new` under `app/dashboard/[companyId]/jobs/` |
| Quantity edit — price kept, 4 dp total, no status write, floors, invoiced-increase, cancelled refusal, tier opt-in | `describe('updateJobPartQuantity')` — 12 it. Reload persistence `automation-pending (#367)` |
| Price edit — recompute, zero allowed, per-part invoice lock, cancelled refusal | `describe('updateJobPartPrice')` — 8 it. Reload persistence `automation-pending (#367)` |
| Header patch: only provided fields, `""` → null, omitted keys untouched | `describe('updateJobDetails')` — 6 it |
| Address/contact FKs scoped to job + company, `""` → null, no clobber | `describe('updateJobAddressContact')` — 3 it |
| Cancel marks every `job_part` cancelled | `describe('bulkCancelJobs')` — 3 it. Single-job cancel `automation-pending` |
| Reopen re-derives each part from its ops, bypassing the cancelled-skip | `describe('reopenJob')` — 1 it |
| Delete **archives**, scoped to id + company, **even with shipments and an invoice** | `describe('deleteJob')` — 4 it |
| A `sent` op holds its part at `in_progress`; admin Complete/Undo refuse an external op | `describe('deriveStatusFromOps with the sent (at-vendor) state')` — 2 it; `describe('admin op guards refuse external (outside-vendor) ops')` — 2 it |
| Invoice creation advances `invoicing_status` and lists the invoice | [`e2e/job-invoicing.spec.ts`](../../e2e/job-invoicing.spec.ts) `test.describe('Job invoicing (QuickBooks)')` — 1 test |
| Job-level recompute cascade (part change → `compute_job_production_status` → job row) | `automation-pending` — SQL in `supabase/migrations/` |
| Auto-progression: first op complete → job `in_progress` (no manual Start Job); last op across all parts complete → job `completed` (no manual Mark Complete) | `automation-pending` |
| Marking a ready op complete makes the next-sequence op on that part ready; Undo returns it to pending | `automation-pending` (`completeJobOperation` / `undoJobOperation`) |
| Creating a shipment record advances `fulfillment_status` as a side effect — there is no "Mark Shipped" production transition | `automation-pending` |
| Attachment upload / inline view / delete persists across reload | `automation-pending` |

---

## SUSPECTED CODE BUG — the delete gate on the detail page

`utils/jobsAccess.ts#deleteJob` archives unconditionally, per CLAUDE.md's *"Deletion is archive
(soft-delete), and never blocks"*. [`app/dashboard/[companyId]/jobs/[jobId]/page.tsx`](../../app/dashboard/[companyId]/jobs/[jobId]/page.tsx)
has not followed:

- `handleDeleteClick` refuses when `shipmentCount > 0` or a QuickBooks invoice link exists —
  *"kept for recordkeeping and can't be deleted"* — so a shipped job can never be archived from
  the UI, though the access layer and its test say it must be.
- The confirm dialog then claims the action *"permanently removes the job and all of its parts,
  operations, notes, and attachments. This cannot be undone."* Nothing is removed and it is
  reversible by clearing `deleted_at`.

Not fixed here (docs-only change). Both the gate and the copy need to go.
