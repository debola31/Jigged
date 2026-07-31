# Inventory & Material Module

> **Single source of truth for inventory.** This doc carries both *what exists today*
> ([§3](#3-what-exists-today)) and *where it's going* ([§4](#4-target-journeys) onward). There
> is no separate journey spec — an earlier revision split the two across
> `docs/inventory-flow.md` and this file, and they drifted within a week. It also absorbs the
> inventory-locations spec that PR #414 promised and never wrote.
>
> **Status:** Draft · **Last substantive update:** 2026-07-27 · **Branch:** `feature/inventory-journey-spec`
>
> **Target state is full material control** — requisition → PO → receive against PO → issue to
> job → remnant back to stock. That is a multi-quarter build, so [§6](#6-sequencing) phases it
> and Phase 1 is deliberately the smallest slice that closes what a real shop already asked for.
>
> **Partially validated, 2026-07-27.** Structural questions were answered from the founder's
> multi-day on-site observation at Contour Tool & Machine, plus **measured** against their
> legacy ERP exports — see [§9](#9-what-we-know-and-what-we-still-dont). Those answers resolved
> the largest modelling fork ([§5.2](#52-is-a-job-a-place--resolved-no)) and cut two journeys.
> Observation is reliable on structure and weaker on frequency; the exports are behavioural and
> outrank both.
>
> The [discovery script](../usability-tests/inventory-discovery-script-v1.md) covers what
> remains, all of it Phase 2 input. Its **findings** file is deliberately untracked —
> `.gitignore` keeps `docs/usability-tests/*findings*` local, because completed sessions
> contain user research.

---

## 1. TL;DR

Inventory is the one Jigged module that has not taken at the one shop we serve. The
diagnosis is not "it needs more features" — it is that **we built the *where* layer first
and the *why* layer never.**

> **Status: the *why* layer shipped 2026-07-28.** Phase 1 — J1 import balances, J9 count sheet,
> J4 material check, J7 issue-to-job — is complete, in zero new tables and zero migrations.
> The diagnosis below is kept as written, because it is what the phase was built against and
> because the failure mode it names (investment following the surface that is easiest to build
> rather than the journey that was asked for) is not a one-off.

Three facts, each verifiable:

1. **All 2026 inventory investment went to a surface nobody asked for.** Six PRs between
   20–25 June built QR-addressable storage locations, a visual storage builder, and an
   operator bin-scan flow. That surface has **no PRD requirement, no module doc, no user
   story, and no user research** behind it. Issue **#496**, opened afterwards, rates
   inventory *"Priority 3 (Later) … the use isn't validated."*
2. **The journey the PRD calls primary was never built.** [`prd.md`](../prd.md) Open Question 2,
   owner-answered: *"you should primarily deplete inventory through jobs."* Nothing in
   Jigged decrements stock as a consequence of production. Every stock movement is a
   deliberate act of bookkeeping, which is exactly the thing shops stop doing.
3. **The one piece of validated shop feedback we had was silently regressed.** Issue #59
   (Shane, `client-feedback`, P0): *"link inventory removals to specific jobs."* It shipped
   in March against `/inventory/[itemId]`, that page was deleted in the May parts
   unification, and [`PartTransactionModal.tsx`](../../components/parts/PartTransactionModal.tsx)
   contains **zero** references to jobs today.

The fix is to make material movement **a by-product of work rather than a separate chore**:
material is checked against a job, issued to a job, and confirmed at the operation. Stock
levels become a consequence of that loop instead of something a person maintains. Storage
locations stay — they are genuinely useful and the QR-on-location piece is the one part of
the build the shop actually asked for — but they stop being the front door.

---

## 1a. Who does what, and where

Every action the product actually supports today, by actor. **This is the summary to read before
§4**, which explains *why* each was designed the way it was and is ten times longer.
Route names are relative to `/dashboard/{companyId}` or `/operator/{companyId}`.

### Admin / office — computer, mouse

| I want to… | Where | How |
|---|---|---|
| See what we have and what's short | `/parts` | `On hand` + `Status` columns; filter `Low` / `Out`. `?status=low` is the shop-wide shortage view. |
| Name the places we already have | `/inventory/locations` (**Storage**) | `Add storage` tile → name it. Flat. `Subdivide` an existing unit only if it needs rows/bins. |
| Make a place recognisable | Storage → tap tile → sheet | `Add a photo`. This is the place's identity — a photo beats the drawn icon. |
| Print labels | Storage toolbar / tile sheet | `Print all labels`, or `Print QR` for one. |
| Count one place | Storage → tap tile → `Count what's here` | Worksheet scoped to that place. Nothing is excluded — at one bin there is no split-part ambiguity. |
| Put stray parts away | Same worksheet, at `Unassigned` | `Move N to…`. `Unassigned` **is** the put-away pile. |
| Count the whole shop | Storage → `Count everything` | Pick parts, count, save. A part split across places is named and skipped — count it at its place instead. |
| See where one part lives | `/parts/{id}` → Inventory tab | Per-location balances with full paths. |

### Operator — own phone

| I want to… | Where | How |
|---|---|---|
| Go to the shelf I'm standing at | `Scan` tab | Scan its label. Resolves location labels *and* job travellers. |
| Browse what's in storage | `Inventory` tab | Board of places with photos + fill state. Tap to drill in. Read-only. |
| Take stock out | Bin view → part card → `Remove` | Qty + unit + optional job tag. Over-removal records the shortfall and zeroes the count rather than blocking. |
| Put stock in | Bin view → part card → `Add` | Qty + unit + notes. |
| Put in a part that isn't here yet | Bin view → `Stock a part` | Picks a tracked part not already in this bin. |
| Move stock to another place | Bin view → part card → `Move` | Any other place in the company. |
| Correct a wrong number | Bin view → part card → `Adjust` | "Adjust stock (cycle count)" — set the true quantity. This *is* a one-part count. |

### Not possible today — and each is a decision, not an oversight

| Journey | Status |
|---|---|
| **Operator asks "is this part in storage, and where?"** | **No tool.** No part search on any operator surface; you must already know which place to open. Per-location balances are on the admin part page, and `AuthGuard` redirects operators out of `/dashboard`. This is J11, deliberately out of Phase 2 scope — but see the bug below. |
| **Photograph a deposit as proof others can read later** | **Unbuilt and, until now, unrecorded.** `inventory_transactions` has no attachment column. Photos attach to *places* (identity), and operator photo capture exists only on job/part **notes** — which cannot tag a place. All three pieces exist; nothing connects them. A movement is currently evidenced by attribution (operator + timestamp + location snapshot), not by an image. |
| **Operator counts or puts away a whole place** | **Office-only.** The place-scoped worksheet lives under `/dashboard`, which operators are redirected out of. So the recurring "work a place" job cannot be done by the person holding the phone. |
| **See this bin's history — who took the last one** | **No surface.** `inventory_transactions` records operator, location and timestamps; the ledger is admin-only. |
| **Reconcile a recorded discrepancy** | **No surface, no owner.** Over-removal sets `has_discrepancy` and nothing lists them. |

> ### 🐞 One false promise in shipped UI
> When a bin holds more parts than the cap, the operator bin view shows:
> *"Showing the 200 largest of 9,428 parts here. **Scan or search a part** to reach one that
> isn't listed."*
>
> Neither route exists. There is no part search on the operator app, and the scanner resolves
> **locations and job travellers** — never a part into this bin. So the one screen that admits
> the list is truncated tells the operator to do two things they cannot do. Either build part
> lookup (J11) or change the copy; the current text is worse than saying nothing.

---

## 2. Goal & non-goals

### Goal

A shop can answer five questions about material without leaving Jigged:

| Question | Journey |
|---|---|
| Do we have it? | [J4](#j4--job-kickoff-material-check) |
| Where is it? | [J11](#j11--find-it) |
| Did we buy it? | [J5](#j5--buy-it) / [J6](#j6--receive-it) |
| Did we use it? | [J7](#j7--issue-material-to-a-job) |
| Will we run out? | [J10](#j10--dont-run-out) |

**And one question underneath all of them:**

| | |
|---|---|
| **Can we trust any of the above?** | **[J9](#j9--count-it)** — the count session |

J9 is deliberately not a sixth row. It isn't a lookup anyone performs; it is the ritual
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
| **No MRP planning run / netting** | Requires reliable lead times and BOM depth we don't have, and produces output nobody in a 10-person shop acts on. Reorder points ([J10](#j10--dont-run-out)) cover the real need. |
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

## 3. What exists today

> Verified against the code on `main` as of 2026-07-27. This section is **current state**;
> everything from [§4](#4-target-journeys) onward is target and rationale.

### Concepts

Four things, easy to conflate:

| Concept | Table | Meaning |
|---|---|---|
| **Item** | `parts` where `is_stocked = true` | The thing you stock. Same row as the manufacturable part — one unified item master. |
| **Balance** | `parts.quantity`, and `part_location_stock.quantity` when location-tracked | How much you have *now*. Authoritative. |
| **Transaction** | `inventory_transactions` | What changed and why. Append-only, and **never replayed** — an audit trail, not the source of the balance. |
| **Location** | `inventory_locations` | A place stock can sit. A nullable-parent tree; QR labels encode the location UUID. |

**Absent entirely** — commonly assumed to exist, and does not: purchase orders · receiving ·
lots / heat numbers / material certs · remnants and drops · on-order quantity ·
min/max · reserved or allocated stock · ABC class · serial / expiry · landed, standard or
average cost · location capacity.

### The item master

There is **no `inventory_items` table**. It was absorbed into `parts` in the May unification
(`27040f2`). Inventory is a filtered view over `parts WHERE is_stocked = true`. The prod schema
comment says it plainly:

> `Unified item master. Replaces the prior two-table split between manufacturable parts and stockable inventory_items.`

**Dependencies:** identity fields (name, description, primary unit, reorder point, source) are
edited on the part's Details tab, not in inventory. Materials a made part consumes live on the
part's BOM (`parts_bom`) — part-attached, not routing-attached; the old `routing_materials`
table was removed.

### Data model

#### `parts` (stocked subset)

Full table in the [Parts module](parts.md). Inventory-relevant columns:

| Column | Type | Required | Description |
|---|---|---|---|
| `id` | uuid | Yes | Primary key |
| `company_id` | uuid | Yes | FK to companies |
| `part_name` | text | Yes | Item name (e.g. "4140 Steel Bar"). UNIQUE per `(company_id, part_name)` |
| `description` | text | No | Optional description |
| `is_stocked` | boolean | Yes | `true` marks the part as tracked inventory |
| `source` | text | Yes | `bought` or `made` — both can be stocked |
| `primary_unit` | text | Yes | Unit of measure; the `parts_requires_unit` CHECK makes it non-null |
| `quantity` | numeric | Yes | On hand in `primary_unit` (CHECK ≥ 0). **Only ever changed through a stock function — never the part form.** |
| `reorder_point` | numeric | No | Low-stock threshold; `NULL` disables status |
| `is_location_tracked` | boolean | Yes | When true, on-hand is the rollup of `part_location_stock` rows |
| `preferred_vendor_id` | uuid | No | FK to vendors. A **label only** — it does not gate cost (migration `20260714173443`) |
| `deleted_at` | timestamptz | No | Soft delete — see [Archive](#archive-soft-delete) |

#### `parts_unit_conversions`

Secondary units with conversion factors to the part's primary unit. Delivers FR-1. Replaced
the former `inventory_unit_conversions`.

| Column | Type | Required | Description |
|---|---|---|---|
| `id` | uuid | Yes | Primary key |
| `part_id` | uuid | Yes | FK to parts |
| `from_unit` | text | Yes | Secondary unit (e.g. "inches"). UNIQUE per `(part_id, from_unit)` |
| `to_primary_factor` | numeric | Yes | Multiply by this to get primary units (CHECK > 0) |
| `created_at` | timestamptz | Yes | |

**Example:** steel bar tracked in lbs. `from_unit: "inches"`, `to_primary_factor: 0.166` →
1 inch = 0.166 lbs. Standard same-category units are auto-offered in the transaction modal;
this table stores only custom / cross-category factors. Company-defined unit names live in
`company_custom_units`.

#### `inventory_transactions`

Append-only ledger. Delivers FR-13. The `restrict_transaction_update_to_notes` trigger makes
`notes` the only mutable column after insert.

| Column | Type | Required | Description |
|---|---|---|---|
| `id` | uuid | Yes | Primary key |
| `company_id` | uuid | Yes | FK to companies (CASCADE) |
| `part_id` | uuid | No | FK to parts (SET NULL) |
| `item_name` | text | Yes | Part-name snapshot — survives part deletion |
| `type` | text | Yes | `addition` \| `depletion` \| `adjustment` (CHECK-enforced) |
| `quantity` | numeric | Yes | Always positive (CHECK ≥ 0); direction lives in `type` |
| `unit` | text | Yes | Unit used for this transaction |
| `converted_quantity` | numeric | Yes | Quantity in the part's primary unit |
| `job_id` | uuid | No | FK to jobs (SET NULL) — **only ever set from the operator bin path** |
| `job_operation_id` | uuid | No | FK to job_operations (SET NULL) |
| `operator_id` | uuid | No | Set when an operator performed the action |
| `notes` | text | No | The only post-insert mutable column |
| `has_discrepancy` | boolean | Yes | True when a graceful depletion clamped to zero |
| `location_id` | uuid | No | FK to inventory_locations (SET NULL) |
| `location_name` | text | No | Location-name snapshot (via `trg_snapshot_txn_location`) |
| `transfer_group_id` | uuid | No | Pairs the two rows of a location-to-location transfer |
| `created_at` | timestamptz | Yes | Transaction timestamp |
| `created_by` | uuid | No | Set when an admin performed the action |

Indexed on `(company_id, created_at DESC)`, `(part_id, created_at DESC)`, and partially on
`job_id`, `job_operation_id`, `location_id`, `transfer_group_id`, and
`WHERE has_discrepancy = true`.

#### `inventory_locations`

The storage tree. Adjacency list — **no `path`, `level`, or `ltree` column**; depth and path
are computed client-side on every read.

| Column | Type | Required | Description |
|---|---|---|---|
| `id` | uuid | Yes | Primary key. **This is what a QR label encodes.** |
| `company_id` | uuid | Yes | FK to companies (CASCADE) |
| `parent_id` | uuid | No | Self-FK, `ON DELETE RESTRICT`. `NULL` = top level |
| `name` | text | Yes | CHECK `length(btrim(name)) > 0` |
| `kind` | text | No | Free text — `cabinet`, `row`, `bin`, `shelf`, `system`… |
| `code` | text | No | Human label printed on the tag (e.g. `CAB1-R03-L`). **No uniqueness constraint.** |
| `sort_order` | integer | Yes | Sibling ordering, default 0 |
| `created_at` / `updated_at` | timestamptz | Yes | |

Indexes: `(company_id, parent_id)`, plus a **partial unique index on `(company_id) WHERE
name = 'Unassigned'`** — that index is the entire mechanism behind the auto-created system
bucket, which the RPCs resolve **by name**.

Two caveats worth knowing before changing anything here:

- **Cycle prevention on re-parent is client-side only** (`moveLocation` walks ancestors in JS).
  There is no DB-level constraint, and `moveLocation` has no UI caller today.
- **The "Unassigned" node is identified two different ways** — by the literal string
  `'Unassigned'` in SQL and by `kind === 'system'` in TypeScript.

#### `part_location_stock`

Per-location balances. **RLS is SELECT-only** — mutated exclusively through SECURITY DEFINER
RPCs.

| Column | Type | Required | Description |
|---|---|---|---|
| `id` | uuid | Yes | Primary key |
| `company_id` | uuid | Yes | FK to companies (CASCADE) |
| `part_id` | uuid | Yes | FK to parts, `ON DELETE RESTRICT`. UNIQUE with `location_id` |
| `location_id` | uuid | Yes | FK to inventory_locations, `ON DELETE RESTRICT` |
| `quantity` | numeric | Yes | CHECK ≥ 0 |
| `created_at` | timestamptz | Yes | |

#### `job_materials` is write-only

Snapshotted at job-part creation by `create_job_part_operations_from_routing()`, then **read by
nothing.** Columns are exactly `job_id`, `job_part_id`, `parts_bom_id`, `material_part_id`,
`expected_quantity`, `unit`, `created_at`, `updated_at` — no `status`, `actual_quantity`,
`consumed_at`, or `consumed_by`. Those were removed by migration
`20260614043526_retire_job_material_consumption`.
[`JobPartMaterialsCard.tsx`](../../components/jobs/JobPartMaterialsCard.tsx) reads the **live
BOM** instead, with the comment *"Material consumption is no longer tracked per job — the part
BOM is the source of truth."*

So a table whose entire purpose was consumption tracking is still written on every job creation
and never read. **It is slated for removal** — the decision and its reasoning are in
[§5.9](#59-job_materials--resolved-drop-it-consumption-backs-onto-the-ledger), along with what backs
consumption tracking instead — nothing new:
[`inventory_transactions`](#inventory_transactions) already carries every field
[J7](#j7--issue-material-to-a-job) needs.

> ⚠️ `docs/modules/jobs.md` was corrected in this branch, but older copies may still document
> this table with consumption columns and an `inventory_item_id` FK. The grid above is verified
> against `types/database.ts`.

### The two stock engines

**The most important implementation fact in this module**, and it was not written down anywhere
before this doc. Which engine runs is decided per-part by `is_location_tracked`:

| | **Path A — aggregate** | **Path B — location-tracked** |
|---|---|---|
| Used when | `is_location_tracked = false` | `is_location_tracked = true` |
| Functions | `addPartStock` / `removePartStock` / `adjustPartStock` (`utils/partsAccess.ts`) | `add_stock_at_location` / `deplete_stock_at_location` / `adjust_stock_at_location` / `transfer_stock` (SECURITY DEFINER RPCs) |
| Mechanism | Client-side read-modify-write on `parts.quantity`, then a **separate** ledger insert | Balance upsert + ledger insert in one transaction, under `SELECT … FOR UPDATE` |
| Atomicity | **None.** Two concurrent writes can lose an update. | Atomic and row-locked. |
| `parts.quantity` | Written directly | Trigger-maintained rollup of `SUM(part_location_stock.quantity)` |

Enforced by three triggers:

- `trg_recompute_part_quantity` — `AFTER INSERT/UPDATE/DELETE` on `part_location_stock`,
  recomputes `parts.quantity`.
- `enforce_tracked_part_quantity` — `BEFORE UPDATE` on `parts`, **raises** if a direct
  `parts.quantity` write on a tracked part disagrees with the sum of balances. Path A is
  therefore *refused by the database* for tracked parts, which is why the UI swaps affordances:
  `PartLocationInventory` replaces the Add/Remove/Adjust buttons.
- `trg_auto_track_stocked_part` — `AFTER INSERT OR UPDATE OF is_stocked` on `parts`, auto-enrols
  stocked parts into location tracking **only** when the company has
  `settings.features.inventory_locations = true`, seeding at "Unassigned". This is why no
  per-part opt-in UI exists.

Consolidating these onto one engine is a recorded intent — see [§5.4](#54-one-stock-engine).

### Nothing decrements automatically

Not on operation complete, not on job complete, not on shipment, not on invoice. Verified: zero
calls to any stock function from `jobsAccess.ts`, `operatorAccess.ts`, `shipmentsAccess.ts`, or
`operationCompletionsAccess.ts`. **Every stock movement in Jigged is a deliberate human act of
bookkeeping** — which is exactly the thing a busy shop stops doing.

**Still true after Phase 1 (2026-07-28), and deliberately.** Consumption is recorded when the
operator removes stock at a bin and tags the job — a deliberate act, not a side effect of
starting or completing anything. What changed is that the job tag is now available to the owner
too (#59 restored) and that [J4](#j4--job-kickoff-material-check) reads those rows back, so the
bookkeeping finally pays for itself. Nothing anywhere decrements stock on its own.

The job tag remains **optional**, and that is the accepted risk of this design — see the
reversal note in [J7](#j7--issue-material-to-a-job).

### UI surfaces

Inventory has **no dedicated item detail, create, edit, or import page.** It is a filtered view
over `parts`; everything else is the Parts UI.

#### ~~Inventory list — `/dashboard/{companyId}/inventory`~~ — DELETED 2026-07-30

**Folded into `/parts`.** The sentence directly above was the whole argument and it sat here
unread: *"It is a filtered view over `parts`; everything else is the Parts UI."* The page was
`getStockedParts` — `parts WHERE is_stocked` — with three extra columns (Quantity, Status, Unit)
and a client-side status filter. Its Import and Delete already existed on Parts, and **Add Item
already redirected to `/parts/new`**. Two pages for one item master.

Parts now carries **On hand** (unit folded into the cell: `40 ea`, and `—` for a non-stocked
part, because a made-to-order part has no stock level and printing `0` reads as "we're out")
plus **Status**, plus a **Stock** filter seeded from `?status=` — which is what makes Parts the
shop-wide shortage lens [J4](#j4--job-kickoff-material-check) had been linking to. `/inventory`
redirects to `/parts`.

The sidebar item became **Storage**, pointing at the board. See
[§5.12](#512-two-nouns-parts-is-what-we-have-storage-is-where-it-lives--2026-07-30) for why that
word, and for the flag-off case where `Count Inventory` moves to the Parts toolbar.

#### Part workspace — Inventory tab

[`components/parts/workspace/tabs/InventoryTab.tsx`](../../components/parts/workspace/tabs/InventoryTab.tsx),
rendered only when `part.is_stocked`.

Current Stock display · a "Below reorder point" chip · unit-conversion editor
(`PartUnitConversionsEditor`) · paginated transaction history (`PartTransactionHistoryTable`,
notes editable in place).

Stock actions depend on the engine: untracked parts get Add / Remove / Adjust via
`PartTransactionModal`; tracked parts get per-location balances via `PartLocationInventory` with
add / remove / adjust / **move**.

> **Known gap:** `PartTransactionModal` has **no job selector**. Issue #59 (validated shop
> feedback: *"link inventory removals to specific jobs"*) shipped in March against the old
> `/inventory/[itemId]` page and was lost when that page was deleted in the May unification. An
> owner cannot tag a removal to a job today; only an operator at a scanned bin can. See
> [J7](#j7--issue-material-to-a-job) — the fix is not simply restoring this control.

#### Locations manager — `/dashboard/{companyId}/inventory/locations`

Feature-gated. [`LocationsManager.tsx`](../../components/inventory/locations/LocationsManager.tsx)
loads locations and occupancy in **one pair of requests** (`getLocationBoard`), rolls occupancy
onto the tree (`rollUpOccupancy`), and renders one of two views — segmented **Board | List**,
board always default, the choice deliberately not persisted.

**The board** ([`LocationBoard.tsx`](../../components/inventory/locations/board/LocationBoard.tsx))
draws one tile per top-level unit with the same chrome as the builder's preview
([`board/boardChrome.tsx`](../../components/inventory/locations/board/boardChrome.tsx)), so what
you preview is what you live with. Each tile carries a rolled-up occupancy chip and per-compartment
fill dots; the **whole tile** is the tap target. Not truncated. `Unassigned` sorts last, muted and
explained. An **Add storage** tile lives permanently in the grid.

**The detail sheet**
([`LocationDetailSheet.tsx`](../../components/inventory/locations/board/LocationDetailSheet.tsx))
owns every action — Subdivide, Add one inside, Print QR, Rename, Duplicate, Delete — plus the
fill line, the child list (each with its own fill state), and a lazily-loaded, explicitly-capped
list of what's stored there. It navigates within itself via child rows and breadcrumb. All
structural actions are suppressed for `kind === 'system'`.

~~**The list** (`LocationTreeView`) survives as a finding aid.~~ **Deleted 2026-07-30** — an
indented text tree is the opposite of the visual map decision 9's corrected research calls for,
Cabinet 1 alone exploded into 15 rows, and at 12–18 places the board is strictly better. The
board is the only view.

Toolbar: **Print all labels** · **Count everything**. (Was **Board|List** · Scan · Print all
labels · New top-level location · Build visually — five setup controls on a page whose governing
principle is [§5.11 "design for the sustain, not the setup"](#511-design-for-the-sustain-not-the-setup).)
Adding storage is the in-grid **Add storage** tile, and it is the only way in.

**Build visually / Subdivide**
([`VisualLocationBuilder.tsx`](../../components/inventory/locations/builder/VisualLocationBuilder.tsx))
is one two-step modal serving both: pick a storage type, then configure levels (*"Call them" /
"A set number" vs "Specific names" / "How many?"*, max 4 levels) against a read-only preview, and
press *"Create N locations"*. Per-branch fine-tuning is available after the uniform layout is set.
It builds the whole tree client-side and materialises it via `materializeLocationSpec`.

Passing a `parentId` turns it into **Subdivide this unit**, which swaps the palette to
`SUBDIVISION_TYPES` (levels that start *below* the container — otherwise picking "Cabinet" while
subdividing Cabinet 3 would create `Cabinet 3 › Cabinet 1`) and continues the sibling numbering,
so a second Rows subdivide yields Row 4–6.

> **Known gap:** this is a *structure-first* setup flow — a shop must model its storage
> abstractly before any item exists. The redesign is [§5.5](#55-locations-keep-them-visual-change-when-they-appear).
> `VisualLocationBuilder` accepts `parentId`/`parentCode` props for building under an existing
> node, but `LocationsManager` only ever passes `null`, so that path is unreachable.

#### Operator surfaces

| Route | Purpose |
|---|---|
| `/operator/{companyId}/inventory` | Warehouse home — browse top-level locations |
| `/operator/{companyId}/inventory/locations/{locationId}` | **The QR scan target.** Parent → drill down; leaf → contents with Add / Remove / Set per part |

Scanning a label opens `/operator/{companyId}/login?location={id}`; the login page reads
`?location=` and routes there post-auth. Operator removals are always **graceful** (clamp to
zero, flag `has_discrepancy`) and stamped with the operator id, and may optionally be tagged to
a job.

QR labels encode the **location UUID**, never the human `code`
(`locationLabelPdf.buildLocationScanUrl`). `utils/locationLabelPdf.ts` emits an A4 sheet,
2 columns × 5 rows, 34 mm QR at error-correction level H. `kind='system'` nodes are excluded
from printing.

### Access layer

All inventory operations go through the Supabase client with RLS — **no FastAPI endpoints**.
Both access files use `getTypedSupabase()`.

**`utils/partsAccess.ts`** — `getStockedParts` · `addPartStock` · `removePartStock` ·
`adjustPartStock` · `getPartTransactions` · `updateTransactionNotes` · `getPartUnitConversions` ·
`replacePartUnitConversions` · `deletePart` / `bulkDeleteParts` (→ `archive_parts` RPC).

**`utils/inventoryLocationsAccess.ts`** — tree CRUD (`getLocations`, `buildLocationTree`,
`getLocation`, `createLocation`, `updateLocation`, `deleteLocation` → `delete_location` RPC,
`materializeLocationSpec`, `duplicateLocation`); reads (`getBalancesForPart`,
`getBalancesForParts`, `getLocationContents`, `resolveScan`, `getLocationOccupancy`,
`getLocationBoard`); and RPC wrappers (`addStockAtLocation`, `depleteStockAtLocation`,
`adjustStockAtLocation`, `transferStock`), each of which first loads the part's conversion context
and passes both display and converted quantities.

`getLocationContents` is **explicitly capped** (`LOCATION_CONTENTS_LIMIT`) and returns the exact
total beside the page, because it had no limit at all and was silently clipped by PostgREST's
`max_rows` — invisible on a seed with 14 balance rows, wrong on a 9,428-part shop. It also
excludes archived parts, which is what keeps it consistent with `inventory_location_occupancy`.

`bulkPutAway` is the batched move behind put-away: **one atomic RPC, never chunked**, because a
half-moved pile is worse than no move. It takes no quantity and no unit (it moves each part's whole
balance), which is what lets it skip the per-part conversion read every other stock write needs —
one request for N parts instead of 2N. The 1000-part cap lives in the RPC, not the UI, so no caller
can loop around it. `setLocationPhoto` / `clearLocationPhoto` / `getLocationPhotoUrl` handle the
photo, ordering their writes so a failure anywhere leaves a *readable* location rather than a row
pointing at a file that isn't there.

**`utils/inventoryCountAccess.ts`** — `loadCountCandidates` (company-wide) and
`loadLocationCountCandidates` (one place, where nothing is excluded because there's no split-bin
ambiguity); `refreshSystemQuantities` and `refreshLocationQuantities`, which must not be confused —
the first reads `parts.quantity`, the roll-up across every bin, and using it for a shelf count would
flag a variance on every row; `commitCount`, which routes each line to the write its target demands
and collects per-line failures rather than aborting.

**`components/scanner/LocationScanner.tsx`** — `getUserMedia` + `zxing-wasm`, reading **our location
labels only** (parts have no barcode). The `.wasm` is served from our own origin via
`scripts/copy-scanner-wasm.mjs`, not the library's CDN, because the surface that needs it is a phone
on shop-floor wifi. Foreign codes are refused rather than guessed at.

`bulkPutAway` is the batched move behind put-away: **one atomic RPC, never chunked**, because a
half-moved pile is worse than no move. It takes no quantity and no unit (it moves each part's whole
balance), which is what lets it skip the per-part conversion read every other stock write needs —
one request for N parts instead of 2N. The 1000-part cap lives in the RPC, not the UI, so no caller
can loop around it. `setLocationPhoto` / `clearLocationPhoto` handle the photo, ordering their writes
so a failure anywhere leaves a *readable* location rather than a row pointing at a file that isn't
there.

**`utils/inventoryCountAccess.ts`** — `loadCountCandidates` (company-wide) and
`loadLocationCountCandidates` (one place, where nothing is excluded because there's no split-bin
ambiguity); `refreshSystemQuantities` and `refreshLocationQuantities`, which must not be confused —
the first reads `parts.quantity`, the roll-up across every bin, and using it for a shelf count would
flag a variance on every row; `commitCount`, which routes each line to the write its target demands
and collects per-line failures rather than aborting.

**`components/scanner/LocationScanner.tsx`** — `getUserMedia` + `zxing-wasm`, reading **our location
labels only** (parts have no barcode). The `.wasm` is served from our own origin via
`scripts/copy-scanner-wasm.mjs`, not the library's CDN, because the surface that needs it is a phone
on shop-floor wifi. Foreign codes are refused rather than guessed at.

**`utils/locationOccupancy.ts`** (pure) — `rollUpOccupancy` / `occupancyFor`. The
`inventory_location_occupancy` view reports what sits *directly* at each location; this rolls it
up the tree so a cabinet whose shelves are full is never reported empty. `occupancyFor`
zero-defaults, so render code never branches on `undefined` — an unknown location and an empty one
are the same thing to a board, and making callers remember that is how a `?.hasStock` slips
through reading as "empty".

**`utils/alertsAccess.ts`** — `getLowStockPartsAlerts`: stocked, non-deleted parts with a
non-null `reorder_point`, filtered in JS to `quantity <= reorder_point`. Severity: `critical` at
0, `high` at ≤50% of the reorder point, else `medium`. Feeds the header `AlertBadge`.

### Feature flag

**`inventory_locations`** — [`lib/featureFlags.ts`](../../lib/featureFlags.ts), opt-in,
**default off for every tenant**. Stored at `companies.settings → features →
inventory_locations`; toggled per company from `/admin/companies`.

Gates four sites: the inventory-page Locations button · the `/inventory/locations` route
(redirects when off) · the operator bottom-nav Inventory tab · the SQL auto-enrolment trigger.

Unaffected when off: the inventory list, the part Inventory tab, aggregate add/remove/adjust,
unit conversions, transaction history, stock status, and reorder alerts.

> **Two caveats.** The operator bin-view *route* has no flag check — only the nav tab is hidden
> — so a stale printed QR still resolves. And `KNOWN_FEATURES` contains exactly three keys:
> `inventory_locations`, `ai_insights`, `data_import`. **There is no `inventory_transactions`
> flag**, despite issue #550 and earlier doc revisions referring to one.

### Archive (soft delete)

Stocked parts are **archived, never hard-deleted**. `deletePart` / `bulkDeleteParts` call the
`archive_parts` RPC, which stamps `deleted_at` in one transaction. It never blocks on references.

- The `parts` row is **kept**, just hidden — every list, search, picker and count filters
  `deleted_at IS NULL`, while by-id reads and retained FKs still resolve it.
- `parts_unit_conversions` and `part_location_stock` are **kept** — nothing cascades, because
  the row survives. They return if the part is revived.
- `inventory_transactions` are unaffected: they retain their `item_name` / `location_name`
  snapshots, and the `part_id` FK still resolves the archived part (its `ON DELETE SET NULL`
  only fires on a true `DELETE`, which the UI no longer issues).
- Re-creating or re-importing the same `part_name` **revives** the archived row rather than
  duplicating it.

Locations are different: `delete_location` only removes an **empty** subtree, and
`part_location_stock` holds `ON DELETE RESTRICT` on both FKs. There is no "delete and relocate
stock" action.

See [`docs/architecture.md`](../architecture.md) §16 for the authoritative deletion policy.

### Dead or unreachable code

Useful as evidence of where the model drifted:

| Item | Status |
|---|---|
| `removePartStockGraceful` | Zero call sites. The graceful path lives in the RPC now. |
| ~~`getLocationTree`~~ | ⛔ **Deleted 2026-07-29.** Zero references, not even a test. |
| ~~`buildLocationUrl`~~ | ⛔ **Deleted 2026-07-29.** Duplicated `locationLabelPdf.buildLocationScanUrl`, which is what actually encodes the printed QR. |
| ~~`bulkGenerateChildren` / `BulkGenerateModal` / `BulkGenerateSpec.startAt`~~ | ⛔ **Deleted 2026-07-29.** Subdivide is a strict superset with a live preview, and the generator had **zero tests** — so deleting was safer than porting. |
| ~~`PartLocationBalance`~~ | ⛔ **Deleted 2026-07-29.** Unused type; `PartLocationBalanceWithLocation` is the live one. |
| ~~`VisualLocationBuilder` `parentId` / `parentCode` props~~ | ✅ **Reachable since 2026-07-29** — this is what Subdivide passes. |
| `moveLocation` | Access layer + tests only. **No re-parent UI exists**, and drag-to-reparent was considered and cut — see [§5.5](#55-locations-keep-them-visual-change-when-they-appear). |
| `enableLocationTracking` / `disableLocationTracking` | Superseded by the auto-track trigger. No UI. |
| `enable_location_tracking_for_company`, `inv_location_path_label` | RPCs with no caller. |
| `job_materials` | Written at job creation, read by nothing. **Scheduled for drop** — [§5.9](#59-job_materials--resolved-drop-it-consumption-backs-onto-the-ledger). |

Path-walking (`parent_id` → ancestors, with a cycle guard) is reimplemented **five times** in
TypeScript, plus once in unused SQL. Phase 2 added the fifth (`LocationsManager`'s `nodePath`,
which returns nodes where the neighbouring `computePath` returns names) — worth extracting, and
noted here rather than quietly left at "four".

---

## 4. Target journeys

Numbered so issues and later docs can cite them. **Bold** = Phase 1.

### **J1 — Seed the item master and opening balances**

**Actor:** owner, at onboarding. **Trigger:** migrating off a legacy ERP or a spreadsheet.

Import the things you stock, with their current on-hand quantity, unit, and reorder point.

**Was:** the [guided import flow](data-import.md) (Upload → Map → Review & Fix → Import)
handled name / description / unit / vendor / BOM, but **stock quantity was not an importable
field** — so a shop migrating in had to hand-key every opening balance or start at zero,
contradicting PRD **FR-16** (*"System supports CSV upload for inventory items"*).

> **Built 2026-07-28.** `quantity` and `reorder_point` are mappable in both import flows, and
> an imported balance now writes an `adjustment` ledger row so it has provenance from day one
> — shaped exactly like `adjustPartStock`'s (`abs(delta)` in the primary unit, direction in the
> notes, since `CHECK (quantity >= 0)` makes a signed delta unstorable). No row when nothing
> moved.
>
> Two things surfaced underneath and were fixed with it:
>
> - **The importer wrote `parts.quantity` unconditionally**, including an explicit `0` when the
>   column was unmapped — zeroing stock on any re-import that didn't map it. For a
>   location-tracked part it also tripped `enforce_tracked_part_quantity`, and since upserts
>   batch 500 at a time, **one such row failed all 500** with an opaque `500`.
> - **`PART_FIELDS` had drifted from `PART_SCHEMA`** — it listed a `category` field that exists
>   nowhere, and omitted `primary_unit`, which the backend marks required. The mapping UI
>   recomputes the required set from that list on the first edit, so `primary_unit` silently
>   dropped out mid-flow.
>
> A quantity for a **location-tracked** part is deliberately not written (its balance is a
> rollup of `part_location_stock`) — and the skip is **reported** in the import result rather
> than the balance quietly not appearing. Set those with a count, or at a location.

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
> and the system has to expect drift from day one. That is what [J9](#j9--count-it) is for,
> and it is why counting is not optional. A lighter-weight periodic **reconciliation** pass —
> refresh these numbers without running a full physical count — is a reasonable later addition
> once we see how the drift actually behaves; it is deliberately **not** specced here.

### J2 — Say where something lives

**Actor:** anyone, incidentally. **Trigger:** recording stock, or tidying.

You are adding or moving material and you say where it is. The place is created **at that
moment** if it doesn't exist yet.

**Today: ✅ CLOSED (Phase 2, 2026-07-30).** Everything this journey asked for exists:

- The **board is permanent** — real places, rolled-up fill state, one tap into a detail sheet, an
  "Add storage" tile always in the grid, photos of the actual furniture, and the wizard demoted to
  an optional *"Subdivide this unit"*.
- **A place is created at the moment you need it**, from the "where is it?" field itself —
  `LocationPicker`'s *"Create «name»"*, shared by the part page, the operator bin view and put-away.
  Held back until the sibling-name unique index existed, because a bare freeSolo create field is
  exactly what produced `ST0CK` beside `STOCK`.
- **Batch put-away** — the place-scoped worksheet, which at `Unassigned` is how a shop empties the
  pile `trg_auto_track_stocked_part` created. See [J9](#j9--count-it): it turned out to be the same
  surface as counting, not a separate one.
- **Scanning a label** now says where something lives without leaving the app.

Sibling names can no longer collide, so the decay this journey's evidence was built on
(`STOCK`/`ST0CK`) is structurally prevented rather than discouraged.

See [§5.5](#55-locations-keep-them-visual-change-when-they-appear).

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
**Deferred to Phase 3** — see the note below.

> **Built 2026-07-28.** `JobPartMaterialsCard` (was a read-only BOM list with no stock in it)
> now shows **Needs · On hand · Issued · Short by** per material, and
> Everything is derived on read — no new table, no migration.
>
> **The shop-wide roll-up was built and then deferred to Phase 3 (#571).** It worked — one row
> per part, on-hand counted once across every open job, verified live on the seed. It came out
> because **it had no next step.** J4's own line says *"from the shortage you can act — add to
> the buy list (J5) or substitute"*, and J5 is Phase 3: the page could tell you that you were
> short and then offer nothing to do about it. A toolbar button whose default window usually
> reported "nothing is short" was earning space on a promise it couldn't keep.
>
> The per-job card is the half that answers J4's actual question — *can I say yes to this rush
> job right now?* — and it needs no purchasing to be useful.
>
> Restoring it is cheap: the page, the batched aggregate (`getShopMaterialShortages`) and the
> roll-up (`rollUpShortages`, with the test pinning on-hand-counted-once) are all in git at
> **`87df208`**. Bring them back with J5, where "short" leads to a buy list.
>
> ### ⚠️ That removal left a live 404 in production for ~2 months
>
> **Found 2026-07-30, fixed the same day.** The page went away; **its entry point did not.**
> `JobPartMaterialsCard` kept rendering a clickable *"N short"* warning chip pointing at
> `/dashboard/{companyId}/inventory/shortages`, and `Header.tsx` kept a title mapping for the
> route. `find app -path '*shortages*'` returned nothing. Any user clicking *"3 short"* got a
> 404 — and **its test asserted that href**, so the suite was actively pinning the broken link
> in place.
>
> Two lessons worth keeping, because neither is caught by tsc, lint or CI:
>
> 1. **Deferring a feature means removing its entry points too.** A link to a deleted route is
>    invisible to every automated check we run — it's a valid string.
> 2. **A test asserting a URL proves the string, not the route.** It passed for two months
>    while the destination didn't exist.
>
> The fix needed no new page: the shop-wide shortage lens is **the Parts stock filter**, so the
> chip now points at `/parts?status=low`. §5.12's merge supplied the surface this journey had
> been missing — the columns were on `/inventory` all along, one page away from the link that
> wanted them.
>
> **Three limitations, all stated on screen rather than left to be found in a wrong number:**
>
> 1. **Top-level materials only.** `parts_bom` is recursive but this compares one level, so a
>    pump job reads *"needs 1 pump core"* and the aluminium inside it is invisible. Correct for
>    [J7](#j7--issue-material-to-a-job) — the operator really does pull the sub-assembly off the
>    shelf — and an incomplete answer to J4's own question. **Recursive explode is the immediate
>    follow-up.**
> 2. **No "on order" column.** Purchase orders don't exist until Phase 3 (#571). A permanently
>    empty column trains people to ignore the row, so it is omitted rather than stubbed.
> 3. **A job card compares one job to the whole shop's stock.** Two jobs each needing 10 against
>    15 both read "not short" individually — nothing surfaces that conflict until the shop-wide
>    roll-up returns in Phase 3. The card says on screen that other open jobs may want the same
>    material, so its number never reads as the whole truth.
>
> **Units that can't be converted are refused, not guessed.** `convertToBaseUnit` returns the
> *unconverted* number with a `console.warn` when there is no route between two units — on this
> screen that renders "you have plenty" for 4 ft against 120 in. The read path calls
> `getConversionFactor` instead, which returns `undefined`, and the row shows a blank short-by
> with a "Can't compare units" chip. **Blank, never zero** — a zero reads as "you're fine",
> which is the one answer we must not give when we cannot compare.

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

> **Their legacy data proves the demand — for the *link*.** 97 of the 121 "locations" in their
> old ERP were job, work-order or part numbers
> ([§5.5](#55-locations-keep-them-visual-change-when-they-appear)). Users typed job numbers into
> a location field for years because there was no job↔material link. **This journey is not a
> hypothesis — it is a workaround they already built by hand, in the wrong field, at scale.**
> It is the strongest-evidenced item in the spec.
>
> ⚠️ **Read that evidence for exactly what it says.** It proves the *link* is wanted. It does
> **not** say where the operator should start. See the reversal below.

**Consumption is recorded at the bin, tagged to the job.** The operator scans a location, takes
what they need, and picks the job — the existing bin path, with the job tag it has always had
([`OperatorLocationActionModal`](../../components/operator/OperatorLocationActionModal.tsx)).
Always graceful: over-consumption clamps to zero, flags `has_discrepancy`, stamps the operator.
[J4](#j4--job-kickoff-material-check) then reads those rows back as "issued" per job.

> ### The job-first reversal — built 2026-07-28, removed the same day
>
> An earlier draft of this section said, emphatically, that **"the entry point must be the job,
> not the bin"**: operator on the traveler → sees what the job needs → taps → confirms taking
> it. That was built — a Material section on the traveler with a take action — reviewed on the
> running app, and **removed**. Recorded here because the reasoning is worth keeping and the
> question will come back.
>
> **1. The evidence was over-read.** 97-of-121 proves users want material tied to a job. It says
> nothing about which screen you start from — a job tag at the bin satisfies it exactly as well,
> and that already existed. The draft treated "the link is wanted" and "the job is the entry
> point" as the same claim. They are not.
>
> **2. It contradicted [§5.2](#52-is-a-job-a-place--resolved-no), two sections earlier.**
> Job-first entry is a *consequence* of job-as-container: if a job is a thing you allocate
> material into, of course the UI starts there — that's where the container is. §5.2 rejected
> job-as-container for us, on the finding that Contour's operator grabs material when they
> start and nothing is staged against a job beforehand. **The draft rejected the model and kept
> its UI shape.**
>
> **3. On Sortly specifically**, since [§5.1](#51-material-moves-through-jobs-by-default) cites
> their [Jobs feature](https://www.sortly.com/blog/new-feature-alert-jobs/) as independent
> validation — that citation is still good, and it validates the **motivation**, not the
> mechanism. Their stated before-state is ours (*"technicians wrote usage on paper or forgot to
> document it"*) and their payoff is J4 + J7 (*"tracking exactly what materials were used"*,
> *"preventing double-purchasing"*). But Sortly's Jobs is a **container**: create the job,
> allocate items to it, close it out and lock the history. We had already declined their
> close-out step for that reason. Taking their entry point while refusing their model was
> half-adopting a design — the half that carries the cost, without the half that makes it
> coherent.
>
> **4. Two write paths for one fact.** Bin-first already recorded job-tagged consumption. Adding
> a second entry point meant two ways to state the same thing, which
> [§5.8](#58-the-ledger-is-append-only-and-non-authoritative) exists to warn about.
>
> **5. It was built on an unadopted surface.** Operators are not yet marking operations complete
> in practice. Stacking material handling onto a screen whose primary job hasn't landed is
> speculative — the traveler's own steps are what needs to work first.
>
> **What job-first would genuinely have added, and what we accept losing:** the job link becomes
> automatic rather than remembered, and an optional field is a field that gets forgotten. That
> is real, and it is the thing to watch.
>
> **REOPEN IF** the job tag turns out to be routinely skipped at the bin — that is the failure
> this design is exposed to, and the one measurable signal that would justify revisiting. Check
> it by counting depletions with a null `job_id` once the shop is using it. Reopen also if a
> shop starts staging material against jobs, which would reopen §5.2 and make the container
> model — and its entry point — correct together rather than piecemeal.

**Consequence for issue #59.** The March ask was a job selector in the owner's
`PartTransactionModal`, and that regression was real — **restored 2026-07-28**, on both stock
engines, with the test that should have existed in March.

#### This journey *is* consumption tracking

An earlier draft had a separate **J9 — "confirm consumption at the operation"**, carrying
issue **#550**. It has been **folded in here**, because once the operator records taking the
material, that record *is* the consumption. A second confirmation step at operation completion
would re-state a fact already captured, and it would add friction to an operator UX that is
deliberately complete-only, one tap
([`operator-paperless-flow.md`](../operator-paperless-flow.md) §5.2).

The mechanics that were specced under J9 carried over unchanged, and **shipped 2026-07-28**:

- **No new table.** A consumption event is an `inventory_transactions` depletion row tagged
  with `job_id` — every field already existed and was indexed. Expected comes from the live BOM
  (the same computation [J4](#j4--job-kickoff-material-check) needs), actual is the sum of
  those rows, variance is computed on read. `job_materials` was not revived; see
  [§5.9](#59-job_materials--resolved-drop-it-consumption-backs-onto-the-ledger).
- **Graceful over-depletion** — clamp to zero, flag `has_discrepancy`, stamp the operator.
  This *is* the bin path's existing behaviour, which is the point: consumption reuses a
  mechanism already in production rather than adding a parallel one.
- **Issue #550 closed by being folded in, not by being built as written.** Worth stating
  plainly, because the issue and the delivery do not match: #550 asked for a confirm-consumption
  step at operation completion, gated behind an `inventory_transactions` feature flag. That flag
  never existed, and the premise named the wrong actor. What shipped is the take-event on the
  traveler. Anyone reading #550 as a spec would be reading a superseded one.

> **Not delivered, and deliberately:** *"issued"* is job-level, not job-part-level, because
> `inventory_transactions` has no `job_part_id`. A job with two parts drawing the same material
> shows the same figure on both. Labelled "issued to this job" for exactly that reason. The fix
> is one nullable column and an index, and it is cheap to add later — it was left out to keep
> Phase 1 migration-free.

**Reopen a distinct confirmation step only if** a real need appears for variance capture that
the take-event can't express — for example a material consumed by one operator and reconciled
by another. Nothing observed at Contour suggests that.

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

### **J9 — Count it**

**Actor:** whoever is assigned. **Trigger:** a schedule, or distrust of a number.

A **count sheet**: here is what we think is here, walk it, enter what you find, review the
variance, commit. Committing writes `adjustment` rows with a reason.

> ### Place-scoped as of 2026-07-30 — and it absorbed put-away
>
> §5.11 asked for the count to be *"recurring, assignable and **place-scoped**"*. The 2026-07-28
> build was none of the third: it was part-first and company-wide. But you walk a shop **bin by
> bin**, not part by part — so `?location=<id>` scopes the same worksheet to one place, reached
> from a board tile, the detail sheet, or a scanned label.
>
> **Put-away turned out to be the same surface, not a neighbouring one.** Standing at a bin you do
> two things: count what's there, and notice what doesn't belong. So beside *"Count N parts"* there
> is a destination picker and *"Put N away"* — and at `Unassigned` that makes this screen how a shop
> empties the pile `trg_auto_track_stocked_part` created, which is [§5.5 decision
> 8](#55-locations-keep-them-visual-change-when-they-appear) and the thing gating the whole feature
> for Contour. A separate put-away page was planned and would have been a second surface doing the
> same job.
>
> Three consequences, all of them from standing at one place instead of reading a catalogue:
>
> - **Nothing is excluded here.** Company-wide, a part split across bins is *uncountable*: count 38
>   against 10+20+10 and no bin defensibly absorbs the −2, so `resolveCountTarget` drops it. At one
>   bin there is no ambiguity — *"Shelf A holds 830"* adjusts Shelf A and says nothing about Shelf B.
>   **The parts the company-wide sheet has to name and skip are countable here**, which is a strict
>   gain nobody planned for.
>
>   > **And now reachable — 2026-07-30.** The gain above was real and *unreachable*: the
>   > company-wide sheet named the held-back parts as **inert chips** and told you to "count these
>   > at their locations", without saying which or offering a way to get there. The holding places
>   > were computed in `resolveCountTarget` and then thrown away, collapsed into a reason string.
>   >
>   > The `excluded` branch now carries them, and each renders as a link into that place's
>   > worksheet. **The capability was never missing; the route was.** Worth recording as a
>   > pattern: a correctly-scoped limitation still reads as a dead end unless the UI says where
>   > to go instead. (The same pass also fixed a silent truncation — it rendered the first 8
>   > held-back parts and dropped the rest without saying so.)
> - **Search runs server-side.** `Unassigned` holds every part a real shop owns; you cannot filter
>   9,428 rows in a browser, and `getLocationContents`' 200-row cap has no search or offset. Hence
>   `getLocationContentsPage`.
> - **The pre-save re-read had to change.** `refreshSystemQuantities` reads `parts.quantity`, the
>   roll-up across every bin — using it for a shelf count would compare against the whole shop's
>   total and flag a variance on every line. `refreshLocationQuantities` reads the bin.
>
> **The two write paths stay deliberately different**, and that is the point rather than an
> inconsistency: counting commits line-by-line and reports per-line failures, because line 50 failing
> must not invalidate lines 1–49. A move is one atomic RPC (`bulk_put_away`), because a half-moved
> pile is worse than no move — you cannot tell what you already did.
>
> **Terminology: still "Count".** The industry term for counting a subset frequently is **"cycle
> count"** ([Unleashed](https://www.unleashedsoftware.com/inventory-management-guide/cycle-count-inventory/)),
> and *"audit"* is the broader, comprehensive, accounting-flavoured word
> ([Fishbowl](https://www.fishbowlinventory.com/blog/inventory-audit-a-comprehensive-guide-with-best-practices-and-procedures)).
> A shop owner would recognise "cycle count", but it is two words of jargon where one plain word
> already works — the same reasoning that rejected *Variance* and *stock count* below. Recorded here
> so a reader knows what we built; not in the UI.
>
> Still missing from §5.11's list: **recurring** and **assignable**. Place-scoping was the half that
> changed the shape of the screen; a schedule and an assignee are additive and unstarted.

> **Built 2026-07-28** at `/dashboard/{companyId}/inventory/count` — **two steps.** Choose the
> parts you're counting, then count them on a **count sheet**: proper columns for
> *Part · Recorded · Counted · Change*, tabular figures so digits line up, and the change filled
> in as you type. Save commits — there is no confirm and no review step.
>
> **The headers name the number's source, not the number.** "On hand" and "Counted" were the
> first attempt and they collided: both columns are quantities on hand, and "on hand" reads as
> the one you just physically counted — which is the *next* column. **Recorded** vs **Counted**
> says the only thing that actually distinguishes them, in the two words a person would use.
> Two alternatives were rejected: *System* (accurate, but names the software rather than the
> fact, and reads as product-speak on a shop floor) and *Expected* — what Sortly and most count
> apps use — for priming the counter toward confirming the record, which a non-blind count
> does not need.
>
> **Change, not Variance.** The footer already reads *"2 will change"* and the button *"Save 2
> changes"*; *Variance* was the single place this page used a different — and less spoken —
> word for the same number.
>
> **"Inventory count", never "stock count"** — in the button, the page title, the import
> messages and the ledger note. The nav item is *Inventory*, so *stock* would be a second word
> for the same thing, learned for no gain. The one exception is **"Stocked"**, the per-part
> flag: that is a real distinct concept with its own switch on the part form, not a synonym.
> Ledger rows written before 2026-07-28 keep the older phrasing — each is an accurate record of
> what was said at the time.
>
> The column layout is the one [every stocktake system converges on](https://www.stockount.com/articles/how-to-do-a-cycle-count),
> and the one a shop already knows from a clipboard — chosen over three alternatives (an
> inline `5 → 7` transition, a one-at-a-time card with a number pad, and a tap-to-confirm
> checklist) because it is the only one still scannable at forty rows. Aligned figures do the
> comparison work that prose like *"System says 5 each"* was failing at.
>
> When every part on the sheet shares a unit it is stated **once** in the footer
> (*"3 will change · all in each"*) rather than repeated down every row; a mixed sheet gets a
> per-row unit column instead, because a bare column of figures in different units is a trap.
>
> Deferred, with reasons: the **one-at-a-time card** is right for a phone at the rack, but that
> is the Phase 2 operator surface — building it now means two counting UIs before we know
> anyone counts on a phone. **Tap-to-confirm** ("Still 180" as one tap) could halve a routine
> re-count, but a one-tap confirm is easy to press without looking at the shelf; worth asking a
> shop before committing.
>
> **The shape was arrived at by getting it wrong twice, and both errors are worth recording.**
>
> **First: Scope → Sheet → Review.** J9 said *"walk it, enter what you find, review the
> variance, commit"* — a data flow — and it was built literally, as three pages. Three problems
> on first use: the review page restated deltas the counter would have understood better the
> instant they typed them; the count field didn't read as a field (an outlined input with a
> floating label and no value looks like a static chip); and *"1 item needs adjusting. 0
> matched"* used accounting language nobody in a shop has a model for.
>
> **Then, over-correcting: a single page listing every stocked part.** Removing the review page
> was right. Removing the *scope* step was not — and the reasoning that led there is the
> instructive part. The scope step looked like structure-before-value, the same error
> [§5.5](#55-locations-keep-them-visual-change-when-they-appear) diagnoses in the location
> builder. But that critique was about **ordering**, and it took the **bounding** benefit down
> with it: choosing says *"I'm counting these five things and then I'm done."* A wall of empty
> inputs, one per stocked part, reads as a form you must complete and hides that counting a
> single part is normal.
>
> So: the scope step earns its place, the review step didn't.
>
> **Two lessons.** Design a journey, not a data flow — a pipeline described in a spec gets built
> as a pipeline of screens unless someone says otherwise. And when removing something, separate
> what it did *badly* from what it did *quietly well*.
>
> Two deviations from what this section originally specified, both deliberate:
>
> **1. Item-scoped, not "scoped to a place."** `inventory_locations` is opt-in and default-off,
> so place-scoping would have made Phase 1 depend on Phase 2. You pick parts by search and
> selection instead. *Reopen when Phase 2 lands:* location scoping becomes the natural entry
> point, and the multi-bin exclusion below disappears with it.
>
> **2. No count-session table.** The sheet is client state autosaved to localStorage, matching
> every other wizard in the app and what dedicated stock-count apps do. **Phase 1 therefore
> adds no tables at all.** Given up: assignment to a person, and cross-device resume. Sortly
> built the server-side lifecycle for exactly those, citing *"lack of accountability"* — a
> multi-counter problem this shop doesn't have yet. Revisit if two people ever count at once.
>
> **An item-level count is ambiguous for a part split across bins**, so the write target is
> resolved per part (`resolveCountTarget` in [`lib/inventoryCountPlan.ts`](../../lib/inventoryCountPlan.ts)):
>
> | Part | Commits to |
> |---|---|
> | Not location-tracked | `parts.quantity` via `adjustPartStock` |
> | Tracked, no stock anywhere | **Unassigned** — the opening-count case, since `trg_auto_track_stocked_part` seeds every stocked part there at 0 |
> | Tracked, stock in exactly one location | that location |
> | Tracked, stock in two or more | **excluded and named** on the scope step — "count this at its locations" |
>
> "Holding stock" means `quantity > 0`; the seeded zero-row must not make a part look placed.
>
> **Save commits — there is no confirm step, and no review page.** Both were built and both
> were removed for the same reason: they restated the numbers the counter had just typed and
> could still see. What the counter needs is the variance *as they type it*, on the row, which
> is where it now appears.
>
> **Variance colour is direction, and only direction:** green up, red down, neutral for no
> change. Nothing else is encoded in that column — the number and its sign are the whole
> message.
>
> **Nothing judges the size of a change.** A 50% proportional threshold once drove a per-row
> caution icon and a "some of these are big" callout, on the strength of the finding that
> [~30% of large variances are count errors](https://www.getonecart.com/cycle-counting-inventory/).
> It failed in practice: against the quantities a small shop holds — 7 on hand, 3 found — a
> proportional change is large almost every time, so it fired on nearly every line and stopped
> carrying information. A dialog that always says the same thing trains people to dismiss it,
> which is worse than not asking.
>
> The finding is probably still sound; **expressing it as a percentage of quantity is what
> failed.** A threshold on the *value* moved (`cost_per_unit × delta`) would scale correctly
> across a $2 bearing and a $2,000 casting. The right figure is a question for a real shop
> rather than a guess from here — **open for discovery**.
>
> Saving safely does not depend on any of that: a wrong count is fixed by counting again, and
> every line writes an `adjustment` row naming both numbers.
>
> Quantities **are** still re-read immediately before the write. Not as a gate — the commit is
> correct either way, since adjust sets absolutes — but because the ledger note records *"system
> said X"*, and a stale X would quietly put a wrong figure in the audit trail. Anything that
> moved mid-count is reported in the success message, after the fact.

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

### J10 — Don't run out

**Actor:** owner. **Trigger:** stock crosses a threshold.

Below the reorder point, the item lands on the buy list. On-order quantity is visible so
nobody double-orders.

**Today: partial.** `parts.reorder_point` exists, `deriveStockStatus` renders
In stock / Low / Out of stock, and `getLowStockPartsAlerts` feeds the header `AlertBadge`.
Missing: email notification, a real buy list, and any concept of on-order.

**Doc conflict to settle:** PRD **FR-2 is a `Must`** and specifies dashboard alerts *plus*
email. this document calls FR-2 a `Should`, reports it partially delivered,
and plans to **hide it** behind the non-existent `inventory_transactions` flag. Meanwhile
[`docs/modules/ai-insights.md`](ai-insights.md) records the low-inventory alert
badge as **built and checked off**. Three docs, three positions, one feature.

### J11 — Find it

**Actor:** anyone. **Today: built, and it works.**

Scan a location QR → the phone opens the bin view → contents, drill-down, and add / remove /
set per part. Searching an item shows its per-location balances with full paths.

This is the genuinely good part of the June build. Keep it.

---

## Considered and cut

Two journeys were specced and then removed once the shop was understood. They are kept here,
**without numbers**, so the decisions are on the record and don't get re-proposed — but they
are deliberately outside the J1–J11 sequence, because they are not work.

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

That question is in [§9](#9-what-we-know-and-what-we-still-dont). It does not block Phase 1:
J9 and J7 are unaffected either way, and J4 can ship with the exclusion added later if it
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

The two-engine split ([§3](#the-two-stock-engines)) is the deepest structural
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

> **⚠️ Re-date this after J7 (added 2026-07-28).** This sat in Phase 4's "quiet phase" when the
> non-atomic path was only exercised by an owner doing occasional bookkeeping. **J7 made it the
> highest-frequency write in the app, performed by operators who may be on the floor at the
> same time.** The exposure is not only the known crash-between-round-trips case — it is a
> **lost update**: two operators each read 100, each take 5, stock lands at 95 instead of 90,
> silently, with two correct-looking ledger rows.
>
> Contour is not exposed (`inventory_locations` is on, so every part routes through the atomic
> `FOR UPDATE` RPC). A flag-**off** shop with two operators is. Note the fix does **not** require
> the full collapse above: a single `deplete_part_stock` SECURITY DEFINER RPC mirroring
> `deplete_stock_at_location` would close it for one migration. Re-evaluate the phase once J7
> has real usage, rather than leaving it parked here by default.

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

1. **The board becomes permanent.** ✅ **BUILT (Phase 2).** Today `LocationBoardPreview` draws
   something that does not exist yet and is never seen again; what you live with afterwards is
   `LocationTreeView.tsx` (since **deleted** — see the reshape note at the end of this section),
   an indented text list. Invert it — the board is the storage home screen, showing real places
   with real contents and fill state.

   Shipped as [`LocationBoard`](../../components/inventory/locations/board/LocationBoard.tsx) +
   [`LocationDetailSheet`](../../components/inventory/locations/board/LocationDetailSheet.tsx),
   drawn with the same chrome as the preview so this decision's promise — *what you preview is
   what you live with* — is structurally enforced rather than maintained by hand. The tree list
   survives, demoted to a Board|List toggle, and finally carries a child count and fill state.

   Three things this decision did **not** anticipate, all found while building it:

   - **It never mentioned `Unassigned`** — see decision 8 below. The single biggest omission.
   - **A compartment cannot be a tap target.** Cells are ~6px tall; at the 48px touch floor a
     5-row × 2-side cabinet becomes a ~500px tile and the drawing, which is the entire point, is
     destroyed. So the whole unit is one tap target and the sheet owns every action. Two taps to
     reach Shelf A, which also mirrors the operator bin view's drill-down.
   - **Fill state must roll up.** The occupancy view reports what sits *directly* at a location,
     so a cabinet whose shelves are full has no row at all. Reporting it empty would be worse
     than showing no fill state: it would send someone to fill an occupied shelf.
2. **Setup goes incremental.** ✅ **BUILT (2026-07-30), and the ordering was correct.** A place
   created inline from a "where is it?" field is a freeSolo create field — exactly the mechanism
   that produced `ST0CK`/`STOCK` in finding 2 — so it landed *after* dedupe (decision 7), not
   before. `LocationPicker`'s *"Create «name»"* is shared by the part page, the operator bin view
   and put-away; the offer is **suppressed whenever a location already answers to that name**,
   matched the same case- and whitespace-insensitive way the unique index compares, so it can never
   offer something the DB would refuse. Creation makes a top-level location with no kind and no
   code: the name is the identity, and a code is display-only since QR payloads carry the UUID.
   Adding one piece of furniture to the board was already built — an "Add storage" tile lives
   permanently in the grid.
3. **The wizard survives, demoted.** ✅ **BUILT (Phase 2).** Count + name-pattern is genuinely
   right for *"this cabinet has 5 rows"* — keep `LevelConfigStep` as an optional **"subdivide
   this unit"** action on a unit already on the board. That also makes `VisualLocationBuilder`'s
   dormant `parentId` path reachable.

   Two traps the plumbing hid, both now covered by tests:
   - **Every `STORAGE_TYPES` entry's level 0 *is* the container**, so reusing that palette while
     subdividing Cabinet 3 creates `Cabinet 3 › Cabinet 1 › Row 1 › Left`. Fixed with a separate
     `SUBDIVISION_TYPES` whose levels start *below* the container. `slice(1)` is not a fix — a
     sliced `Bins` or `Single shelf` is an empty spec.
   - **Subdividing twice must continue the numbering** (Row 4–6), not regenerate Row 1–3.
     `materializeLocationSpec` inserts sequentially and is not transactional, so with decision 7's
     index in place a collision mid-run would leave a partial tree behind an opaque `23505`.
4. **Fix the palette.** ✅ **BUILT (Phase 2), with the bar rack deliberately left out.**
   [`storageTypes.tsx`](../../components/inventory/locations/builder/storageTypes.tsx) has seven
   types. Real shop vocabulary ([McMaster](https://www.mcmaster.com/products/storage-racks/):
   shelving units, storage racks, mobile racks, bin racks, storage cabinets, drawer units,
   workbenches, bins, chests, pegboard) suggests more. Added the honest single-level ones —
   *floor space*, *outside/yard*, *bench* — which matters because 118 of 121 legacy locations were
   flat and a palette of only structures forces "on the floor by the saw" to be modelled as a
   cabinet.

   > **Amended.** This decision originally asserted a **bar rack / vertical material rack** is
   > "the defining storage object in a machine shop". §9 of this same document records that
   > Contour's 22 real places contain **no rack of any kind** and marks the claim *weakly
   > refuted* — so the document contradicted itself. The honest status is an **open question**,
   > not an assertion, and the card stays out until a pilot shop asks for it. A code comment in
   > `storageTypes.tsx` records this, because without it someone re-adds the card in three months
   > on the same intuition.
5. **Fill state.** ✅ **BUILT (Phase 2).** A visibly-empty bin is the
   [two-bin kanban](https://businessmap.io/blog/two-bin-kanban-system) signal expressed in
   software. Deliberately **empty-vs-has-stock only, never a percentage**: we don't know a
   shelf's capacity, and a confident "72% full" would be exactly the invented number that costs
   the feature its credibility. Rolled up (see decision 1). Zero-quantity balance rows persist
   after depletion, and the view's `quantity > 0` matches `getLocationContents` exactly — so a
   just-depleted shelf flipping to empty is the *desired* signal, not drift.

   > **Amended: split from photos.** This decision originally bundled fill state with *"a photo
   > of the actual rack beats any icon"*. The two have wildly different cost — fill state is one
   > view plus a pure function; photos are a bucket, an upload UI, thumbnails and mobile capture.
   > Bundled, fill state would have been delayed behind media work for no reason.
   >
   > **Photos then shipped separately, 2026-07-30.** A `photo_path` column on `inventory_locations`
   > (not a table: one photo is what this decision asks for, and a column inherits the table's
   > existing RLS *and* billing write-gate), reusing `compressPhoto` and the private `attachments`
   > bucket. It renders **above** the compartments rather than replacing them — the photo carries
   > identity, the compartments carry fill state. Board only, never the list view, which has to stay
   > cheap. Every tile's signed URL comes from **one** batched `createSignedUrls`.
   >
   > Splitting them was worth it for a reason that only appeared during the build: **reading any
   > attachment was broken on every fresh local stack and every preview branch.** `storage.objects`
   > had INSERT and DELETE policies under migration control and **no SELECT policy at all** — it
   > existed only in the prod snapshot. So part attachments and operator note photos were equally
   > unreadable outside production, and nobody had noticed. Same failure mode
   > `create_attachments_storage_bucket` fixed for the bucket; it fixed the bucket and missed the
   > policy. Now under migration control.
6. **Flat-vs-tree default — CLOSED, answered by decision 3.**
   [MRPeasy](https://www.mrpeasy.com/resources/user-manual/stock/settings/locations/) has no
   nesting at all and tells users to name locations `"Room 1, A1"`;
   [Katana](https://support.katanamrp.com/en/articles/8340252-basics-of-storage-bins) makes bins
   opt-in inside a location. `parent_id` is nullable, so flat is a default and a UI decision —
   **not a migration**.

   > **Amended: not "revisit" — resolved.** Subdivide-on-demand *is* the opt-in-bins model this
   > decision was pointing at. Adding storage now creates a flat unit; nesting appears only when
   > someone explicitly subdivides. Nothing further to decide.
7. **Names must dedupe, and codes must not.** ✅ **BUILT (Phase 2).**

   > **Amended: finding 2 conflated two different problems.** Its evidence — `STOCK`/`ST0CK`,
   > `JEFF'S DESK`/`JEFFS DESK` — is entirely about **names**. Separating names from codes
   > changes the answer, in opposite directions:
   >
   > - **Names:** a unique index on
   >   `(company_id, coalesce(parent_id, sentinel), lower(btrim(name)))`, with a backfill in the
   >   same migration ahead of it. A plain `UNIQUE (company_id, parent_id, name)` would not have
   >   constrained top-level locations at all, since NULLs compare distinct. Paired with a live
   >   *"Cabinet 3 already has a Shelf A"* warning in the form, because nothing exact catches
   >   `ST0CK`.
   > - **Codes: deliberately unconstrained.** A duplicate `code` has **no functional
   >   consequence** — QR payloads carry the location UUID and nothing in the app resolves by
   >   code. An index would buy nothing while risking a mid-flight insert failure inside the
   >   sequential, non-transactional `materializeLocationSpec`, leaving a partial tree — far
   >   worse than a duplicate sticker. What *is* worth fixing is the collision a human confuses:
   >   `['Left','Lower']` both derived `…-L`, and `explicitCodeIn` now yields `L`/`LO`.
8. **"Put these away" — the batched move out of `Unassigned`.** ✅ **BUILT 2026-07-30. The rollout
   gate below is now CLEARED.**

   > **New decision, added in Phase 2.** Decision 1 never mentioned `Unassigned`, which is the
   > largest omission in this section. `trg_auto_track_stocked_part` guarantees a top-level
   > `('Unassigned', kind='system')` row the moment any stocked part exists, so for Contour it
   > holds **every part they own** — one tile with 9,428 parts beside four holding nothing. That
   > board is truthful but not yet useful, and it is **the most likely way the second attempt
   > fails like the first** (§9.3).
   >
   > The board also does what it can without a bulk move: the tile is muted, sorted last, explained
   > as *"your put-away list, not a shelf"*, and carries its rolled-up count — because *"9,428 parts,
   > nowhere in particular"* is precisely the diagnosis that motivates adding a cabinet.
   >
   > ### How the design questions resolved
   >
   > This decision listed three: *does it move all of part X to one bin? bulk-assign a selection? a
   > picker per part?* The answers, in order:
   >
   > - **All of part X, yes** — put-away means *"this lives here now"*, not *"split 40 across two
   >   bins"*. Partial moves already have `transfer_stock`. That single simplification removes the
   >   quantity argument, which removes unit conversion, which removes a per-part read: **one request
   >   for N parts where looping the per-part path costs 2N**.
   > - **Bulk-assign a selection, driven by search.** Not by paging: nobody assigns 9,428 parts, they
   >   assign what they're holding. *"Search o-ring, take all 40, send them to Drawer 2"* finishes
   >   Contour's real backlog in tens of operations, not thousands of decisions.
   > - **No separate picker per part, and no separate page.** The surface is
   >   [J9](#j9--count-it)'s place-scoped worksheet — because standing at a bin, counting what's
   >   there and moving what doesn't belong are the same visit. A dedicated put-away page was planned
   >   and would have been a second screen doing one job.
   >
   > `bulk_put_away` is one atomic RPC, capped at 1000 parts to bound how long it holds
   > `part_location_stock` row locks. Atomicity is the whole point — a half-moved pile is worse than
   > no move, because you can't tell what you already did — so the TS wrapper deliberately **never
   > chunks** the array, and the cap is enforced in the DB where no future caller can loop around it.
   >
   > ### The gate, and its outcome
   >
   > ~~`inventory_locations` stays OFF for Contour until batch put-away exists.~~ **It exists.** The
   > flag remains opt-in and off by default — that's its normal state, not a hold — and the board can
   > now be emptied into, which is what the gate was protecting against. Turning it on for a pilot
   > shop is a rollout decision, no longer a blocked one.
9. **Thing-first sequencing — CORRECTED 2026-07-30. The original claim misread both of its
   own sources.**

   > **What this said, and why it was wrong.** It claimed *"the company whose entire product
   > is visual inventory does not lead with a storage hierarchy"*, citing two Sortly pages.
   > Both were re-read; **neither supports it**, and one points the other way.
   >
   > - The [labeling guide](https://www.sortly.com/blog/how-to-label-inventory/) is about
   >   labeling **items**, not locations. It never mentions shelves, bins, racks or aisles.
   >   Citing its silence on address codes was a **category error** — absence of evidence
   >   read as evidence of absence.
   > - The [stockroom method](https://www.sortly.com/blog/how-to-organize-a-stockroom/)
   >   *prescribes* a storage hierarchy. Step 2 is **"Make the most of your storage space"**;
   >   it orders shelves by frequency and weight (eye level / higher / heavy on the bottom),
   >   recommends **"shelving dividers and drawers"**, says **"labels or other identifiers
   >   can also clarify where inventory is stored"**, and — most relevant to us —
   >   recommends you **"post maps, charts, and other documentation that show team members
   >   exactly how inventory should be stocked."**
   >
   > **What survives:** only the sequencing. An inventory list is step 1, storage is step 2.
   > That is about **onboarding order**, not about whether storage should be visual or nested.
   >
   > **What actually justifies the flat default:** finding 1 — **118 of 121** of Contour's
   > legacy locations were flat, in a system that supported a `/` path separator. That is
   > *their behaviour*, not borrowed authority, and it was always the stronger argument. This
   > decision leaned on Sortly because it read as external validation; it wasn't.
   >
   > **What this changes downstream:** the visual thread gets *promoted*, not demoted. "Post
   > a map that shows exactly how inventory should be stocked" is an endorsement of the board,
   > and of photos as a place's primary identity (decision 5) — flat places each with a
   > photograph *are* that map. It also gives issue **#421** real backing rather than only
   > intuition.
   >
   > Recorded at length because the mistake was invisible: the citation looked authoritative,
   > and a plan was built on it before anyone opened the links.

> ### ⚠️ Reshaped again, 2026-07-30 — the page contradicted §5.11, and we shipped it anyway
>
> Phase 2 delivered the board, and the first reaction on opening it was *"I don't know what
> this locations button is supposed to take me to."* That was correct, and the cause is
> embarrassing in a specific way: **§5.11 is titled "Design for the sustain, not the setup",
> and every control on the toolbar was setup** — Scan · Print all labels · New top-level
> location · Build visually, plus a fifth setup entry as a grid tile. The page violated the
> decision it was built under, and the decisions above describe the build without noticing.
>
> What changed, and what each amends:
>
> - **Three entry points to two flows, one duplicated (amends decisions 2 and 3).**
>   `Build visually` and the in-grid `Add storage` tile called the **identical function**.
>   There is now **one** way to add storage — the tile, opening the simple form: a name, an
>   optional kind, one flat place. The multi-level builder survives *only* as Subdivide on a
>   unit that already exists, which is what decision 3 prescribed in the first place; its
>   top-level path is removed rather than left dormant. The empty state had the same disease
>   in sharper form — `Build visually` and `Add manually` side by side, asking someone who has
>   never seen the feature to choose between two flows before knowing what either produces.
> - **The list view is cut (amends decision 1).** Decision 1 kept the tree "demoted to a
>   Board|List toggle". Wrong call: an indented text tree is the *opposite* of the map decision
>   9's corrected research asks for, Cabinet 1 alone exploded into 15 rows, and at 12–18 places
>   the board is strictly better. A toggle with no good answer is a burden, not an option.
>   `LocationTreeView` is deleted.
> - **Scan is removed from this page.** Scanning a printed label is something you do standing
>   at a shelf — an operator gesture, not an admin one at a desk. It became a tab-bar action in
>   the operator layout, where one scanner now resolves **both** location labels and job
>   travelers (see the unified-scanner decision below).
> - **`Count everything` arrives, and the board becomes the hub.** With `/inventory` folded
>   into Parts there is no sibling page to host the company-wide sheet, and §5.11 wanted the
>   count place-scoped anyway. You reach a place's worksheet by tapping its tile; the
>   company-wide sheet is one button here.
> - **Photos become a place's primary identity (amends decision 5).** A place with no photo now
>   carries a passive glyph on its tile, because a photographed place and an unphotographed one
>   otherwise look identical from the board. Passive, not a button: the tile is one tap target
>   and the sheet owns actions.
>
> **"Locations" was also the wrong word, and not merely a vague one.** Across
> [Sortly](https://www.sortly.com/business-inventory-app/), Katana and
> [MRPeasy](https://www.mrpeasy.com/resources/user-manual/stock/settings/locations/),
> *"locations"* conventionally means **sites / warehouses** — "track inventory across multiple
> locations". Jigged is single-site, so the label imported a meaning we don't have. The sidebar
> item is now **Storage**; see the `/inventory`-folded-into-Parts decision for why that word
> and not "Inventory".

**Under full material control locations get *more* load-bearing, not less** — a remnant is a
physical thing in a place, and *"is there a drop I can use"* is a spatial query.

Revisit issue **#421** (3D diorama preview) against decision 1: a diorama of *real, occupied*
storage is a different and better proposition than a diorama of a preview. Decision 9's
correction strengthens this — *"post maps, charts… that show exactly how inventory should be
stocked"* is the job a diorama would do.

**The spike ran on 2026-07-30; full result on the issue. Three findings that outlive the
decision:**

1. **Real 3D is out on cost alone.** Measured gzipped: `three` alone **123 KB**, with
   `@react-three/fiber` **230 KB**, with `drei` **289 KB** — for a read-only depiction on the least
   frequent screen in the product. An inline-SVG isometric does the same job in **~1.4 KB of
   markup and zero dependencies**.
2. **CSS 3D flattens inside our own chrome, silently.** `overflow: hidden`, `opacity < 1`,
   `filter`, and `backdrop-filter` on a `transform-style: preserve-3d` root all collapse the
   subtree to flat — and `getComputedStyle().transformStyle` **still reports `preserve-3d`** in
   every one of those cases, so the obvious debugging check confirms a lie. `contain: paint` is
   safe, and the same property on an *ancestor* card is safe. `StorageUnitShell` sets
   `overflow: hidden` and our cards use `backdrop-filter`, so a CSS-3D unit dropped into the
   existing tile flattens today. **This matrix is Chromium-only — the WebKit run never completed,
   and operators are on iPhones.**
3. **Depth buys recognition and spends legibility.** In a labelled isometric cabinet the row
   labels collide with each other and with filled compartments, back rows occlude front ones, and
   at board scale the diagonal silhouettes tile into a pattern rather than a set of distinct
   places. The flat board keeps every compartment individually legible and addressable.

**What the drawing is actually for, post-photos.** A photo beats any drawing at recognition, but a
photo cannot show **fill state** and doesn't exist until someone takes one. So the schematic's two
real jobs are the fill-state canvas and the pre-photo placeholder — both of which the current flat
drawing already does. That is the strongest argument for leaving this alone, and it is the falsifier
to answer before building anything: *if the flat schematic already does both jobs, an isometric is
decoration on a setup screen*, which is exactly what §5.11 says not to build.

**Also corrected on the issue:** "no stored geometry" is a product choice (a stored layout is a
second source of truth that drifts from the tree the moment a cabinet moves in real life), not a
technical wall — and depicting a *kind* is a `kind` → shape lookup, **not** geometry, so the small
version of the idea never touches the invariant.

**Drag-to-reparent: considered and cut.** Their data (118/121 flat) says a re-parent gesture
serves a hierarchy they don't have, and the house precedent is explicit — routings reorder with
arrow buttons, no drag-and-drop. If it's ever wanted, the honest shape is a "Move into…"
`Autocomplete` wiring the existing cycle-guarded `moveLocation`. Note that the demand this
*looks* like is demand to move **stock**, not locations — and that UI already exists.

> **One of the original three reasons is withdrawn, 2026-07-31.** This also said *"drag on a
> shop tablet is the most failure-prone interaction available"*. There is no shop tablet:
> storage setup happens at an **office computer with a mouse**, where drag is an entirely
> ordinary interaction (founder observation — see
> [the device model](../../CLAUDE.md#who-uses-what-on-what--the-device-model)).
>
> The cut still stands on the two reasons that survive — the hierarchy isn't there, and the
> house pattern is arrow buttons. But it now stands on two legs, not three, and anyone
> reconsidering it should not be told drag is unreliable here.
>
> **This matters beyond drag.** The same false premise was used against a drag-to-place floor
> plan for issue **#421**; that objection is withdrawn too. What remains against a facility map
> is that a map's value scales with what you *can't* see from where you stand, and this shop has
> 12–18 places that a small team learns in a week.

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

### 5.9 `job_materials` — **RESOLVED: drop it. Consumption backs onto the ledger.**

**Drop `job_materials`.** Its own retirement migration states the purpose it was kept for —
*"a per-job expected-BOM snapshot"* — and that purpose no longer holds on either of the two
grounds a snapshot could stand on:

| Reason to snapshot expected quantities | Still valid? |
|---|---|
| **Deletion resilience** — a referenced part is deleted and the job would lose its material list | **No.** Universal archive means the row survives and by-id reads still resolve it. Nothing is lost. |
| **Drift resilience** — the BOM is *edited* and the job should still show what was planned | **No** — archive doesn't cover this (an edited edge is mutated, not archived), but the product already chose the opposite behaviour: `JobPartMaterialsCard` deliberately reads the **live** BOM so the job reflects current edits. |

So the snapshot is dead for its stated purpose *and* for the deletion case, and nothing reads
it — every code reference is a type definition, a comment, or the RPC that writes it. A
write-only table is worse than no table, because it reads as a source of truth to the next
person who opens the schema.

**Work involved:** stop `create_job_part_operations_from_routing()` writing it, drop the table,
and remove its entry from the billing write-gate (`stripe_write_enforcement`, where it is
parent-resolved via `jobs.job_id`). Job creation is core, so this is not a free deletion.

#### What backs consumption tracking instead

**`inventory_transactions`, unchanged.** A consumption event is a `depletion` row tagged with
`job_id`. Every field J9 needs already exists and is already indexed:

`job_id` · `job_operation_id` · `part_id` · `quantity` · `unit` · `converted_quantity` ·
`operator_id` · `created_at` · `location_id` · `has_discrepancy`

The model becomes three parts, only one of which is stored:

| | Source |
|---|---|
| **Expected** | BOM × job-part quantity, **computed live** — the same computation [J4](#j4--job-kickoff-material-check) already needs |
| **Actual** | `SUM(inventory_transactions.converted_quantity)` where `job_id = X AND part_id = Y AND type = 'depletion'` |
| **Variance** | Computed on read |

This is the ledger doing the job a ledger is for: answering *what happened*. It also handles a
case a snapshot row handles badly — **the same material consumed more than once** (two
operations, or a correction). Multiple rows sum naturally, and the history survives; a single
`actual_quantity` column would be overwritten and the earlier value lost.

**Two consequences to accept explicitly:**

1. **Editing a BOM retroactively changes "expected" on historical jobs**, so variance figures
   shift. This is already true today via the live-BOM read. Acceptable for a shop that isn't
   doing cost-variance analysis; revisit if anyone asks for a frozen planned-vs-actual record,
   at which point the answer is a snapshot **at consumption time**, not at job creation.
2. **"Skipped" is not representable.** The old model had `status: pending | consumed | skipped`;
   with a ledger, no row means *either* skipped or not-yet-done. Given the operator UX is
   deliberately minimal — complete-only, one tap
   ([`operator-paperless-flow.md`](../operator-paperless-flow.md) §5.2) — the recommendation is
   **don't model completeness at all**: the operator records what they took, and silence is not
   an error state. If a real need for explicit skip appears, add it then, and not by reviving a
   per-job material row.

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
- ~~Their workaround is a cheap hedge available to us: **drop `apple-mobile-web-app-capable`**
  so the home-screen icon opens in Safari rather than standalone.~~

  > ### ⚠️ **CORRECTED 2026-07-30 — that hedge does not work any more**
  >
  > Since **iOS 16.4**, Safari honours the **web app manifest's `display` member** for Add to Home
  > Screen, and `apple-mobile-web-app-capable` is the *legacy* mechanism it superseded. So dropping
  > the meta tag no longer keeps an installed app in Safari — if the manifest says `standalone`, it
  > installs standalone regardless.
  >
  > iOS also treats `standalone`, `fullscreen` and `minimal-ui` alike. **`display: 'browser'` is the
  > only value that keeps the icon opening in Safari**, and that is what
  > [`app/manifest.ts`](../../app/manifest.ts) now ships.
  >
  > This was caught by writing the manifest: the first draft omitted the meta tag *and* set
  > `display: 'standalone'`, following this section — which would have installed standalone and
  > walked the new scanner straight into the permission bug this hedge exists to avoid. The two
  > halves cancelled out.

**Which flow needs it:** walking up to one bin is ~2 taps either way. The workflow the current
architecture cannot serve is **continuous scanning** — a count session ([J9](#j9--count-it))
or checking in a pallet ([J6](#j6--receive-it)), where ten scans mean ten camera-app round
trips.

**Decision:** do not commit to native, and do not assume PWA suffices. Time-boxed spike in
Phase 2 — installed PWA + `getUserMedia` + zxing-wasm on the actual handsets the shop carries
— answering one question: *does camera permission persist across navigations in standalone
mode on current iOS?* If yes, PWA covers (b) and only (a) remains native-only. If no, cost
native properly.

~~Jigged has **no PWA manifest, no service worker, no `apple-mobile-web-app` meta and no
viewport export** today.~~ **Built 2026-07-30.**

| | State |
|---|---|
| **PWA basics** | ✅ [`app/manifest.ts`](../../app/manifest.ts) · `viewport` export with `viewportFit: 'cover'` + `themeColor` · 192/512/maskable icons generated from one vector ([`lib/brandMark.tsx`](../../lib/brandMark.tsx)), no binary assets and nothing upscaled from the 96px logo · `env(safe-area-inset-bottom)` on the operator bottom nav, which sat under the iOS home indicator. Also fixed: `apple: '/apple-icon.png'` **404'd** — the generated route has no extension — so the home-screen icon was broken. Still **no service worker**: offline is a separate question and nothing here needs it. |
| **(b) live in-app scanner** | ✅ [`LocationScanner`](../../components/scanner/LocationScanner.tsx) — `getUserMedia` + `zxing-wasm`, wired into the operator inventory home (where the scanner icon was decorative), the put-away destination, and the board. **It reads locations only**: parts have no barcode, so "scan a part" does not exist. Foreign codes are refused rather than guessed at. The `.wasm` is served from our own origin, not the library's CDN — a shop floor's wifi is exactly where a CDN fetch fails. |
| **The spike's actual question** | ❌ **STILL OPEN, and it now has a concrete gate.** `display: 'browser'` is what makes the scanner work today. Flipping it to `'standalone'` is the deliverable: it is only safe once someone confirms, on the shop's own handsets, that camera permission survives navigation. Nothing testable from a desk settles this, and a working scanner is not evidence that it has been settled. |
| **(a) scan → open our app directly** | ❌ Unchanged, and still native-only — Universal Links have no PWA equivalent. Note the in-app scanner sidesteps *most* of the pain (b) caused, so (a) alone is a much weaker case for going native than the two together were. |

### 5.11 Design for the sustain, not the setup

The documented failure mode of every bin system is decay: *"it's tempting to put a new
material somewhere temporary and add the bin code later; later rarely comes"*
([Craftybase](https://craftybase.com/blog/bin-location)). Sortly's stockroom method makes
step 5 *"establish standard operating procedures"* with periodic audits.

Our equivalent is [J9](#j9--count-it). The count session is **not a reporting feature** —
it is the ritual that keeps the other twelve journeys true. Spec it as recurring, assignable
and place-scoped, not a one-off Adjust button.

> **This section was violated by the page built under it, 2026-07-28 → corrected 2026-07-30.**
>
> The Storage board shipped with a toolbar in which **every control was setup**, which is the
> exact failure this section names. Worth stating plainly, because writing the principle down
> did not prevent it: the build followed the *decisions* (§5.5's numbered list) and nobody
> re-read the *principle* they were meant to serve.
>
> The board's chrome is now two controls, and its daily job — tap a place, count what's there,
> move what doesn't belong — is what the tiles are for. The test is simple and worth reusing on
> any surface in this module: **if every control on a page is something you do once, the page
> has no reason to be visited twice.**
>
> Still missing from this section's list: **recurring** and **assignable**. Place-scoping was
> the half that changed the shape of the screen; a schedule and an assignee remain unstarted.

---

### 5.12 Two nouns: Parts is *what we have*, Storage is *where it lives* — 2026-07-30

`/inventory` was deleted. It was **`getStockedParts` — i.e. `parts WHERE is_stocked` — plus
three columns** (quantity, status, unit) and one filter (stock status, computed at render from
`quantity + reorder_point`, never stored). Its toolbar was Import · Delete · Locations · Count,
and Parts already had Import and bulk delete; it even delegated part creation to `/parts/new`.
The two pages referenced each other as complements in their own source comments.

**No unique capability. Two pages for one item master, which is why neither could be
described.** Parts gained On hand + Status and a Stock filter; `/inventory` redirects to it.

#### Why the sidebar says "Storage" and not "Inventory"

In the industry **"inventory" means the items and their quantities, not the places** — Sortly's
own feature is *"Inventory Photos: visually track inventory by adding photos of your **items**"*,
the product category is "inventory management" (stock levels), and "physical inventory" is the
act of counting items. Its stockroom method uses **"storage space"**, **"storage solutions"**,
**"shelving"** for places.

Decisively: **after this merge, Parts *is* the inventory.** A sidebar reading `Parts` (holding
the quantities) beside `Inventory` (holding the shelves) would have the two labels swapped
relative to their meanings. Familiarity argued for keeping the old word, but that only holds
while Parts isn't the inventory — and now it is.

Routes stay under `/inventory/*`. Renaming them is churn for no user-visible gain, and the QR
payloads encode `/operator/...` paths, not these.

#### The flag-off case

`inventory_locations` gates the board, so a shop with the flag off has **no places at all**.
There, the **Storage** nav item is hidden and `Count Inventory` moves to the **Parts** toolbar —
the only place the reshape adds a control rather than removing one.

#### One scanner for every Jigged QR

Both QR kinds are deep links through the operator login passthrough, differing only by query
string: `?location={uuid}` versus `?job={uuid}&part={uuid}`. The in-app scanner read only the
first, so an operator holding a traveler sheet had to leave for the phone's camera — a different
gesture for a near-identical piece of paper. [`lib/jiggedScan.ts`](../../lib/jiggedScan.ts)
resolves either.

> **A trap worth recording.** Older travelers still in circulation encode a **third** param,
> `operation=`, and jump straight to that step's action view (current sheets omit it so the
> operator picks). A parser that dropped it would have silently downgraded an old sheet to the
> traveler index — making in-app scanning *worse* than the camera-app path those sheets were
> printed for. Found by reading `login/page.tsx`'s `postLoginPath` rather than assuming the
> routes; the handler now mirrors it exactly.

Refusals are deliberate: a job id without a part id can't open a traveler, so it isn't one; a
bare UUID is always a location, since a traveler needs two ids and guessing would be a coin
flip.

#### The operator tab bar, and what nearly got buried

**Jobs · Inventory · Scan · My work.** Scan is a tab because it is the operator's most frequent
physical gesture, and it opens a **dialog rather than navigating**, so scanning never loses the
screen you were on — the point for the continuous flows (a count session, receiving a pallet)
that motivated an in-app scanner at all.

An earlier draft merged `My work` + `Profile` into one tab to free the slot. That was wrong:
it puts an operator's own work behind a second tap to make room for account settings nobody
opens mid-shift. **Profile moved to a header avatar instead** — it holds a read-only
name/email card, Logout and Give Feedback, and the header already had the station picker.

#### Operators see the same board

The operator surface listed names, kinds and codes while the owner's page drew each unit with
compartments, photo and fill state. Backwards: **the person who most needs to recognise a
physical place is the one standing in front of it, and `CAB3-A` is not recognisable.** The
operator page now renders `LocationBoard` itself — same component, same `getLocationBoard`
request pair, same roll-up — so the two cannot drift.

Two deliberate differences: `onAddStorage` is optional and omitted (creating places is an
owner's job; an operator doing it mid-shift is how `MISC 8-25-21` gets into a location table —
finding 2), and tapping a unit navigates into the existing bin view rather than opening a
second actions sheet over it.

---

## 6. Sequencing

### Phase 1 — close the validated loop ✅ **COMPLETE 2026-07-28**

Ordered by dependency, not value. **Get numbers in → use them → keep them true.**

> All four journeys shipped, plus the #59 patch. **Zero new tables and zero migrations across
> the whole phase** — which is not a coincidence: every figure J4 and J7 need already existed
> on `parts_bom`, `parts` and `inventory_transactions`. The module's gap was never schema.
>
> Carried forward, each recorded where it belongs rather than as a general TODO: the recursive
> BOM explode ([J4](#j4--job-kickoff-material-check)), `job_part_id` on the ledger
> ([J7](#j7--issue-material-to-a-job)), and the re-dated atomicity debt
> ([§5.4](#54-one-stock-engine)).

1. **Get numbers in — two doors, both required.**
   - **[J1](#j1--seed-the-item-master-and-opening-balances) import**: `quantity` and
     `reorder_point` through the existing Upload → Map → **Review & Fix** → Import flow.
     Completes a pipeline that already exists and closes FR-16.
   - **[J9](#j9--count-it) count session**: for shops arriving with nothing usable, and
     thereafter the correction mechanism for everyone. The opening count is just a count with
     an empty expected column — **one flow, not an onboarding special case.**

   These are peers. Which gets built first is a team call, not a product one — but a shop with
   no importable data (Contour) can't start until J9 exists, and a shop with good data
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

No new feature flag, and — as built — **no new tables and no migrations.** J1 adds columns to
an existing import mapping; J9's sheet is a localStorage draft committing through the existing
adjust functions. *(This section originally budgeted one table for a count session; see J9 for
why that turned out to be unnecessary.)*

[§5.2](#52-is-a-job-a-place--resolved-no) is resolved — a job is **not** a place. Build the
simple depletion.

### Phase 2 — locations reshaped ✅ **COMPLETE 2026-07-30**

**Shipped:** the permanent board with rolled-up fill state · the detail sheet that owns every
action · the tree list demoted to a Board|List toggle (finally carrying a child count) · the
wizard demoted to "Subdivide this unit" with a container-safe palette · single-level places
(floor, yard, bench) · sibling-name dedupe (backfill + unique index + live form warning) ·
`BulkGenerateModal` and four dead exports retired.

Fixed on the way, each found by reading a chain end-to-end rather than by a failing test: the
empty state was unreachable for every real tenant (`trg_auto_track_stocked_part` guarantees an
`Unassigned` row, so `tree.length === 0` was always false); `getLocationContents` was silently
clipped by `max_rows` and didn't filter archived parts; `companyName` was never passed, so the QR
label sheet printed with no heading; `materializeLocationSpec` re-validated the parent once per
node.

**Then completed 2026-07-30**, closing the four items the board slice had deferred:

| Also shipped | Note |
|---|---|
| **Batch put-away** (decision 8) | `bulk_put_away` — one atomic RPC, whole-balance, DB-capped at 1000. Landed **inside J9's place-scoped worksheet**, not as its own page: counting a bin and moving what doesn't belong are one visit. **This clears the rollout gate.** |
| **Place-scoped counting** ([J9](#j9--count-it)) | What §5.11 asked for all along. Also removes an exclusion — split-across-bins parts are countable at one bin, where the company-wide sheet must skip them. |
| **Inline create-a-place** (decision 2) | `LocationPicker`, shared by three surfaces, with the create offer suppressed on a name match so it can't mint `ST0CK` beside `STOCK`. |
| **Photos** (split out of decision 5) | `photo_path` column, batched signed URLs, board tiles only. |
| **PWA basics + the scanner** ([§5.10](#510-native-app-deferred-scanning-case-must-be-spiked)) | Manifest (`display: 'browser'`, deliberately), viewport, generated icons, safe-area insets, and a real in-app scanner for our own location labels. |

**Still deferred, deliberately:**

| Deferred | Why |
|---|---|
| **The §5.10 spike's actual question** | Does iOS persist camera permission in a *standalone* PWA? Needs the shop's handsets. `display: 'browser'` is what makes the scanner work meanwhile, and flipping it is the gate. |
| **Bar rack card** (decision 4) | §9 marks it *weakly refuted* — their 22 real places contain no rack. Open question, not an assertion. |
| **Drag-to-reparent** | Serves a hierarchy 118/121 of their locations didn't have; the house precedent is arrow buttons, not drag. |
| **Recurring + assignable counts** (§5.11) | Place-scoping was the half that changed the screen's shape. A schedule and an assignee are additive. |
| **Service worker / offline** | Nothing built needs it, and offline stock writes are a much larger question than a cache. |

**Bugs found while building, each pre-existing and none caught by a test:**

| Found | Was |
|---|---|
| **No SELECT policy on `storage.objects`** in any migration | **Every attachment read broken on every fresh local stack and preview branch** — part files and operator photos too, not just the new photos. Existed only in the prod snapshot. |
| `friendlyErrorMessage` ignored `check_violation` | Every stock RPC's hand-written message was replaced by a generic fallback. "Insufficient stock at source location (have 5, need 10)" surfaced as "Failed to update stock." |
| `apple: '/apple-icon.png'` | 404 — the generated route has no extension. The home-screen icon was broken. |
| The board's fill dot rendered at **zero width** | A bare `<span>` is `display: inline`, which ignores width. Right colour, invisible. jsdom has no layout engine, so only a browser could catch it. |
| Subdivide interleaved new children with old | `sort_order` defaulted to 0, so Rows landed between existing Shelves. |

**Follow-ups, now filed as issues rather than left in prose:** **#618**
`materializeLocationSpec` is sequential and non-transactional (one multi-row insert or an RPC is the
real fix — `bulk_put_away` is the shape to copy) · **#619** `getBalancesForParts` chunks part *ids*
at 500, but 500 × 3 locations = 1,500 rows against `max_rows` 1000, so it can truncate silently the
way `getLocationContents` did · **#620** the board deliberately removes `TOP_LIMIT`, which is right,
but implies windowing past a few hundred units.

### Phase 3 — purchasing

**J5** POs · **J6** receiving against PO · **J10** buy list + on-order. **This is issue #571**
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
  production; [J9](#j9--count-it) covers correctness in the meantime.
- **[J4](#j4--job-kickoff-material-check) customer-material exclusion** — *only if* service
  jobs turn out to carry BOM lines for customer-supplied material, which would otherwise raise
  false shortages. See [Customer-supplied, cut](#cut--customer-supplied-material-whose-is-it).
- **[§5.4](#54-one-stock-engine) one-stock-engine collapse** and the
  **[§5.9](#59-job_materials--resolved-drop-it-consumption-backs-onto-the-ledger) `job_materials` drop**
  (stop writing it, drop the table, remove it from the billing write-gate) — debt paydowns
  that want a quiet phase.

---

## 7. Gap analysis — what we missed

Scored against the twelve journeys, plus the two that were cut. "Docs said" means the module
doc **as it stood before this rewrite** — the record of what we had written down, which is the
point of the exercise.

| Journey | PRD says | Docs said (pre-rewrite) | Built? |
|---|---|---|---|
| J1 opening balances | FR-16 `Should` — CSV upload for inventory items | silent | ✅ **built 2026-07-28** |
| J2 where it lives | *(absent — no PRD requirement at all)* | AC only, no user story | ✅ **closed 2026-07-30** — was ⚠️ inverted; the board, inline create, put-away and photos all land |
| J3 quote cost | FR-11 | in parts/routings docs | ✅ |
| J4 material check | Flow 3 step 2 | silent | ✅ 2026-07-28 (top level only) |
| J5 buy it | Flow 3 steps 4–5 | silent | ❌ |
| J6 receive it | Admin persona; Flow 3 step 6 | silent | ❌ |
| J7 issue to job *(incl. consumption)* | **Open Question 2 — the primary path**; FR-3 / Flow 1 step 1 | "Planned (#550)" | ✅ 2026-07-28 — bin checkout + job tag, read back by J4. Job-first entry built and reverted (see J7) |
| J8 remnants | *(absent)* | silent | ❌ |
| J9 count | success metric: 100% accuracy | silent | ✅ **built 2026-07-28**, place-scoped 2026-07-30 (§5.11's actual ask) |
| J10 don't run out | **FR-2 `Must`** | FR-2 `Should`, partial, propose hiding | ⚠️ badge only |
| J11 find it | *(absent)* | AC only | ✅ |
| Traceability *(cut)* | *(absent)* | silent | ⛔ **cut** — no regulated customers |
| Customer-supplied *(cut)* | *(absent)* | *(absent)* | ⛔ **cut** — frequent, but never stocked |

**Three structural misses, in order of cost:**

1. **We shipped the only journey with no requirement behind it, and skipped the one marked
   primary.** J2/J11 got six PRs; J4/J7/J9 got nothing.
2. **The module doc could only describe what was built.** Because it was written as an
   implementation audit, absent concepts (receiving, purchasing, counting, shortage,
   remnants, traceability) do not appear even as gaps. You cannot notice a missing journey in
   a doc whose structure has nowhere to put it.
3. **Validated feedback had no protection.** #59 shipped, was deleted by an unrelated
   refactor, and nobody noticed for two months. There was no test and no AC pinning it.

### Stale-doc reconciliation

| File | Problem | Action |
|---|---|---|
| [`docs/modules/jobs.md`](jobs.md) §material tracking | Documents `job_materials` columns that don't exist (`inventory_item_id`, `actual_quantity`, `status`, `consumed_at`), a `JobMaterialsCard` with consume/skip actions, and `create_job_operations_from_routing` — then **links to the inventory.md section stating none of it exists**. | Rewrite against reality |
| [`docs/architecture.md`](../architecture.md) | Still lists `routing_materials` (removed) and `job_materials … actual consumption`. | Correct both |
| `docs/build-sequence.md` | 3,910 lines of superseded per-module specs, including a REST API (`GET/POST /api/inventory`) that never existed. | **Deleted** in this pass |
| [`docs/modules/demo-company.md`](demo-company.md) | Seed SQL against dead `inventory_items` / `inventory_unit_conversions`. | Correct |
| [`docs/usability-tests/usability-test-script-v1.md`](../usability-tests/usability-test-script-v1.md) Task 4 | Targets `/inventory/[itemId]`, deleted in May. Would fail if run today. | Superseded by the discovery script |
| `docs/modules/inventory-locations.md` | Promised by PR #414, never written. The largest inventory feature has no module doc. | Folded into the inventory module doc |

---

## 8. Acceptance criteria — what is actually verified

Each bullet carries a verification clause: a passing test, a manual procedure, or an explicit
automation-pending tag. **A checked box means the cited test exists and passes.**

**List, search and filter**

- [x] **Given** a stocked part with quantity 0, **when** status renders, **then** it reads
  "Out of stock" (and "Low" at or below `reorder_point`, else "In stock") — *verified by
  `__tests__/components/inventory/StockStatusChip.test.tsx > 'deriveStockStatus'` (5 cases,
  including null/undefined quantity treated as 0)*.
- [x] **Given** the Status chip for `status="out"`, **when** it renders, **then** it reads
  "Out of stock" — *verified by `__tests__/components/inventory/StockStatusChip.test.tsx > 'StockStatusChip'`*.
- [ ] **Given** the inventory list, **when** it loads, **then** it shows only parts with
  `is_stocked = true` and `deleted_at IS NULL` — *manual: `getStockedParts`; automation-pending*.
- [ ] **Given** the list, **when** a user searches, **then** rows filter by name or
  description — *manual: `.or(part_name.ilike / description.ilike)`; automation-pending*.

**Stock movement**

- [ ] **Given** a stocked part, **when** an owner adds stock in the primary unit, **then**
  `parts.quantity` increases and an `addition` row is written — *automation-pending (`addPartStock`)*.
- [ ] **Given** a stocked part, **when** an owner removes stock, **then** quantity decreases
  and a `depletion` row is written; removal is blocked if it would go negative —
  *automation-pending (`removePartStock`)*.
- [ ] **Given** a stocked part, **when** an owner adjusts to a specific quantity, **then**
  quantity is set and an `adjustment` row records the delta — *automation-pending (`adjustPartStock`)*.
- [ ] **Given** a transaction, **when** its notes are edited, **then** reloading shows the
  update, and no other column is mutable — *automation-pending; DB side enforced by `restrict_transaction_update_to_notes`*.

**Flexible units (FR-1)**

- [x] **Given** a part with a custom conversion, **when** stock is added at a location in that
  unit, **then** the converted quantity reflects the factor — *verified by
  `__tests__/utils/inventoryLocationsAccess.test.ts > 'RPC wrappers' > 'addStockAtLocation applies a custom unit conversion…'`*.
- [ ] Same, on the **aggregate** path — *automation-pending. Note the coverage skew: the newer
  location path is tested, the older and more-used aggregate path is not.*

**Delete**

- [x] **Given** any stocked part, referenced or not, **when** a user deletes it, **then** it is
  archived via `archive_parts` and never blocked — *verified by
  `__tests__/utils/partsAccess.test.ts > 'deletePart'`*.
- [x] **Given** several selected parts, **when** a user bulk-deletes, **then** all are archived
  in one RPC call — *verified by `__tests__/utils/partsAccess.test.ts > 'bulkDeleteParts'`*.

**Locations (feature-gated)**

- [x] **Given** a location-tracked part, **when** balances are read, **then** each row joins to
  its location with the full path — *verified by `__tests__/utils/inventoryLocationsAccess.test.ts > 'getBalancesForPart'`*.
- [x] **Given** a depletion at a location, **then** the RPC forwards the graceful flag and job
  tag and returns the discrepancy result — *verified by `…test.ts > 'depleteStockAtLocation forwards graceful flag, job tag, and discrepancy result'`*.
- [x] **Given** an adjustment at a location, **then** the RPC is called with the newly-converted
  quantity — *verified by `…test.ts > 'adjustStockAtLocation calls adjust with the new converted quantity'`*.
- [x] **Given** a new location, **when** an owner creates it, **then** a trimmed,
  company-scoped row is inserted — *verified by `…test.ts > 'createLocation'`*.

**The storage board (Phase 2)**

- [x] **Given** a cabinet that holds nothing directly but whose shelves hold 3 parts between
  them, **when** the board renders, **then** the cabinet reads **occupied, 3 parts** — never
  "empty" — *verified by `__tests__/utils/locationOccupancy.test.ts > 'rollUpOccupancy'` AND
  `__tests__/components/inventory/locations/LocationBoard.test.tsx > 'reports a container as
  occupied when only its shelves hold stock'`, and live against the seed (Cabinet 3 has no
  occupancy row at all; Shelf A 2, Shelf B 1).* This is the assertion the feature turns on:
  reporting it empty would send someone to fill an occupied shelf.
- [x] **Given** any tree size, **when** the board loads, **then** it issues **exactly two**
  requests — *verified by `__tests__/utils/inventoryLocationsAccess.test.ts > 'getLocationBoard —
  request budget'`, pinned at both 40 and 400 locations.*
- [x] **Given** a company whose only location is the auto-created `Unassigned` bucket, **then**
  the board treats it as having no storage and states the size of the pile — *verified by
  `…/LocationsManager.test.tsx > 'treats a company with only the system bucket as having no
  storage'`*. The old `tree.length === 0` predicate was false for every real tenant.
- [x] **Given** the `Unassigned` bucket, **then** it sorts last, is visually muted, and offers
  **no** Rename / Delete / Duplicate / Subdivide — *verified by `…/LocationBoard.test.tsx` AND
  `…/LocationDetailSheet.test.tsx > 'withholds every structural action from the system bucket'`*.
  Renaming it would split the backfill bucket, since the stock RPCs resolve it by literal name.
- [x] **Given** a location holding more parts than the page cap, **then** both the sheet and the
  operator bin view say so rather than presenting a clipped list — *verified by
  `…test.ts > 'getLocationContents'` (cap + exact total + archived-part exclusion) AND
  `…/LocationDetailSheet.test.tsx > 'admits truncation…'`*.
- [x] **Given** Subdivide on `Cabinet 3`, **then** the palette offers **no container card** and
  the spec's first node is `Row 1` with code `CAB3-R01` under `parentId = 'cab-3'` — *verified by
  `…/VisualLocationBuilder.test.tsx > 'subdividing an existing unit'`*. This pins both the
  dormant nested-create path and the `Cabinet 3 › Cabinet 1` trap.
- [x] **Given** a second Subdivide of a unit already holding Row 1–3, **then** it generates
  **Row 4–6** with codes `R04`–`R06` — *verified by `__tests__/utils/locationSpec.test.ts >
  'continuing past existing siblings'` AND `…/LocationsManager.test.tsx > 'continues the
  numbering on a repeat subdivide'`*. Required, not cosmetic: a collision would kill a sequential
  non-transactional insert run partway.
- [x] **Given** two siblings with names differing only by case or whitespace, **then** the DB
  refuses the second and the form warns before submit — *verified live against the local stack
  (`"  shelf a  "` rejected beside `Shelf A`; two roots refused; the same name under a different
  parent still allowed) AND by `…/LocationFormModal.test.tsx` for the warning parity.*
- [x] **Given** a company where a user-made `unassigned ` predates the system bucket by a
  decade, **when** the dedupe migration runs, **then** the `kind='system'` row keeps the literal
  name `Unassigned` — *verified live against the local stack, 2026-07-29.* If the wrong row were
  renamed the failure would be silent: every stock RPC would write to a freshly-created empty
  bucket while the balances stayed behind.

**Put away, and the place-scoped count (Phase 2, 2026-07-30)**

- [x] **Given** several parts ticked at `Unassigned` and a destination chosen, **when** Put away
  runs, **then** each part's **whole balance** moves, the source rows read 0, and **one**
  `transfer_group_id` covers every ledger row of the batch — *verified live against the seed
  (2 parts, 240 + 120 moved, 4 ledger rows, 1 group, actor stamped, zero rollup mismatches, board
  7→5 and 1→3) AND by `__tests__/utils/inventoryLocationsAccess.test.ts > 'bulkPutAway'`*.
- [x] **Given** any number of selected parts, **then** put-away issues **exactly one** RPC and never
  more — *verified by `…> 'sends every part in ONE rpc call, whatever the count'`*. That test exists
  to stop a future chunk loop silently un-guaranteeing atomicity.
- [x] **Given** a failure partway through a batch, **then** **nothing** moves — *verified against
  the local stack with a trigger that raises on the last part of a 4-part batch; Yard and Unassigned
  both unchanged.*
- [x] **Given** a batch over 1,000 parts, **then** the DB refuses it with a plain message, and
  "Select all" is disabled before you can try — *verified live AND by
  `…/InventoryCountPage.test.tsx > 'refuses to select-all past the cap'`*.
- [x] **Given** a same-source-and-destination, an empty selection, or a cross-company destination,
  **then** each is refused — *verified live against the local stack.*
- [x] **Given** `?location=<id>`, **then** the sheet counts **that bin** — `systemQuantity` is the
  balance there, not the company-wide roll-up, and the pre-save re-read uses
  `refreshLocationQuantities` — *verified by `…/InventoryCountPage.test.tsx > 're-reads THIS bin
  before saving, not the company-wide total'`*. Using the roll-up would flag a variance on every row.
- [x] **Given** a completed move, **then** the list refetches from **offset 0** rather than reusing
  the old page — *verified by `…> 'refetches from the start after a move'`*. Those rows just left this
  location, so the result set shifted.
- [x] **Given** a bin holding more parts than one page, **then** the sheet says so and search runs
  server-side — *verified by `…> 'admits when the bin holds more than the page shows'` and
  `…/inventoryLocationsAccess.test.ts > 'getLocationContentsPage'` (search, offset, exact total, and
  that `referencedTable` is the embed **alias** — the table name type-checks and then fails at
  runtime with `PGRST108`)*.

**Creating a place inline**

- [x] **Given** a name typed into a location picker that nothing answers to, **then** it offers to
  create it; **given** a name that already exists case- or whitespace-insensitively, **then** the
  offer is withheld — *verified by `__tests__/components/inventory/locations/LocationPicker.test.tsx`*.
  The DB refuses the duplicate anyway; the point is never to offer what it would refuse.
- [x] **Given** a destination picker, **then** the source and the `Unassigned` bucket are both
  excluded — *verified by the same file.* You never put something away *into* the pile.

**Photos**

- [x] **Given** a photo picked for a location, **then** it is compressed client-side, stored at
  `{company_id}/locations/{id}/…` and rendered on the board tile — *verified live (52KB image/jpeg
  from a PNG, thumbnail on the tile with the compartments still below it) AND by
  `…/LocationBoard.test.tsx > 'photos'`*.
- [x] **Given** a board where several locations have photos, **then** every signed URL comes from
  **one** `createSignedUrls` call, and none at all when nothing has a photo — *verified by
  `…/inventoryLocationsAccess.test.ts > 'location photos'`*.
- [x] **Given** a `photo_path` whose URL won't resolve, **then** the sheet says the photo couldn't
  be loaded rather than showing an empty frame — *verified by `…/LocationDetailSheet.test.tsx`*. An
  empty frame reads as "no photo" and invites adding a second one.
- [x] **Given** any attachment in the bucket, **then** a company member can read it **on a fresh
  local stack or preview branch** — *verified live; previously impossible, because the
  `storage.objects` SELECT policy existed only in the prod snapshot.*

**Scanning**

- [x] **Given** a printed label generated exactly as the PDF prints it, **then** the real decoder
  reads it back and the location id is recovered — *verified by
  `__tests__/components/scanner/LocationScanner.test.tsx > 'printed label → decoder → location id'`,
  which runs `zxing-wasm` against the same `.wasm` the app serves.* Testing the writer and reader
  separately would both pass while no label in the shop scanned.
- [x] **Given** a code that isn't ours — a shipping barcode, a vendor code, another system's QR, a
  job-traveler QR — **then** it is refused, not guessed at — *verified by the same file (7 cases).*
- [x] **Given** a blocked camera, **then** the message says where to fix it; **given** the dialog
  closing, **then** every track is stopped — *verified by the same file AND live in the browser,
  where a cameraless headless session produced exactly that message.*
- [ ] **Given** the app installed to an iOS home screen with `display: 'standalone'`, **then**
  camera permission survives navigation — **NOT VERIFIED, and not verifiable from a desk.** This is
  §5.10's spike; `display: 'browser'` ships precisely because the answer is unknown.

**PWA**

- [x] **Given** the app, **then** `/manifest.webmanifest` serves with `display: 'browser'`, and
  `/apple-icon`, `/icon-192`, `/icon-512` and `/icon-maskable` all resolve — *verified live; the
  previous `apple-icon.png` href 404'd.*

**Operator**

- [x] **Given** an operator at a bin, **when** they Remove stock, **then** it depletes
  gracefully and stamps the operator — *verified by `__tests__/components/operator/OperatorBinView.test.tsx`*.
- [x] **Given** an operator at a location, **when** they receive a tracked part, **then** it is
  added at that location — *verified by `__tests__/components/operator/OperatorReceivePartModal.test.tsx`*.

**Opening balances (J1)**

- [x] **Given** a CSV with an on-hand column, **when** it is mapped, **then** `quantity` and
  `reorder_point` appear at the Map step and import — *verified by
  `api/tests/integration/test_parts_import_api.py > 'test_execute_imports_stocked_part_with_unit_and_quantity'`*.
- [x] **Given** an imported quantity that changes a balance, **then** an `adjustment` row is
  written carrying both numbers — and **no** row when the value is unchanged — *verified by
  `…> 'test_execute_writes_an_adjustment_ledger_row_for_an_imported_balance'` AND
  `…> 'test_execute_writes_no_ledger_row_when_the_quantity_is_unchanged'`*.
- [x] **Given** the quantity column is unmapped, **then** the key is absent rather than `0`, so
  a re-import cannot zero existing stock — *verified by
  `…> 'test_execute_omits_quantity_entirely_when_the_column_is_unmapped'`*.
- [x] **Given** a location-tracked part, **then** its quantity is not written **and the skip is
  reported** — *verified by `…> 'test_execute_skips_and_reports_quantity_for_a_location_tracked_part'`*.
- [x] **Given** a brand-new part at a locations-enabled company, **then** the quantity *is*
  written, since the guard is BEFORE UPDATE and the auto-track trigger seeds from it —
  *verified by `…> 'test_execute_writes_quantity_for_a_brand_new_part_even_with_locations_on'`*.

**Stock count (J9)**

- [x] **Given** a part split across two or more locations, **then** it is excluded from the
  sheet and named — *verified by `__tests__/lib/inventoryCountPlan.test.ts > 'resolveCountTarget'`
  AND `__tests__/components/inventory/InventoryCountPage.test.tsx > 'names parts held back…'`*.
- [x] **Given** a tracked part with no stock anywhere, **then** the count commits to Unassigned
  — *verified by `__tests__/lib/inventoryCountPlan.test.ts`*.
- [x] **Given** a counted line, **then** it routes to `adjustPartStock` or
  `adjustStockAtLocation` per its target, and never writes `parts.quantity` for a tracked part
  — *verified by `__tests__/utils/inventoryCountAccess.test.ts > 'commitCount routing'`*.
- [x] **Given** pressing Save, **then** quantities are re-read first and anything that moved is
  named in the confirmation message — *verified by
  `__tests__/components/inventory/InventoryCountPage.test.tsx`*. (Was "entering Review"; there
  is no Review step, and the re-read is now for the ledger note's accuracy rather than a gate.)
- [x] **Given** the `inventory_locations` flag is ON, **then** a count writes to the part's own
  bin rather than defaulting to Unassigned — *verified live against the local stack, 2026-07-28:
  `BUY-BEARING-608ZZ` 580→575 landed on **Shelf A**, `RAW-STEEL-BLANK` 180→178 on **Yard**,
  `ASM-GEARBOX` 0→4 on **Unassigned**, each ledger row carrying its `location_id`;
  `BUY-ORING-214` (split 828/552) stayed excluded and untouched; zero rollup mismatches
  company-wide.* This branch had been unit-tested only until the seed enabled the flag.
- [x] **Given** an uncounted line, **then** its balance is left untouched — *verified by
  `__tests__/lib/inventoryCountPlan.test.ts > 'buildVariances'`*.
- [x] **Given** an unfinished sheet, **then** it can be resumed, and a draft from another
  company is ignored — *verified by `…InventoryCountPage.test.tsx > 'draft resume'`*.

**Material check (J4)**

- [x] **Given** a job, **when** it is viewed, **then** each material shows required · on hand ·
  issued · short by — *verified by `__tests__/components/jobs/JobPartMaterialsCard.test.tsx`*.
- [ ] **Given** two open jobs needing the same material, **then** on-hand is counted **once**
  across them — **built and deferred to Phase 3**, not a gap left open by accident. It was
  verified working (`rollUpShortages`, on-hand-counted-once test, git `87df208`) and pulled
  because a shortage has nowhere to go until there's a buy list.
- [x] **Given** a BOM unit with no route to the stock unit, **then** short-by is **blank, never
  zero**, and the row says why — *verified by `…JobPartMaterialsCard.test.tsx > 'renders an em
  dash, never a number'`; manually confirmed 2026-07-28 with a `pounds` BOM line against an
  `each` part.*
- [x] **Given** a job part with any number of BOM lines, **then** the read costs one query per
  table rather than one per line — *verified by
  `…materialCheckAccess.test.ts > 'reads one query per table regardless of BOM size'`.*
- [ ] **Given** a made sub-assembly on a BOM, **then** its own materials are exploded —
  **not built, and captioned on screen.** Level 1 only; see the note in J4. Follow-up.

**Issue to job (J7)**

- [x] **Given** an operator at a bin, **when** they remove stock and tag a job, **then** a
  `depletion` row carrying `job_id` is written and the balance drops — *verified by
  `__tests__/components/operator/OperatorLocationActionModal.test.tsx`; manually confirmed
  2026-07-28 on both engines, including the graceful clamp at zero stock.*
- [x] **Given** those depletions, **when** the job is viewed, **then** they read back as
  "issued" against the right material — *verified by
  `__tests__/utils/materialCheckAccess.test.ts`; manually confirmed on J-0006.*
- [ ] **Given** an operator on the traveler, **when** they take material, **then** the job link
  is made without them choosing it — **built 2026-07-28 and removed the same day.** Not a gap
  to fill: see the reversal in [J7](#j7--issue-material-to-a-job) for why, and for the signal
  that would justify revisiting (job tags routinely skipped at the bin).

**Owner-side job link (#59)**

- [x] **Given** an owner removing stock, **then** they can tag it to a job, on both engines —
  *verified by `__tests__/components/parts/PartTransactionJobTag.test.tsx`.* Regressed May
  2026 and unnoticed for two months **because nothing pinned it**; that is what these seven
  cases are for.

---

---

## 9. What we know, and what we still don't

### Answered — founder observation, 2026-07-27

From multi-day on-site observation at Contour Tool & Machine. **Reliable on structure, weaker
on frequency and pain-ranking**, and it is the founder's model of the shop rather than the
shop's own words — good enough for the structural decisions below, not for prioritisation.

> ### Device model corrected — founder observation, 2026-07-31
>
> *"No one used a shop tablet in Contour or any shop I've seen"* — it is the machine's own **HMI**,
> a **personal phone**, or the **office computer**.
>
> This matters because the docs had assumed shop-floor tablets in about a dozen places, two of
> which called it *"our primary device"*. The canonical model now lives in
> [CLAUDE.md](../../CLAUDE.md#who-uses-what-on-what--the-device-model): admin and user work
> (Storage, Parts, Quotes, Jobs, all data setup) happens at an **office computer with a mouse**;
> the operator surface is a **personal phone**; machine control is the machine's own HMI and is
> **not a Jigged surface at all**.
>
> **Most touch conclusions survive**, because a phone is at least as constrained as a tablet — the
> 48px floor, no hover-dependent UI, and high contrast all still hold, more strongly than before.
> What changes is the reasoning available on the **admin** surface: hover exists there, bundle
> weight is cheap there, and **drag is a perfectly ordinary interaction there** — which retires
> §5.5's stated reason for cutting drag-to-reparent (*"drag on a shop tablet is the most
> failure-prone interaction available"*). That cut may still be right on its other ground — 118 of
> 121 locations are flat, so a re-parent gesture serves a hierarchy they don't have — but the
> device half of the argument is withdrawn.
>
> Same correction applies to issue **#421**: an argument against a drag-to-place floor planner
> based on tablet drag reliability does not hold if setup happens at a desk.
>
> Still unknown, and only an interview reaches it: **whose** phone, and whether operators mind
> using a personal device for work.

| Question | Answer | What it decided |
|---|---|---|
| Staged before the job, or grabbed at the machine? | **Grabbed at the machine** | [§5.2](#52-is-a-job-a-place--resolved-no) — a job is **not** a place. Cheaper branch. |
| Stock vs buy per job? | **They stock** — lots of rush jobs, so they hold what those need | Confirms Phase 1's premise; [J4](#j4--job-kickoff-material-check) reframed around *"can I say yes to this rush job?"* |
| Who moves material? | **The operator, on the floor** | [J7](#j7--issue-material-to-a-job) stays on the operator's bin path; #59's owner-side fix demoted but shipped |
| What units? | **Mixed** — some `each`, some feet/inches | FR-1 conversion is load-bearing, both discrete and continuous |
| Opening balances? | **Start from zero.** Legacy figures exist but accuracy is *"questionable"* | [J1](#j1--seed-the-item-master-and-opening-balances) out of Phase 1; [J9](#j9--count-it) becomes onboarding |
| Certs / heat / regulated customers? | **None** | [Traceability, cut](#cut--traceability-can-we-prove-it) cut, lot layer cut, Phase 4 halved |
| Customer-supplied material? | **Yes, a lot of them** — service one-offs. **Never stocked**: arrives with the job, worked, leaves | [Customer-supplied, cut](#cut--customer-supplied-material-whose-is-it). It's a job attribute, not inventory — no ownership flag anywhere |
| How many storage places? | **~10, ±4.** Cabinets and shelving | Validates [§5.5](#55-locations-keep-them-visual-change-when-they-appear) — one wizard pass generating 16 is over-built for this shop |
| Have they ever counted? | **Yes, tried** | Rescuing a lapsed practice, not introducing one → [J9](#j9--count-it) first run can be self-served |
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
| …with `onHand` populated | **43 (0.5%)** | ⛔ **This shop has no opening-balance data.** They enter through the counting door, not the import door — see [J9](#j9--count-it). |
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
| Is there a **bar rack**? | Phase 2 palette | Their 22 real places include `STOCK`, `SHELF`, `YARD`, `CABINET 3-10` — **no rack of any kind**. Now *weakly refuted*, but they hold material in feet and inches, so long stock lives somewhere. Don't add the card on a guess either way. **Phase 2 shipped without it**, and [§5.5 decision 4](#55-locations-keep-them-visual-change-when-they-appear) was amended to cite this open question rather than assert the opposite — the two sections used to contradict each other. A code comment in `storageTypes.tsx` carries the reasoning, so the card isn't re-added on intuition. |
| What do `ZAPP`, `SMD`, `SBS`, `DB BOX`, `0-5` actually mean? | Phase 2 palette naming | Their vocabulary is opaque from outside, and it's the vocabulary that matters. One screen-share answers all of it — the card-sort in the discovery script is still the instrument. Phase 2's palette hedges by adding the *honest* single-level types (floor, yard, bench) so an opaque place doesn't have to be modelled as furniture. |
| ~~**How should thousands of parts leave `Unassigned` in bulk?**~~ | ~~The Phase 2 rollout~~ | ✅ **ANSWERED and built, 2026-07-30.** All of part X to one bin (partial moves already have `transfer_stock`); bulk-assign a **search-driven** selection, because nobody assigns 9,428 parts — they assign what they're holding; and no separate picker or page, because it belongs in [J9](#j9--count-it)'s place-scoped worksheet. See [§5.5 decision 8](#55-locations-keep-them-visual-change-when-they-appear). The rollout gate this was holding is cleared. |
| Do they actually reuse drops? | [J8](#j8--cut-it-return-the-remnant) | Remnants lost their free ride when lots were cut, so this now has to justify itself |
| Scan ten in a row? Dead zones? Whose phones? | [§5.10](#510-native-app-deferred-scanning-case-must-be-spiked) PWA-vs-native spike | Phase 2 only |
| Label durability and placement | Label PDF | Implementation detail, not data model |
| Frequency / pain ranking | Prioritisation within phases | The one thing neither observation nor exports reach |

Carried forward from elsewhere:

- **Scrap.** Does scrapping a unit consume material, and how does it relate to the existing
  `has_discrepancy` flag? ([`operator-paperless-flow.md`](../operator-paperless-flow.md) §5.4)
- **Issue #541** — does #496 mean *"beyond locations"* or *"including locations, which we
  overbuilt"*? **Answered: beyond.** Locations are worth keeping and reshaping; the gap is the
  material↔job loop. #541 can be closed.

### What no interview can answer

Whether they will **sustain** the count ritual, and whether a shortage view changes behaviour.
These are predictive, not descriptive — observation of current practice cannot reach them.
They are answered by shipping Phase 1 and watching, which is a reason to ship J9 early rather
than to keep asking.

**Two Sortly reports are gated downloads and were not obtained** — *2026 State of Inventory*
and the *Do You Need to Track Inventory?* flowchart. The latter speaks directly to #541.
Worth pulling; do not cite numbers from either until someone has read them.

---

## 10. Next steps

**Phase 1 complete (2026-07-28). Phase 2 complete (2026-07-30).**

The *why* layer this spec was written to diagnose exists: numbers get in (J1, J9), get used on a
job (J4), and record themselves as work happens (J7). Phase 2 went back to the *where* layer and
reshaped it: the board is permanent and has a daily job, the wizard is demoted to Subdivide,
sibling names can't collide, places are created where you need them, storage has photos, counting
is place-scoped, put-away exists, and a scan no longer leaves the app.

**Six of the eleven journeys are closed; two are partial; three are untouched.** What's left is
[Phase 3 — purchasing](#phase-3--purchasing) (J5 POs · J6 receiving · J10 buy list, issue #571,
merged not parallelised) and [Phase 4](#phase-4--debt-paydown-and-remnants). The single largest
remaining gap is **J10**: FR-2 marks it `Must` and it is still an alert badge with no buy list.

**Two things are owed that aren't builds:**

1. **§5.10's spike** — does iOS persist camera permission in a standalone PWA? It needs the shop's
   handsets, and `display: 'browser'` is what makes the scanner work until it's answered. Flipping
   that line is the deliverable.
2. **A rollout decision.** The gate that kept `inventory_locations` off for Contour was batch
   put-away, and that now exists. Whether to turn the flag on for them is a judgement call about
   readiness, no longer a blocked one.

**On the usability test: it is no longer a gate.** It was the right instrument when we had no
evidence. We now have something better for the questions that mattered — 121 location rows and
9,428 part rows of actual behaviour, which beats self-report on exactly the points where
self-report is weakest. What remains for it (their vocabulary, the bar rack, the scanning
spike) is **Phase 2 input and can run in parallel with Phase 1 development.** Do not hold the
build for it.

1. ~~**Build [J9](#j9--count-it) first**~~ · ~~**then [J4](#j4--job-kickoff-material-check)**~~ ·
   ~~**then [J7](#j7--issue-material-to-a-job) job-first**~~ — **all shipped 2026-07-28**, with
   [J1](#j1--seed-the-item-master-and-opening-balances) and the #59 patch. Phase 1 is closed;
   [§6](#6-sequencing) carries what each left behind. **Next is Phase 2.**
4. **Close #541** — answered: #496 means *beyond* locations; the gap is the material↔job loop.
   Re-scope **#496** from *"the use isn't validated"* to the phasing in [§6](#6-sequencing).
5. **Fold #571 into Phase 3.** **#550 and #59 are ready to close** — both delivered
   2026-07-28. Note #550 closed by being *folded into* J7, not built as written: it asked for a
   confirm-consumption step behind an `inventory_transactions` feature flag that never existed,
   and named the wrong actor. Anyone reading the issue as a spec is reading a superseded one.
6. **Run the [discovery script](../usability-tests/inventory-discovery-script-v1.md) alongside**,
   for Phase 2 only. Trim it to the vocabulary walk, the bar-rack question and the scanning
   probes — the rest is answered.

> **Expect Phase 1 to shrink Phase 2.** Roughly 80% of what made their old location list
> unusable was job numbers in the wrong field. [J7](#j7--issue-material-to-a-job) removes that
> pressure. Re-evaluate how much locations work is actually needed *after* Phase 1 ships,
> rather than committing to Phase 2's scope now.
