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
> (no regulated customers → no traceability), and **cut a second**
> ([Customer-supplied, cut](#cut--customer-supplied-material-whose-is-it) — customer material is never stocked). They are founder
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

A shop can answer five questions about material without leaving Jigged:

| Question | Journey |
|---|---|
| Do we have it? | [J4](#j4--job-kickoff-material-check) |
| Where is it? | [J12](#j12--find-it) |
| Did we buy it? | [J5](#j5--buy-it) / [J6](#j6--receive-it) |
| Did we use it? | [J7](#j7--issue-material-to-a-job) / [J9](#j9--confirm-consumption-at-the-operation) |
| Will we run out? | [J11](#j11--dont-run-out) |

**And one question underneath all of them:**

| | |
|---|---|
| **Can we trust any of the above?** | **[J10](#j10--count-it)** — the count session |

J10 is deliberately not a sixth row. It isn't a lookup anyone performs; it is the ritual
that keeps the other five true, and every one of them degrades to a guess without it. It is
also **Phase 1 work, not a later addition** — imported numbers are a starting position, not a
truth claim, and a shop arriving with nothing usable has no other way in. Treating counting as
a reporting feature that arrives once the "real" features are done is how inventory modules
rot; see [§5.11](#511-design-for-the-sustain-not-the-setup).

The remaining journeys are the write side and the setup that keep those answers current —
[J1](#j1--seed-the-item-master-and-opening-balances) seeding,
[J2](#j2--say-where-something-lives) recording where things are,
[J3](#j3--estimate-material-cost-on-a-quote) the quoting boundary, and
[J8](#j8--cut-it-return-the-remnant) remnants.

> **Considered and cut**, listed so the omissions read as decisions rather than oversights:
>
> - *"Can we prove it?"* — [Traceability](#cut--traceability-can-we-prove-it), cut. No certs, no
>   heat numbers, no regulated customers, so the whole lot layer went with it
>   ([§5.6](#56-lots--resolved-dont-build-them)).
> - *"Whose is it?"* — [Customer-supplied material](#cut--customer-supplied-material-whose-is-it), cut.
>   Real and frequent, but **never stocked**: it arrives with the job, is worked, and leaves.
>   It's an attribute of a job, not of inventory.

### Explicit non-goals (deliberate, decided)

| Non-goal | Rationale |
|---|---|
| **No demand forecasting** | A job shop's demand *is* its order book. Forecasting a make-to-order backlog is modelling noise. |
| **No MRP planning run / netting** | Requires reliable lead times and BOM depth we don't have, and produces output nobody in a 10-person shop acts on. Reorder points ([J11](#j11--dont-run-out)) cover the real need. |
| **No multi-warehouse** | One building. `inventory_locations` already nests if a second site ever appears. |
| **No customer-owned stock model** | Customer-supplied material is real and frequent but **never enters stock** — it arrives with the job, is worked, and leaves ([Customer-supplied, cut](#cut--customer-supplied-material-whose-is-it)). No ownership flag, no consignment ledger, no valuation. |
| **No inventory valuation, COGS, or accounting postings** | Accounting stays in QuickBooks. Jigged tracks *quantities and identity*; money is costing's job (`part_procurement_tiers`, `compute_part_cost_at_qty`). |
| **No automatic purchasing** | The system proposes a buy list; a human places the order. Auto-ordering requires vendor integration and trust we haven't earned. |
| **No tool-crib / perishable-tooling management** | Adjacent and real, but a different object with a different lifecycle (tool life, regrinds, checkout). Out of scope; revisit as its own module. |

### In scope

The twelve journeys in [§4](#4-target-journeys), the modelling decisions in
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

### **J1 — Seed the item master and opening balances**

**Actor:** owner, at onboarding. **Trigger:** migrating off a legacy ERP or a spreadsheet.

Import the things you stock, with their current on-hand quantity, unit, and reorder point.

**Today:** partial. The [guided import flow](modules/data-import.md) (Upload → Map →
Review & Fix → Import) exists and handles name / description / unit / vendor / BOM.
**Stock quantity is not an importable field** — so a shop migrating in must hand-key every
opening balance or start at zero. This contradicts PRD **FR-16** (*"System supports CSV
upload for inventory items"*).

**Missing:** `quantity` and `reorder_point` in the import mapping, and writing an opening
`adjustment` ledger row per item rather than a bare `parts.quantity` write, so the balance
has provenance from the first day.

> **Verification belongs *inside* the import flow, not after it.** An earlier revision of this
> spec proposed importing quantities into a count sheet's "expected" column so a human would
> count before anything became a balance. **That was wrong** — it bolts a second verification
> step onto a pipeline that already has one, makes "import" not actually import, and couples
> two features that should be independent.
>
> The **Review & Fix** step is the verification step. Quantities should flow through it like
> every other column, with the flow surfacing what it can actually determine from the data:
> how many rows carry a quantity at all, which look stale against a last-edited date, which
> are zero versus blank versus missing. Confirm what's readable, flag what isn't, and let the
> human accept or correct **in one place**. That strengthens the import flow rather than
> routing around it.
>
> **Assume the numbers are wrong anyway.** Shops in this niche rarely hold accurate counts —
> Contour's legacy `onHand` was populated on 43 of 9,428 rows (0.5%), and freshness was
> unknowable for most of the rest. So an import is a *starting position*, not a truth claim,
> and the system has to expect drift from day one. That is what [J10](#j10--count-it) is for,
> and it is why counting is not optional. A lighter-weight periodic **reconciliation** pass —
> refresh these numbers without running a full physical count — is a reasonable later addition
> once we see how the drift actually behaves; it is deliberately **not** specced here.

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

> **Their legacy data proves the demand.** 97 of the 121 "locations" in their old ERP were
> job, work-order or part numbers ([§5.5](#55-locations-keep-them-visual-change-when-they-appear)).
> Users typed job numbers into a location field for years because there was no job↔material
> link. **This journey is not a hypothesis — it is a workaround they already built by hand,
> in the wrong field, at scale.** It is the strongest-evidenced item in the entire spec.

**The entry point must be the job, not the bin.** This is the sharpest consequence of the
validation, and it reverses an assumption baked into both the current build and the earlier
draft of this spec:

- **Today the flow is bin-first** — scan a location QR → see contents → remove → *optionally*
  tag a job. That serves someone auditing a bin. It does not serve an operator whose context
  is *"I'm starting job 1047."*
- **The flow should be job-first** — operator is on the job traveler → sees the material the
  job needs → taps it → sees where it is → confirms taking it. The depletion is job-linked by
  construction rather than by an optional field the operator must remember.
- Bin-first stays as the secondary path. It is the right shape for J10 counting and J12
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

**Why this is Phase 1:** it is the ritual that keeps the other eleven journeys true, and
the PRD's own success metric (*"100% inventory accuracy within 3 months"*) is unmeasurable
without it. It also carries the label-maintenance task — replacing damaged QR labels is
[a job for a scheduled audit](https://www.sortly.com/blog/how-to-label-inventory/), and the
count session is that audit.

**It is also the only way a shop with no usable legacy data gets numbers at all.** Import
([J1](#j1--seed-the-item-master-and-opening-balances)) and counting are the two doors into
the module, and every shop comes through one or the other:

| The shop arrives with… | Door |
|---|---|
| Trustworthy on-hand figures | Import ([J1](#j1--seed-the-item-master-and-opening-balances)) |
| Figures of unknown quality | Import, then count to correct |
| Nothing usable | Count only — the first session *is* the opening balance |

Contour is the third row: their legacy `onHand` was populated on **43 of 9,428 rows (0.5%)**,
with freshness unknowable for most of the rest. Their parts table is a quoting catalogue
(`price1` 88% full, `custCode` 51%), not an inventory record. Neither door is a special case
built for one shop — **both are normal, and the module needs both.**

> **They have tried counting before** *(2026-07-27)* — their old ERP had a locations feature
> and an on-hand column. So this is **rescuing a lapsed practice, not introducing one**: no
> education needed, and the first session can be self-served rather than facilitated. But see
> [§5.5](#55-locations-keep-them-visual-change-when-they-appear) — a previous attempt failing
> raises the bar rather than lowering it.

**Design the first run and the hundredth as the same flow.** An onboarding-only count mode
would be a second code path that rots; the opening count is just a count whose expected column
happens to be empty.

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

### J12 — Find it

**Actor:** anyone. **Today: built, and it works.**

Scan a location QR → the phone opens the bin view → contents, drill-down, and add / remove /
set per part. Searching an item shows its per-location balances with full paths.

This is the genuinely good part of the June build. Keep it.

---

## Considered and cut

Two journeys were specced and then removed once the shop was understood. They are kept here,
**without numbers**, so the decisions are on the record and don't get re-proposed — but they
are deliberately outside the J1–J12 sequence, because they are not work.

### Cut — Traceability *("can we prove it?")*

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

### Cut — Customer-supplied material *("whose is it?")*

Customers do bring their own material for service-style one-off jobs, and there are a lot of
them. An earlier revision of this spec promoted that into a journey with an ownership flag on
stock.

**Cut on 2026-07-27: customer-supplied material is never stocked.** It arrives with the job,
is worked on while the job is active, and leaves with the finished part. It has no balance, no
life in a storage location, and nothing to count. It is an attribute of a **job**, not of
inventory — and modelling it as stock-we-don't-own would have pushed an ownership flag through
every read path (on-hand math, reorder logic, count sheets, buy list) to describe something
that never behaves like stock.

Same test that cut job-as-place in [§5.2](#52-is-a-job-a-place--resolved-no): don't model a
workflow the shop doesn't have.

**One narrow interaction survives, and it belongs to [J4](#j4--job-kickoff-material-check),
not here.** If a service job carries a BOM line for the customer's material, J4 would compute
a shortage against it and push it onto a buy list — a false alarm, on a job type that is
frequent. Whether that can happen depends on a single unanswered question:

| Do service jobs carry a BOM line for the customer's material? | Then |
|---|---|
| **No** — it's "here's a part, fix it", no material line | **Nothing to do.** J4 has nothing to compute against, no false shortage is possible, and this is fully closed. |
| **Yes** | J4 needs one exclusion so those lines don't raise shortages. A flag on the BOM line or the job — **not** on stock, and not a journey. |

That question is in [§8](#8-what-we-know-and-what-we-still-dont). It does not block Phase 1:
J10 and J7 are unaffected either way, and J4 can ship with the exclusion added later if it
turns out to be needed.

**Reopen only if** customer material starts being *stored* between delivery and use — at which
point it is genuinely stock with an owner, and this section's original analysis applies.

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

> ⚠️ **Contour already had a locations feature, and we have the wreckage.** Their old ERP's
> location table was exported on 2026-07-27 — **121 rows** — and it is the best evidence in
> this entire spec, because it is *behaviour*, not self-report.
>
> | What the 121 rows actually contain | Count |
> |---|---|
> | Job numbers (`J55502-04`, `J-32579-01`…) | **46** |
> | Bare work-order numbers (a run of `45292`–`45362`…) | **45** |
> | Part numbers (`174712-33-2`, `B5981B-33-1`…) | 6 |
> | `MISC 2-4-20`, `MISC 8-25-21`, `MISC. 6-23-18` | 3 |
> | **Things that are actually places** (`STOCK`, `SHELF`, `YARD`, `OFFICE`, `QC`, `CABINET 3-10`, `JEFF'S DESK`, `DB BOX`, `ENG WINDOW`, `ZAPP`, `SMD`, `SBS`…) | **22** |
>
> Three findings, each of which independently supports the redesign:
>
> **1. The hierarchy was never used. 118 of 121 are flat** — only `Main/Main`,
> `Main/Main/Control` and one other use the `/` path separator at all. Their old system encoded
> nesting as a delimited string, exactly the
> [MRPeasy flat-list convention](https://www.mrpeasy.com/resources/user-manual/stock/settings/locations/),
> and they still didn't nest. **Our multi-level wizard is solving a problem this shop has
> demonstrably never had.** This is the single strongest argument in §5.5 and it comes from
> their own data.
>
> **2. Free text decayed exactly as predicted.** `STOCK` and `ST0CK` (letter O vs zero).
> `JEFF'S DESK` and `JEFFS DESK`. `J-52818-01` and `J52818-01`. Three separate dated `MISC`
> entries — the *"put it somewhere temporary and fix the code later"* pattern,
> [documented as the #1 failure mode](https://craftybase.com/blog/bin-location), preserved in
> amber. **Create-on-the-fly is right, but it must dedupe aggressively** — a bare freeSolo text
> field reproduces this within a year.
>
> **3. ~80% of the "locations" are not locations.** 97 of 121 are job, work-order or part
> numbers. Users were writing *"this material is for job J55502"* into the only field
> available, because **the system had no way to express job↔material allocation.** That is not
> a location system failing; that is people hand-building [J7](#j7--issue-material-to-a-job)
> out of the wrong primitive.
>
> **Usability or maintenance? The data answers it: neither, quite.** It was a **modelling**
> failure — one free-text field asked to carry two unrelated concepts, with no constraint on
> either. That is fixable by design, so the redesign is the right bet, and §5.5's direction
> holds. But note the corrected priority: **the missing job↔material link (Phase 1) caused
> most of the location mess.** Fixing J7 will remove ~80% of what made their old location list
> unusable *before Phase 2 writes a line of code.*
>
> **~22 real places** also lands close to the founder's ~10 (±4) estimate once the job numbers
> are stripped out — and several of the 22 (`0-5`, `1/2''DBL`, `3/8 DRILL BLK`) look like
> tooling sizes rather than places, so the true figure is plausibly 12–18.

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
at a place. Nothing sits between them.

Two knock-ons, recorded so they aren't missed:

- **[J8 remnants](#j8--cut-it-return-the-remnant) must now stand on its own.** It was going to
  arrive free as a child-lot. Building it now means an explicit remnant concept — and it needs
  confirming they actually reuse drops before that's worth it.
- **[Customer-supplied, cut](#cut--customer-supplied-material-whose-is-it) needed no lot either** — it
  was subsequently cut altogether, because that material is never stocked.

**Reopen with [Traceability, cut](#cut--traceability-can-we-prove-it)** if a regulated customer ever appears.

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

Ordered by dependency, not value. **Get numbers in → use them → keep them true.**

1. **Get numbers in — two doors, both required.**
   - **[J1](#j1--seed-the-item-master-and-opening-balances) import**: `quantity` and
     `reorder_point` through the existing Upload → Map → **Review & Fix** → Import flow.
     Completes a pipeline that already exists and closes FR-16.
   - **[J10](#j10--count-it) count session**: for shops arriving with nothing usable, and
     thereafter the correction mechanism for everyone. The opening count is just a count with
     an empty expected column — **one flow, not an onboarding special case.**

   These are peers. Which gets built first is a team call, not a product one — but a shop with
   no importable data (Contour) can't start until J10 exists, and a shop with good data
   shouldn't be made to count 9,000 rows by hand.

2. **[J4](#j4--job-kickoff-material-check) material check** — the rush-job question:
   *can I say yes right now?* No new tables.

3. **[J7](#j7--issue-material-to-a-job) issue-to-job, job-first, on the operator surface** —
   the operator's entry point is the job traveler, not a bin scan. Largest build in the phase,
   and the one an earlier draft had pointed at the wrong actor.

[Customer-supplied](#cut--customer-supplied-material-whose-is-it) was cut, and with it the
ownership flag that would have touched every read path. Restoring the #59 owner-side job
selector stays a small correctness patch, **not** a headline item — the owner is not who moves
material.

No new feature flag. **One new table: the count session.** J1 adds columns to an existing
import mapping, not a schema of its own.

[§5.2](#52-is-a-job-a-place--resolved-no) is resolved — a job is **not** a place. Build the
simple depletion.

### Phase 2 — locations reshaped

**J2** incremental places · permanent board · photos + fill state · palette fix · retire the
mandatory wizard · PWA basics + the scanner spike ([§5.10](#510-native-app-deferred-scanning-case-must-be-spiked)).

### Phase 3 — purchasing

**J5** POs · **J6** receiving against PO · **J11** buy list + on-order. **This is issue #571**
— merge, don't parallelise.

### Phase 4 — debt paydown and remnants

**The traceability half is cut** — Contour keeps no certs or heat numbers and serves no
regulated customers, so [Traceability, cut](#cut--traceability-can-we-prove-it) and the whole lot layer are
gone. What's left:

- **[J8](#j8--cut-it-return-the-remnant) remnants**, now justified on material-cost grounds
  alone rather than riding along with lot modelling. **Confirm they actually reuse drops
  before building it** — that was never asked.
- **Reconciliation** — a lighter-weight periodic refresh of on-hand figures without running a
  full physical count. Deliberately unspecced until we can see how drift actually behaves in
  production; [J10](#j10--count-it) covers correctness in the meantime.
- **[J4](#j4--job-kickoff-material-check) customer-material exclusion** — *only if* service
  jobs turn out to carry BOM lines for customer-supplied material, which would otherwise raise
  false shortages. See [Customer-supplied, cut](#cut--customer-supplied-material-whose-is-it).
- **[§5.4](#54-one-stock-engine) one-stock-engine collapse** and
  **[§5.9](#59-decide-job_materials-fate) `job_materials` resolution** — debt paydowns that
  want a quiet phase.

---

## 7. Gap analysis — what we missed

Scored against the twelve journeys, plus the two that were cut.

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
| J12 find it | *(absent)* | AC only | ✅ |
| Customer-supplied *(cut)* | *(absent)* | *(absent)* | ⛔ **cut** — frequent, but never stocked |

**Three structural misses, in order of cost:**

1. **We shipped the only journey with no requirement behind it, and skipped the one marked
   primary.** J2/J12 got six PRs; J4/J7/J10 got nothing.
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
| Certs / heat / regulated customers? | **None** | [Traceability, cut](#cut--traceability-can-we-prove-it) cut, lot layer cut, Phase 4 halved |
| Customer-supplied material? | **Yes, a lot of them** — service one-offs. **Never stocked**: arrives with the job, worked, leaves | [Customer-supplied, cut](#cut--customer-supplied-material-whose-is-it). It's a job attribute, not inventory — no ownership flag anywhere |
| How many storage places? | **~10, ±4.** Cabinets and shelving | Validates [§5.5](#55-locations-keep-them-visual-change-when-they-appear) — one wizard pass generating 16 is over-built for this shop |
| Have they ever counted? | **Yes, tried** | Rescuing a lapsed practice, not introducing one → [J10](#j10--count-it) first run can be self-served |
| Did a locations feature already fail them? | **Yes** — *"badly designed and not really intuitive"*, and we now have the export | ⚠️ Raises the bar on [§5.5](#55-locations-keep-them-visual-change-when-they-appear). We get one more attempt, not two |

### Measured — from their legacy exports, 2026-07-27

Two CSVs from the old ERP. This is **behavioural evidence**, which outranks everything above
it: it is what they did, not what anyone remembers.

| Measurement | Value | What it settled |
|---|---|---|
| Legacy locations, total | **121** | — |
| …that are job / work-order / part numbers | **97 (80%)** | Users hand-built [J7](#j7--issue-material-to-a-job) in a location field. Strongest evidence in the spec. |
| …that are genuinely places | **22** (likely 12–18 after tooling sizes) | Confirms the founder's ~10 ±4. Wizard generating 16 in one pass is over-built. |
| …using the `/` hierarchy | **3 of 121** | **Nesting was never used.** Flat-first is correct. |
| Near-duplicates | `STOCK`/`ST0CK`, `JEFF'S DESK`/`JEFFS DESK`, `J-52818-01`/`J52818-01`, 3× dated `MISC` | Free text decays. Create-on-the-fly **must** dedupe. |
| Parts rows | **9,428** | Real scale; cf. NFR-8's 10,000-item target |
| …with `onHand` populated | **43 (0.5%)** | ⛔ **This shop has no opening-balance data.** They enter through the counting door, not the import door — see [J10](#j10--count-it). |
| …with `price1` / `custCode` | 88% / 51% | Their parts table is a **quoting catalogue**, not an inventory record |
| …with `lastEditDate` | 28% | Freshness is unknowable for most rows — assume imported numbers drift from day one |

> **Two corrections this measurement forced.** An earlier revision read the founder's *"rare
> data was populated"* as *"raw data … for a lot of parts"*, and on that basis proposed
> importing quantities into a count sheet's *expected* column instead of into stock. Both are
> withdrawn: the export shows 0.5%, and bolting a verification step onto the far side of the
> importer was the wrong shape regardless — verification belongs in **Review & Fix**, inside
> the flow. See [J1](#j1--seed-the-item-master-and-opening-balances).

### Still open

**Nothing here blocks Phase 1.** The exports closed the two that mattered most — the locations
post-mortem and the opening-balance question — and the rest is Phase 2 input.

| Question | Gates | Note |
|---|---|---|
| **Do service jobs carry a BOM line for the customer's material?** | [J4](#j4--job-kickoff-material-check) only | The last live question from the cut [Customer-supplied, cut](#cut--customer-supplied-material-whose-is-it). If yes, J4 needs one exclusion so those lines don't raise false shortages; if no, fully closed. Doesn't block Phase 1 either way. `custCode` is set on 51% of parts, but that likely means *"made for customer X"*, not *"customer supplied the material"* — **do not conflate them**. |
| Is there a **bar rack**? | Phase 2 palette | Their 22 real places include `STOCK`, `SHELF`, `YARD`, `CABINET 3-10` — **no rack of any kind**. Now *weakly refuted*, but they hold material in feet and inches, so long stock lives somewhere. Don't add the card on a guess either way. |
| What do `ZAPP`, `SMD`, `SBS`, `DB BOX`, `0-5` actually mean? | Phase 2 palette naming | Their vocabulary is opaque from outside, and it's the vocabulary that matters. One screen-share answers all of it — the card-sort in the discovery script is still the instrument. |
| Do they actually reuse drops? | [J8](#j8--cut-it-return-the-remnant) | Remnants lost their free ride when lots were cut, so this now has to justify itself |
| Scan ten in a row? Dead zones? Whose phones? | [§5.10](#510-native-app-deferred-scanning-case-must-be-spiked) PWA-vs-native spike | Phase 2 only |
| Label durability and placement | Label PDF | Implementation detail, not data model |
| Frequency / pain ranking | Prioritisation within phases | The one thing neither observation nor exports reach |

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

**This spec is done, and Phase 1 is unblocked. Start building.**

The structural questions are answered, [§5.2](#52-is-a-job-a-place--resolved-no) is resolved,
and the legacy exports closed the two questions that were still worth waiting on. Nothing on
the open list gates the first build.

**On the usability test: it is no longer a gate.** It was the right instrument when we had no
evidence. We now have something better for the questions that mattered — 121 location rows and
9,428 part rows of actual behaviour, which beats self-report on exactly the points where
self-report is weakest. What remains for it (their vocabulary, the bar rack, the scanning
spike) is **Phase 2 input and can run in parallel with Phase 1 development.** Do not hold the
build for it.

1. **Build [J10](#j10--count-it) first** — Phase 1's entry point. Blank-slate walk across ~12–18
   places; the first commit *is* the opening balance. Self-served, since they've counted before.
2. **Then [J4](#j4--job-kickoff-material-check)** — no new tables, and it's the rush-job payoff.
3. **Then [J7](#j7--issue-material-to-a-job) job-first** — the largest build, and the
   best-evidenced thing in the spec: they hand-built it in a location field 97 times.
4. **Close #541** — answered: #496 means *beyond* locations; the gap is the material↔job loop.
   Re-scope **#496** from *"the use isn't validated"* to the phasing in [§6](#6-sequencing).
5. **Fold #571 into Phase 3** and **#550 into Phase 1** (J7) and J9. #550's premise has shifted:
   it assumed an `inventory_transactions` flag that does not exist, and the actor is the
   operator, not the owner.
6. **Run the [discovery script](usability-tests/inventory-discovery-script-v1.md) alongside**,
   for Phase 2 only. Trim it to the vocabulary walk, the bar-rack question and the scanning
   probes — the rest is answered.

> **Expect Phase 1 to shrink Phase 2.** Roughly 80% of what made their old location list
> unusable was job numbers in the wrong field. [J7](#j7--issue-material-to-a-job) removes that
> pressure. Re-evaluate how much locations work is actually needed *after* Phase 1 ships,
> rather than committing to Phase 2's scope now.
