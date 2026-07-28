# Inventory & Material Flow — Proposal & Journey Spec

> **Status:** Draft proposal · **Date:** 2026-07-26 · **Branch:** `feature/inventory-journey-spec`
>
> **Purpose.** Define what inventory in Jigged is *for*, spec the material journeys
> end-to-end, and record the product decisions that bound them. This doc is meant to
> (a) become the inventory-journey source of truth, (b) drive the rewrite of
> [`docs/modules/inventory.md`](modules/inventory.md), and (c) answer issue **#541**
> ("confirm whether inventory gaps block Contour") with something better than a guess.
>
> **Target state is full material control** — requisition → PO → receive against PO →
> heat/lot + cert → issue to job → remnant back to stock → traceable. That is a
> multi-quarter build, so [§6](#6-sequencing) phases it and Phase 1 is deliberately the
> smallest slice that closes what a real shop already asked for.
>
> **Partially validated, 2026-07-27.** The structural questions were answered from the
> founder's multi-day on-site observation at Contour Tool & Machine — see
> [§8](#8-what-we-know-and-what-we-still-dont). Those answers **resolved the largest
> modelling fork** ([§5.2](#52-is-a-job-a-place--resolved-no)), **cut a phase**
> (no regulated customers → no traceability), and **promoted customer-supplied material**
> from a footnote to a journey ([J14](#j14--customer-supplied-material)). They are founder
> observation, not participant interview: reliable on structure, weaker on frequency and
> pain-ranking. What remains open is listed in [§8](#8-what-we-know-and-what-we-still-dont).
>
> The [discovery script](usability-tests/inventory-discovery-script-v1.md) is still the
> instrument for the rest. Its **findings** file is deliberately untracked — `.gitignore`
> keeps `docs/usability-tests/*findings*` local, because completed sessions contain user
> research.

---

## 1. TL;DR

Inventory is the one Jigged module that has not taken at the one shop we serve. The
diagnosis is not "it needs more features" — it is that **we built the *where* layer first
and the *why* layer never.**

Three facts, each verifiable:

1. **All 2026 inventory investment went to a surface nobody asked for.** Six PRs between
   20–25 June built QR-addressable storage locations, a visual storage builder, and an
   operator bin-scan flow. That surface has **no PRD requirement, no module doc, no user
   story, and no user research** behind it. Issue **#496**, opened afterwards, rates
   inventory *"Priority 3 (Later) … the use isn't validated."*
2. **The journey the PRD calls primary was never built.** [`prd.md`](prd.md) Open Question 2,
   owner-answered: *"you should primarily deplete inventory through jobs."* Nothing in
   Jigged decrements stock as a consequence of production. Every stock movement is a
   deliberate act of bookkeeping, which is exactly the thing shops stop doing.
3. **The one piece of validated shop feedback we had was silently regressed.** Issue #59
   (Shane, `client-feedback`, P0): *"link inventory removals to specific jobs."* It shipped
   in March against `/inventory/[itemId]`, that page was deleted in the May parts
   unification, and [`PartTransactionModal.tsx`](../components/parts/PartTransactionModal.tsx)
   contains **zero** references to jobs today.

The fix is to make material movement **a by-product of work rather than a separate chore**:
material is checked against a job, issued to a job, and confirmed at the operation. Stock
levels become a consequence of that loop instead of something a person maintains. Storage
locations stay — they are genuinely useful and the QR-on-location piece is the one part of
the build the shop actually asked for — but they stop being the front door.

---

## 2. Goal & non-goals

### Goal

A shop can answer five questions without leaving Jigged:

| Question | Journey |
|---|---|
| Do we have it? | [J4](#j4--job-kickoff-material-check) |
| Where is it? | [J13](#j13--find-it) |
| Did we buy it? | [J5](#j5--buy-it) / [J6](#j6--receive-it) |
| Did we use it? | [J7](#j7--issue-material-to-a-job) / [J9](#j9--confirm-consumption-at-the-operation) |
| Can we prove it? | [J12](#j12--prove-it-traceability--cut) — **cut**, no regulated customers |

### Explicit non-goals (deliberate, decided)

| Non-goal | Rationale |
|---|---|
| **No demand forecasting** | A job shop's demand *is* its order book. Forecasting a make-to-order backlog is modelling noise. |
| **No MRP planning run / netting** | Requires reliable lead times and BOM depth we don't have, and produces output nobody in a 10-person shop acts on. Reorder points ([J11](#j11--dont-run-out)) cover the real need. |
| **No multi-warehouse** | One building. `inventory_locations` already nests if a second site ever appears. |
| **No consignment or customer-owned stock *accounting*** | Customer-supplied material is real and frequent — it gets a journey ([J14](#j14--customer-supplied-material)) and an **ownership flag on stock**. What stays out of scope is valuing it, or reporting on it as a liability. |
| **No inventory valuation, COGS, or accounting postings** | Accounting stays in QuickBooks. Jigged tracks *quantities and identity*; money is costing's job (`part_procurement_tiers`, `compute_part_cost_at_qty`). |
| **No automatic purchasing** | The system proposes a buy list; a human places the order. Auto-ordering requires vendor integration and trust we haven't earned. |
| **No tool-crib / perishable-tooling management** | Adjacent and real, but a different object with a different lifecycle (tool life, regrinds, checkout). Out of scope; revisit as its own module. |

### In scope

The thirteen journeys in [§4](#4-target-journeys), the modelling decisions in
[§5](#5-design-decisions), the phasing in [§6](#6-sequencing), and the discovery needed to
validate them.

---

## 3. Current reality (what's actually built)

> Verified against the code on `main` as of 2026-07-26.

### The item master

There is **no `inventory_items` table**. It was absorbed into `parts` in the May
unification (`27040f2`). Inventory is a filtered view over `parts WHERE is_stocked = true`.
The prod schema comment says it plainly:

> `Unified item master. Replaces the prior two-table split between manufacturable parts and stockable inventory_items.`

Inventory-relevant `parts` columns: `is_stocked`, `primary_unit` (NOT NULL via the
`parts_requires_unit` CHECK), `quantity` (CHECK ≥ 0), `reorder_point` (nullable),
`is_location_tracked`, `preferred_vendor_id`, `source` (`made` | `bought`), `deleted_at`.

### The surfaces

| Route | File |
|---|---|
| `/dashboard/{companyId}/inventory` | [`app/dashboard/[companyId]/inventory/page.tsx`](../app/dashboard/[companyId]/inventory/page.tsx) |
| `/dashboard/{companyId}/inventory/locations` | [`app/dashboard/[companyId]/inventory/locations/page.tsx`](../app/dashboard/[companyId]/inventory/locations/page.tsx) |
| `/operator/{companyId}/inventory` | [`app/operator/[companyId]/inventory/page.tsx`](../app/operator/[companyId]/inventory/page.tsx) |
| `/operator/{companyId}/inventory/locations/{locationId}` | the QR scan target |

There is **no item detail, create, edit, or import route** — all three redirect into the
Parts surface. Stock management lives on the part workspace Inventory tab.

### Two mutually exclusive stock engines

This is the deepest structural fact about the module, and it is not written down anywhere
today. Which engine runs is chosen per-part by `is_location_tracked`:

| | **Path A — aggregate** | **Path B — location-tracked** |
|---|---|---|
| Used when | `is_location_tracked = false` | `is_location_tracked = true` |
| Mechanism | Client-side read-modify-write on `parts.quantity`, then a **separate** ledger insert | SECURITY DEFINER RPCs — balance upsert + ledger insert in **one transaction**, under `SELECT … FOR UPDATE` |
| Functions | `addPartStock` / `removePartStock` / `adjustPartStock` | `add_stock_at_location` / `deplete_stock_at_location` / `adjust_stock_at_location` / `transfer_stock` |
| Atomicity | **None.** Two concurrent writes can lose an update. | Atomic and row-locked. |
| `parts.quantity` | Directly written | Trigger-maintained rollup of `SUM(part_location_stock.quantity)` |

`enforce_tracked_part_quantity` (a `BEFORE UPDATE` trigger on `parts`) **hard-rejects** a
direct `parts.quantity` write on a tracked part when the value ≠ the sum of its balances.
So Path A is not merely discouraged for tracked parts — it is refused by the database.
The UI swaps affordances to match: `PartLocationInventory` replaces the Add/Remove/Adjust
buttons when a part is tracked.

`trg_auto_track_stocked_part` auto-enrols every stocked part into location tracking **if
and only if** the company has `settings.features.inventory_locations = true`, seeding it at
an auto-created "Unassigned" bucket. This is why no per-part opt-in UI exists.

### Nothing decrements automatically

Not on operation complete, not on job complete, not on shipment, not on invoice. Verified:
zero calls to any stock function from `jobsAccess.ts`, `operatorAccess.ts`,
`shipmentsAccess.ts`, or `operationCompletionsAccess.ts`. **Every stock movement in Jigged
is a deliberate human act of bookkeeping.**

The single job linkage that exists: an operator at a scanned bin may optionally tag a
removal with a job. That is a *label on a manual action*, not automation — and it is
available only on the operator path, never to an owner in the dashboard.

### `job_materials` is write-only

Snapshotted at job creation by `create_job_part_operations_from_routing()`, then **read by
nothing**. Confirmed columns are exactly `job_id`, `job_part_id`, `parts_bom_id`,
`material_part_id`, `expected_quantity`, `unit`, `created_at`, `updated_at` — no `status`,
`actual_quantity`, `consumed_at`, or `consumed_by`. Those were removed by migration
`20260614043526_retire_job_material_consumption`.
[`JobPartMaterialsCard.tsx`](../components/jobs/JobPartMaterialsCard.tsx) reads the **live
BOM** instead, with the comment *"Material consumption is no longer tracked per job — the
part BOM is the source of truth."*

So a table whose entire purpose was consumption tracking still gets written on every job
creation and is never read. It is either the foundation for [J9](#j9--confirm-consumption-at-the-operation)
or dead weight; [§5.9](#59-decide-job_materials-fate) decides.

### Absent entirely

Purchase orders · receiving · lots / heat numbers / material certs · remnants and drops ·
count sessions · on-order quantity · min/max · allocated or reserved stock · ABC class ·
lot / serial / expiry · landed, standard or average cost · location capacity.

### Feature flag

`inventory_locations` — first entry in `KNOWN_FEATURES`
([`lib/featureFlags.ts`](../lib/featureFlags.ts)), **opt-in, default off for every tenant**.
Gates four sites: the inventory-page Locations button, the `/inventory/locations` route,
the operator bottom-nav Inventory tab, and the SQL auto-enrolment trigger.

**Note:** `docs/modules/inventory.md` currently references a *second* flag,
`inventory_transactions` (issue #550), intended to gate reorder status and per-job
consumption. **That flag does not exist.** `KNOWN_FEATURES` has exactly three keys:
`inventory_locations`, `ai_insights`, `data_import`.

### Dead or unreachable code

Useful as evidence of where the model drifted:

| Item | Status |
|---|---|
| `removePartStockGraceful` | Zero call sites. The graceful path lives in the RPC now. |
| `getLocationTree` | Zero references, not even a test. |
| `moveLocation` | Access layer + tests only. **No re-parent UI exists.** |
| `enableLocationTracking` / `disableLocationTracking` | Superseded by the auto-track trigger. No UI. |
| `buildLocationUrl` | Duplicate of `locationLabelPdf.buildLocationScanUrl`. |
| `enable_location_tracking_for_company`, `inv_location_path_label` | RPCs with no caller. |
| `VisualLocationBuilder` `parentId` / `parentCode` props | Always `null` — "build under an existing node" is wired but unreachable from the UI. |
| `job_materials` | Written at job creation, read by nothing. |

Path-walking (`parent_id` → names array with a cycle guard) is reimplemented **four times**
in TypeScript, plus once in unused SQL.

---

## 4. Target journeys

Numbered so issues and later docs can cite them. **Bold** = Phase 1.

### J1 — Seed the item master and opening balances

**Actor:** owner, at onboarding. **Trigger:** migrating off Tangle / a spreadsheet.

Import the things you stock, with their current on-hand quantity, unit, and reorder point.

**Today:** partial. The parts importer exists and handles name / description / unit /
vendor / BOM. **Stock quantity is not an importable field** — so a shop migrating in has
to hand-key every opening balance, or start at zero. This directly contradicts PRD **FR-16**
(*"System supports CSV upload for inventory items"*).

**Missing:** `quantity` and `reorder_point` columns in the parts import mapping, writing
an opening `adjustment` ledger row per item rather than a bare `parts.quantity` write.

> **Mostly deferred out of Phase 1 — validated 2026-07-27.** Contour's old parts table *does*
> carry on-hand figures for a lot of parts, but *"whether it's up to date and accurate is
> questionable."* Importing those straight into `parts.quantity` would launder distrusted
> numbers into a fresh system — worse than an honest zero.
>
> **Split the feature.** Importing quantities **into stock** stays deferred. Importing them
> **into a count sheet's expected column** ships with [J10](#j10--count-it) in Phase 1, so the
> first count verifies the legacy data instead of ignoring it. Same parsing work, radically
> different trust semantics: nothing reaches the ledger until a human counts it.
>
> The general importer gap is still real and still contradicts FR-16 — it just isn't customer
> #1's problem. It becomes blocking at the **second** company, where trusted figures may
> exist and a direct-to-stock import is legitimate.

### J2 — Say where something lives

**Actor:** anyone, incidentally. **Trigger:** recording stock, or tidying.

You are adding or moving material and you say where it is. The place is created **at that
moment** if it doesn't exist yet.

**Today:** inverted. Storage must be modelled up front through the visual builder — pick a
type, declare levels, counts and name patterns, press *"Create 16 locations"* — before a
single item exists. See [§5.5](#55-locations-keep-them-visual-change-when-they-appear).

**Missing:** inline place-creation from a "where is it?" field; a permanent visual board;
photos; fill state.

### J3 — Estimate material cost on a quote

**Actor:** quoter. **Today: built** — `parts_bom` + `part_procurement_tiers` + yield
(`consume_whole_units`, `costing_batch_quantity`) via `compute_part_cost_at_qty`.

Listed only to mark the boundary: **quoting reads material *cost*, never material
*availability*.** A quote never checks stock and never reserves anything. That is correct
and should stay correct — see [§5.7](#57-quoting-never-touches-stock).

### **J4 — Job kickoff material check**

**Actor:** owner / scheduler. **Trigger:** a job is created or about to be scheduled.

> **Why this shop stocks at all — validated 2026-07-27.** Contour runs **a lot of rush jobs**,
> and holds the material those need rather than ordering per job. That is the whole
> justification for J4: the question isn't bookkeeping, it's *"can I say yes to this rush job
> right now?"* Answer speed matters more than answer precision — a fast approximate on-hand
> beats a slow exact one. It also confirms Phase 1's premise: there is real stock to check
> against, so J4 is not comparing to zero.

The job shows, per material: **required · on hand · on order · short by**. Anything short
is flagged *before* the job is scheduled, not discovered at the machine. From the shortage
you can act — add to the buy list ([J5](#j5--buy-it)) or substitute.

A shop-wide **"Short for this week"** view aggregates the same computation across open jobs.

**Today: missing.** `JobPartMaterialsCard` shows a read-only BOM list with no quantities
compared against stock. Nothing anywhere computes a shortage.

**Why this is Phase 1:** it is the highest-value read in the entire module, it needs **no
new tables** (BOM × job quantity vs `parts.quantity`), and it is the thing that makes the
stock number worth maintaining at all. Catching a shortage at kitting rather than
mid-production is [the documented payoff](https://www.globalshopsolutions.com/blog/kitting-and-pre-stage-with-erp-to-boost-throughput).

### J5 — Buy it

**Actor:** owner / admin. **Trigger:** a shortage, or a reorder-point alert.

Shortages accumulate into a **buy list**. Grouped by vendor, it becomes a purchase order
with an expected date. Once a PO exists, its quantity is **on order** — visible in J4 so
nobody orders the same bar twice.

**Today: missing.** Zero occurrences of `purchase_order` or `on_order` in the schema.
`parts.preferred_vendor_id` is a label only — since migration `20260714173443` it no longer
gates cost.

**Note:** this *is* issue **#571** (purchasing module: multi-vendor cost sheets, RFQ, POs,
approved-vendor list, bulk/purchasing UoM). Merge the two rather than running them in
parallel.

### J6 — Receive it

**Actor:** admin / shipping clerk — a persona the PRD already defines
(*"Receive inbound materials"*) and that no screen serves today.

Material arrives. Match it against the PO, record what actually came, capture the **heat /
lot number** and attach the **cert PDF**, print a human-readable tag, and put it away to a
place.

**Today: missing.** The closest thing is `OperatorReceivePartModal` — a one-off *"stock a
part into this bin"* with no PO, vendor, cost, lot, or cert linkage.

**Constraint:** the tag on the material is human-readable (heat, item, PO). It is **not** a
second scannable object — see [§5.3](#53-the-location-is-the-scan-anchor).

### **J7 — Issue material to a job**

**Actor: the operator, on the floor.** *(Validated 2026-07-27 — at Contour the operator moves
material. Not the owner, not an admin.)* **Trigger:** the operator starts the job and goes to
get material.

Take the material, and the depletion is **linked to the job**. This is the PRD's stated
primary path and issue #59's ask.

**The entry point must be the job, not the bin.** This is the sharpest consequence of the
validation, and it reverses an assumption baked into both the current build and the earlier
draft of this spec:

- **Today the flow is bin-first** — scan a location QR → see contents → remove → *optionally*
  tag a job. That serves someone auditing a bin. It does not serve an operator whose context
  is *"I'm starting job 1047."*
- **The flow should be job-first** — operator is on the job traveler → sees the material the
  job needs → taps it → sees where it is → confirms taking it. The depletion is job-linked by
  construction rather than by an optional field the operator must remember.
- Bin-first stays as the secondary path. It is the right shape for J10 counting and J13
  finding, and it already works.

**Consequence for issue #59.** The March ask was a job selector in the owner's
`PartTransactionModal`, and that regression is real — but it is **no longer the high-value
fix**, because the owner is not who moves material. Restoring it is a small correctness
patch; building the job-first operator path is the actual journey. Do not let the open issue
number set the priority.

**Deliberately not adopted:** Sortly's *close out the job and lock the history* step. It
belongs to their job-as-container model, which [§5.2](#52-is-a-job-a-place--resolved-no)
rejected for us. Revisit only if that fork reopens.

### J8 — Cut it, return the remnant

**Actor:** operator at the saw. **Trigger:** a bar is cut and something usable is left.

The drop goes back to a place with its **remaining length** recorded, and stays findable so
the next job can use it instead of opening a new bar.

**Today: missing.** This is the most machine-shop-specific gap in the module and the one
with the clearest cash value — remnant tracking exists precisely so shops
[reuse material instead of scrapping it](https://www.peptechnology.com/product/inventory-management/).

Shop practice to respect: machinists already
[mark both ends of a bar and re-mark the cut end](https://www.practicalmachinist.com/forum/threads/solution-for-raw-material-inventory-management.404375/)
before it goes back on the rack. The software should mirror that habit, not replace it.

### J9 — Confirm consumption at the operation

**Actor:** operator. **Trigger:** finishing an operation that consumed material.

Confirm what was actually used, correcting the expected quantity where it differs.

**Today: missing** — issue **#550**, blocked behind a feature flag that doesn't exist.
Graceful over-depletion (clamp to zero, flag `has_discrepancy`, stamp the operator) already
works at the bin level and should be reused here.

**Tension to resolve in discovery:** the operator UX is deliberately minimal — *complete-only*,
no start/stop, one tap ([`operator-paperless-flow.md`](operator-paperless-flow.md) §5.2).
Adding a material confirmation step cuts against that. It may belong on the *job*, done once
by one person, rather than on every operation.

### **J10 — Count it**

**Actor:** whoever is assigned. **Trigger:** a schedule, or distrust of a number.

A **count session** scoped to a place: here is what we think is here, walk it, enter what
you find, review the variance, commit. Committing writes `adjustment` rows with a reason.

**Today: missing.** *"Cycle count"* appears in the codebase only as **label text** on the
Adjust button. There are no count sessions, sheets, variance reports, or freeze.

**Why this is Phase 1:** it is the ritual that keeps the other twelve journeys true, and
the PRD's own success metric (*"100% inventory accuracy within 3 months"*) is unmeasurable
without it. It also carries the label-maintenance task — replacing damaged QR labels is
[a job for a scheduled audit](https://www.sortly.com/blog/how-to-label-inventory/), and the
count session is that audit.

> **Promoted — this is how Contour onboards.** The **first count session *is* the opening
> balance**, which makes J10 the entry point to the whole module for customer #1, not a
> maintenance feature that arrives later.
>
> **They have tried counting before** *(validated 2026-07-27)* — their old ERP had an
> inventory-locations feature and an on-hand column on the parts table. So we are **rescuing a
> lapsed practice, not introducing a new one**: no education needed, and the first session can
> be self-served rather than facilitated. But see
> [§5.5](#55-locations-keep-them-visual-change-when-they-appear) — a previous attempt failing
> raises the bar rather than lowering it.
>
> **Seed the first count from the legacy data — as *expected*, never as truth.**
> Their old parts table has on-hand figures populated for a lot of parts, of unknown accuracy
> and unknown freshness. Do **not** import those into `parts.quantity`; that launders numbers
> nobody trusts into a fresh system. Import them into the **count sheet's expected column**
> instead, so the first run is a *verification* rather than a blank-slate discovery. Three
> things fall out:
>
> - The first count is much faster — you're checking a number, not inventing one.
> - The variance report becomes a genuine onboarding moment: *here is how wrong your old
>   system was.* That is the most persuasive argument for the ritual we will ever get, and it
>   is free.
> - Nothing enters the ledger until the count commits, so the first `adjustment` row is an
>   honest counted value. No fabricated opening balance, consistent with the no-silent-
>   fallbacks rule in `CLAUDE.md`.
>
> If the legacy export turns out to be unusable, the fallback is the blank-slate walk — the
> flow is the same, the expected column is just empty.

### J11 — Don't run out

**Actor:** owner. **Trigger:** stock crosses a threshold.

Below the reorder point, the item lands on the buy list. On-order quantity is visible so
nobody double-orders.

**Today: partial.** `parts.reorder_point` exists, `deriveStockStatus` renders
In stock / Low / Out of stock, and `getLowStockPartsAlerts` feeds the header `AlertBadge`.
Missing: email notification, a real buy list, and any concept of on-order.

**Doc conflict to settle:** PRD **FR-2 is a `Must`** and specifies dashboard alerts *plus*
email. `docs/modules/inventory.md` calls FR-2 a `Should`, reports it partially delivered,
and plans to **hide it** behind the non-existent `inventory_transactions` flag. Meanwhile
[`docs/modules/ai-insights.md`](modules/ai-insights.md) records the low-inventory alert
badge as **built and checked off**. Three docs, three positions, one feature.

### J12 — Prove it (traceability) — **CUT**

*"Which jobs used heat 5521-B?"* · *"Show me the cert for the parts on this shipment."*

**Validated 2026-07-27: Contour does not keep certs or heat numbers and does not serve
regulated customers. This journey is cut.** With it goes the entire lot/heat/cert layer that
[§5.6](#56-lots--resolved-dont-build-them) proposed as Phase 4's spine.

Consequences, so this isn't quietly re-added later:

- **No lots.** Stock is a quantity of an item at a place. Nothing sits between them.
- **[J8 remnants](#j8--cut-it-return-the-remnant) loses its free ride** and must now justify
  itself on material-cost grounds alone — it was going to arrive as a by-product of lot
  modelling.
- **[J6 receiving](#j6--receive-it) simplifies** to matching a delivery against a PO. No cert
  capture, no heat field, no document attachment.

**Reopen if** an aerospace, defense or medical customer appears — at which point this is a
significant build, not a toggle. The
[heat-lot linkage research](https://precisionam.com/articles/quality-compliance/aerospace-precision-machining-traceability/)
is cited in [J6](#j6--receive-it) so the requirement doesn't have to be relearned.

### J14 — Customer-supplied material

**Actor:** admin receiving, then the operator consuming. **Trigger:** a customer drops off
material and asks for work on it.

*Validated 2026-07-27 — this was a footnote in the earlier draft and is now a real
requirement:* **"there are a lot of them."** Customers bring their own material for
service-style, one-off jobs.

Material arrives that **the shop does not own**. It must be findable and consumable like any
other stock, while being excluded from anything that treats stock as an asset or a
replenishment signal.

**Today: missing entirely.** Every stocked item is implicitly shop-owned.

The properties that make this distinct — worth settling before Phase 1 designs the item model,
because retrofitting an ownership flag through the ledger later is painful:

| Behaviour | Shop-owned | Customer-supplied |
|---|---|---|
| Counts toward on-hand for [J4](#j4--job-kickoff-material-check) | Yes, for any job | **Only for that customer's job** |
| Triggers a reorder point ([J11](#j11--dont-run-out)) | Yes | **Never** — we don't buy it |
| Appears on the buy list | Yes | **Never** |
| Contributes to material cost on the quote | Yes | **No** — it's free to us |
| Leftover returns to general stock | Yes | **No** — it's still theirs |

Two open questions this raises, both cheap to answer and both listed in
[§8](#8-what-we-know-and-what-we-still-dont): do these service jobs have a BOM at all (they
may be "here's a part, fix it"), and does leftover customer material get returned, scrapped,
or quietly absorbed?

**Sequencing note:** the *flag* is cheap and belongs in Phase 1's data model. The *workflows*
around it (return, segregation, per-customer visibility) can wait.

### J13 — Find it

**Actor:** anyone. **Today: built, and it works.**

Scan a location QR → the phone opens the bin view → contents, drill-down, and add / remove /
set per part. Searching an item shows its per-location balances with full paths.

This is the genuinely good part of the June build. Keep it.

---

## 5. Design decisions

### 5.1 Material moves through jobs by default

Ad-hoc add / remove / adjust remains available — PRD Open Question 2 already settled that
(*"you should primarily deplete inventory through jobs but for many other reasons you should
be able to do it elsewhere"*). But the job-linked path is the primary one and the UI should
say so.

**Independently validated.** Sortly — a visual, mobile-first, deliberately-not-an-ERP tool —
shipped a [Jobs feature on 22 July 2026](https://www.sortly.com/blog/new-feature-alert-jobs/)
after years of resisting that complexity. Their stated before-state is ours: *"technicians
wrote usage on paper or forgot to document it, causing warehouse inventory inaccuracies."*
Their payoff is J4 and J7 exactly — *"tracking exactly what materials were used for billing"*
and *"preventing double-purchasing."*

**Corollary, and the design principle for the whole module:** prefer designs where the data
self-corrects as a by-product of work (issue-to-job, receive-against-PO, scan-at-bin) over
designs that require a separate act of bookkeeping. Every bookkeeping-only affordance we
ship is a thing a busy shop will stop doing.

### 5.2 Is a job a *place*? — **RESOLVED: no**

**Finding (2026-07-27):** at Contour, *the operator grabs material when they start the job.*
Nothing is pulled and parked against a job beforehand.

So a job is **not** a place. `inventory_locations` stays purely physical, and **J7 is a
straight depletion carrying a `job_id`** — no virtual nodes, no job-container, no
`transfer_stock` reuse.

This was the largest fork in the spec and it resolved to the cheaper branch. What we give up
by not modelling it — staging/kitting, shortage-flagged-at-kitting, return-on-cancellation —
is real capability, but capability for a workflow this shop does not have. Do not build it
speculatively.

**Reopen if:** a later shop stages material, or Contour starts. The Sortly-style
job-as-container remains the right design *if the behaviour appears*; it is recorded here so
it doesn't have to be rediscovered.

### 5.3 The location is the scan anchor

**Shop-stated, not inferred.** Contour has asked for QR on the location. This is the single
point in the shipped locations work with explicit demand behind it, and the code already
behaves this way: `buildLocationScanUrl` encodes the location UUID and routes through
`/operator/{companyId}/login?location={id}`.

**Do not add a competing QR-on-lot scan path.** Consequences:

- Lot identity is resolved **at** a scanned location — scan the bin, then confirm or pick
  which heat is in it.
- The receiving tag on the material is **human-readable** (heat, item, PO), not scannable.
- Under full material control this constraint shapes the receiving and traceability screens.

### 5.4 One stock engine

The two-engine split ([§3](#two-mutually-exclusive-stock-engines)) is the deepest structural
debt in the module: one path is atomic and one is a client-side race, and which you get
depends on a boolean.

**Recommendation: collapse onto the RPCs.** PR #446 already made the argument — a part left
entirely at "Unassigned" behaves exactly like a global-quantity item, so the location-tracked
path is a strict superset. Collapsing gives atomicity everywhere and deletes a whole class
of divergence.

**Blocker to respect:** the flag is currently what decides. Making RPCs universal means
`inventory_locations` stops being a feature flag and becomes the data model, with an
"Unassigned"-only default for shops that don't want bins. That is a bigger migration than
it looks and should be its own PR, not smuggled into a journey.

### 5.5 Locations: keep them visual, change *when* they appear

> ⚠️ **Contour has already been through a failed locations feature.** *(Validated 2026-07-27.)*
> Their old ERP had one, and it was *"badly designed and not really intuitive for them to
> use."* We are not introducing this concept — we are **rebuilding something that already
> burned them once.**
>
> That changes the standard this redesign is held to. A second bad locations experience does
> not get a third attempt; it confirms their prior that this category of feature is not for
> them. Two consequences:
>
> 1. **Find out precisely what was wrong with the old one before designing ours.** They lived
>    it, so this is free, and it is better evidence than any amount of generic WMS research.
>    It is now the **highest-value open question in this spec** — see
>    [§8](#8-what-we-know-and-what-we-still-dont).
> 2. **Establish whether it was a *usability* failure or a *maintenance* failure** — the two
>    have opposite implications and "badly designed" is ambiguous between them:
>
>    | If the real cause was… | Then… |
>    |---|---|
>    | **Usability** — too many clicks, wrong vocabulary, setup too heavy | The §5.5 redesign is the right bet. Proceed. |
>    | **Maintenance** — it worked, nobody kept it current | **No UI fixes this.** Locations stay deprioritised behind the material↔job loop, and [J10](#j10--count-it) is the only lever that matters. |
>
>    The existing evidence tilts toward usability — *"not really intuitive"* is a usability
>    complaint — but that is our inference from a secondhand paraphrase, not their words. Ask
>    directly before committing Phase 2.

Research is **for** visual — [Sortly](https://www.sortly.com/blog/why-photos-are-vital-in-inventory-management/)
(visual-over-alphanumeric is the small-business wedge),
[CyberStockroom](https://www.cyberstockroom.com/warehouse-location-mapping-software)
(a map of the real facility is the whole product), and shops already run on
[5S visual management](https://resources.duralabel.com/articles/5s-floor-marking) — shadow
boards, floor marking, *a place for everything*. Visual is their native language.

It is **against** the current timing and target:

1. **The board becomes permanent.** Today `LocationBoardPreview` draws something that does
   not exist yet and is never seen again; what you live with afterwards is
   [`LocationTreeView.tsx`](../components/inventory/locations/LocationTreeView.tsx), an
   indented text list. Invert it — the board is the storage home screen, showing real places
   with real contents and fill state.
2. **Setup goes incremental.** A place is created inline from a "where is it?" field while
   recording stock, or by adding one piece of furniture to the board. No mandatory
   pre-modelling.
3. **The wizard survives, demoted.** Count + name-pattern is genuinely right for *"this
   cabinet has 5 rows"* — keep `LevelConfigStep` as an optional **"subdivide this unit"**
   action on a unit already on the board. That also makes `VisualLocationBuilder`'s dormant
   `parentId` path reachable.
4. **Fix the palette.** [`storageTypes.tsx`](../components/inventory/locations/builder/storageTypes.tsx)
   has seven types and is missing **bar rack / vertical material rack** — the defining
   storage object in a machine shop. Compare against real shop vocabulary
   ([McMaster](https://www.mcmaster.com/products/storage-racks/): shelving units, storage
   racks, mobile racks, bin racks, storage cabinets, drawer units, workbenches, bins, chests,
   pegboard). Allow the honest ones too: *floor*, *outside*, *under the bench*.
5. **Add photos and fill state.** A photo of the actual rack beats any icon. A visibly-empty
   bin is the [two-bin kanban](https://businessmap.io/blog/two-bin-kanban-system) signal
   expressed in software. Reuse the existing media infrastructure (`PartFilesSheet`,
   `NoteMediaGallery`).
6. **Revisit the flat-vs-tree default.** [MRPeasy](https://www.mrpeasy.com/resources/user-manual/stock/settings/locations/)
   has no nesting at all and tells users to name locations `"Room 1, A1"`;
   [Katana](https://support.katanamrp.com/en/articles/8340252-basics-of-storage-bins) makes
   bins opt-in inside a location. `parent_id` is nullable, so flat is a default and a UI
   decision — **not a migration**.
7. **Thing-first is what the visual-inventory leader itself prescribes.** Sortly's
   [stockroom method](https://www.sortly.com/blog/how-to-organize-a-stockroom/) is ordered
   *"1. Create an inventory list → 2. Optimize storage space"* — storage is step **two** —
   and it explicitly says not to map everything up front. Their
   [labeling guide](https://www.sortly.com/blog/how-to-label-inventory/) gives **no guidance
   at all** on aisle/shelf/bin address codes. The company whose entire product is visual
   inventory does not lead with a storage hierarchy.

**Under full material control locations get *more* load-bearing, not less** — a remnant is a
physical thing in a place, and *"is there a drop I can use"* is a spatial query.

Revisit issue **#421** (3D diorama preview) against decision 1: a diorama of *real, occupied*
storage is a different and better proposition than a diorama of a preview.

### 5.6 Lots — **RESOLVED: don't build them**

The earlier draft proposed a lot layer between item and location: a heat/lot has a quantity
and sits in a place, a remnant is a child lot pointing at its parent, and both traceability
and remnant reuse fall out of one shape.

**Contour keeps no certs or heat numbers and serves no regulated customers
(validated 2026-07-27), so the layer has no justification.** Stock is a quantity of an item
at a place, with an ownership flag. Nothing sits between them.

Two knock-ons, recorded so they aren't missed:

- **[J8 remnants](#j8--cut-it-return-the-remnant) must now stand on its own.** It was going to
  arrive free as a child-lot. Building it now means an explicit remnant concept — and it needs
  confirming they actually reuse drops before that's worth it.
- **[J14 customer-supplied](#j14--customer-supplied-material) is a flag on stock, not on a
  lot** — which is simpler, and is why it can ship in Phase 1.

**Reopen with [J12](#j12--prove-it-traceability--cut)** if a regulated customer ever appears.

### 5.7 Quoting never touches stock

A quote reads material *cost*; it never reads availability and never reserves. Quotes are
speculative — reserving against them would corrupt on-hand for work that may never land.
This is current behaviour and it is correct; recorded here so nobody "fixes" it.

### 5.8 The ledger is append-only and non-authoritative

`inventory_transactions` is a genuine append-only ledger — the
`restrict_transaction_update_to_notes` trigger makes `notes` the only mutable column — but
it is **never replayed**. `parts.quantity` and `part_location_stock.quantity` are the
authoritative running balances, written alongside.

Stated explicitly because the current shape reads like an event-sourced system that isn't
one. If we ever want the ledger to be authoritative, that is a deliberate re-architecture
with a reconciliation job, not a drift.

### 5.9 Decide `job_materials`' fate

It is written on every job creation and read by nothing. Either it becomes the backing table
for [J9](#j9--confirm-consumption-at-the-operation) — gaining `actual_quantity`, `status`,
`consumed_at`, `consumed_by` back — or it is dropped. **Leaving a write-only table in place
is the worst of the three options**, because it looks like a source of truth to the next
person reading the schema.

Note the existing smell: the snapshot is taken at job creation, and then the UI deliberately
reads the *live* BOM instead, so the job reflects current BOM edits. Those two behaviours
contradict each other. Decide which one is intended.

### 5.10 Native app: deferred, scanning case must be spiked

Sortly having an iOS app is weak evidence for us — they are mobile-first and inventory-only,
where the phone *is* the product, while Jigged's quoting, costing, jobs and invoicing live on
desktop. But the **scan-flow argument is strong and iOS-specific**, and splits in two:

**(a) Scan → open our app directly.** A native app claims the URL via **Universal Links**, so
scanning a rack label opens Jigged immediately. **An installed PWA cannot** — iOS does not
deep-link scanned URLs into installed PWAs; they open in the browser. Not closeable by a PWA.

**(b) A live in-app scanner** (open app, camera already running, scan ten things in a row).
Buildable in a PWA, with a caveat that may be disqualifying:

- `BarcodeDetector` is **not implemented in WebKit**, so every iOS browser lacks it. The path
  is `getUserMedia` + a WASM decoder (zxing-wasm / ZBar-WASM), which reaches
  [near-native decode speed](https://dev.to/ilhannegis/barcode-scanning-on-ios-the-missing-web-api-and-a-webassembly-solution-2in2).
  **Decode performance is not the problem.**
- Camera access in **standalone home-screen PWA mode is** the problem.
  [STRICH](https://kb.strich.io/article/29-camera-access-issues-in-ios-pwa) — a barcode-SDK
  vendor, so a hostile witness — reports camera permission **is not persisted for PWAs** and
  Safari **re-prompts on route navigation** at the same origin
  ([WebKit #185448](https://bugs.webkit.org/show_bug.cgi?id=185448)). A scanner that re-asks
  permission every navigation is worse than tapping a banner.
- Their workaround is a cheap hedge available to us: **drop `apple-mobile-web-app-capable`**
  so the home-screen icon opens in Safari rather than standalone.

**Which flow needs it:** walking up to one bin is ~2 taps either way. The workflow the current
architecture cannot serve is **continuous scanning** — a count session ([J10](#j10--count-it))
or checking in a pallet ([J6](#j6--receive-it)), where ten scans mean ten camera-app round
trips.

**Decision:** do not commit to native, and do not assume PWA suffices. Time-boxed spike in
Phase 2 — installed PWA + `getUserMedia` + zxing-wasm on the actual handsets the shop carries
— answering one question: *does camera permission persist across navigations in standalone
mode on current iOS?* If yes, PWA covers (b) and only (a) remains native-only. If no, cost
native properly.

Jigged has **no PWA manifest, no service worker, no `apple-mobile-web-app` meta and no
viewport export** today. PWA basics ride along with Phase 2 either way — they are
prerequisites for the spike.

### 5.11 Design for the sustain, not the setup

The documented failure mode of every bin system is decay: *"it's tempting to put a new
material somewhere temporary and add the bin code later; later rarely comes"*
([Craftybase](https://craftybase.com/blog/bin-location)). Sortly's stockroom method makes
step 5 *"establish standard operating procedures"* with periodic audits.

Our equivalent is [J10](#j10--count-it). The count session is **not a reporting feature** —
it is the ritual that keeps the other twelve journeys true. Spec it as recurring, assignable
and place-scoped, not a one-off Adjust button.

---

## 6. Sequencing

### Phase 1 — close the validated loop

Revised against the 2026-07-27 findings. Ordered by dependency, not value:

1. **[J10](#j10--count-it) count session** — *first, because it is onboarding.* Contour starts
   from zero and their legacy figures aren't trustworthy, so the first count **is** the
   opening balance. Nothing downstream means anything until there are numbers to check.
2. **[J4](#j4--job-kickoff-material-check) material check** — the rush-job question:
   *can I say yes right now?* Needs no new tables.
3. **[J7](#j7--issue-material-to-a-job) issue-to-job, job-first, on the operator surface** —
   the operator's entry point is the job traveler, not a bin scan. This is the largest build
   in the phase and the one the earlier draft had pointed at the wrong actor.
4. **[J14](#j14--customer-supplied-material) ownership flag only** — cheap, and belongs in the
   item model now rather than being retrofitted through the ledger later. Workflows deferred.

**Dropped from Phase 1:** [J1](#j1--seed-the-item-master-and-opening-balances) opening-balance
import — customer #1 starts from zero, so this becomes blocking only at company #2.
Restoring the #59 owner-side job selector stays a small correctness patch, **not** a
headline item — the owner is not who moves material.

No new feature flag. New tables: the count session, and an ownership flag on stock.

[§5.2](#52-is-a-job-a-place--resolved-no) is resolved — a job is **not** a place. Build the
simple depletion.

### Phase 2 — locations reshaped

**J2** incremental places · permanent board · photos + fill state · palette fix · retire the
mandatory wizard · PWA basics + the scanner spike ([§5.10](#510-native-app-deferred-scanning-case-must-be-spiked)).

### Phase 3 — purchasing

**J5** POs · **J6** receiving against PO · **J11** buy list + on-order. **This is issue #571**
— merge, don't parallelise.

### Phase 4 — debt paydown, remnants, and the deferred import

**The traceability half is cut** — Contour keeps no certs or heat numbers and serves no
regulated customers, so [J12](#j12--prove-it-traceability--cut) and the whole lot layer are
gone. What's left:

- **[J8](#j8--cut-it-return-the-remnant) remnants**, now justified on material-cost grounds
  alone rather than riding along with lot modelling. **Confirm they actually reuse drops
  before building it** — that was never asked.
- **[J1](#j1--seed-the-item-master-and-opening-balances) opening-balance import**, deferred
  here from Phase 1. Becomes blocking at company #2.
- **[J14](#j14--customer-supplied-material) workflows** — return, segregation, per-customer
  visibility. The flag itself ships in Phase 1.
- **[§5.4](#54-one-stock-engine) one-stock-engine collapse** and
  **[§5.9](#59-decide-job_materials-fate) `job_materials` resolution** — debt paydowns that
  want a quiet phase.

---

## 7. Gap analysis — what we missed

Scored against the thirteen journeys.

| Journey | PRD says | Doc says | Built? |
|---|---|---|---|
| J1 opening balances | FR-16 `Should` — CSV upload for inventory items | silent | ❌ quantity not importable |
| J2 where it lives | *(absent — no PRD requirement at all)* | AC only, no user story | ⚠️ inverted |
| J3 quote cost | FR-11 | in parts/routings docs | ✅ |
| J4 material check | Flow 3 step 2 | silent | ❌ |
| J5 buy it | Flow 3 steps 4–5 | silent | ❌ |
| J6 receive it | Admin persona; Flow 3 step 6 | silent | ❌ |
| J7 issue to job | **Open Question 2 — the primary path** | "Planned (#550)" | ❌ regressed |
| J8 remnants | *(absent)* | silent | ❌ |
| J9 operator consumption | FR-3 / Flow 1 step 1 | "Planned (#550)" | ❌ removed then re-intended |
| J10 count | success metric: 100% accuracy | silent | ❌ label text only |
| J11 don't run out | **FR-2 `Must`** | FR-2 `Should`, partial, propose hiding | ⚠️ badge only |
| J12 traceability | *(absent)* | silent | ⛔ **cut** — no regulated customers |
| J13 find it | *(absent)* | AC only | ✅ |
| J14 customer-supplied | *(absent)* | *(absent)* | ❌ — and it's frequent |

**Three structural misses, in order of cost:**

1. **We shipped the only journey with no requirement behind it, and skipped the one marked
   primary.** J2/J13 got six PRs; J4/J7/J10 got nothing.
2. **The module doc could only describe what was built.** Because it was written as an
   implementation audit, absent concepts (receiving, purchasing, counting, shortage,
   remnants, traceability) do not appear even as gaps. You cannot notice a missing journey in
   a doc whose structure has nowhere to put it.
3. **Validated feedback had no protection.** #59 shipped, was deleted by an unrelated
   refactor, and nobody noticed for two months. There was no test and no AC pinning it.

### Stale-doc reconciliation

| File | Problem | Action |
|---|---|---|
| [`docs/modules/jobs.md`](modules/jobs.md) §material tracking | Documents `job_materials` columns that don't exist (`inventory_item_id`, `actual_quantity`, `status`, `consumed_at`), a `JobMaterialsCard` with consume/skip actions, and `create_job_operations_from_routing` — then **links to the inventory.md section stating none of it exists**. | Rewrite against reality |
| [`docs/architecture.md`](architecture.md) | Still lists `routing_materials` (removed) and `job_materials … actual consumption`. | Correct both |
| `docs/build-sequence.md` | 3,910 lines of superseded per-module specs, including a REST API (`GET/POST /api/inventory`) that never existed. | **Deleted** in this pass |
| [`docs/modules/demo-company.md`](modules/demo-company.md) | Seed SQL against dead `inventory_items` / `inventory_unit_conversions`. | Correct |
| [`docs/usability-tests/usability-test-script-v1.md`](usability-tests/usability-test-script-v1.md) Task 4 | Targets `/inventory/[itemId]`, deleted in May. Would fail if run today. | Superseded by the discovery script |
| `docs/modules/inventory-locations.md` | Promised by PR #414, never written. The largest inventory feature has no module doc. | Folded into the inventory module doc |

---

## 8. What we know, and what we still don't

### Answered — founder observation, 2026-07-27

From multi-day on-site observation at Contour Tool & Machine. **Reliable on structure, weaker
on frequency and pain-ranking**, and it is the founder's model of the shop rather than the
shop's own words — good enough for the structural decisions below, not for prioritisation.

| Question | Answer | What it decided |
|---|---|---|
| Staged before the job, or grabbed at the machine? | **Grabbed at the machine** | [§5.2](#52-is-a-job-a-place--resolved-no) — a job is **not** a place. Cheaper branch. |
| Stock vs buy per job? | **They stock** — lots of rush jobs, so they hold what those need | Confirms Phase 1's premise; [J4](#j4--job-kickoff-material-check) reframed around *"can I say yes to this rush job?"* |
| Who moves material? | **The operator, on the floor** | [J7](#j7--issue-material-to-a-job) becomes job-first on the operator surface; #59's owner-side fix demoted |
| What units? | **Mixed** — some `each`, some feet/inches | FR-1 conversion is load-bearing, both discrete and continuous |
| Opening balances? | **Start from zero.** Legacy figures exist but accuracy is *"questionable"* | [J1](#j1--seed-the-item-master-and-opening-balances) out of Phase 1; [J10](#j10--count-it) becomes onboarding |
| Certs / heat / regulated customers? | **None** | [J12](#j12--prove-it-traceability--cut) cut, lot layer cut, Phase 4 halved |
| Customer-supplied material? | **Yes, and there are a lot of them** — service-style one-offs | Promoted to [J14](#j14--customer-supplied-material); ownership flag into Phase 1 |
| How many storage places? | **~10, ±4.** Cabinets and shelving | Validates [§5.5](#55-locations-keep-them-visual-change-when-they-appear) — one wizard pass generating 16 is over-built for this shop |
| Have they ever counted? | **Yes, tried.** Their old ERP had an inventory-locations feature and an on-hand column on parts | Rescuing a lapsed practice, not introducing one → [J10](#j10--count-it) first run can be self-served |
| Is there legacy on-hand data? | **Yes, populated for a lot of parts** — accuracy and update frequency both unknown | Seed the first count sheet's *expected* column from it; never import it into stock |
| Did a locations feature already fail them? | **Yes** — *"badly designed and not really intuitive"* | ⚠️ Raises the bar on [§5.5](#55-locations-keep-them-visual-change-when-they-appear). We get one more attempt, not two |

### Still open

**Blocks nothing in Phase 1** — none of these need answering before development starts.

| Question | Gates | Note |
|---|---|---|
| **What exactly was wrong with the old ERP's locations feature — and was it usability or maintenance?** | [§5.5](#55-locations-keep-them-visual-change-when-they-appear) / all of Phase 2 | **Highest-value question in the spec.** They lived it, so it's free to ask, and it beats any generic research. Usability → our redesign is the right bet. Maintenance → no UI saves it and locations stay deprioritised. |
| Can we get their legacy on-hand export? | [J10](#j10--count-it) first run | Determines whether the first count is a verification or a blank-slate walk. Same flow either way, so it doesn't block design — but it changes the onboarding demo considerably. |
| Is there a **bar rack**? | Phase 2 palette | Only *cabinets and shelving* were named — the standing bar-rack hypothesis is **neither confirmed nor refuted**. They hold material in feet/inches, which implies long stock lives somewhere. Do not add the card on a guess. |
| What do they call each of the ~10 places? | Phase 2 palette naming | The card-sort in the discovery script is still the instrument |
| Do service jobs have a BOM at all? | [J14](#j14--customer-supplied-material) | May be "here's a part, fix it" with no material line |
| Does leftover customer material get returned, scrapped, or absorbed? | [J14](#j14--customer-supplied-material) | |
| Do they actually reuse drops? | [J8](#j8--cut-it-return-the-remnant) | Now that remnants lost their free ride, this must justify itself |
| Would anyone scan ten things in a row? Dead zones? Whose phones? | [§5.10](#510-native-app-deferred-scanning-case-must-be-spiked) PWA-vs-native spike | Phase 2 only |
| Label durability and placement | Label PDF | Implementation detail |
| Frequency / pain ranking | Prioritisation within phases | The one thing observation is genuinely weak at |

Carried forward from elsewhere:

- **Scrap.** Does scrapping a unit consume material, and how does it relate to the existing
  `has_discrepancy` flag? ([`operator-paperless-flow.md`](operator-paperless-flow.md) §5.4)
- **Issue #541** — does #496 mean *"beyond locations"* or *"including locations, which we
  overbuilt"*? **Answered: beyond.** Locations are worth keeping and reshaping; the gap is the
  material↔job loop. #541 can be closed.

### What no interview can answer

Whether they will **sustain** the count ritual, and whether a shortage view changes behaviour.
These are predictive, not descriptive — observation of current practice cannot reach them.
They are answered by shipping Phase 1 and watching, which is a reason to ship J10 early rather
than to keep asking.

**Two Sortly reports are gated downloads and were not obtained** — *2026 State of Inventory*
and the *Do You Need to Track Inventory?* flowchart. The latter speaks directly to #541.
Worth pulling; do not cite numbers from either until someone has read them.

---

## 9. Next steps

**Phase 1 is unblocked.** The structural questions are answered
([§8](#8-what-we-know-and-what-we-still-dont)), [§5.2](#52-is-a-job-a-place--resolved-no) is
resolved, and nothing on the still-open list gates the first build. Design can start.

1. **Design [J10](#j10--count-it) first** — it is Phase 1's entry point, because the first
   count session *is* Contour's opening balance. They have counted before, so it can be
   self-served. Seed the expected column from their legacy on-hand export if we can get it.
2. **Ask what was wrong with the old ERP's locations feature** — usability or maintenance?
   It doesn't block Phase 1, but it decides whether Phase 2 is worth doing at all, and it
   costs one question to someone who lived it.
3. **Close #541** — answered: #496 means *beyond* locations; the gap is the material↔job loop.
   Re-scope **#496** from *"the use isn't validated"* to the phasing in [§6](#6-sequencing).
4. **Fold #571 into Phase 3** and **#550 into Phase 1** ([J7](#j7--issue-material-to-a-job))
   and J9. Note #550's premise has shifted: it assumed an `inventory_transactions` feature
   flag that does not exist, and the actor is the operator, not the owner.
5. **Run the [discovery script](usability-tests/inventory-discovery-script-v1.md)** for the
   Phase 2 questions — storage vocabulary, the bar-rack question, the scanning/PWA spike
   inputs. No longer blocking, so it can happen alongside Phase 1 rather than before it. It's
   a video call: send the pre-call photo request 2–3 days ahead, record it, fill the findings
   CSV the same day.
