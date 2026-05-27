# PRD: Shipments (v2.2)

**Status:** v2.2 — corrections on top of v2.1: restores the Bill To block alongside Ship To on the packing slip (Created By is not on the slip), and drops the "Create Reorder" surface added in PR 6 along with its `jobs.related_to_job_id` data model. Flow F (reopening a closed job) is removed; FR-21 simplified accordingly.
**Author:** Debola Akeredolu
**Last updated:** May 20, 2026
**Related GitHub issues:** #228 (packing slip generation), #229 (auto-close on full shipment), #230 (shipment tracking visible on job detail)
**Related milestone:** Shipping & Order Fulfillment

---

## 0. Why this PRD looks different from v1

V1 was a competent spec. V2 is the same product idea passed through three frameworks: Cagan's Inspired, Fadell's Build, and SVPG's writing on Customer Discovery Programs. The frameworks change what goes at the top.

The traditional PRD opens with problem and goals. This one opens with a press release for the feature six months after launch, then the headline moment, then the hypotheses and the four risks the Friday demo is meant to address. Implementation detail (requirements, data model, phasing) comes later. This is the Fadell ordering: write the story before you build the product. It's also the Cagan ordering: tackle the riskiest assumptions before you write code, and use the production build as your discovery vehicle when the cost calculus permits.

One material deviation from Cagan: he insists MVP should mean "Minimum Viable Prototype" because building production code for learning is wasteful. We are shipping production code as the prototype. The deviation is deliberate. Two conditions have changed since Cagan wrote that:

1. AI-assisted development has compressed the cost of "production-quality enough" by an order of magnitude. The waste argument is weaker.
2. the shipping clerk cannot be reached for a remote Figma walkthrough. the salesperson is the only path to her, and the salesperson needs to demo something real in her workflow.

So the beta-in-production *is* the prototype, gated behind a feature flag scoped to the pilot customer. Cagan's underlying principle — validate before you commit to scale — is preserved. The artifact is different.

This is consistent with Fadell's V1 framing in Build: the first generation product is essentially a prototype that ships, for innovators and early adopters who tolerate a rough experience. the pilot customer is exactly that profile.

One architectural commitment v2 makes deliberately: we are getting the job status model right on the first commit, not patching it later. The existing `jobs.status` enum (`not_started | in_progress | completed | shipped | cancelled`) conflates two independent concepts — what's happening in the shop versus what's happening to the customer's order. The conflation worked when no real shipments existed in the system. It breaks now. §7 makes this architecturally clean before we start writing shipment records against it. Doing this upfront is more work than reusing the existing `shipped` value would be, but it avoids a migration we'd otherwise be forced to run within weeks, and it removes a class of ambiguity that would confuse the shipping clerk on Friday ("is this job still being worked on?" cannot be answered if the only available status says `shipped`).

---

## 1. Background and the painkiller

Jigged covers customer → part → quote → job → operator execution. It stops at "job is done." There is currently nothing in the system that captures what physically left the shop, when, to whom, against which order, in what quantity. The job either sits open forever (Tangle's failure mode) or gets manually flipped to a status nobody trusts.

Fadell's framework distinguishes painkillers from vitamins. Painkillers solve acute, frequent, named pain. Vitamins are pleasant additions. The shipment work is two things bundled together, and they have different framings:

**The painkiller is shipment visibility, not the packing slip.** the salesperson spent six minutes in usability testing describing the inability to answer "where's my order?" without walking to find the shipping clerk. He uses the words: "I have to go find the shipping clerk up front and say, 'Can you look in here and tell me if this has been shipped?'" That is a pain felt every working day, multiple times per day, by a senior salesperson. Painkiller.

**The packing slip itself is closer to a vitamin.** Tangle has one. E2 has one. Every system in the category has one. the shipping clerk prints one every day; she's not bleeding. A better-looking slip is a nice addition but it's not what creates the relief moment.

This distinction matters because it tells you what to design around. The packing slip is table stakes — get it right, ship it, move on. The visibility experience is where Jigged earns its place in the salesperson's day.

---

## 2. The press release

Fadell's discipline: if you can't write the press release for the feature, you don't yet know what you're building. This is the press release for Jigged Shipments six months after launch, written from the salesperson's perspective in his own voice. The acid test is whether it sounds true.

> "Used to be, every time a customer called asking where their order was at, I'd put them on hold, walk down to the front, find the shipping clerk, and have her dig through Tangle to see what shipped. Sometimes it took ten minutes. Now I just pull up the job in Jigged and I can see it right there — what's shipped, what's still owed, the packing slip number, the date, the tracking if she put it in. I'm answering customer calls in thirty seconds without leaving my desk. And the jobs list actually shows what's open versus done. Tangle had a whole bunch of jobs sitting open that were really shipped weeks ago. Jigged closes them on its own when the last piece goes out. Honestly the biggest thing for me isn't the packing slips, it's that I can finally see what's going on without bugging the shipping clerk."

If that's what the salesperson actually says in six months, the feature worked. Every requirement below should ladder up to making that paragraph true.

What's notable about this press release: the salesperson names the painkiller (visibility, not paperwork), he names a specific number (thirty seconds, ten minutes), he distinguishes Jigged from Tangle on the behavior that matters (auto-close), and he downgrades the packing slip relative to the visibility. The PRD should match this hierarchy.

---

## 3. The headline moment

Fadell asks: if one thing in this feature is perfect, what is it? The thing the user remembers, the thing they tell their peers about, the thing that anchors the feature's identity.

For Shipments, the headline moment is this:

> A customer is on the phone with the salesperson. the salesperson types the PO number into Jigged's search bar. The job loads. At the top of the job page, in his immediate field of view, he sees: ordered, shipped, remaining, last ship date, packing slip number, tracking. He reads it to the customer. The call ends in under sixty seconds. the shipping clerk never knew the call happened.

Three design implications follow from picking this moment as the anchor:

**Information density is prioritized over visual minimalism on the job detail page.** the salesperson is reading aloud during a phone call. He needs to see everything at once without scrolling, hovering, or clicking. This is where Jigged should look more like the legacy systems the salesperson is used to (information-dense, scannable) than like a modern minimal SaaS dashboard. the salesperson told us in usability testing that the new E2 layout "wasn't immediately recognizable" — change aversion is real in this market. The job detail header should be a heads-up display, not a hero section.

**Search has to be fast and forgiving.** A PO number, a job number, a customer name should all hit. Auto-suggest with the right answer in the first two characters typed. This is the moment the salesperson is interrupting a phone call. Friction here is the whole feature failing.

**Auto-close has to be trustworthy.** If the salesperson's customer is on the line and the job says "open" but it actually shipped last week (because someone forgot to close it), the painkiller becomes a poison pill. Auto-close from physical shipment events is what makes the displayed status believable.

Every other flow in this PRD supports this moment. Shipment creation has to happen reliably so the data is there for the salesperson. The packing slip has to print so the shipping clerk keeps using the system instead of routing around it. The job detail page has to render the status block before anything else loads. If we built shipment creation perfectly but the headline moment was broken, the feature would fail.

---

## 4. Hypotheses and the four risks

Cagan frames every product idea against four risks: value, usability, feasibility, business viability. This section names what we believe, what would prove us wrong, and which risk each belief addresses. The Friday demo is structured to probe all four.

### Value risk: will the shipping clerk actually use the create-shipment flow?

**What we believe:** the shipping clerk will adopt the create-shipment flow if it's three clicks or fewer for the common case (ship everything that's remaining on a job) and the resulting packing slip looks at least as good as Tangle's.

**Why we believe it:** the salesperson said E2 "worked pretty well" for this job. E2 and Tangle both have the same basic flow pattern. The pain isn't the flow, it's the visibility downstream of it. If the shipping clerk's daily flow is comparable in friction to what she has now, adoption is mostly determined by whether the rest of the shop (the salesperson, the pilot shop owner) is using Jigged.

**What would disprove it:** the shipping clerk watches the salesperson demo the create-shipment flow on Friday and her reaction is "that's more steps than what I do now" or "I'd never give up Tangle for that." Or she tries it and gets stuck on a step we didn't anticipate.

**How we mitigate it:** This is the riskiest assumption in the PRD because the shipping clerk has not been a research participant. Friday is the first time she sees anything. We mitigate by making her reaction the gating decision for Phase 3 (full rollout). If she objects on Friday, we don't build the full thing.

### Usability risk: can the shipping clerk figure out the flow without training?

**What we believe:** A first-time user can create and print a packing slip in under five minutes during a guided session, with the salesperson narrating but not clicking.

**Why we believe it:** The flow is conventional. Every job-shop ERP in our research has roughly this pattern. the shipping clerk has used both E2 and Tangle and is comfortable with the genre.

**What would disprove it:** the shipping clerk can't find the "Create Shipment" button. the shipping clerk doesn't understand what "Shipping Arrangement" means. the shipping clerk creates the wrong quantity and doesn't realize it. the shipping clerk prints the slip and reacts negatively to its appearance.

**How we mitigate it:** Pre-Friday checklist requires a colleague (not the salesperson) doing the flow cold. If they can't do it in five minutes, neither can the shipping clerk.

### Feasibility risk: can we build it cleanly in the time we have?

**What we believe:** The data model and core flows are straightforward CRUD plus a PDF render plus a trigger. Claude Code can produce a working Phase 1 in a few days.

**What would disprove it:** The dual-status migration interacts badly with existing job-status logic. Multi-tenant RLS on the new tables breaks. Triggers cascade in unexpected ways during high-volume operator activity. PDF generation at the volume needed is too slow. None of these are likely but none have been verified.

**How we mitigate it:** Phase 1 is shipped end-to-end (ugly) before Phase 2 begins. If feasibility blows up, we discover it before we've committed to polish.

### Viability risk: does this make the pilot shop owner more likely to pay for Jigged?

**What we believe:** This feature, combined with quoting, brings Jigged across the threshold where the pilot shop owner sees it as a credible Tangle replacement and is willing to start the paid-pilot conversation.

**Why we believe it:** the salesperson's biggest complaint about Tangle is shipment visibility, and the pilot shop owner reportedly cares most about reporting and accountability. Both of those concerns are addressed by the shipment data this feature captures. The auto-close feature alone removes one of the most visible operational frustrations in the pilot shop owner's current setup ("half of them are closed").

**What would disprove it:** the pilot shop owner sees the demo and says "interesting but I need [other feature] first." Or the pilot shop owner uses it for two weeks and his behavior doesn't change because Tangle is still the source of truth for him.

**How we mitigate it:** The post-Friday decision framework explicitly includes a "the pilot shop owner conversation" trigger — when do we ask the pilot shop owner the paid-pilot question? The answer should be after the shipping clerk has used the system for at least one week and we have signal from her.

---

## 5. Primary user, secondary users

V1 of the PRD treated three personas equally. Cagan would force a hierarchy. Here it is.

### Primary user: the shipping clerk (shipping clerk)

the shipping clerk uses the create-shipment flow daily. She is the user whose adoption determines whether the feature is real or theoretical. Every functional requirement in this PRD should pass the "the shipping clerk can do this on Friday" test.

What we know about the shipping clerk: she handles shipping at the pilot customer. the salesperson mentioned her by name. She uses Tangle today. That's it. Everything else in v1's persona description was invented from the salesperson's secondhand account.

This is the riskiest gap in the PRD. The Friday demo is the first time we will have direct contact with this user. The whole beta exists to convert her from an inferred user to an observed one.

### Secondary user: the salesperson (salesperson, primary buyer-proxy)

the salesperson doesn't create shipments. He consumes the data the shipping clerk's flow generates. His daily pain — "where's my order?" — is the visibility experience, not the create flow. The job detail page and the job list views are his surfaces.

the salesperson is also the buyer-proxy: he's the user the pilot shop owner listens to about whether Jigged is working. the salesperson's experience is what creates the case for the pilot shop owner to pay for Jigged. Cagan's framing: features that empower the daily user create the references that empower the sale.

### Secondary user: the pilot shop owner (owner, budget owner)

the pilot shop owner cares about reporting. He's interested in fulfillment rates by customer, on-time delivery, jobs that have been stuck open too long. None of these reports ship in v1. The data layer captures everything the pilot shop owner will eventually want; the reports come after pilot validation.

the pilot shop owner is the budget owner and the gate to a paid pilot. His experience of this feature is "the salesperson stopped complaining about Tangle" and "the open-orders list actually means something now." Indirect but high-leverage.

### Out-of-scope user: operator

Operators do not create or view shipments in v1. They see "this job has shipped" passively on the traveler view. Whether operators should ever initiate shipments is a separate shop-floor research question.

---

## 6. Goals and non-goals

### Primary goals

- Make the headline moment from §3 real. the salesperson answers a customer's "where's my order?" call in under 60 seconds without leaving his desk.
- Get the shipping clerk to use the create-shipment flow at least once on Friday with the salesperson watching, and ideally multiple times in the week after.
- Auto-close jobs when fully shipped so the open-orders list reflects reality.
- Produce a packing slip that's at least as good as Tangle's.

### Secondary goals

- Capture shipment data cleanly enough that it becomes a useful dataset for the platform thesis (delivery performance, customer concentration, repeat ship-to patterns) when reporting ships in v1.1.
- Earn the the pilot customer pilot conversation. Move the pilot customer from design partner to reference customer.
- Set up the data model so that future work (carrier integrations, BOL generation, customer portal) slots in without rework.

### Non-goals

Each deliberate cut. Fadell's rule: don't disrupt too many things at once. The Amazon Fire Phone failed because it changed too much. This PRD changes one thing — shipment visibility — and accepts table-stakes parity on everything else.

- **Carrier label printing or rate shopping.** Shops use the customer's UPS/FedEx account or the carrier's own web tool. EasyPost and Shippo dominate e-commerce, not job shops. Defer.
- **Bill of Lading generation.** LTL is minority of small-shop volume.
- **Multi-warehouse / multi-location inventory.**
- **International customs documents.**
- **First Article Inspection Report generation.** Aerospace territory, not ICP.
- **Standalone Certificate of Conformance documents.** Embedded tagline on the packing slip covers the pragmatic case.
- **Customer-facing portal.** Worth planning for in the data model; not built in v1.
- **Operator-initiated shipments.** Gated on shop-floor research.
- **Reporting dashboards.** Data is captured; visualization ships in v1.1 after pilot data exists.
- **Email-from-Jigged** of slips to customers. Download-and-attach is fine in v1.

---

## 7. Domain model

The atomic unit is `Shipment`, not `PackingSlip`. A PackingSlip is one rendering of a Shipment. A future BOL would be another rendering. A future "track my order" page would be another view.

### 7.1 The two orthogonal lifecycles

The architectural truth confirmed by every job shop ERP in our research is that a job has two independent lifecycles. The current Jigged schema conflates them, which worked while no shipments existed in the system. With shipments, the conflation fails.

**Production lifecycle.** What's happening in the shop. Independent of whether anything has left the building.

```
not_started → in_progress → completed
                                ↓
                          cancelled (terminal, from any prior state)
```

**Fulfillment lifecycle.** What's happening to the customer's order. Independent of whether the shop is still working on remaining quantity.

```
unshipped → partially_shipped → fully_shipped
```

These evolve independently. Examples of real states that the old conflated enum cannot represent cleanly:

- *In production AND partially shipped:* 10 of 50 parts are made and shipped; the remaining 40 are still being machined. Production = `in_progress`, Fulfillment = `partially_shipped`. Common at the pilot customer today.
- *Completed AND unshipped:* the parts are finished and sitting in finished goods, waiting for the customer to pick them up next Tuesday. Production = `completed`, Fulfillment = `unshipped`. This is the "Ready to Ship" queue.
- *Cancelled AND partially shipped:* the customer cancelled the remainder after the shop had already shipped 5 of 20. The shipped quantity stays shipped (it's at the customer); the rest will never be made. Production = `cancelled`, Fulfillment = `partially_shipped`. Rare but not theoretical.

Cetec ERP's documentation describes the same concept: "Split work orders for partial completions or ship partial orders while leaving backorders open." Microsoft Dynamics 365 likewise allows multiple shipments per sales order without changing the order's primary status. This is the consensus shape.

### 7.2 Status fields and where they live

Status exists at two levels — the line item and the job. Job-level status is always derived from line-item-level status, computed via trigger.

**At the `job_parts` (line item) level:**

- `production_status`: `not_started | in_progress | completed | cancelled`. Set by operator activity. The operator marking the last operation complete moves a line from `in_progress` to `completed`.
- `fulfillment_status`: `unshipped | partially_shipped | fully_shipped`. Computed from `shipment_line_items`. The line is `fully_shipped` when `SUM(quantity from non-voided shipments) >= qty_ordered`.

**At the `jobs` level:**

- `production_status`: derived from `job_parts.production_status` via trigger. Rules:
  - All parts `cancelled` → job is `cancelled`
  - All parts `completed` (excluding cancelled lines) → job is `completed`
  - Any part `in_progress` or mix of states → job is `in_progress`
  - All parts `not_started` → job is `not_started`
- `fulfillment_status`: derived from `job_parts.fulfillment_status` via trigger. Rules:
  - All non-cancelled parts `fully_shipped` → job is `fully_shipped`
  - Any part `partially_shipped` or mix of shipped + unshipped → job is `partially_shipped`
  - All parts `unshipped` (or only cancelled lines exist) → job is `unshipped`

The "auto-close" behavior in v1 of the PRD becomes a derived fact rather than a state transition: a job is "done" when `production_status IN ('completed', 'cancelled')` AND `fulfillment_status = 'fully_shipped'`. The jobs list hides jobs in this state by default.

### 7.3 What this replaces

The existing `jobs.status` and `job_parts.status` columns and the `compute_job_status` trigger are replaced. The migration from old to new is small because no shipments exist yet:

- Old `status = 'shipped'` → new `production_status = 'completed'`, `fulfillment_status = 'fully_shipped'`.
- Old `status IN ('not_started', 'in_progress', 'completed', 'cancelled')` → new `production_status` = same value, `fulfillment_status = 'unshipped'`.
- The old `compute_job_status` trigger is decomposed into `compute_job_production_status` and `compute_job_fulfillment_status`, each watching its respective source data.

Every existing query that reads `jobs.status` needs to be updated. The audit is small (current Jigged has fewer than 30 such references) and Phase 1 is where it gets done.

### 7.4 Display vs storage

Field names in storage are stable (`production_status`, `fulfillment_status`). UI labels are decoupled and validated with the shipping clerk on Friday. Initial labels are conservative:

- Production: "Not Started", "In Progress", "Completed", "Cancelled."
- Fulfillment: "Not Shipped", "Partially Shipped" (with "X of Y" detail), "Shipped".

If the shipping clerk says "Completed" doesn't match what she calls it, we change the label without changing the field name. Storage stays internally consistent; UI tracks how the shipping clerk talks.

### 7.5 The rest of the model

```
Customer
  └── has many Addresses (one default ship-to, optional default bill-to, plus others)
  └── has many Jobs
        ├── has a derived production_status (trigger)
        ├── has a derived fulfillment_status (trigger)
        └── has many JobLineItems (part + qty ordered + due date)
              ├── has a production_status (set by operator activity)
              ├── has a derived fulfillment_status (trigger from shipment_line_items)
              └── has many ShipmentLineItems (links a shipment to a job line item with a qty)

Shipment
  ├── belongs to one Customer
  ├── ships to one Address (or one-time address)
  ├── has many ShipmentLineItems (can span multiple jobs for the same customer)
  ├── has a packing_slip_number (unique per company, auto-generated)
  ├── has a ship_date (defaults to today)
  ├── has a carrier (enum + "other")
  ├── has an optional tracking_number
  ├── has an optional weight, package_count, package_type
  ├── has an optional shipping_arrangement
  ├── has optional notes
  └── has a CoC text block (default per customer, editable per shipment, optional)
```

The full schema sketch is in Appendix A. **Note:** Appendix A is illustrative and was written before Phase 1 shipped. The canonical schema lives in `supabase/migrations/` (PRs 1–7 plus the upcoming Phase 1.5 customer-consistency migration). Two notable on-the-ground deviations from the sketch: customer addresses use `default_billing` / `default_shipping` boolean flags (not a `type` enum with `is_default`), and `customer_po_number` lives on `jobs` (not as a per-line value on the shipment). Other modeling decisions:

- One shipment can span multiple jobs (same customer) because shops box mixed parts.
- Partial shipments are line-item-level, not job-level, because a job can have multiple parts shipping on different schedules.
- Shipping Arrangement is metadata, not behavior in v1. It prints on the slip and is captured for reporting.

---

## 8. User flows

Ordered by importance to the headline moment.

### Flow A (the headline moment): the salesperson answers a customer call

1. Customer calls: "What's the status on PO 4471?"
2. the salesperson types `4471` into the global search bar.
3. The matching job appears in the top result within 200ms.
4. the salesperson clicks. Job detail page loads, and within his immediate field of view he sees:
   - Production status: e.g., "In Progress" or "Completed."
   - Fulfillment status with detail: e.g., "Partially Shipped: 5 of 10. 5 remaining" or "Shipped" or "Not Shipped."
   - Last ship date, packing slip number, tracking number, carrier (if any shipment exists).
5. He reads the answer to the customer. Call ends.

The two statuses sit side by side. Production and fulfillment are independent facts, and the salesperson needs both to answer common questions. "Are you still working on it?" is production. "Did anything go out yet?" is fulfillment. Single-status systems make him guess.

What has to be true for this flow to work:
- Global search must hit on PO number, job number, customer name, packing slip number.
- The job detail page must render the dual-status block before any other section.
- The status block must be readable at a glance (no nested clicks, no hover-to-reveal).
- Both statuses must be derived correctly from underlying data (triggers, not application-layer code that can drift).

### Flow B: the shipping clerk creates a shipment from a finished job (Friday demo flow)

1. the shipping clerk opens the job (the salesperson shows her where).
2. Job detail page shows a "Create Shipment" button. the shipping clerk clicks it.
3. Form opens, pre-filled with: today's date, customer's default ship-to, all open line items at full remaining quantity, default carrier (if set on customer), default shipping arrangement (if set on customer), default CoC text (if set on customer or company).
4. the shipping clerk confirms or edits, clicks "Create Shipment & Print."
5. System generates packing slip number, saves shipment, opens PDF.
6. the shipping clerk prints. `fulfillment_status` updates to `fully_shipped` (all line items now fully shipped). Status block on the job page updates visibly. Job disappears from the default jobs-list view (now considered "done" per FR-18). The operations panel on the job stays editable — only `production_status = 'cancelled'` disables it. Production and fulfillment are orthogonal lifecycles per §7, so a job that ships partially with remaining production work still allows operators to log time.

Three clicks: Create Shipment → confirm → Print. This is the bar.

### Flow C: the shipping clerk ships a partial (5 of 10)

1. the shipping clerk opens the job, clicks "Create Shipment."
2. Form pre-fills with full remaining (10). the shipping clerk edits the qty for that line to 5.
3. the shipping clerk saves. Packing slip prints showing "Quantity shipped: 5, Remaining: 5 still owed."
4. Job stays open. Job detail page shows shipment history (1 shipment, 5 of 10).
5. When the rest is ready, the shipping clerk creates another shipment. Form pre-fills at qty 5 (the remaining), gets a new packing slip number, completes the job.

### Flow D: the shipping clerk ships mixed parts from one customer across two jobs

1. the shipping clerk (or the salesperson) opens the top-level Shipments page from the sidebar.
2. Clicks "New Shipment."
3. Picks a customer (searchable typeahead).
4. Sees every open line for that customer, grouped by job. Default view applies the line-level "Ready to Ship" filter (`job_parts.production_status = 'completed'` only). Search input filters by part / job / customer PO. Each line is a checkbox with editable qty pre-filled at `qty_remaining` (clamped to zero for over-shipped lines, which render with a disabled checkbox and an "already shipped in full" indicator).
5. the shipping clerk checks the lines she's actually boxing across one or more jobs, confirms, saves.
6. One packing slip is generated covering the selected lines. Each affected job's `fulfillment_status` updates via trigger; either or both may reach `fully_shipped`.

Less common than Flow B but worth supporting because the alternative (separate slips for one physical box) is what shops complain about. Pulled into active scope as part of Phase 1.5 (was deferred to Phase 4 in v2.0).

### Flow E: the pilot shop owner reviews fulfillment health

1. the pilot shop owner opens the jobs list.
2. Default view hides "done" jobs (per FR-18: `production_status IN ('completed', 'cancelled')` AND `fulfillment_status = 'fully_shipped'`). Open jobs are visible.
3. Each row shows order date, due date, customer, qty ordered, qty shipped, qty remaining, production status, fulfillment status, days-since-due-date for overdue items.
4. He can sort by overdue or filter by customer.

Reports view (charts, on-time rates) is deferred to v1.1.

---

## 9. Functional requirements

Each requirement maps back to the headline moment or to a specific risk being mitigated. Numbering preserved from v1 where requirements are unchanged.

### Headline moment requirements (most important)

- `[FR-12]` Job detail page shows a Shipment History section: one row per shipment with packing slip #, ship date, carrier, tracking #, qty shipped that shipment, and a download/view link.
- `[FR-13]` Job detail page shows a dual-status block in the top section, rendered before any other section on the page. Block contains: production status badge, fulfillment status badge with "X of Y" detail when partially shipped, latest shipment summary (PS#, date, carrier, tracking) when a shipment exists. Per-line breakdown ("Part A: 5 of 10 shipped. Part B: 3 of 3 shipped.") visible without clicking.
- `[FR-14]` Status labels are storage-stable and display-decoupled. Internal field names: `production_status`, `fulfillment_status`. Display labels are configurable in code and validated with the shipping clerk on Friday.
- `[FR-15]` All users with job access see shipment history and both status fields. No role restriction in v1.
- `[FR-NEW-1]` Global search hits on PO number, job number, customer name, packing slip number, part number. Sub-second response.
- `[FR-NEW-2]` Job detail page renders the status block in under 200ms server-side. Both status values come from indexed columns or materialized triggers, not computed at request time.

### Status derivation and "done" state

The old "auto-close" requirement is replaced. Status is derived from underlying data rather than transitioned manually; "done" is a derived predicate, not a stored state.

- `[FR-16]` `job_parts.fulfillment_status` is derived via trigger from `shipment_line_items`. Rules in §7.2.
- `[FR-17]` `jobs.production_status` and `jobs.fulfillment_status` are derived via triggers from `job_parts` rows. Rules in §7.2.
- `[FR-18]` A job is considered "done" when `production_status IN ('completed', 'cancelled')` AND `fulfillment_status = 'fully_shipped'`. This is computed in queries, not stored.
- `[FR-19]` Jobs list hides "done" jobs by default (FR-18 predicate). Toggle to show.
- `[FR-20]` Audit log entry written when `jobs.fulfillment_status` transitions to `fully_shipped`. Includes triggering shipment, user, timestamp.
- `[FR-21]` Closed jobs cannot be reopened. New work for the same part creates a new job.

### Shipment creation

- `[FR-1]` User can create a shipment from a job detail page; line items pre-fill at remaining quantity.
- `[FR-2]` User can create a shipment from a top-level Shipments page that spans multiple jobs for one customer. Entry point is the global "New Shipment" button on `/dashboard/{companyId}/shipments`. The customer detail page is not a shipment-creation surface.
- `[FR-NEW-3]` Top-level Shipments nav entry and route `/dashboard/{companyId}/shipments`, gated by the company `shipments_enabled` feature flag.
- `[FR-NEW-4]` Shipments list view: paginated table with packing slip #, ship date, customer, jobs covered (one chip per distinct `job_number`), carrier, tracking number, line-item count, created-by. Searchable by packing slip #, customer name, tracking number. Sortable by ship date (newest first by default).
- `[FR-NEW-5]` "New Shipment" entry from the list: customer-first picker, then a per-job_part picker grouped by job, showing every line with `qty_remaining > 0` and `production_status != 'cancelled'` for that customer. The picker has a default-on "Ready to Ship" filter chip and a search input over part name / job number / customer PO. The "Ready to Ship" filter operates at the **line level** (`job_parts.production_status = 'completed'`), not the job level — a job with mixed completion states surfaces only its completed parts. This matches the operations/fulfillment orthogonality §7 commits to: the shipping clerk ships what's done, regardless of whether sibling parts on the same job are still in production. Lines already fully shipped render visibly with a disabled checkbox and an "already shipped in full" indicator. Same downstream form fields and the same `create_shipment_with_line_items` RPC as Flow B.
- `[FR-NEW-6]` Database integrity for multi-job shipments, enforced by trigger (not just RPC) so the invariant holds for any future insert path:
  - Every `shipment_line_items.job_part_id` must reference a `job_part` whose `job.customer_id` equals the parent `shipments.customer_id`.
  - `shipments.customer_id` is immutable after insert. Any `UPDATE` that changes `customer_id` raises — voiding and recreating is the right path for that case. Without this pair, flipping the parent shipment's customer would leave existing line items pointing at the old customer's jobs and the line-item trigger wouldn't fire (no rows on that table changed).
- `[FR-3]` Shipment form fields: ship date (default today), ship-to address (default customer's default ship-to, with dropdown to other customer addresses or "add new"), carrier (dropdown), tracking number (optional), shipping arrangement (default from customer, editable), weight (optional), package count (optional), notes (optional), CoC text (default from customer settings, editable, can be removed). Customer PO is **not** entered on the shipment form — it lives on `jobs.customer_po_number` (set at quote-to-job conversion) and is read off each job at packing-slip render time.
- `[FR-4]` System refuses over-shipment with a soft warning that can be confirmed.
- `[FR-5]` System refuses zero-quantity shipments.
- `[FR-6]` Packing slip number is auto-generated, unique per company, sequential. Format configurable per company in settings. Default `PS-{YYYY}-{0000}`.
- `[FR-7]` Each shipment creation is atomic.

### Packing slip PDF

- `[FR-8]` PDF includes: company logo, shop's return address, packing slip number, ship date, customer name, **Bill To** (left, resolved from the customer's `default_billing` address at render time) and **Ship To** (right, from the shipment's `shipping_address_id`), carrier, tracking number, shipping arrangement, weight/package count, notes, CoC text (if present), signature line for shipper. Line items table with columns: `Job Number | Customer PO | Part # | Description | Qty Shipped | Qty Remaining`. The Qty Remaining **column** appears in the table when at least one line on the slip has `qty_remaining > 0`; otherwise the column is hidden entirely. When the column is present, every **cell** in it shows the numeric value (including 0 for lines that are fully shipped) — cells are not blanked. Multi-job slips use the same single table; Job Number and Customer PO are per-row, which makes single-job slips mildly redundant on those two columns and multi-job slips immediately legible without restructuring the renderer.
- `[FR-9]` PDF is printable on standard letter paper at a $200 shop laser printer.
- `[FR-10]` PDF is regeneratable from a shipment at any time.
- `[FR-11]` PDF is downloadable.

### Addresses

- `[FR-30]` Customer detail page has an Addresses tab. CRUD on addresses, with type (ship_to / bill_to / both) and is_default per type.
- `[FR-31]` New customers default to a single "use same as billing" address.
- `[FR-32]` Shipment form allows entering a one-time address. Phase 3.

### Settings

- `[FR-33]` Packing slip number format.
- `[FR-34]` Default CoC text.
- `[FR-35]` Shop's shipping address.

---

## 10. Non-functional requirements

- **Performance:** Job detail page status block in under 200ms server-side. Global search in under 500ms. PDF generation in under 3 seconds.
- **Reliability:** Packing slip numbers never duplicated, never skipped. Unique constraint plus a sequence.
- **Auditability:** Every shipment creation, edit, and void logged with user, timestamp, previous state.
- **Editability:** Shipment can be edited within 24 hours; after that, void + recreate. Voided shipments stay in history with strikethrough. Validate window with the shipping clerk.
- **Print fidelity:** PDF tested on a real shop printer before Friday.
- **Feature flag:** All shipment-related UI gated behind a per-company feature flag. Default off. the pilot customer-only for v1.

---

## 11. Beta-as-prototype methodology

This section names the methodology explicitly so Claude Code and future PRD readers understand why the development pattern is different from a traditional spec.

### What we're doing

Shipping production code to the pilot customer as the prototype. Everything is feature-flagged. No other Jigged customer sees this feature until Friday's results are evaluated.

### Why this is defensible despite Cagan's "MVP = prototype" warning

Cagan's warning is about *waste*. The waste comes from building production-quality code (tests, edge cases, polish, scaling concerns) for the purpose of learning, when a Figma mock would have produced the same learning at 5% of the cost.

Two conditions break that equation in our case:

First, AI-assisted development has compressed the cost of "production-quality enough" by an order of magnitude. The labor cost of building this feature is days, not weeks. The marginal cost of building production code over a clickable mock is small.

Second, our user is unreachable except through her existing workflow. the shipping clerk does not take Zoom calls. We cannot put a Figma prototype in front of her. The only way she sees this feature is if the salesperson demos it during his Friday visit, and the only credible demo is something running in the actual Jigged she would use.

The deviation is real but it preserves Cagan's underlying principle: validate before committing to scale. Feature-flagging keeps the blast radius at one company.

### What we lose by skipping the Figma stage

We lose the chance to test multiple visual layouts cheaply. The packing slip looks however it looks; we don't get to compare three versions. We lose the chance to test the create-shipment flow with a non-shipping-clerk user before we commit to it.

Mitigation: pre-Friday, a colleague who has never seen Jigged before runs the create-shipment flow cold. If they can't do it in five minutes, the flow gets reworked before the shipping clerk sees it.

### What we gain

We get real data on real workflows. the shipping clerk tries to ship a real part to a real customer. The packing slip prints from a real printer. If something is broken in that flow, we find out from the user who matters, not from a researcher reading body language during a Figma walkthrough.

---

## 12. Phasing as experience slices

V1 of the PRD phased by engineering layer. V2 phases by user-visible experience. Each phase is end-to-end usable. Phase 1 and 2 from v1 are bundled here because the dual-lifecycle architecture commits us to a real status model from the start, not a temporary one — there's nothing to ship between "ugly slice" and "Friday-ready" that wouldn't introduce a temporary decision.

### Phase 1: Friday-ready, end-to-end (target: complete 48 hours before Friday)

The full vertical slice with the architecture done right. the shipping clerk sees this on Friday.

**Schema and triggers (the foundation):**
- New tables: `addresses`, `shipments`, `shipment_line_items`.
- New columns on `jobs` and `job_parts`: `production_status`, `fulfillment_status`. Drop or deprecate old `status` columns after migration.
- Backfill existing data: old `status = 'shipped'` → `production_status = 'completed'` + `fulfillment_status = 'fully_shipped'`; everything else → `production_status` = same value + `fulfillment_status = 'unshipped'`.
- Replace `compute_job_status` trigger with `compute_job_production_status` and `compute_job_fulfillment_status`. Each watches its own source data.
- Trigger on `shipment_line_items` insert/update/void: recompute `job_parts.fulfillment_status`, which cascades to `jobs.fulfillment_status`.
- RLS policies on all new tables following existing patterns.
- Update all existing queries that read `jobs.status`. Audit list comes from a grep of the repo; expected count under 30.

**Customer-side data management:**
- Address tab on customer detail page with CRUD.
- Default ship-to and default bill-to per customer.
- Default carrier, default shipping arrangement, default CoC text per customer.

**Shipment creation (Flow B and Flow C):**
- "Create Shipment" button on job detail page.
- Shipment form with FR-3 fields.
- Pre-fill defaults from customer.
- Full and partial shipment support.
- Over-shipment soft warning (FR-4).
- Atomic save: shipment + line items + PDF generation succeed or fail together.

**Job detail page (the headline moment):**
- Dual-status block at the top, before any other section (FR-13).
- Per-line breakdown ("Part A: 5 of 10").
- Shipment history table (FR-12).
- Production status badge that updates when operators complete operations (existing behavior, just reading the new column).

**Jobs list:**
- Default view hides "done" jobs per FR-18 predicate.
- Toggle to show all.

**Packing slip PDF:**
- All FR-8 fields.
- Designed to print cleanly on a standard shop laser printer.
- Tested on an actual printer before Friday.

**Global search:**
- Hits on PO number, job number, customer name, packing slip number, part number.

**Operational:**
- Feature flag on for the pilot customer. Off for every other tenant.
- Audit log entry on `fulfillment_status` transition to `fully_shipped`.

**Acceptance:**
- Debola does the full loop on staging with realistic the pilot customer data. It works.
- A colleague who has never used Jigged completes Flow B in under five minutes, cold.
- The pre-Friday checklist in §13 passes.

### Phase 1.5: Top-level Shipments page + Flow D (post-Friday, before Phase 2 polish)

Phase 1 covered single-job shipments via the per-job "Create Shipment" button. Phase 1.5 adds the company-wide audit surface and the multi-job creation path. Flow D was originally Phase 4 (deferred); pulled forward because the schema and RPC already support multi-job shipments and the top-level page is the natural home for both shipment history and the cross-job create flow.

- Top-level Shipments nav entry, gated by the company `shipments_enabled` feature flag, with a Skeleton placeholder during company-data load (no late flash).
- Shipments list page at `/dashboard/{companyId}/shipments` (FR-NEW-4).
- Customer-first new-shipment wizard with multi-job line picker (FR-NEW-5).
- Customer-consistency triggers on `shipment_line_items` and `shipments.customer_id` immutability (FR-NEW-6).
- Refactor `CreateShipmentModal` so the same inner form body serves both `jobId` (Flow B) and `customerId` (Flow D) entry modes.
- Per-job "Create Shipment" button remains as the shortcut for the common single-job case.

### Phase 2: Whatever the shipping clerk tells us is missing (target: week after Friday)

Driven by Friday observation. No commitments in advance. Examples of things that might land here, none decided now:

- Different default values on the form.
- A field we missed (e.g., box dimensions).
- A label change because the current word didn't match the shipping clerk's mental model.
- A workflow tweak based on something we didn't anticipate.

Acceptance: the shipping clerk uses Jigged for shipping on at least three real shipments in the week, without falling back to Tangle.

### Phase 3: One-time addresses, edit/void

Only built if Phase 2 succeeds. Post-pilot. Multi-job (Flow D) moved up to Phase 1.5.

### Phase 4: Reporting and dashboards

Only built once we have a month of pilot data. Post-pilot.

---

## 13. The Friday demo: plan, prep, decisions

### What the salesperson shows the shipping clerk

A short demo, not a full pitch. The order matters.

1. **Open a real job at the pilot customer.** the salesperson picks a job that the shipping clerk actually shipped recently in Tangle. Reproduces it in Jigged.
2. **Show the status block.** "Hey the shipping clerk, look at this — I can see the order is shipped without coming to find you." Plant the headline-moment seed.
3. **Hand her the keyboard.** "Want to try shipping the next one?" This is the moment of truth.
4. **Let her drive Flow B (or Flow C if a real partial is queued up).** the salesperson narrates as little as possible. The script is: don't help unless she's stuck for 30+ seconds, don't explain how things work.
5. **Print the slip.** Hand it to her. Watch her reaction. Compare it to her Tangle slip.

Total session: 15-30 minutes if everything works. Less if it doesn't.

### What the salesperson should observe and capture

the salesperson is a salesperson, not a researcher. The instrumentation has to be lightweight. Three questions to answer, written down after the session, not during:

1. **Did the shipping clerk get stuck anywhere?** If yes, where and for how long?
2. **What did the shipping clerk say out loud during the flow?** Verbatim quotes only. No interpretation.
3. **Would the shipping clerk use this tomorrow if it was available?** Direct question at the end. Watch for hedging.

Optional: a phone photo of any moment where the shipping clerk's face changes (confusion, satisfaction, frustration).

### Pre-Friday checklist

Must all be true before the salesperson demos. Owner: Debola.

- [ ] Feature flag is on for the pilot customer. Off for every other tenant.
- [ ] The the pilot customer database has at least three open jobs with parts that match what the shipping clerk actually ships.
- [ ] One of those jobs is set up to be a clean full-shipment demo.
- [ ] One of those jobs is set up to be a clean partial-shipment demo.
- [ ] the pilot customer's shipping address is correct on the company settings.
- [ ] Default carrier and shipping arrangement are set on at least one customer.
- [ ] A test print of the packing slip has been done on a standard laser printer. It looks professional.
- [ ] A colleague who has never seen Jigged has done Flow B cold and completed it in under five minutes.
- [ ] The status block on the job detail page renders correctly on the salesperson's actual laptop, in actual the pilot customer network conditions.
- [ ] Auto-close has been tested with at least three real-data scenarios.
- [ ] Global search returns the right job within 500ms for PO number, job number, and customer name.
- [ ] the salesperson has been walked through the demo flow at least once before Friday. He can do it without referring to notes.
- [ ] A rollback plan exists. If something breaks on Friday, we know how to turn the feature off without taking down Jigged.

If any of these are false on Thursday evening, the demo doesn't happen. Better to skip the demo than to show broken software to the only user we have.

### Post-Friday decision framework

The Friday session produces one of four outcomes. Each has a defined next step.

**Outcome A: the shipping clerk uses it, finishes the flow, says she'd use it tomorrow.** Highest-confidence outcome. Trigger: build Phase 2 immediately. Schedule a one-week check-in. Begin the pilot shop owner conversation about paid pilot.

**Outcome B: the shipping clerk completes the flow with help but has reservations.** Most likely outcome. Trigger: identify the reservations, scope Phase 2 around them, ship the changes, schedule a follow-up demo in two weeks. Hold the pilot shop owner conversation until reservations are addressed.

**Outcome C: the shipping clerk can't complete the flow or rejects the slip's appearance.** Trigger: pause feature development. Schedule a research session with the shipping clerk (in person or phone). Re-evaluate the design with new information. Possibly rework substantially.

**Outcome D: The demo never happens** because something is broken in the pre-checklist or the salesperson's visit changes. Trigger: reset. The PRD is fine. The execution failed. Use the time to make Phase 1 better before the next opportunity.

The decision must happen within 48 hours of Friday. Don't let the outcome sit.

---

## 14. Things Claude Code should not do

Direct anti-features. Fadell's "don't disrupt too many things at once" applied as a list of explicit cuts.

- Do not implement carrier API integrations. No EasyPost, Shippo, ShipStation, UPS API. Tracking number is a text field.
- Do not generate Bills of Lading.
- Do not build a customer-facing tracking page.
- Do not add a customer-portal authentication system.
- Do not auto-send emails to customers on shipment.
- Do not add a "Powered by Jigged" footer to the packing slip.
- Do not modify the operator view as part of this work.
- Do not implement a per-shipment photo upload.
- Do not add SMS or push notifications.
- Do not roll the feature out to any tenant other than the pilot customer. Feature flag must default off.
- Do not redesign the job detail page beyond adding the status block at the top.
- Do not introduce new dependencies (image libraries, PDF libraries beyond what's already in the stack) without flagging.

---

## 15. Plan-review request to Claude Code

Per the standard workflow, this PRD goes to Claude Code with the following framing:

> Read `docs/PRD-shipments.md`. Produce an implementation plan for Phase 1 — the full Friday-ready vertical slice as defined in §12. The plan should include: migration SQL for the dual-status schema change (including the backfill from the existing `status` column), RLS policies for new tables, the audit list of existing queries that reference `jobs.status` and how each will be updated, the new triggers replacing `compute_job_status`, the shipment-creation form, packing slip PDF generation, dual-status block on job detail page, global search updates, jobs-list filter changes, and feature flag setup. Do not write code yet. Do not exceed Phase 1 scope. Flag any ambiguity in the PRD as a question for Debola. Identify any risks to the 48-hour-before-Friday target and propose what to cut if needed.

After Phase 1 plan is reviewed and approved, repeat for Phase 2, etc.

---

## Appendix A: Schema sketch

> **Status:** This appendix is the original v2 design sketch. Phase 1 shipped with a few deviations — most visibly, `customer_addresses` uses `default_billing` / `default_shipping` boolean flags rather than the `type` enum + `is_default` pattern below. The canonical schema lives in [supabase/migrations/](../../supabase/migrations/). Keep this section as historical context; consult the migrations for the authoritative shape.

```sql
-- New tables (as-shipped in supabase/migrations/20260519_shipments_pr1_customer_addresses.sql)

CREATE TABLE customer_addresses (
  id UUID PRIMARY KEY,
  company_id UUID NOT NULL REFERENCES companies(id),
  customer_id UUID NOT NULL REFERENCES customers(id),
  default_billing BOOLEAN NOT NULL DEFAULT false,
  default_shipping BOOLEAN NOT NULL DEFAULT false,
  attention_to TEXT,
  line1 TEXT NOT NULL,
  line2 TEXT,
  city TEXT NOT NULL,
  state TEXT NOT NULL,
  postal_code TEXT NOT NULL,
  country TEXT NOT NULL DEFAULT 'US',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE shipments (
  id UUID PRIMARY KEY,
  company_id UUID NOT NULL REFERENCES companies(id),
  customer_id UUID NOT NULL REFERENCES customers(id),
  ship_to_address_id UUID REFERENCES addresses(id),
  one_time_address JSONB,
  packing_slip_number TEXT NOT NULL,
  ship_date DATE NOT NULL DEFAULT current_date,
  carrier TEXT,
  tracking_number TEXT,
  shipping_arrangement TEXT,
  weight_lbs NUMERIC(10,2),
  package_count INTEGER,
  package_type TEXT,
  notes TEXT,
  coc_text TEXT,
  created_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  voided_at TIMESTAMPTZ,
  voided_by UUID REFERENCES users(id),
  UNIQUE (company_id, packing_slip_number)
);

CREATE TABLE shipment_line_items (
  id UUID PRIMARY KEY,
  shipment_id UUID NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
  job_part_id UUID NOT NULL REFERENCES job_parts(id),
  quantity NUMERIC(12,2) NOT NULL CHECK (quantity > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Dual-status migration on existing tables

ALTER TABLE jobs
  ADD COLUMN production_status TEXT
    CHECK (production_status IN ('not_started', 'in_progress', 'completed', 'cancelled')),
  ADD COLUMN fulfillment_status TEXT
    CHECK (fulfillment_status IN ('unshipped', 'partially_shipped', 'fully_shipped'));

ALTER TABLE job_parts
  ADD COLUMN production_status TEXT
    CHECK (production_status IN ('not_started', 'in_progress', 'completed', 'cancelled')),
  ADD COLUMN fulfillment_status TEXT
    CHECK (fulfillment_status IN ('unshipped', 'partially_shipped', 'fully_shipped'));

-- Backfill
UPDATE job_parts SET
  production_status = CASE
    WHEN status = 'shipped' THEN 'completed'
    ELSE status
  END,
  fulfillment_status = CASE
    WHEN status = 'shipped' THEN 'fully_shipped'
    ELSE 'unshipped'
  END;

UPDATE jobs SET
  production_status = CASE
    WHEN status = 'shipped' THEN 'completed'
    ELSE status
  END,
  fulfillment_status = CASE
    WHEN status = 'shipped' THEN 'fully_shipped'
    ELSE 'unshipped'
  END;

-- Enforce NOT NULL after backfill
ALTER TABLE jobs
  ALTER COLUMN production_status SET NOT NULL,
  ALTER COLUMN fulfillment_status SET NOT NULL;

ALTER TABLE job_parts
  ALTER COLUMN production_status SET NOT NULL,
  ALTER COLUMN fulfillment_status SET NOT NULL;

-- Drop old status column (or rename to status_deprecated for one release)
ALTER TABLE jobs DROP COLUMN status;
ALTER TABLE job_parts DROP COLUMN status;

-- Drop the old combined trigger
DROP TRIGGER IF EXISTS compute_job_status ON job_parts;
DROP FUNCTION IF EXISTS compute_job_status();

-- New triggers: each watches its own source data

-- Trigger 1: job_parts.production_status changes propagate to jobs.production_status
CREATE FUNCTION compute_job_production_status() RETURNS TRIGGER AS $$
  -- All cancelled → cancelled
  -- All completed (ignoring cancelled) → completed
  -- Any in_progress or mixed → in_progress
  -- All not_started → not_started
  -- Implementation per §7.2 rules
$$ LANGUAGE plpgsql;

CREATE TRIGGER compute_job_production_status
  AFTER INSERT OR UPDATE OF production_status ON job_parts
  FOR EACH ROW EXECUTE FUNCTION compute_job_production_status();

-- Trigger 2: shipment_line_items changes propagate to job_parts.fulfillment_status,
-- which cascades to jobs.fulfillment_status
CREATE FUNCTION compute_job_part_fulfillment_status() RETURNS TRIGGER AS $$
  -- SUM(quantity from non-voided shipments) compared against qty_ordered
  -- 0 → unshipped
  -- partial → partially_shipped
  -- >= qty_ordered → fully_shipped
$$ LANGUAGE plpgsql;

CREATE TRIGGER compute_job_part_fulfillment_status
  AFTER INSERT OR UPDATE OR DELETE ON shipment_line_items
  FOR EACH ROW EXECUTE FUNCTION compute_job_part_fulfillment_status();

CREATE FUNCTION compute_job_fulfillment_status() RETURNS TRIGGER AS $$
  -- All fully_shipped (ignoring cancelled lines) → fully_shipped
  -- Any partially_shipped or mix → partially_shipped
  -- All unshipped → unshipped
$$ LANGUAGE plpgsql;

CREATE TRIGGER compute_job_fulfillment_status
  AFTER INSERT OR UPDATE OF fulfillment_status ON job_parts
  FOR EACH ROW EXECUTE FUNCTION compute_job_fulfillment_status();

-- Customer-level defaults
ALTER TABLE customers
  ADD COLUMN default_shipping_arrangement TEXT,
  ADD COLUMN default_carrier TEXT,
  ADD COLUMN default_coc_text TEXT;

-- Company-level settings
ALTER TABLE companies
  ADD COLUMN packing_slip_number_format TEXT NOT NULL DEFAULT 'PS-{YYYY}-{seq:0000}',
  ADD COLUMN shipping_address_id UUID REFERENCES addresses(id);

-- Audit log for fulfillment_status transitions
CREATE TABLE job_fulfillment_audit (
  id UUID PRIMARY KEY,
  job_id UUID NOT NULL REFERENCES jobs(id),
  from_status TEXT,
  to_status TEXT NOT NULL,
  triggering_shipment_id UUID REFERENCES shipments(id),
  triggering_user_id UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

Claude Code's Phase 1 plan will produce the actual trigger function bodies. The shapes above are illustrative.

---

## Appendix B: Decisions consolidated

| # | Decision | Source |
|---|----------|--------|
| 1 | Shipment is a first-class entity; PDF is a render | First-principles analysis |
| 2 | One shipment can span multiple jobs (same customer). Entry point is the top-level `/shipments/new` page with a customer-first picker — not the customer detail page | Research: shops box mixed parts |
| 3 | Partial shipments are line-item-level | A job can have multiple parts shipping on different schedules |
| 4 | Auto-close on full shipment, computed via trigger | the salesperson: "I don't know why Tangle doesn't do that" |
| 5 | No role-gated shipping visibility | the salesperson's complaint at the pilot customer |
| 6 | No carrier API integration in v1 | Research: shops use carrier tools or customer accounts |
| 7 | No BOL in v1 | LTL is minority of small-shop volume |
| 8 | CoC as embedded packing-slip text | Industry pragmatic pattern |
| 9 | Shipping arrangement is metadata, not behavior | v1 captures it; reporting comes later |
| 10 | Shipments voidable but not deletable | Audit integrity |
| 11 | Default packing slip number format `PS-{YYYY}-{0000}` | Configurable per company |
| 12 | No "Powered by Jigged" on slip | Shop's brand is the headline |
| 13 | **Beta-as-prototype** in production with feature flag for the pilot customer-only | Cost calculus has changed; user is unreachable remotely |
| 14 | **the shipping clerk is the primary user**, the salesperson is the buyer-proxy, the pilot shop owner is the budget owner | Cagan: name your primary user |
| 15 | **Job detail status block renders first** | Headline-moment design implication |
| 16 | **Phasing is experience-slice, not engineering-layer** | Fadell: ship the whole experience |
| 17 | **Friday is the gating event** for Phase 2 and the pilot shop owner conversation | Pilot validation precedes scale |
| 18 | **Production and fulfillment are orthogonal lifecycles**, stored as separate fields | Shop-floor reality; every reference ERP separates them; existing conflation breaks once real shipments exist |
| 19 | **Old `jobs.status` enum is replaced**, not extended, in Phase 1 | Avoids temporary state; backfill is trivial because no shipments exist yet |
| 20 | **"Done" is a derived predicate**, not a stored status | Auto-close becomes a query, not a state transition; eliminates a class of drift bugs |
| 21 | **Phase 1 bundles all foundation work** (formerly v1 Phases 1 + 2) | Architectural correctness from the start; no temporary decisions to unwind |
| 22 | **Customer detail page is not a shipment-creation surface.** It manages customer attributes (contacts, addresses, defaults). Shipment creation lives at `/shipments/new` with a customer picker as the first step. Two entry points: (1) the per-job "Create Shipment" button for the common single-job case, (2) the `/shipments/new` flow for multi-job shipments. Adding a third entry point on the customer detail page would muddle the surface's purpose | Surface-scope discipline; avoids three-way fork on the same creation path |
| 23 | **Packing slip renders Bill To (left) + Ship To (right); "Created By" is not on the slip.** Bill-to resolves to the customer's `default_billing` address at render time. | The two addresses receiving needs both for reconciliation. Commit `31c3086` had temporarily swapped Bill To for Created By; v2.2 reverts that. |
| 24 | **Flow D (multi-job shipments) moved into active scope as Phase 1.5** (was Phase 4) | Schema and RPC already support it; only the UI was missing |
| 25 | **`shipments.customer_id` is immutable after insert** | A shipment changing customers post-creation is incoherent; pairs with the line-item customer-consistency trigger to close a silent inconsistency window |

Bold rows are new in v2 (rows 13–21 in v2.0; rows 22–25 added in v2.1/v2.2). Earlier numbering retained a no-longer-relevant "Reorders create new jobs with a 'related to' link" row that was dropped in v2.2 along with the reorder feature itself.

---

## Appendix C: Methodology principles applied

Lightweight map showing which framework principle informs which PRD section. For Debola's reference and for anyone reviewing the PRD's intellectual lineage.

| Principle | Source | Applied in |
|-----------|--------|------------|
| Painkillers, not vitamins | Build (Fadell) | §1 — distinguishes visibility (painkiller) from packing slip (vitamin) |
| Story / press release first | Build (Fadell) | §2 — the salesperson's six-months-later quote |
| The whole experience matters | Build (Fadell) | §12 — phasing by experience slices |
| Don't disrupt too many things | Build (Fadell) | §6, §14 — non-goals and anti-features |
| V1 = prototype, ship to early adopters | Build (Fadell) | §0, §11 — beta-as-prototype methodology |
| Work within constraints | Build (Fadell) | §11 — solo + Claude Code shapes what's possible |
| Heartbeat / predictable cadence | Build (Fadell) | §12 — phase-by-phase release rhythm |
| Don't lock in temporary architecture | Build (Fadell) / first principles | §0, §7, §12 — orthogonal lifecycle done correctly in Phase 1 |
| MVP should be a prototype | Inspired (Cagan) | §11 — acknowledged and deliberately deviated from |
| Four big risks | Inspired (Cagan) | §4 — value, usability, feasibility, viability |
| Discovery vs. delivery | Inspired (Cagan) | §0, §13 — Friday demo is the discovery moment |
| Outcomes over outputs | Inspired (Cagan) | §6 — goals named in terms of behavior change |
| Reference customers / Customer Discovery Program | SVPG | §6, §13 — the pilot customer as 1 of 6-8 needed |
| Fall in love with the problem | Inspired (Cagan) | §1 — pain comes before solution |
| Test value qualitatively | Inspired (Cagan) | §13 — "would you use this tomorrow" question |
| Empowered teams | Inspired (Cagan) | §11 — acknowledged solo team and what that means |
| Story maps | Inspired (Cagan) | §8 — user flows organized by activity |
