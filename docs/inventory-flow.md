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
> **Journeys marked _hypothesis_ have not been validated with a shop.** The
> [discovery script](usability-tests/inventory-discovery-script-v1.md) exists to convert them.
> Its **findings** file is deliberately untracked — `.gitignore` keeps
> `docs/usability-tests/*findings*` local, because completed sessions contain user research.
> Read [§8](#8-what-we-do-not-know) before treating any of this as settled.

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
| Can we prove it? | [J12](#j12--prove-it-traceability) |

### Explicit non-goals (deliberate, decided)

| Non-goal | Rationale |
|---|---|
| **No demand forecasting** | A job shop's demand *is* its order book. Forecasting a make-to-order backlog is modelling noise. |
| **No MRP planning run / netting** | Requires reliable lead times and BOM depth we don't have, and produces output nobody in a 10-person shop acts on. Reorder points ([J11](#j11--dont-run-out)) cover the real need. |
| **No multi-warehouse** | One building. `inventory_locations` already nests if a second site ever appears. |
| **No consignment or customer-owned stock accounting** | Customer-supplied material is a real thing (see [§8](#8-what-we-do-not-know)) but it is a *flag on a lot*, not a separate ownership ledger. |
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
to hand-key every opening balance, or start at zero and drift immediately. This directly
contradicts PRD **FR-16** (*"System supports CSV upload for inventory items"*).

**Missing:** `quantity` and `reorder_point` columns in the parts import mapping, writing
an opening `adjustment` ledger row per item rather than a bare `parts.quantity` write.

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

**Actor:** owner, admin, or operator. **Trigger:** material is pulled for a job.

Pull the material, and the depletion is **linked to the job**. This is the PRD's stated
primary path and issue #59's validated ask.

**Today: missing where it matters.** An operator at a scanned bin can tag a removal to a
job. An owner in the dashboard cannot — `PartTransactionModal` has no job field at all.
The March feedback shipped and was lost in the May unification.

**Also adopt:** *close out the job and lock the history* as an explicit final step, giving
an immutable audit trail of what a job consumed. Borrowed from Sortly's
[Jobs feature](https://www.sortly.com/blog/new-feature-alert-jobs/), shipped 22 July 2026.

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

### J12 — Prove it (traceability)

**Actor:** owner, under audit or customer request.

*"Which jobs used heat 5521-B?"* · *"Show me the cert for the parts on this shipment."*

**Today: missing entirely.** No lot, heat, or cert concept exists.

**Scope gate:** this journey only earns its cost if the shop serves regulated customers.
See [§8](#8-what-we-do-not-know) — the discovery answer can delete Phase 4 outright.

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

### 5.2 Is a job a *place*? — **decide before Phase 1 ships**

Sortly's model **transfers materials into the job** rather than consuming them on the spot.
If a job is a container material can sit in, three things fall out for free:

- **Staging / kitting** — material pulled and parked against a job before it runs.
- **Shortage flagged at kitting**, before scheduling, not mid-production.
- **Return on cancellation** — material goes back to stock by moving, not by a
  compensating adjustment.

Mechanically it costs almost nothing: it reuses `part_location_stock` and the existing
`transfer_stock` RPC instead of needing a new table. The cost is conceptual —
`inventory_locations` stops being purely physical, and every location query has to reason
about virtual nodes.

**This is the largest modelling fork in the spec.** It changes J4, J7 and J8. Caveat the
analogy honestly: Sortly's jobs are field-service jobs; ours have routings and BOMs and
already carry `job_materials`.

**Recommendation:** decide it against the discovery finding for *"does material get staged
for a job before it runs, or pulled at the machine?"* If they stage, a job is a place. If
they pull at the machine, it isn't, and J7 is a straight depletion with a `job_id`.

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

### 5.6 Lots are a layer above locations

A heat/lot has a quantity and sits in a place. A **remnant is a child lot** with its own
dimensions, pointing at its parent. This single shape makes both traceability
([J12](#j12--prove-it-traceability)) and remnant reuse ([J8](#j8--cut-it-return-the-remnant))
fall out of the same model rather than needing two mechanisms.

Lots are Phase 4 and gated on the discovery answer about certs.

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

**J4** material check · **J7** issue-to-job (restore the #59 job selector) · **J10** count
session · **J1** opening balances in the importer.

No new physical-tracking concepts, no new feature flag, and no new tables except the count
session. This is the slice that makes the stock number worth maintaining, and every item in
it traces to either the PRD's stated primary journey or explicit shop feedback.

Decide [§5.2](#52-is-a-job-a-place--decide-before-phase-1-ships) before this ships.

### Phase 2 — locations reshaped

**J2** incremental places · permanent board · photos + fill state · palette fix · retire the
mandatory wizard · PWA basics + the scanner spike ([§5.10](#510-native-app-deferred-scanning-case-must-be-spiked)).

### Phase 3 — purchasing

**J5** POs · **J6** receiving against PO · **J11** buy list + on-order. **This is issue #571**
— merge, don't parallelise.

### Phase 4 — traceability and remnants

**J6** certs/heat capture · **J8** remnants · **J12** trace queries. Also
[§5.4](#54-one-stock-engine) collapse and [§5.9](#59-decide-job_materials-fate) resolution,
which are debt paydowns that want a quiet phase.

**Gate:** if discovery shows no regulated customers, cut Phase 4's traceability half and
re-justify remnants ([J8](#j8--cut-it-return-the-remnant)) on material-cost grounds alone.

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
| J12 traceability | *(absent)* | silent | ❌ |
| J13 find it | *(absent)* | AC only | ✅ |

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

## 8. What we do not know

**No user research on inventory exists.** The findings CSV is an empty template; no
usability test has ever been run. Grepping all of `docs/` for `stockroom`, `tool crib`,
`pallet rack`, `shelving` or `cabinet` returns **zero hits** — the storage vocabulary in the
builder came from generic WMS research, never from looking at Contour's shop. PR #419's own
follow-up (*"usability-test the storage-type icon set with Johnny/Shane and lock it"*) never
happened.

Open questions that change the spec:

| Question | What it decides |
|---|---|
| Do they serve regulated customers who demand certs? | Whether Phase 4 exists at all |
| Stock vs buy per job — what's the actual split? | Whether J1/J10 matter or only J4–J7 do |
| Is material staged for a job before it runs? | [§5.2](#52-is-a-job-a-place--decide-before-phase-1-ships) — whether a job is a place |
| How many real storage places are there? | Hypothesis is 6–10, not 16. Validates [§5.5](#55-locations-keep-them-visual-change-when-they-appear) |
| Would anyone scan ten things in a row? | [§5.10](#510-native-app-deferred-scanning-case-must-be-spiked) — the entire native-app case |
| Where does the phone lose signal? | PWA offline scope |
| What is a paper label on the bar rack like after a month? | Label material, not data model |

Carried forward, unresolved, from elsewhere:

- **Scrap.** Does scrapping a unit consume material, and how does it relate to the existing
  `has_discrepancy` flag? ([`operator-paperless-flow.md`](operator-paperless-flow.md) §5.4)
- **Customer-supplied material.** Real in job shops, unmodelled here. Probably a flag on a
  lot; needs confirming it happens at Contour before building anything.
- **Issue #541** — does #496 mean *"beyond locations"* or *"including locations, which we
  overbuilt"*? This spec's answer: **beyond**. Locations are worth keeping and reshaping;
  the gap is the material↔job loop.

**Two Sortly reports are gated downloads and were not obtained** — *2026 State of Inventory*
and the *Do You Need to Track Inventory?* flowchart. The latter speaks directly to #541.
Worth pulling; do not cite numbers from either until someone has read them.

---

## 9. Next steps

1. Run the [discovery script](usability-tests/inventory-discovery-script-v1.md) with
   Shane and Johnny. Fill the findings CSV in the shop.
2. Answer the certs question first — it gates a whole phase.
3. Decide [§5.2](#52-is-a-job-a-place--decide-before-phase-1-ships) (job as place) from the
   staging finding.
4. Close **#541** with the answer; re-scope **#496** from *"the use isn't validated"* to the
   phasing in [§6](#6-sequencing).
5. Fold **#571** into Phase 3 and **#550** into Phase 1 (J7) and J9.
