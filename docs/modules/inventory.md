# Inventory & Material Module

**Scope:** current state (§3) + target (§4+) in one file; the earlier `docs/inventory-flow.md` split
drifted within a week. Absorbs the inventory-locations spec PR #414 never wrote. Draft · 2026-07-27 ·
`feature/inventory-journey-spec`.

> **Condensed 2026-07-31: 26,148 → ~10,100 words (−61%), the pilot for [#634](https://github.com/debola31/Jigged/issues/634).**
> What went: the build log — "it started as X, then became Y" — superseded reasoning left standing
> beside the decision that replaced it, prose restating what code does, and acceptance criteria
> re-describing what tests already assert. What stayed, deliberately: every measured number, every
> **withdrawn argument** (one line each — recording that a reason was *wrong* is what stops the next
> person rebuilding on it), citations, and every named gap. Section numbers are unchanged; other docs
> cite them.
>
> If you are tempted to add length here, add it as a table row.

**Target state = full material control:** requisition → PO → receive against PO → issue to job →
remnant back to stock. Multi-quarter (§6 phases it); Phase 1 is the smallest slice closing what a
shop actually asked for.

**Partially validated 2026-07-27:** founder's multi-day observation at Contour Tool & Machine,
**measured** against their legacy ERP exports (§9) — resolved the largest modelling fork (§5.2), cut
two journeys. Observation is reliable on structure, weak on frequency; the exports are behavioural
and outrank both. The [discovery script](../usability-tests/inventory-discovery-script-v1.md) covers
the rest (Phase 2); findings untracked (`.gitignore`: `docs/usability-tests/*findings*`) as user
research.

---

## 1. TL;DR

Inventory is the one module that has not taken at the one shop we serve. Not a feature gap: **we
built the *where* layer first, the *why* layer never.** The *why* layer shipped 2026-07-28 — Phase 1
(J1 opening balances, J9 count sheet, J4 material check, J7 issue-to-job), zero new tables, zero
migrations. The failure mode recurs, so it stays named: investment follows the easiest surface, not
the journey asked for.

- **All 2026 investment went to a surface nobody asked for:** six PRs, 20–25 June — QR storage
  locations, visual builder, operator bin-scan — with no PRD requirement, module doc, story or
  research. #496: inventory is *"Priority 3 (Later) … the use isn't validated."*
- **The journey the PRD calls primary was never built:** [`prd.md`](../prd.md) Open Question 2,
  owner-answered *"primarily deplete inventory through jobs"*. Nothing decrements stock as a
  consequence of production; every movement is deliberate bookkeeping — what shops stop doing.
- **The one validated shop request regressed:** #59 (Shane, `client-feedback`, P0) *"link inventory
  removals to specific jobs"* shipped March on `/inventory/[itemId]`, killed by the May parts
  unification. **Since repaired** —
  [`PartLocationActionModal.tsx`](../../components/parts/PartLocationActionModal.tsx) tags removals via
  `JobTagPicker`; the doc's "zero references to jobs today" is withdrawn.

Fix: movement becomes **a by-product of work, not a chore** — checked, issued and confirmed against
a job; stock a consequence. Locations stay (QR-on-location was asked for) but stop being the front
door.

---

## 1a. Who does what, and where

Every action the product actually supports today, by actor. **This is the summary to read before
§4**, which explains *why* each was designed the way it was and is ten times longer.

> **Rebuilt 2026-08-01.** The admin table previously listed eight rows and **not one of them was a
> stock write** — its only part-page entry was "See where one part lives", while that same tab has
> always done Add / Remove / Move / Adjust. It under-reported the built surface by roughly half,
> named three buttons that do not exist (`Count what's here`, `Move N to…`), and was the section a
> reader would go to first. Verified against the code, row by row.
Route names are relative to `/dashboard/{companyId}` or `/operator/{companyId}`.

### Admin / office — computer, mouse

There is **no page called Inventory** — `/inventory` is a 307 redirect to `/parts`. The owner's
inventory work lives under three nouns: **Parts** (what we have), the **part detail → Inventory
tab** (where every stock write happens), and **Storage** (where it lives). Storage and everything
flag-gated below appear only when `inventory_locations` is on for the company — **on for Contour**,
off by default elsewhere, and only the founder flips it.

| I want to… | Where | How |
|---|---|---|
| Decide we stock a part at all | `/parts/{id}` → workspace | `Stocked`, primary unit, reorder point. The Inventory tab does not exist until `Stocked` is on. |
| See what we have and what's short | `/parts` | `On hand` + `Status` columns; filter `Low` / `Out`. `?status=low` adds **Reorder at** and **Short by**. |
| Get a stock list in | `/parts` → `Import` | On-hand, unit and reorder point from CSV. An existing location-tracked part's quantity is **skipped**, and the skip is reported. |
| **Add / remove / adjust stock** | `/parts/{id}` → Inventory tab | The four buttons. Until receiving (J6) exists **this is how stock gets in**. |
| **Move stock between places** | Same tab → `Move` | Source picker lists only places that hold some. |
| **Tag a removal to a job** | Same tab → `Remove` → job picker | Restored 2026-07-28 (#59). |
| See where one part lives | `/parts/{id}` → Inventory tab | Per-location balances with full paths. |
| **Read a part's ledger** | Same tab → history table | Date, type, qty, job, place, notes (editable), **who did it**, and any movement photo. |
| Add a location, and say how it is divided | Storage | `Add storage` → name it **and** shape it on one screen, written in one `create_location_tree` call. Levels are optional: no levels is one location (the yard). **Was two steps until 2026-08-10** — name a bare location, then find `Divide it up…` inside its detail drawer — which is how a shop ended up with named furniture and nothing in it. |
| **Change a unit's layout** | Storage → pick a unit → `Change layout` | Opens on the unit's REAL subtree and writes a **diff** — creates, renames, re-parents, removes — through one `apply_location_layout` call. Anything it removes that holds stock has to be re-placed first, and anything it divides up moves its stock down. **Was an append until 2026-08-15** ([§5.13](#513-change-layout-changes-the-layout--2026-08-15)): the same dialog, seeded with five default rows and told to number PAST what was already there, so asking a five-row cabinet for three rows gave you eight. |
| **Reorganise a place** | Storage → pick it in the list, or a cell in the grid | `Rename`, `Duplicate`, `Add one inside`, `Delete` (empty subtrees only). ~~`Move into…` (re-parent)~~ **removed 2026-08-10** — see [§5.12](#512-two-nouns-parts-is-what-we-have-storage-is-where-it-lives--2026-07-30). |
| Print labels | Storage toolbar / place drawer | `Print all labels` for setup, or `Print QR` for one place **and everything under it**. There is no row selection: bulk-print-a-subset is the only job those checkboxes served, nobody has asked for it twice, and a checkbox column charges every row on every visit for it. |
| **See what happened in one place** | Storage → click a place → `Recent activity` | Movements with author and photo. Offered for `Unassigned` too. |
| **See stock moving across the whole shop** | `/activity` → `Inventory` | Every movement, newest first, transfers folded to one row. Each row links to that part's ledger. Added 2026-08-01 — `getRecentActivity` already existed and its only caller was the operator's phone. |
| **Move stock at a place** | Storage → click a cell → drawer → `Add` · `Remove` · `Move` | **A quantity per row, several parts at a time.** Fixes the *place* and picks the *parts* — the inverse of the part page, and the information you actually have standing at a cabinet. [`PlaceStockActionForm`](../../components/inventory/locations/place/PlaceStockActionForm.tsx), **new 2026-08-10**: before it, Storage could not put anything into a bin at all. |
| Audit ONE place | Storage → click a cell → drawer → `Adjust` | [`PlaceAdjustForm`](../../components/inventory/locations/place/PlaceAdjustForm.tsx): everything at that place under **recorded · counted · changed**, variance as you type. **A blank is not a zero** — untouched rows keep their balance, and a typed 0 is an assertion that the bin is empty. |
| Audit a whole cabinet | Storage → pick a unit → `Bulk Adjust` | [`UnitAdjustDrawer`](../../components/inventory/locations/place/UnitAdjustDrawer.tsx) — every bin under the unit in one drawer, a row per **(part, place)**, recorded · counted · changed. Was `Count or put away`, then `Adjust`, then a page; see §5.12. |
| **Count one part at one place** | `/parts/{id}` → Inventory tab → the icon on a balance row | Offered on **every** row including zeros. |
| **Count one part everywhere** | Same tab → `Count all N places` | One sheet, one row per place. Appears once the part is in more than one place. |
| Put stray parts away | Place worksheet, at `Unassigned` | Tick rows → `Send the ticked parts to…` → `Put N away`. Moves each part's **whole** balance. |
| **"Where is my o-ring?" — and take five off the shelf** | Storage → the page search | [`StorageSearch`](../../components/inventory/locations/StorageSearch.tsx) matches **places and parts in one box**, grouped, **one row per part**. Picking a part opens [`PartPlacesDrawer`](../../components/inventory/locations/place/PartPlacesDrawer.tsx) — every place it is, with quantities and a total — and each row **expands into the four verbs scoped to that part at that place**, so the job finishes where the answer was. `Open bin` is inside the expanded section for when you want the whole shelf. |
| Count the whole shop | `/parts` → `Count Inventory` | One door, and now the worksheet's **only** browsing entry: Storage stopped navigating there entirely 2026-08-10. The page keeps its place-scoped mode for a part's own balance row (`?location=…&part=…` from [`PartLocationInventory`](../../components/parts/PartLocationInventory.tsx)). |
| **Add a part the bin read didn't return** | Place worksheet → `Found something not listed?` | The "system says zero, I'm holding twelve" case. |
| Check a job has material | `/jobs/{id}` | `JobPartMaterialsCard`. Top-level BOM only; no on-order. |

**Not built on this surface:** receiving against a PO (J5/J6 — no schema at all), a vendor-grouped
buy list, reorder email (PRD FR-2 is a `Must`), filtering or exporting the ledger (FR-13), a
discrepancy queue, a shop-wide movement feed, and scheduled or assigned counts.

### Operator — own phone

| I want to… | Where | How |
|---|---|---|
| Go to the shelf I'm standing at | `Scan` tab | Scan its label. Resolves location labels *and* job travellers. |
| Find where a part is | `Inventory` tab | `PartAutocomplete` (same control as quotes/jobs) → every place holding it, with path + quantity. Tap a place to go there. Stock in the put-away pile is called out separately, never as a shelf. |
| See what changed while I was elsewhere | `Inventory` tab | Shop-wide recent-activity feed, newest first, with photos. Each row taps through to its place — which is also how you reach a bin whose label came off. Hidden while a part is selected. |
| Put something away without a label to scan | `Inventory` tab → part → `Put it away…` | Destination picker showing what each place already holds. **Navigates**, doesn't write — the movement is recorded at the bin. Fallback only; scanning the shelf is the better input. |
| Take stock out | Bin view → part card → `Remove` | Qty + unit + optional job tag. Over-removal records the shortfall and zeroes the count rather than blocking. |
| Put stock in | Bin view → part card → `Add` | Qty + unit + notes. |
| Put in a part that isn't here yet | Bin view → `Stock a part` | Picks a tracked part not already in this bin. |
| Move stock to another place | Bin view → part card → `Move` | Any other place in the company. |
| Correct a wrong number | Bin view → part card → `Adjust` | "Adjust stock (cycle count)" — set the true quantity. This *is* a one-part count. |

### Not possible today — and each is a decision, not an oversight

| Journey | Status |
|---|---|
| **Photograph a deposit as proof others can read later** | **Built 2026-07-31.** `inventory_transactions.photo_path`, written at INSERT inside the RPC (a column set by UPDATE later would have to stay mutable, which recreates editable evidence). Upload-then-RPC, so a failed write orphans an object rather than pointing a row at nothing. |
| **Operator counts or puts away a whole place** | **Still office-only.** The worksheet lives under `/dashboard`, which `AuthGuard` redirects operators out of. Unchanged by the 2026-08-01 counting work, which fixed reachability *for the owner*. |
| **See this bin's history — who took the last one** | **Built 2026-07-31.** `BinHistory` under the bin view; the shop-wide version is the Inventory tab's feed. Required populating `operator_id` on add/adjust/transfer first — only `deplete` wrote it, and `created_by` is an `auth.users` id the browser cannot read. Rows predating that render **without** an author rather than "Unknown". |
| **Reconcile a recorded discrepancy** | **No surface, no owner.** Over-removal sets `has_discrepancy`; it renders as a per-row chip on two part-scoped views and nothing lists them. A queue was specced 2026-08-01 and **cut**: resolution provably cannot be derived, because graceful depletion clamps to zero, the place read filters `.gt('quantity',0)`, and `committableVariances` drops a zero delta — so the remedy cannot produce the adjustment the query would look for. It needs a `discrepancy_resolved_at` column. |

> ### ✅ The false promise, and how it closed
> The operator bin view's truncation notice used to read *"Showing the 200 largest of 9,428 parts
> here. **Scan or search a part** to reach one that isn't listed"* — and neither route existed.
> Stripped to *"ask the office"* on 2026-07-30, then restored 2026-07-31 as a link to the part
> lookup, which is a route that now does exist. Worth keeping as a pattern: copy that names a
> capability is a promise, and the fix while it is unbuilt is to say less, not to say it anyway.

---

## 2. Goal & non-goals

Five answerable questions: **have it?** J4 · **where?** J11 · **bought it?** J5/J6 · **used it?** J7
· **running out?** J10. Beneath them, **can we trust it? — J9, the count session**: the ritual that
keeps the other five true, hence **Phase 1, not later** (imports are a starting position, not a truth
claim; a shop arriving with nothing usable has no other way in). Counting deferred as reporting is
how inventory modules rot (§5.11). Write side and setup: J1 seeding, J2 where things live, J3 the
quoting boundary, J8 remnants — twelve journeys (§4).

**Cut, as decisions:** traceability — no certs, heat numbers or regulated customers, so the lot layer
went with it (§5.6); re-confirmed 2026-08-01, Contour does not want it either. Kept on the radar for
**customer #2**, not for this shop — [#642](https://github.com/debola31/Jigged/issues/642).
Customer-supplied material — real and frequent but **never stocked** (arrives with the job, is
worked, leaves): a job attribute.

### Explicit non-goals (deliberate, decided)

| Non-goal | Rationale |
|---|---|
| Demand forecasting | A job shop's demand *is* its order book. |
| MRP run / netting | No trustworthy lead times or BOM depth; nobody in a 10-person shop acts on the output. J10 reorder points cover it. |
| Multi-warehouse | One building; `inventory_locations` nests if a second appears. |
| Customer-owned stock | Never enters stock — no ownership flag, ledger or valuation. |
| Valuation / COGS / postings | QuickBooks owns money; Jigged tracks *quantities and identity* — cost is costing's (`part_procurement_tiers`, `compute_part_cost_at_qty`). |
| Automatic purchasing | We propose the buy list, a human orders; auto needs vendor integration and unearned trust. |
| Tool crib / perishable tooling | Different lifecycle (tool life, regrinds, checkout); own module later. |

---

## 3. What exists today

> Verified against the code on `main` as of 2026-07-27; feature-flag list re-checked 2026-07-31. Current state; §4 onward is target. Columns: [`types/database.ts`](../../types/database.ts).

**Item** = `parts WHERE is_stocked` — the stocked thing *is* the manufacturable part, one master (no `inventory_items`; absorbed May, `27040f2`); identity fields live on the part's Details tab, a made part's materials on `parts_bom` (`routing_materials` gone). **Balance** = `parts.quantity`, or `part_location_stock.quantity` when tracked — authoritative. **Transaction** = `inventory_transactions`: append-only, **never replayed** — audit trail, not the balance's source. **Location** = `inventory_locations`, adjacency tree; its row `id` is what a QR encodes.

**Absent entirely:** purchase orders · receiving · lots/certs · remnants · on-order · min/max · reserved · ABC · serial/expiry · landed, standard or average cost · location capacity.

### Data model — non-obvious bits only

| Table | Detail |
|---|---|
| `parts` | `primary_unit` is required by a **CHECK** (`parts_requires_unit`), not a NOT NULL column — `types/database.ts` types it `string | null`, so an insert omitting it compiles and then fails at runtime; `quantity` **written only by a stock function, never the part form**; `reorder_point` NULL disables status; `preferred_vendor_id` is a **label only, not a cost gate** (`20260714173443`). |
| `parts_unit_conversions` | FR-1. `(part_id, from_unit)` UNIQUE, `to_primary_factor` > 0 — bar in lbs: `inches` × 0.166. Custom/cross-category only; names in `company_custom_units`. |
| `inventory_transactions` | FR-13. `quantity` always positive, direction in `type`; `has_discrepancy` = clamped-to-zero depletion; `transfer_group_id` pairs a transfer's two rows; `notes` the only mutable column (`restrict_transaction_update_to_notes`). |
| `inventory_locations` | `parent_id` self-FK RESTRICT; `code` **not unique**; **no `path`/`level`/ltree** — depth recomputed client-side each read. The partial unique index `(company_id) WHERE name='Unassigned'` *is* the auto-bucket mechanism, resolved **by name**. Traps: re-parent cycle check is client-side only; Unassigned is that string in SQL but `kind==='system'` in TS. |
| `part_location_stock` | `(part_id, location_id)` UNIQUE, both FKs RESTRICT, RLS **SELECT-only**. A row exists only while the part is actually there — `CHECK (quantity > 0)`, emptying deletes. **Never at a location with children** — see below. |

### A place is a container or a bin, never both

**Invariant (20260806160053):** *a location with at least one child holds no `part_location_stock`
rows.* If Cabinet 1-A is just Side 1 and Side 2, nobody means "put it in the cabinet" — they mean a
side, and every picker used to offer the cabinet anyway.

This partly reverses [`20260623031347`](../../supabase/migrations/20260623031347_drop_location_display_flags.sql),
which dropped `is_stockable` on the reasoning that *"every location can hold stock"*. That was right
about leaves and about printing (a container's QR still navigates); it was wrong about containers.
No flag came back: containment is already `parent_id`, and a flag that must agree with it is a
second source of truth that can drift.

Both directions are enforced, by two **`DEFERRABLE INITIALLY IMMEDIATE` constraint triggers sharing
one name** across the two tables:

| Direction | Trigger on | Refuses |
|---|---|---|
| (a) | `part_location_stock` INSERT | stock landing on a location that has children |
| (b) | `inventory_locations` INSERT / UPDATE OF `parent_id` | children under a location that holds stock, and any child under `Unassigned` |

**The row locks in those trigger bodies are load-bearing, not defensive.** Both test cross-row state
with a plain `EXISTS`, PostgREST runs at READ COMMITTED, and deferral does not help — a deferred
trigger takes a *fresh* snapshot at commit, which still excludes an uncommitted transaction. Two
concurrent transactions (one adding children, one adding stock) would each see nothing and both
commit, breaking the invariant **silently**. Postgres only detects that write skew at SERIALIZABLE.
So direction (a) takes `FOR SHARE` on the location row and (b) takes `FOR UPDATE`: those conflict,
the second transaction blocks, and its post-lock `EXISTS` sees the winner's rows. The implicit FK
locks are both `FOR KEY SHARE` and do not conflict with each other, so they serialise nothing.
`test_concurrent_subdivide_and_stock_cannot_both_win` in
[`test_location_children_hold_no_stock.py`](../../api/tests/integration/test_location_children_hold_no_stock.py)
fails **only** when the locks are removed — every other case in that file passes without them.

Why deferrable at all: subdividing a loaded shelf must pass through the illegal intermediate state
(create the children, then move the stock down). `subdivide_location(p_parent_id, p_nodes, p_moves)`
is the only caller allowed through — it takes the parent lock up front, defers both triggers,
inserts the subtree from a flat `{ref, parent_ref}` list, and delegates each move to the existing
`transfer_stock` so the ledger and `transfer_group_id` are identical to any other movement. An
incomplete distribution therefore cannot half-apply: the deferred check fires at COMMIT and rolls
the sub-locations back with it. It is browser-callable and on the `function_execute_leaks()`
allowlist.

Client-side, [`utils/locationDestinations.ts`](../../utils/locationDestinations.ts) is the single
source of the two option rules — `stockDestinationOptions` (leaves only, no pile) and
`locationParentOptions` (containers required, but not one holding stock directly). Six call sites
each hand-rolled their own list before, and none filtered containers.
| `job_materials` | **Write-only** — written by `create_job_part_operations_from_routing()`, read by nothing since `20260614043526_retire_job_material_consumption` dropped its consumption columns; the live BOM is read instead. Slated for removal (§5.9). Older `jobs.md` copies wrongly show those columns and an `inventory_item_id` FK. |

### The two stock engines

Per part by `is_location_tracked`; unification is intent (§5.4).

| | A — aggregate (`false`) | B — tracked (`true`) |
|---|---|---|
| Writes | `addPartStock`/`removePartStock`/`adjustPartStock` | `add_stock_at_location`/`deplete_…`/`adjust_…`/`transfer_stock` RPCs |
| How | Client read-modify-write of `parts.quantity`, then a **separate** ledger insert | Balance upsert + ledger insert in one transaction, `SELECT … FOR UPDATE` |
| Atomicity | **None** — concurrent writes lose updates | Atomic, row-locked; `parts.quantity` is a `trg_recompute_part_quantity` rollup |

`enforce_tracked_part_quantity` raises when a direct `parts.quantity` write disagrees with the balance sum, so the DB refuses Path A on tracked parts — hence the UI swap to `PartLocationInventory`. `trg_auto_track_stocked_part` enrols stocked parts at Unassigned only when `features.inventory_locations = true`, hence no per-part opt-in UI.

**Nothing decrements automatically** — not on operation complete, job complete, shipment or invoice; zero stock calls in the jobs, operator, shipments or operation-completions access files. Deliberate, still true after Phase 1: consumption is recorded when an operator depletes at a bin and tags the job, which J4 reads back. The tag stays **optional** — accepted risk (J7).

### UI surfaces

No item detail/create/edit/import page of its own; that is all Parts UI.

- ~~`/inventory` list~~ **deleted 2026-07-30**, redirects to `/parts`: a second parts list with no unique capability. Parts carries **On hand** (`—` not `0` for non-stocked, since `0` reads as "we're out"), **Status**, and a Stock filter seeded from `?status=` — the shortage lens J4 links to. Sidebar says **Storage** (§5.12).
- **Part → Inventory tab** ([`InventoryTab.tsx`](../../components/parts/workspace/tabs/InventoryTab.tsx)) when `is_stocked`: untracked → Add/Remove/Adjust (`PartLocationActionModal`), tracked → `PartLocationInventory` (+ move). **No longer a gap** — this said "no job selector … only an operator at a bin can tag a job", which was true when written and was repaired on 2026-07-28: `JobTagPicker` is on both engines (`PartLocationActionModal`). §1 already recorded the repair; §3 did not, and the two sat contradicting each other.
- **`/inventory/locations`** (flag-gated) — [`LocationsManager`](../../components/inventory/locations/LocationsManager.tsx), a **two-pane workspace since 2026-08-10**, plus a place drawer: [`StorageUnitList`](../../components/inventory/locations/StorageUnitList.tsx) on the left (searchable, `Add storage` lives with it) and [`LocationPanel`](../../components/inventory/locations/LocationPanel.tsx) on the right — the unit's actions, its drawn grid, and what is in the selected place. Picking a unit is a **selection, not a journey**: `router.replace` to `?unit={id}` with `scroll: false`, on the one page. It was a nested `/{unitId}` route for a day and Next treated every pick as a page transition — the whole screen blanked to change one pane, and clicking through six cabinets buried the page you arrived from under six history entries. Below `md` the same query param is what makes the two panes read as separate screens, with `All storage` going back to the list. **`LocationDetailSheet` is deleted**: it owned every action from the board era, and once the pane showed the selected location at any depth there was nothing left for a drawer to do. Page chrome is down to **Print all labels** alone (§5.11), and the instructional paragraph above the list went with the shape that needed explaining. The place's own actions are the four verbs — `Add` · `Remove` · `Move` · `Adjust` — which are the four ledger row types and nothing else; a unit with structure offers only `Adjust`, because stock lives in the places and not in the cabinet.
- **Change layout** — one [`VisualLocationBuilder`](../../components/inventory/locations/builder/VisualLocationBuilder.tsx) modal in `reshape` mode: seeded from the unit's real subtree via [`readSubtreeAsSpec`](../../utils/locationReshape.ts), diffed as you type by `planReshape`, written by `applyLocationLayout` → `apply_location_layout`. The same component still builds a new unit (`unit={null}` → `create_location_tree`); passing a unit is what makes it a reshape. **The diff is the whole feature**, and it turns on one thing: a `LocationSpecNode.key` may now carry a location id under `locationReshape`'s `id:` prefix, which is what tells "this is Row 3, renamed" from "this is a new location that happens to be called Row 3". Everything else falls out — a removal is an id the edited tree stops mentioning, a create is a key that never was one.
  - **`reconcileLevelsWithExisting` is where the append died.** The numbers editor applies the i-th planned name to the i-th existing child KEEPING ITS KEY, so 5 rows → 3 removes rows 4–5 and 3 → 5 creates two. It calls `planLevelNames(level, [])` — the empty sibling list — where the old path passed the unit's real names precisely so the run would continue past them.
  - **The impact is on screen before the confirm, not inside it.** `describeReshape` renders "Removing 2 locations, 1 of which holds stock" live above the editor, from the occupancy map the Storage page already had and had never handed to this dialog. A duplicate sibling name is flagged as you type, folded `lower(btrim(…))` so the check and the expression index agree — `docs/interaction-standards.md` forbids a confirm that ends in an error.
  - **Re-ordering is never reported, and never counts as a change.** `sort_order` defaults to 0, so a unit built one location at a time through the form has every child at 0 while the spec's positions are 0,1,2 — counting that meant *opening* the dialog claimed an edit it could not describe. It still rides in the payload, so positions normalise whenever a real change is applied.
  - **Second step when something is losing its stock (2026-08-06, generalised 2026-08-15):** [`DistributeContentsStep`](../../components/inventory/locations/builder/DistributeContentsStep.tsx) asks where each part goes, allows **splitting one part across several destinations** (you divide a shelf *because* what is on it is already in two piles), and leads with **"Send everything to…"** because a 200-row table of decisions is not a UI. Its sources are now **N locations, not one**: the bins being removed ∪ the surviving leaves being divided up. Rows are keyed `part@location`, so the same part in two doomed bins is two independent decisions. Confirm stays out of reach until each row's lines sum exactly to its on-hand — not politeness: an incomplete distribution rolls the whole reshape back at COMMIT, deletions and all. Past `RESHAPE_DISTRIBUTE_MAX` (200) it **refuses** rather than showing a clipped table. **Nothing sweeps to `Unassigned`**: the pile is a root, so it is never inside the unit being reshaped and cannot be a destination at all.
- **Depth** — `readUnitLayout` draws up to **four levels below a unit** (grid · one chooser · two choosers), which is exactly what `LevelConfigStep.MAX_LEVELS` builds and what `assert_location_depth` allows. Past that it declines and lists, which is now only reachable by data predating the cap. **Was three until 2026-08-15**, one less than the wizard could build.
- ~~**Storage table** — an accordion with one open branch (2026-08-06)~~ → **deleted 2026-08-10, replaced by two screens.** It held `openPath` (root→deepest ids) rather than a set of expanded ids, so "one open branch" was the only representable state. What killed it was scale, measured: Contour built **237 locations, 216 of them leaves, 180 in one cabinet**, and the operator's own model is spatial (*"three rows down, five slots over"*) — a list is the one shape that cannot express it. Now: [`StorageUnitList`](../../components/inventory/locations/StorageUnitList.tsx) (five unit cards, shape read back in words) → [`UnitGridView`](../../components/inventory/locations/UnitGridView.tsx) (the unit drawn, cells at the 44px touch floor, scrolling horizontally rather than shrinking). Both surfaces use the same component; the operator's is at the existing QR target route, so nothing was reprinted. Depth is decided once in [`lib/locationGrid.ts`](../../lib/locationGrid.ts) — no component counts levels.
- **Counting a container** (2026-08-06) — `?location=<container>` gathers **every bin beneath it**, depth-first, one line per (part, bin). It needed no new write path: `commitCount` already adjusts each line at its own `target.locationId`, so a sheet spanning ten bins is ten independent one-bin assertions. `getContentsPageForLocations` is `getLocationContentsPage` generalised from `.eq` to `.in`, ordered by the bin's `sort_order` then name then part — a walking route as far as one query expresses it; across two shelves it interleaves by sibling position, which is why every row carries its bin's full path. **A split part stays two lines, never one total** — aggregating would re-create exactly the ambiguity that makes the company-wide sheet *skip* split parts. The **bulk put-away is withheld** on a subtree sheet: `bulk_put_away` moves parts out of one location and the ticked rows come from several. (Briefly, containers had no count action at all — the button was hidden rather than the read widened. That was wrong and lasted one commit.)
- **Operator** — `/operator/{companyId}/inventory` is the warehouse home (browse top-level places; the flag hides this nav tab); `…/inventory/locations/{locationId}` is **the QR target**, reached through `/L/{code}` and the login passthrough. A **leaf** shows contents with Add/Remove/Move/Adjust and `Stock a part`; a **container** shows only its sub-locations plus one line saying stock goes in them — it used to show `Stock a part` directly above *"No stock recorded directly here"*, a button inviting you to break the sentence beside it. Operator removals are always graceful (clamp to 0, flag `has_discrepancy`), stamped `operator_id`, job tag optional. The zero-stock lookup says **"None available"**, not the old *"None in any place right now."*: `parts.quantity` is a pure roll-up, so no rows means none on hand anywhere — a stock fact the old wording dressed as a placement one.
- QR labels encode the location **UUID** in base32 (`lib/jiggedScan.ts` `buildScanUrl`): **Avery 5163** adhesive stock, 2 × 5 on Letter, QR version 6 at error-correction H, `kind='system'` excluded. The label prints the QR, the place's **name** as the primary line and its parent path beneath — **nothing else**: no border, no icon, and nothing identifying Jigged. A `jigged.app` micro-line was drawn briefly and removed; a sticker on a shop's own shelf is the shop's, and attribution belongs on a document someone reads. It was A4 at 34 mm and version **10** until August 2026; see [operator-view.md](operator-view.md#qr-codes-and-scanning) for why that had to change. There was a `code` line under the path until 20260803034616; see below.

### Access layer

Supabase + RLS via `getSupabase()`, **no FastAPI**: `partsAccess.ts`, `inventoryLocationsAccess.ts`, `inventoryCountAccess.ts`, `locationOccupancy.ts`. Non-obvious:

- `getLocationContents` caps at 200 (`LOCATION_CONTENTS_LIMIT`) and shows the exact total: uncapped, PostgREST `max_rows` clipped it silently — invisible on a 14-row seed, wrong on a 9,428-part shop. Archived parts excluded, matching the `inventory_location_occupancy` view.
- `bulkPutAway` — **one atomic RPC, never chunked** (a half-moved pile is worse than none); it moves whole balances, so N parts cost one request, not 2N — every *other* location-stock wrapper first loads the part's conversion context and sends **both** display and converted quantities, which is the second read that makes an ordinary stock write cost 2; the 1000-part cap sits in the RPC, not the UI.
- `occupancyFor` **zero-defaults** so render code never branches on `undefined` — an optional `?.hasStock` reads an *unknown* location as "empty", which is exactly how the roll-up bug comes back.
- `refreshSystemQuantities` reads the all-bin roll-up, so a shelf count using it flags variance on every row; `refreshLocationQuantities` is the per-place one.
- **`code` is gone (20260803034616).** The founder asked why a label printed a code when it already printed the name, and there was no answer that survived contact. `locationLabelPdf` laid out the QR, then the full path at 11pt black, then the code at 10pt grey — a second human-readable identifier one line under the first. And **nothing in the app could look one up**: no search, no filter, no `eq('code')`, and the scanner parses the UUID. The three defences all failed — "short enough to say out loud" (you would say *Shelf A*, and nothing accepts a spoken code), "survives a rename" (the QR carries the UUID, so it already did), and "matches codes stencilled on the rack" (a shop with that scheme would simply *name* the place `A-12`). Safe to drop rather than deprecate because no one had printed a label yet. The parent-prefixed zero-padded scheme in `locationSpec` (`CAB1` → `CAB1-R03` → `CAB1-R03-L`) went with it; the builder keeps its **name** planning, which is the half anyone reads.
- **`kind` left the UI in the same pass**, for the same reason one step earlier: its only consumer was the board's `unitKind`, which chose a drawing, and the board became a table. The column stays because `kind = 'system'` marks the `Unassigned` pile and `resolveFallbackPlace`, `excludeSystem`, the operator put-away split and the panel's action gate all key off it — but it is now set only by `inv_get_or_create_unassigned`, never by a person.
- `LocationScanner` is wired into the operator Scan tab and the put-away destination picker on the place-scoped count worksheet. **Not the owner's Storage board** — an earlier revision of this line said it was; grep says two references, both above. It reads our location labels only (parts have no barcode) and refuses foreign codes; its `zxing-wasm` `.wasm` is self-hosted, not from the library CDN, because the consumer is a phone on shop wifi.

### Flag · archive · dead code

**`inventory_locations`** ([`lib/featureFlags.ts`](../../lib/featureFlags.ts)) — opt-in, **default off for every tenant**, at `companies.settings → features`, toggled per company from `/admin`. Gates the Locations entry, the route, the operator Inventory tab and the auto-enrol trigger. Caveats: the operator bin *route* has no flag check, so a stale printed QR still resolves; `KNOWN_FEATURES` holds four keys — `inventory_locations`, `ai_insights`, `machine_maintenance`, `quickbooks_desktop` (earlier revisions said three, before machine maintenance; `data_import` was a fifth until data import became a global feature). There is **no `inventory_transactions` flag**, despite #550 and earlier revisions citing one.

**Archive** — `deletePart`/`bulkDeleteParts` → `archive_parts` stamps `deleted_at`, never blocking on references (architecture.md §16); children (conversions, balances) are kept and return on revive, transactions keep their name snapshots, and re-importing the same `part_name` **revives** rather than duplicating. `delete_location` differs: **empty** subtrees only, no delete-and-relocate.

**Dead/unreachable** — `removePartStockGraceful` · `enableLocationTracking`/`disableLocationTracking` (superseded by auto-track; both now billing-gated anyway, #645) · `enable_location_tracking_for_company`, `inv_location_path_label` · `job_materials`. Deleted 2026-07-29: `getLocationTree`, `buildLocationUrl` (duplicated `buildLocationScanUrl`), `bulkGenerateChildren`/`BulkGenerateModal` (Subdivide is a strict superset with live preview, and it had **zero tests**, so deleting beat porting), `PartLocationBalance`. Path-walking was reimplemented **five times** in TS plus once in unused SQL; **extracted 2026-08-06** to [`lib/locationTree.ts`](../../lib/locationTree.ts) (`computePathNames`, re-exported from `inventoryLocationsAccess` for existing importers). It lives in `lib/` rather than beside the access layer because that module builds a Supabase client at import time, so wanting a display path used to drag the whole access layer — and a `lib/supabase` stub — into every consumer and every test of one.

---

## 4. Target journeys

Numbered for citation. **Bold** = Phase 1 (shipped 2026-07-28, zero new tables). [§1a](#1a-who-does-what-and-where) is the actor map; this is *why* each is shaped as it is.

### **J1 — Seed the item master and opening balances**

Owner imports what he stocks, with on-hand, unit and reorder point. **Built 2026-07-28** in both [import flows](data-import.md); previously unimportable, contradicting PRD **FR-16**.

- Each imported balance writes an `adjustment` row for provenance — `abs(delta)`, direction in the notes, since `CHECK (quantity >= 0)` bars a signed delta; none when nothing moved.
- Location-tracked parts get no `quantity` write (balance rolls up from `part_location_stock`); the skip is *reported*, not silent.
- Two importer bugs fixed with it: unconditional `parts.quantity` writes, where an unmapped column's explicit `0` zeroed stock on re-import, tripped `enforce_tracked_part_quantity` and **failed all 500 rows of the upsert batch**; and `PART_FIELDS`/`PART_SCHEMA` drift (phantom `category`, missing required `primary_unit`).
- Quantities flow through **Review & Fix** like every other column, and it should surface what the data can actually tell you — how many rows carry a quantity at all, which look stale against a last-edited date, which are zero versus blank versus missing. **Not built; the importer range-validates only.**
- Previously: land quantities in a count sheet's *expected* column so a human counts first — withdrawn because **Review & Fix already is** the verification step, and it coupled two independent features.
- Assume the figures are wrong: Contour's legacy `onHand` was filled on **43 of 9,428 rows (0.5%)**, freshness unknowable. An import is a starting position, hence [J9](#j9--count-it); a periodic lighter **reconciliation** pass is deliberately unspecced.

### J2 — Say where something lives

Anyone naming a place as they need it. **Closed (Phase 2, 2026-07-30):** permanent board of real places (fill state, "Add storage" tile), `LocationPicker`'s *"Create «name»"* inside the where-is-it field, batch put-away, label scanning; the wizard demoted to an optional *"Subdivide this unit"*. Create-on-the-fly waited on the sibling-name unique index — a bare freeSolo field is what produced `ST0CK` beside `STOCK`, now structurally prevented. [§5.5](#55-locations-keep-them-visual-change-when-they-appear).

### J3 — Estimate material cost on a quote

Quoter. **Built** — `parts_bom` + `part_procurement_tiers` + yield (`consume_whole_units`, `costing_batch_quantity`) via `compute_part_cost_at_qty`. Here for the boundary only: quoting reads *cost*, never *availability*, and reserves nothing ([§5.7](#57-quoting-never-touches-stock)).

### **J4 — Job kickoff material check**

Owner/scheduler asking *"can I say yes to this rush job now?"* — validated 2026-07-27: Contour stocks for rush work, so speed beats precision and there is real stock to compare against. **Built 2026-07-28:** `JobPartMaterialsCard` shows **Needs · On hand · Issued · Short by**, derived on read — no tables, and [kitting catches shortages pre-production](https://www.globalshopsolutions.com/blog/kitting-and-pre-stage-with-erp-to-boost-throughput).

- Three limits, all on screen: **top-level materials only** (`parts_bom` is recursive, this compares one level; recursive explode is next); **no "on order"** (no POs until Phase 3 — an always-empty column trains people to ignore the row); **one job vs the whole shop's stock** (two jobs each needing 10 against 15 both read "not short").
- Unconvertible units are **blank, never zero**: `convertToBaseUnit` returns the unconverted number with a warn ("plenty" for 4 ft against 120 in), so the read path uses `getConversionFactor` and `undefined` renders a "Can't compare units" chip.
- The shop-wide **"Short for this week"** roll-up was built and verified, then deferred to Phase 3 (**#571**) — no next step without [J5](#j5--buy-it). Restore from `87df208` (`getShopMaterialShortages`, `rollUpShortages`, test pinning on-hand-counted-once).
- ⚠️ That removal **left a live 404 in production for ~2 months** — the *"N short"* chip and `Header.tsx` still pointed at the deleted `/inventory/shortages`, **and its test asserted the href**. Fixed 2026-07-30 → `/parts?status=low` (§5.12's merge supplied the lens). Two lessons nothing automated catches: deferring a feature means removing its entry points, and a test asserting a URL proves the string, not the route.

### J5 — Buy it

Owner/admin: shortages become a vendor-grouped buy list → PO with expected date, its quantity reading as **on order** in J4 so nobody buys the same bar twice. **Missing** — no `purchase_order`/`on_order` in the schema; `parts.preferred_vendor_id` is a label only since migration `20260714173443`. This **is** issue **#571** (multi-vendor cost sheets, RFQ, POs, approved vendors, bulk UoM) — merge, don't parallel.

### J6 — Receive it

Admin/shipping clerk — a PRD persona (*"Receive inbound materials"*) with no screen. Match the PO, record what came, capture **heat/lot** + **cert PDF**, print a tag, put it away. **Missing**; closest is `OperatorReceivePartModal` (bin stock-in; no PO, vendor, cost, lot, cert). The tag is human-readable, **not** a second scannable object ([§5.3](#53-the-location-is-the-scan-anchor)).

### **J7 — Issue material to a job**

**The operator, on the floor** (validated 2026-07-27 — not owner, not admin). **Built:** consumption recorded **at the bin, tagged to the job** ([`OperatorLocationActionModal`](../../components/operator/OperatorLocationActionModal.tsx)) — over-consumption clamps to zero, flags `has_discrepancy`, stamps the operator; J4 reads it back as "issued". Issue **#59**'s regressed job selector was restored 2026-07-28 on both stock engines, with the test that should have existed in March.

**97 of 121** legacy "locations" were job/work-order/part numbers — the link built by hand, in the wrong field, at scale. It proves the *link* is wanted, not where the operator starts.

**Job-first entry (traveller → needs → tap to take) was built and removed the same day, 2026-07-28**: the evidence was over-read; it contradicted [§5.2](#52-is-a-job-a-place--resolved-no), rejecting job-as-container while keeping its UI shape; [Sortly's Jobs](https://www.sortly.com/blog/new-feature-alert-jobs/) validates the motivation, not the mechanism (a container, with the close-out we declined); it made two write paths for one fact ([§5.8](#58-the-ledger-is-append-only-and-non-authoritative)); and it sat on the unadopted traveller. Accepted loss: an automatic job link rather than an optional field people forget. **REOPEN IF** the tag is routinely skipped (count depletions with null `job_id`) or a shop starts staging material against jobs.

#### This journey *is* consumption tracking

The earlier separate J9 (issue **#550**) is folded in — the take-record *is* the consumption, and confirming again at operation completion would restate it against a complete-only UX ([`operator-view.md`](operator-view.md#status-model)). Shipped 2026-07-28, **no new table**: a depletion row tagged `job_id`, expected from the live BOM, actual their sum, variance on read; `job_materials` not revived ([§5.9](#59-job_materials--resolved-drop-it-consumption-backs-onto-the-ledger)). **#550 closed by folding in, not as written** — it specified an operation-completion step behind an `inventory_transactions` flag that never existed, and named the wrong actor. **Deliberately not delivered:** "issued" is job-level, not job-part-level (no `job_part_id`), so two parts drawing one material show the same figure — hence *"issued to this job"*; one nullable column + index fixes it, omitted to keep Phase 1 migration-free. Reopen a separate confirmation only for variance the take-event can't express (consumed by one operator, reconciled by another).

### J8 — Cut it, return the remnant

Operator at the saw returns the drop to a place with its **remaining length**, findable before the next bar is opened. **Missing** — the most shop-specific gap and clearest cash value ([reuse instead of scrap](https://www.peptechnology.com/product/inventory-management/)). Mirror the habit: machinists already [mark both ends and re-mark the cut end](https://www.practicalmachinist.com/forum/threads/solution-for-raw-material-inventory-management.404375/).

### **J9 — Count it**

Whoever is assigned, on a schedule or on distrust of a number. **Built 2026-07-28** at `/dashboard/{companyId}/inventory/count`: pick parts, then a **count sheet** (*Part · Recorded · Counted · Change*, tabular figures, change as you type). Save commits — no confirm, no review; both restated numbers just typed. **Place-scoped 2026-07-30** via `?location=<id>` from a tile, sheet or scanned label, because you walk a shop bin by bin ([§5.11](#511-design-for-the-sustain-not-the-setup) asked for it).

**Made reachable 2026-08-01** (#646), after the founder looked for it and concluded it did not exist — a fair reading, since both doors were on the Storage board and enabling locations *removed* the Parts toolbar button. Now: **Count here** on every balance row of the part page including zero rows, an unconditional Parts toolbar entry (`?from=parts`), a one-part-at-one-place sheet (`?location=&part=`) that also makes the excluded-part chips land where their own copy promised, real **pagination** past `LOCATION_PAGE_SIZE` (the 100-row cap made `Unassigned` — every stocked part, by the auto-track trigger — impossible to work through), and **"Found something not listed?"**, which adds a part the bin read cannot return because the part has no row there at all. `loadPartAtLocationCandidate` READS the balance rather than assuming 0: counting 0 against an assumed 0 is a zero delta, and `committableVariances` drops it, so confirming an empty shelf would commit nothing.

**Counting a part in EVERY place it sits, 2026-08-01** — `?part=<id>` with no location: one sheet, one row per place, each row targeting its own location, so `commitCount` routes every line to its own shelf. Reachable from **Count all N places** on the part page.

**A count row IS (part, place), 2026-08-02.** The founder on the held-back notice: *"this is silly... many parts will be in many places."* That is the right reading, and it retired an entire arm of the model. A split part used to be kept **off** the company-wide sheet — a single total has no unambiguous home, so `resolveCountTarget` returned `excluded` and the picker named it with a chip per place. The sheet no longer asks for a single total. It asks for a number per place, so the ambiguity is not resolved: **it is never posed.** `CountTarget` collapsed to one shape, `excluded` and the two partitioners that served it are gone, and the notice with them.

The two steps are deliberately **different grains**, which is the one judgement in this change worth arguing with. The *picker* stays one row per part ("count this one wherever it is") — it is unbounded, unvirtualised and filtered in the browser, so one row per (part, place) would have multiplied it for no gain, and made a 20-part shop read *"Count 40 parts"*, which is the same species of nonsense as the notice it replaced. The *sheet* is place-grained, grouped under a part header carrying a read-only subtotal. **The header has no input, on purpose** — a total field there would rebuild the 38-against-10+20+10 bug behind a UI now promising it works.

**The row rule, and the two simpler rules that were both wrong.** One row per place holding stock, plus exactly one row at the system bucket when a part holds stock nowhere. Emitting a row per balance *row* used to fill the sheet with the zero residue `transfer_stock` and `bulk_put_away` left behind forever — a live absolute write target on a shelf the part had left, which makes a count worse than not counting. Filtering to `> 0` alone deletes the opening count, because every stocked part was seeded at `Unassigned` with 0, so a first-time count would find its whole catalogue missing — and *"the system says zero and I am holding twelve"* is the count that matters most. On the seed's 14 stocked parts the three rules gave 18, 11 and 15 rows; the middle one dropped 4 parts.

**Half of that is now moot, and deliberately so — 20260802144310 (#657).** The residue is deleted, every producer deletes-at-zero instead of parking a 0, and `part_location_stock` CHECKs `quantity > 0`. **A row means the part is there**, so "rows that exist" and "places holding stock" are the same set and the four `.gt('quantity', 0)` filters that stood between them are gone. CLAUDE.md's *no silent runtime fallbacks for data-at-rest issues* is what forced it: one of those filters said in its own comment that it was papering over bad data, and four filters over one unfixed invariant is exactly the accumulation that rule warns about.

The fallback arm survives and is now the only subtlety left: a part holding stock nowhere has **no balance row at all**, and is reached through `resolveFallbackPlace` reading the company's `kind = 'system'` bucket from the *locations* list. The tempting guard — "delete zero rows except a part's last one" — was rejected as both unnecessary (20260802015837 asserts only the rollup, which a row-less part satisfies trivially; 30 parts already had none) and harmful, since sparing rows is what keeps *a row exists* and *the part is here* out of step.

> **The bug the naive version would have armed, reproduced before writing the migration.** `trg_auto_track_stocked_part` is `AFTER INSERT OR UPDATE **OF is_stocked**`, and `updatePart` sends `is_stocked` on every save — so it re-runs when someone merely renames a part. Its `ON CONFLICT DO NOTHING` was being satisfied by nothing except the part's own leftover zero row. Delete the residue without fixing the trigger and the next rename re-inserts the part's whole quantity at `Unassigned` on top of the stock already on its shelf: **580 → 1160**, silently, with no ledger row to recover from. Hence the migration fixes every producer *before* it deletes a single row, and [`test_balance_rows_are_holdings.py`](../../api/tests/integration/test_balance_rows_are_holdings.py) pins it — the constraint cannot, because both the row and the rollup stay internally consistent, just consistently wrong.

**"+ Count it somewhere else"** sits under each group: an affordance, not a picker step, because on `?part=` the user already chose the part. It goes through `loadPartAtLocationCandidate` (which READS the balance, so a place the part has never been in is countable), is idempotent on `countRowKey`, and deliberately touches neither the URL nor `serverSearch` — the loader effect depends on both and calls `setEntries({})`, so either would silently wipe every number typed so far.

This forced `CountEntries` off part-id keys onto **`countRowKey`** (`partId::locationId`, unconditional since every row has a place). Keyed by part alone, two rows for one part shared a single number — typing 800 for Shelf A silently committed 800 to Shelf B against a different recorded quantity. The same root cause produced a React duplicate-key warning on the sheet rows and made the pre-save re-read fetch composite keys instead of part ids. Three further part-id keys survived in the page until 2026-08-02, invisible while a part could only occupy one row: the one-part sheet seeded `selected` by bare part id, the "already on the sheet" guard probed a row-keyed map with a part id (so it had **never once fired**, and re-adding a part silently overwrote its typed count), and `candidates` deduped by part.

The pre-save re-read now fetches **every place of every counted part** in one batched read, rather than one request per bin. It is measured against each row's own place — never `parts.quantity`, the roll-up across every bin, which would report a variance on every line. Reading by part also lets it see a place the sheet does *not* hold: if a part gained stock somewhere mid-count, that is named afterwards. Deliberately **not** blocking — leaving a place blank leaves it untouched, and *"I only walked Shelf A"* is the normal case.

The same PR fixed **live data loss**: `save()` built variances by mapping over `candidates`, which is replaced whenever the server list changes, so a number typed for a part that then fell out of the result set was silently never committed. The sheet now holds chosen rows by value. **Recurring** and **assignable** stay unstarted. It is the ritual keeping the others true — the PRD's *"100% inventory accuracy within 3 months"* is unmeasurable without it — and carries [QR-label maintenance](https://www.sortly.com/blog/how-to-label-inventory/).

**Put-away is the same surface:** a destination picker and *"Put N away"* sit beside *"Count N parts"*, so at `Unassigned` this empties the pile `trg_auto_track_stocked_part` creates (§5.5 decision 8 — Contour's gate); a planned separate put-away page would have duplicated it. Bin scope needs its own read (`getLocationContentsPage`): `Unassigned` holds every part a shop owns, against a 200-row cap with no search. Counting commits line-by-line with per-line failures (line 50 must not void 1–49); a move is one atomic RPC (`bulk_put_away`), a half-moved pile being worse than none.

**Wording and layout.** Headers are **Recorded/Counted** — not *On hand* (collides), *System* (product-speak) or *Expected* (Sortly's; primes toward confirming the record); the delta is **Change**, not *Variance*; the noun is **"inventory count"**, never *cycle count* ([Unleashed](https://www.unleashedsoftware.com/inventory-management-guide/cycle-count-inventory/)), *audit* ([Fishbowl](https://www.fishbowlinventory.com/blog/inventory-audit-a-comprehensive-guide-with-best-practices-and-procedures)) or "stock count" — jargon, or a second word for the nav item; the one exception is the per-part **Stocked** flag. Older ledger rows keep the old phrasing. The column sheet beat inline `5 → 7`, a one-at-a-time card + numpad (deferred: Phase 2 phone surface) and tap-to-confirm (too easy to press unlooked) as the only layout [scannable at forty rows](https://www.stockount.com/articles/how-to-do-a-cycle-count). Units show once in the footer when uniform, per-row when mixed.

**Two first-use failures worth keeping besides the review page:** the count field didn't read as a field at all (an outlined input with a floating label and no value looks like a static chip), and *"1 item needs adjusting. 0 matched"* was accounting language nobody in a shop has a model for.

**Wrong twice:** built literally as three screens (*Scope → Sheet → Review*) — design a journey, not a data flow; then over-corrected by dropping **scope** too, when that critique was about *ordering* and took the *bounding* value with it ("these five, then I'm done" versus a wall of inputs reading as a form to complete).

Two deviations from spec: **no count-session table** (localStorage, so Phase 1 adds none — giving up assignment and cross-device resume, which Sortly built a server lifecycle for citing *"lack of accountability"*, a multi-counter problem this shop lacks); and **item-scoped**, since `inventory_locations` is default-off and place-scoping would have made Phase 1 depend on Phase 2 — resolved since by `?location=`. Both deviations are now closed. `resolveCountTarget`'s four-way commitment is gone with them: the `untracked → parts.quantity via adjustPartStock` arm died with `is_location_tracked` (20260802015837) and the `excluded` arms with the (part, place) row above, leaving one decision — where does a part holding stock nowhere get counted? — as [`resolveFallbackPlace`](../../lib/inventoryCountPlan.ts). It resolves the system bucket by **`kind`, not the name "Unassigned"**: `isReservedKind` stops anyone typing `system` into a kind, while nothing stops them renaming one. A company without one **throws** rather than quietly shortening the sheet — every company has had one since 20260802015837 created and asserted it, so its absence is a data fault, and a dropped part hides behind a shorter list nobody counts.

**Nothing judges the size of a change.** A 50% proportional threshold, on the finding that [~30% of large variances are count errors](https://www.getonecart.com/cycle-counting-inventory/), fired on nearly every line at small-shop quantities (7 on hand, 3 found) and stopped informing. The finding is probably sound; **percentage-of-quantity is what failed** — value moved (`cost_per_unit × delta`) would scale across a $2 bearing and a $2,000 casting, but the figure is **open for discovery**. Safety doesn't rest on it: recount to fix, and every line writes an `adjustment` row naming both numbers. Quantities are re-read just before the write — not as a gate (adjust sets absolutes) but because the note records *"system said X"*; mid-count movement is reported after.

**Both doors are normal:** trustworthy figures → import ([J1](#j1--seed-the-item-master-and-opening-balances)); unknown quality → import then count; nothing usable → count only, that first session *being* the opening balance. Contour is the third (`onHand` on 43 of 9,428 rows; `price1` 88% full, `custCode` 51% — a quoting catalogue, not an inventory record) and **has counted before**, so this rescues a lapsed practice rather than teaching one — though a failed prior attempt raises the bar (§5.5). First run and hundredth are **one flow**; an onboarding-only mode is a second code path that rots.

### J10 — Don't run out

Owner: below the reorder point an item lands on the buy list, on-order visible so nobody double-orders. **Partial** — `parts.reorder_point` and `deriveStockStatus` (In stock/Low/Out) exist, surfaced by the shortage lens on the parts page; email, a real buy list and any concept of on-order do not.

**2026-08-01:** `/parts?status=low` grew **Reorder at** and **Short by** columns (`shortfall()`, derived like `deriveStockStatus` so the two cannot disagree; **0 at equality**, because a part sitting exactly on its line is on the buy list). `?status=out` gets **Reorder at** only — "short by" there would restate the reorder point on every row. That is the worksheet half of a buy list, not the buy list: no vendor grouping, no PO, no on-order.

**2026-08-02:** the header alert badge was **removed**, and with it `getLowStockPartsAlerts` and its scan bound. The badge's low-inventory list was a second, weaker rendering of the same predicate the shortage lens already draws — and the lens is the surface a buy list would grow out of. So the shortage lens is now the only low-stock door, which also settles two thirds of the doc conflict below.

**Doc conflict to settle:** PRD **FR-2 is a `Must`** (dashboard *plus* email); this doc calls it a `Should`, partly delivered, and plans to hide it behind the non-existent `inventory_transactions` flag. ([`ai-insights.md`](ai-insights.md) no longer claims the badge as built — that line went with the badge.) FR-2 now rests entirely on the shortage lens, with no notification of any kind.

### J11 — Find it

Anyone. **Built 2026-07-31** on the operator Inventory tab — the third status this journey has had, so the history is worth keeping: *"built, and it works"* (wrong, the office half only), then **not built** (right), now built on both sides.

[`OperatorPartLookup`](../../components/operator/OperatorPartLookup.tsx) reuses the same `PartAutocomplete` quotes and jobs use, with `kind="stocked"` and **no** `onCreateNew` — creating parts is not an operator's job. A bespoke search box was written first and thrown away: it showed nothing at all until a minimum-query floor was cleared, so the screen looked broken while working correctly. `openOnFocus` plus the shared spinner fixes that structurally.

**No migration and no policy change was needed** — `parts`, `inventory_locations` and `part_location_stock` all have membership-only SELECT with no role predicate. Only the UI was missing.

Three answers, which a first cut collapsed into one and got wrong (it showed *"240 ea across 1 place — Unassigned"*, presenting the put-away pile as a shelf):

| State | Answer |
|---|---|
| Not location-tracked | The on-hand total, and *why* there is no shelf. Never "nowhere" — that reads as missing. |
| Tracked, sitting in `Unassigned` | Called out first and separately: *"N not put away yet."* |
| Tracked, on shelves | Each place with its full path and quantity; zero-quantity pass-through rows excluded, or the count sends someone to an empty shelf. |

---

## Considered and cut

Two journeys specced, then cut **2026-07-27**; kept without numbers, outside J1–J11, so they aren't re-proposed.

| Cut | Why | Consequence | Reopen if |
|---|---|---|---|
| **Traceability** (heat numbers, certs) | Contour keeps neither; no regulated customers | Kills the lot/cert layer [§5.6](#56-lots--resolved-dont-build-them) made Phase 4's spine. **No lots**: stock is a quantity of an item at a place. [J8](#j8--cut-it-return-the-remnant) remnants must justify themselves on material cost alone; [J6](#j6--receive-it) is delivery-vs-PO matching only — no cert, heat field or attachment. | An aerospace/defense/medical customer appears — a real build, not a toggle. **Widened 2026-08-01** ([#642](https://github.com/debola31/Jigged/issues/642)): also fires on a **prospect** needing it during customer-#2 acquisition, which is likelier to come first and arrives as a deadline rather than a request. Contour itself still does not want it. [Heat-lot research](https://precisionam.com/articles/quality-compliance/aerospace-precision-machining-traceability/) stays cited in J6. |
| **Customer-supplied material** | Frequent on service one-offs but **never stocked**: arrives with the job, leaves with the part — no balance, nothing to count. A *job* attribute; an ownership flag would have crossed every read path (on-hand, reorder, counts, buy list) for something that never behaves like stock. Same test as job-as-place, [§5.2](#52-is-a-job-a-place--resolved-no). | Survivor in [J4](#j4--job-kickoff-material-check): a service job whose BOM lists customer material shows a false shortage. Whether such lines exist is open in [§9](#9-what-we-know-and-what-we-still-dont); if so, exclude on the BOM line or job — never on stock. Doesn't block Phase 1. | It starts being *stored* between delivery and use. |

---

## 5. Design decisions

### 5.1 Material moves through jobs by default

Ad-hoc add/remove/adjust stays (PRD Open Question 2); job-linked is primary and the UI says so. Validated: Sortly — visual, mobile-first, not an ERP — shipped [Jobs, 22 Jul 2026](https://www.sortly.com/blog/new-feature-alert-jobs/) after years of resisting, from our before-state (usage written on paper or forgotten) for J4 + J7's payoff (billing accuracy, no double-purchasing). **Principle:** prefer data that self-corrects as a by-product of work (issue-to-job, receive-against-PO, scan-at-bin); bookkeeping-only affordances get abandoned.

### 5.2 Is a job a *place*? — **RESOLVED: no**

2026-07-27: Contour's operator grabs material at job start; nothing is parked against a job first. Locations stay purely physical; **J7 is a straight depletion carrying `job_id`** — no virtual nodes, no job-container, no `transfer_stock` reuse. The spec's largest fork, on the cheaper branch; forgoes staging/kitting, shortage-at-kitting, return-on-cancellation. **Reopen if a shop stages material** — Sortly's job-as-container is then right.

### 5.3 The location is the scan anchor

Shop-stated: the only locations work with explicit demand. `buildScanUrl` encodes the company and location UUIDs as base32 into `/L/{code}`. **No competing QR-on-lot path** — lot identity resolves *at* a scanned location; receiving tags stay human-readable (heat, item, PO).

### 5.4 One stock engine

Two engines (§3) — one atomic, one a client-side race, chosen by a boolean — is the deepest debt. **Collapse onto the RPCs** (PR #446: a part left at `Unassigned` behaves exactly like a global-quantity item, so the location path is a strict superset); blocker is that the flag then becomes the data model with an `Unassigned`-only default, so it needs its own PR. **Re-dated after J7 (2026-07-28):** J7 made the non-atomic path the highest-frequency write, run concurrently, so the exposure is **lost update**, not just crash-between-round-trips — two operators each take 5 from 100, stock lands at 95 not 90, with two correct-looking ledger rows. Contour is safe (flag on → atomic `FOR UPDATE` RPC); a flag-**off** shop with two operators is not. One `deplete_part_stock` SECURITY DEFINER RPC mirroring `deplete_stock_at_location` closes it without the collapse.

### 5.5 Locations: keep them visual, change *when* they appear

Contour's legacy ERP locations (exported 2026-07-27, **121 rows**) are the spec's best evidence — behaviour, not self-report: 46 job numbers, 45 bare work-order numbers, 6 part numbers, 3 dated `MISC`, **22 actual places**.

1. **118 of 121 flat**, despite a `/` separator ([MRPeasy convention](https://www.mrpeasy.com/resources/user-manual/stock/settings/locations/)) — the multi-level wizard solved a problem they never had. Their behaviour, so the strongest argument here.
2. **Free text decayed:** `STOCK`/`ST0CK`, `JEFF'S DESK`/`JEFFS DESK`, `J-52818-01`/`J52818-01`, 3 dated `MISC` — [the #1 documented failure mode](https://craftybase.com/blog/bin-location). Create-on-the-fly only with aggressive dedupe.
3. **97 of 121 (~80%) aren't places** but job/WO/part numbers — J7 hand-built from the wrong primitive, nothing else expressing job↔material allocation.

A **modelling** failure, not usability or maintenance: one field, two unconstrained concepts. Corrected priority — the missing job↔material link (Phase 1) caused most of the mess. 22 ≈ the founder's ~10 (±4); several (`0-5`, `3/8 DRILL BLK`) are tooling sizes, so **12–18** is real. Research favours visual ([photos](https://www.sortly.com/blog/why-photos-are-vital-in-inventory-management/), [facility maps](https://www.cyberstockroom.com/warehouse-location-mapping-software), [5S](https://resources.duralabel.com/articles/5s-floor-marking)); the objection was to timing.

| # | Decision — all ✅ built (Phase 2 / 2026-07-30) | What must survive |
|---|---|---|
| 1 | Board is the storage home screen, not a preview seen once | Unit is one tap target: 6px compartments at the 48px floor would make a 5-row×2-side cabinet a ~500px tile. Fill state **rolls up**, else a full cabinet reads empty. Missed `Unassigned` (→ 8). |
| 2 | Incremental setup, create inline | After 7, inline create being finding 2's freeSolo mechanism. `LocationPicker`'s "Create «name»" is suppressed when the name exists, matched as the index compares. Creates flat — name is identity, QR carries the UUID. |
| 3 | Wizard survives only as **Change layout** on an existing unit | Reaches `VisualLocationBuilder`'s dormant `parentId`. Tested trap: `STORAGE_TYPES` level 0 *is* the container (→ `Cabinet 3 › Cabinet 1 › Row 1`), hence separate `SUBDIVISION_TYPES`. **"Re-subdividing must continue numbering (Row 4–6)" is WITHDRAWN — 2026-08-15.** It was true, tested, and was the bug: a control called `Change layout` that can only number past what it finds cannot change anything. Continuation survives only where "beside" really is the intent — `Add storage` at the root, and `duplicateSubtreeAsSibling`. See [§5.13](#513-change-layout-changes-the-layout--2026-08-15). |
| 4 | Palette fixed | 10 kinds (7 + flat *floor space*, *outside/yard*, *bench*): with 118/121 flat, structures-only forces "on the floor by the saw" into a cabinet. **Withdrawn:** "a bar rack is the defining storage object in a machine shop" — Contour's 22 places contain none (§9); open question, card out until a pilot asks. |
| 5 | Fill state = the [two-bin kanban](https://businessmap.io/blog/two-bin-kanban-system) signal | **Empty-vs-has-stock only, never a percentage** — capacity is unknown and "72% full" is the invented number that costs credibility. **Withdrawn 2026-08-10:** photos of the *place* (`inventory_locations.photo_path`, drawn above the compartments — photo = identity, compartments = fill state). Built, then never used once: **0 of 313 locations** ever carried one and the bucket held **0 objects** under any `{company}/locations/` prefix, so the column and its UI are gone. What the shop actually wants photographed is the *material*, which lives on `inventory_transactions.photo_path` and stays. **Independent of that withdrawal and still true:** building it is what exposed `storage.objects` having **no SELECT policy** in migrations — every attachment unreadable on local stacks and previews, fixed by [`20260730021430`](../../supabase/migrations/20260730021430_storage_read_policy_under_migration_control.sql). |
| 6 | Flat default | **CLOSED by 3** — subdivide-on-demand *is* opt-in bins ([Katana](https://support.katanamrp.com/en/articles/8340252-basics-of-storage-bins) makes bins opt-in inside a location; [MRPeasy](https://www.mrpeasy.com/resources/user-manual/stock/settings/locations/) has no nesting, names locations `"Room 1, A1"`). `parent_id` nullable → UI, not a migration. Was "revisit". |
| 7 | Names dedupe; codes deliberately don't | Finding 2 is all **names**: unique index on `lower(btrim(name))` with a NULL-safe parent sentinel, plus backfill — a plain `UNIQUE (company_id, parent_id, name)` leaves top-level rows unconstrained, NULLs comparing distinct — plus a live "already has a Shelf A" warning, nothing exact catching `ST0CK`. Codes unconstrained: nothing resolves by code, and an index could fail mid-run in `materializeLocationSpec` (no longer true since 2026-08-10 — that path is one transaction — but codes went entirely in 20260803034616, so the question is moot). |
| 8 | "Put these away" — batched move out of `Unassigned` | `trg_auto_track_stocked_part` guarantees a system `Unassigned`. It once held a row for **every stocked part**, which is what made this the likeliest repeat of attempt 1's failure (§9.3) — but [`20260802144310`](../../supabase/migrations/20260802144310_prune_zero_balance_rows.sql) pruned the zero-balance residue and added `CHECK (quantity > 0)`, so a row now means the part is actually there. Contour's `Unassigned` holds **57** rows (measured 2026-08-08), not the 9,428 this line used to claim — that is the *parts catalogue* count from §9, a different denominator. The pile this empties is real but small; keep the tool, discount the urgency. Moves **all of part X** (partials have `transfer_stock`), which kills quantity, conversion and a per-part read: one request for N parts vs 2N looped. Search-driven selection inside J9's place-scoped worksheet, not a new page. `bulk_put_away` is one atomic RPC, DB-capped at 1000 parts to bound `part_location_stock` locks, and the wrapper **never chunks**. **Rollout gate CLEARED**; flag stays opt-in. |
| 9 | Thing-first sequencing | **CORRECTED 2026-07-30: previously "the company whose whole product is visual inventory doesn't lead with a storage hierarchy", from two Sortly pages; withdrawn — neither supports it.** The [labeling guide](https://www.sortly.com/blog/how-to-label-inventory/) labels *items*, never shelves (silence read as evidence = category error); the [stockroom method](https://www.sortly.com/blog/how-to-organize-a-stockroom/) *prescribes* hierarchy, down to *"post maps, charts… that show exactly how inventory should be stocked."* Survives: onboarding *order* only; the flat default rests on 118/121. Visual thread thereby *promoted* — photographed flat places **are** that map (backs 5, #421). **Withdrawn 2026-08-10 with decision 5:** places are not photographed, so this leg is gone; the flat default still rests on 118/121. |

**Reshaped 2026-07-30 — the page contradicted §5.11 ("design for the sustain, not the setup") and shipped anyway:** every toolbar control was setup.

| Amendment | Why |
|---|---|
| **One** way to add storage: the in-grid tile's form (amends 2, 3) | `Build visually` called the identical function; multi-level survives only as Subdivide |
| ~~**List view cut**, `LocationTreeView` deleted (amends 1)~~ → **both are gone, 2026-08-10** | The list lost to the board, then the board lost to a table, then the table lost to measurement. The premise under all three — that a shop has 12–18 places — was **wrong by an order of magnitude**: Contour has 237. Storage is now a list of *units* that opens a *drawn* unit, which is the shape the original board argument wanted and the flat-shop data never justified. |
| **Scan** moved to an operator tab-bar action | You scan at a shelf; one scanner resolves location labels *and* job travelers |
| ~~**`Count all parts`** lands here~~ → **removed 2026-08-10** | `/inventory` folded into Parts, leaving no sibling page — so it landed on Storage by elimination rather than because anyone audits a whole shop that way. `Adjust` on a unit replaced it with the scope people actually use, and `Count Inventory` on the Parts toolbar still holds the shop-wide door. |
| ~~**Photos are a place's identity** (amends 5)~~ → **withdrawn 2026-08-10** | Unphotographed tiles got a passive glyph; the tile is one tap target. Cut with the feature — 0 of 313 places were ever photographed, and what the shop wants photographed is the material, not the shelf. |
| Sidebar says **Storage** | In [Sortly](https://www.sortly.com/business-inventory-app/)/Katana/MRPeasy "locations" means sites/warehouses; Jigged is single-site |

Under full material control locations get *more* load-bearing: a remnant is a physical thing in a place, and *"is there a drop I can use"* is a spatial query.

**#421 (3D diorama) — spiked 2026-07-30; three findings outlive it.** (1) Cost rules out real 3D: gzipped `three` **123 KB**, +`@react-three/fiber` **230 KB**, +`drei` **289 KB** on the least-frequent screen, against **~1.4 KB** of inline-SVG isometric with zero dependencies. (2) CSS 3D flattens silently inside our own chrome — `overflow:hidden`, `opacity<1`, `filter` or `backdrop-filter` on a `preserve-3d` root each collapse the subtree while `getComputedStyle().transformStyle` still reports `preserve-3d`; `StorageUnitShell` and our `backdrop-filter` cards hit it today, and the matrix is **Chromium-only — the WebKit run never completed, and operators are on iPhones**. (3) Depth buys recognition, spends legibility (labels collide, back rows occlude front). Post-photos the schematic's only jobs are fill-state canvas and pre-photo placeholder, both already done flat — **the falsifier: if so, an isometric is decoration on a setup screen.** (**Note 2026-08-10:** place photos were withdrawn, so the "post-photos" premise no longer holds; the conclusion survives on findings 1–3, none of which depended on it. #421 stays closed.) Also corrected: "no stored geometry" is a product choice (a stored layout drifts once a cabinet moves), not a technical wall — and depicting a *kind* is a `kind` → shape lookup, **not** geometry, so the small version of the idea never touches the invariant.

**Drag-to-reparent: cut** — 118/121 flat serves no hierarchy, and the house pattern is arrow buttons (routings); if ever wanted, a "Move into…" `Autocomplete` over cycle-guarded `moveLocation`. **The picker that answered this was itself removed 2026-08-10** ([§5.12](#512-two-nouns-parts-is-what-we-have-storage-is-where-it-lives--2026-07-30)); the finding stands, its remedy does not. **Withdrawn 2026-07-31:** previously also "drag on a shop tablet is the most failure-prone interaction available" — withdrawn because there is no shop tablet; setup happens at an office computer with a mouse ([device model](../../CLAUDE.md#who-uses-what-on-what--the-device-model)). Two legs, not three, and the same false premise was used against a drag-to-place floor plan for #421, so that falls too. Still against a facility map: its value scales with what you *can't* see from where you stand, and 12–18 places are learned in a week.

### 5.6 Lots — **RESOLVED: don't build them**

The earlier draft put a lot layer between item and location (heat/lot as a quantity at a place; a remnant as its child lot), so traceability *and* remnant reuse fell out of one shape. **Contour keeps no certs or heat numbers and serves no regulated customers (validated 2026-07-27)** — no justification *then*. Stock is a quantity of an item at a place, nothing between. Knock-ons: **J8 remnants must stand alone** (an explicit remnant concept, worth building only once they're confirmed to reuse drops); customer-supplied material needed no lot either and was cut outright, never being stocked.

> **The finding stands for Contour. Widened 2026-08-01 — [#642](https://github.com/debola31/Jigged/issues/642).**
>
> Re-checked directly: Contour keeps no traceability, does not use it, and **does not want it**. So
> nothing above is qualified — the 2026-07-27 validation holds, and this stays cut.
>
> What is new is not a Contour want but a **product** one: the founder rates lot tracing a
> nice-to-have, and it may be required by **customer #2**, whose acquisition is the current focus.
> That widens the reopen trigger from *"an existing regulated customer appears"* to include **a
> prospect who needs it during a sales conversation** — a real distinction, because the second is
> the one likely to arrive first, and it arrives as a deadline rather than a request.
>
> Unchanged: it is a data-model change (a third dimension on `part_location_stock`, which is
> `UNIQUE(part_id, location_id)` today) belonging with **[J6 Receive](#j6--receive-it)**, where
> heat/lot and the cert PDF are captured. Nothing shipped forecloses it; every addition is additive.

### 5.7 Quoting never touches stock

Quotes read material *cost* only — never availability, never a reservation. Reserving against
speculative work would corrupt on-hand. Recorded so nobody "fixes" it.

### 5.8 The ledger is append-only and non-authoritative

`inventory_transactions` is truly append-only (`restrict_transaction_update_to_notes` leaves `notes`
the only mutable column) but is **never replayed**; `parts.quantity` and
`part_location_stock.quantity` are the authoritative balances, written alongside. It reads like event
sourcing and isn't — authoritative ledger = deliberate re-architecture with a reconciliation job, not
a drift.

### 5.9 `job_materials` — RESOLVED: drop it; consumption backs onto the ledger

Its retirement migration kept it as "a per-job expected-BOM snapshot"; neither ground survives.
**Deletion resilience:** no — universal archive keeps the row, by-id reads resolve it. **Drift
resilience:** no — archive doesn't cover edits, and the product chose the opposite:
[`JobPartMaterialsCard`](../../components/jobs/JobPartMaterialsCard.tsx) deliberately reads the
**live** BOM. Nothing reads the table (every reference is a type, a comment, or the writing RPC), and
write-only is worse than absent — the next reader takes it for truth.

**Not executed as of 2026-07-31** (Phase 4 debt): stop `create_job_part_operations_from_routing()`
writing it, drop the table, un-gate it in `stripe_write_enforcement` (parent-resolved via
`jobs.job_id`). Job creation is core, so not free.

**Consumption instead** = a `depletion` row in `inventory_transactions` tagged `job_id`; every field
J9 needs is present and indexed — `job_id` · `job_operation_id` · `part_id` · `quantity` · `unit` ·
`converted_quantity` · `operator_id` · `created_at` · `location_id` · `has_discrepancy`. **Expected**
= BOM × job-part qty computed live ([J4](#j4--job-kickoff-material-check)'s computation); **actual** =
`SUM(converted_quantity)` for `job_id` + `part_id`, `type='depletion'`; **variance** on read. Rows
sum, so twice-consumed material (two operations, or a correction) works and history survives; one
`actual_quantity` column would overwrite it.

Accepted: editing a BOM retroactively shifts "expected" on old jobs — already true via the live read;
a frozen planned-vs-actual record means a snapshot **at consumption time**, not at job creation. And
**"skipped" is unrepresentable** — `status: pending | consumed | skipped` is gone, so no row means
skipped *or* not-yet-done. Don't model completeness (the operator records a quantity, not a
per-material state — [operator-view.md](operator-view.md#status-model)); add skip only on real need,
never by reviving a per-job row.

### 5.10 Native app: deferred; the scanning spike is the gate

Sortly's iOS app is weak evidence — mobile-first, inventory-only, phone *is* the product, while
Jigged's quoting, costing, jobs and invoicing live on desktop. The iOS **scan** argument is strong, in
two halves:

- **(a) Scan → open our app:** native claims the URL via Universal Links; **an installed PWA cannot**,
  since iOS won't deep-link scanned URLs into PWAs. ❌ Still native-only — and the in-app scanner
  removes most of (b)'s pain, so (a) alone is a far weaker case than both together.
- **(b) Live in-app scanner:** `BarcodeDetector` is absent from WebKit → `getUserMedia` + WASM decoder
  (zxing-wasm / ZBar-WASM) at [near-native decode speed](https://dev.to/ilhannegis/barcode-scanning-on-ios-the-missing-web-api-and-a-webassembly-solution-2in2),
  so decode isn't the problem. **Camera permission is:** STRICH (a barcode-SDK vendor, so a hostile
  witness) reports it [isn't persisted for PWAs](https://kb.strich.io/article/29-camera-access-issues-in-ios-pwa),
  Safari re-prompting on same-origin navigation ([WebKit #185448](https://bugs.webkit.org/show_bug.cgi?id=185448))
  — worse than tapping a banner. ✅ Built 2026-07-30 (§6 Phase 2):
  [`LocationScanner`](../../components/scanner/LocationScanner.tsx), **locations only** (parts have no
  barcode; foreign codes refused, not guessed), `.wasm` self-hosted since shop wifi is where CDN
  fetches fail.

> **Corrected 2026-07-30.** Previously hedged with "drop `apple-mobile-web-app-capable` so the icon
> opens in Safari"; withdrawn because iOS 16.4+ honours the manifest's `display` member for Add to
> Home Screen, superseding that legacy tag. iOS treats `standalone`/`fullscreen`/`minimal-ui` alike,
> so **`display: 'browser'` is the only value keeping the icon in Safari** — what
> [`app/manifest.ts`](../../app/manifest.ts) ships. The first manifest draft dropped the tag *and* set
> `standalone`: the very bug the hedge existed to avoid.

One bin is ~2 taps either way; **continuous scanning** — a count session ([J9](#j9--count-it)),
receiving a pallet ([J6](#j6--receive-it)) — is where ten scans mean ten camera-app round trips.

**PWA basics shipped:** [`app/manifest.ts`](../../app/manifest.ts) · `viewportFit: 'cover'` + `themeColor` · 192/512/maskable icons generated from one vector ([`lib/brandMark.tsx`](../../lib/brandMark.tsx)), nothing upscaled from the 96px logo · `env(safe-area-inset-bottom)` on the operator bottom nav, which sat under the iOS home indicator. Still no service worker — nothing here needs one.

**Decision:** neither commit to native nor assume a PWA suffices. Time-boxed spike on the shop's own
handsets: *does camera permission persist across navigations in standalone mode on current iOS?* Yes →
PWA covers (b); no → cost native properly. ❌ **Open, concretely gated:** `display: 'browser'` is what
makes the scanner work, so flipping it to `'standalone'` is the deliverable — and a working scanner is
not evidence that permission persists.

### 5.11 Design for the sustain, not the setup

Bin systems decay: *"it's tempting to put a new material somewhere temporary and add the bin code
later; later rarely comes"* ([Craftybase](https://craftybase.com/blog/bin-location)). Sortly's
stockroom method step 5 is *"establish standard operating procedures"* with periodic audits. Our
equivalent is [J9](#j9--count-it) — the ritual keeping the other twelve journeys true, not a reporting
feature. Spec it recurring, assignable, place-scoped; not a one-off Adjust button.

> **Violated by the page built under it (2026-07-28), corrected 2026-07-30.** The Storage board
> shipped with a toolbar in which every control was setup — the exact failure named here; the build
> followed §5.5's decisions and nobody re-read the principle. Chrome is now two controls. Reusable
> test: **if every control on a page is something you do once, the page has no reason to be visited
> twice.** **Recurring** and **assignable** remain unstarted; place-scoping was the only half that
> changed the screen.

---

### 5.12 Two nouns: Parts is *what we have*, Storage is *where it lives* — 2026-07-30

| Decision | Why |
|---|---|
| `/inventory` deleted, redirects to **Parts**, which gained On hand + Status + a Stock filter | It was `getStockedParts` (`parts WHERE is_stocked`) + three columns (quantity, status, unit) + one filter (stock status, computed at render from `quantity + reorder_point`, never stored); toolbar Import · Delete · Locations · Count, though Parts already had Import + bulk delete and it delegated creation to `/parts/new`. Each file called the other a complement. **No unique capability; two pages for one item master, so neither could be described.** |
| Sidebar says **Storage**, not Inventory | Industry usage: inventory = the items and quantities, not the places. Sortly's own feature is *"Inventory Photos: visually track inventory by adding photos of your **items**"*; its category is "inventory management" (stock levels), "physical inventory" is counting items, and its stockroom method says "storage space"/"shelving" for places. (§5.5 decision 9 misread this citation twice — Sortly photographs and scans *items*. As of 2026-08-10 we agree with them on the photos: place photos are gone, and what gets photographed here is the material moving through a place.) Decisive: after the merge **Parts *is* the inventory**, so `Parts` (quantities) beside `Inventory` (shelves) reads swapped; familiarity argued for the old word only while Parts wasn't the inventory. |
| Routes stay `/inventory/*` | Churn for no user-visible gain; QR payloads encode `/operator/...`. |
| Flag off (`inventory_locations`) | **Storage** nav hides. `Count Inventory` is on the Parts toolbar **always** as of 2026-08-01 — gating it on the flag meant enabling locations took counting away, which is how the founder concluded place-scoped counting did not exist. |
| One module writes, reads and routes every Jigged QR — [`lib/jiggedScan.ts`](../../lib/jiggedScan.ts) | Two shapes, `/L/{code}` and `/T/{code}`, differing only by the kind letter; before, a traveler sent the operator out to the phone camera. **Redesigned August 2026** because the old codes did not scan — payloads were 120–157 chars at QR version 8–10. Now 77 chars of uppercase base32 at version 4/6. **Trap:** the whole scheme rests on every character staying inside the QR *alphanumeric* charset — one lowercase letter silently costs a version, which is 9% of module size on a shelf label. [`qrVersionCeiling.test.ts`](../../__tests__/utils/qrVersionCeiling.test.ts) fails CI on it. Refusals: anything that is not exactly one of the two shapes, including a bare UUID (it names no company, so the offline tenant check could not run). |
| Operator tabs **Jobs · Inventory · Scan · Maintenance · Me** (PR #636) | Scan is a tab (most frequent physical gesture) opening a **dialog, not a navigation**, so scanning never loses the screen — the point for continuous flows. It had to take a slot: Material caps bottom nav at 3–5 and both flags on already filled five. `Me` merges My work + Profile and **leads with work**, identity demoted to one compact row and Logout last — Material disallows a settings tab outright, NN/g measured hidden nav at 44–56% usage vs 89% visible, and YouTube's "You" / Strava's "You" are the exact precedent (both also pulled the avatar out of the header). The earlier withdrawal ("burying work behind settings") was right about the risk and wrong about the only fix.
| ~~The board draws nothing on a flat shop~~ → **board deleted 2026-08-01, replaced by a table** | The measurement that forced it: `unitKind` has exactly ONE consumer (`boardChrome.tsx:278`), and for a childless node the only thing `kind` changes is the rack border — the whole body is behind `children.length > 0`, whose own comment says *"most real locations are flat (118 of 121 in their legacy export), so that was the common case looking broken."* So the board was already a grid of labels for almost every real place, with worse density than a table and no sorting, multi-select or bulk anything. The sentence that had killed the list — *"Cabinet 1 alone exploded into 15 rows"* — was a **wizard artefact**: the cabinet template generates 1 × 5 × 2 = 16 nodes in one pass. Stop making that the default and a flat shop's table is 12–18 rows total. **Withdrawn 2026-08-10 — this is the sentence that was wrong.** It is the founding claim of the table, and the shop then deliberately built a 12 × 15 cabinet: 237 locations, 180 bins in one of them. The generator was never the reason storage got big; a shop with real storage is big. Measuring the default and not the ceiling is the mistake worth remembering. Twelve of twelve surveyed tools present locations as a tree or table; none draws them — convergent evolution, **not** user evidence, and no user has ever been observed using any storage UI here. Also deleted: the icon palettes (`STORAGE_TYPES` was unreachable for its entire life), `LocationBoardPreview`, `specToBoard`, `BoardNode`, `unitKind`. The generator survives as the valuable half. #421 (3D) closed, not deferred. |
| ~~Operators render the same `LocationBoard`~~ → **operator board removed 2026-07-31** | The reasoning that put it there was sound (whoever most needs to *recognise* a place stands in front of it, and `CAB3-A` isn't recognisable) and it still holds — for the **owner's** Storage page, which keeps the board. What it never established is that an operator needs a *map of places* at all. Industry usage is consistent: *inventory* = items and quantities, *storage* = places, and every operator action here is an item action. The tab was Storage content under an Inventory label. It also competed with Scan, which reaches a place faster **and** proves you are standing at it — and with 12–18 places you are among, walking beats scrolling a picture of furniture three feet away. Replaced by a part lookup (J11) over a shop-wide activity feed; the one thing the board did that nothing else did — reach a bin whose label came off — survives as the tap target on every activity row. |
| ~~**`Move into…`** re-parents a unit~~ → **removed 2026-08-10** | Founder call, on the grounds that configure-on-creation plus `Change layout` covers the reshaping people actually do. It never had strong evidence behind it: 118 of 121 legacy locations were flat and Contour's five real units nest under nothing, so re-parenting answered a shape the shop has never built. **What it does not cover, said plainly:** `Change layout` reshapes a unit's *inside*; nothing now moves an existing cabinet under another. `moveLocation` and `locationParentOptions` are kept — cycle-guarded and tested — and are **unreferenced again**, which is the state that made a mis-parented cabinet permanent before 2026-08-01. Deliberate this time, and recorded here so the next reader does not mistake it for an oversight. |
| **Four verbs, and there is no fifth** — `Add` · `Remove` · `Move` · `Adjust` on Storage, 2026-08-10 | The founder asked for `Count` · `Store` · `Retrieve` as three buttons, then found the answer himself: *"I just don't get the meaning of put away which it seems is move"* and *"Count is just adjust then too."* **Both are literally true, and measured:** put-away is [`bulkPutAway`](../../utils/inventoryLocationsAccess.ts) → `bulk_put_away`, which writes ordinary transfer pairs, and its control on the worksheet already read `Move N to…`; a count is [`commitCount`](../../utils/inventoryCountAccess.ts) calling `adjustStockAtLocation` once per line. So the ledger has exactly four row types — `addition`, `depletion`, `transfer`, `adjustment` — and the operator's four verbs already named them one-to-one. `Count` and `Put away` were **batch forms of two of the four**, not actions of their own, which is why they are gone as names and why `Adjust` is the one verb that navigates (an audit is inherently multi-part). Order is fixed to the operator's, so the same person meets the same row on both surfaces. **A naming study was started and stopped:** the vocabulary did not need research once the ledger was read. |
| **One place is a dialog; many places are the worksheet** — 2026-08-10 | `Adjust` first navigated at every scope, and at a bin holding two parts that bought a page transition, a two-step wizard, a search field over two rows and a bulk put-away panel that the `Move` verb now duplicates — to say the Yard holds 175 blanks rather than 180. A leaf is the same weight as the other three verbs, so it takes a dialog and the grid stays put. A container still navigates, because auditing a 12 × 15 cabinet is a walk of the shop and search, paging and per-line commit reporting are not dialog work. **Both ends call `commitCount`**, so the `adjustment` rows and their notes are identical whichever door was used — the split is in the surface, never in the write. It is the same shape `Move` already had: one part in a dialog, the bulk form in the worksheet. |
| **The place drawer** — 2026-08-10 | Clicking a cell opens a right drawer (a bottom-anchored full-width sheet under `sm`) holding the place's contents, the four verbs, its QR/rename/delete, and its history. **This is the sheet that was deleted eight days earlier, brought back at a different scope**, and the difference is the whole justification: the old one was the board era's ONLY surface, so it owned the *cabinet's* actions too and acting on what you were looking at meant covering it up. The pane shows the unit; a drawer shows a *place*, which the pane cannot — 180 bins do not each get a section. **It also fixes a reported off-by-one**: the contents used to sit under the grid, so selecting a bin near the top of a 12-row cabinet put the answer below the fold and the panel scrolled the page to it, moving the grid up under the cursor by about one row — click Row 4, the page jumps, click again where Row 4 was, and you get Row 5. Measured in a browser: cells and labels align to half a pixel and one click always selected the row it was on. Nothing below the grid means nothing to scroll to. Add · Remove · Move · Adjust are **views inside the drawer**, never dialogs over it — one layer, one way back. |
| **The drawer is ONE page** — 2026-08-10 | The four verbs open a section under the button that opened them, and the same button closes it. They were views the drawer swapped to for about an hour: one layer, but still the contents list, the history and the other three verbs off screen to type one quantity. A form here only ever holds a part, a quantity and a note, so there is room. The pressed verb is filled, so the open section has a visible owner, and its submit carries the noun (`Add stock`, not `Add`) because bare `Add` collided with the toggle that opened it. |
| **`Bulk Adjust`, not `Adjust`, on a unit** — 2026-08-10 | A place's `Adjust` is in its drawer and does one bin; a unit's opens a worksheet over every bin under it. Same verb and the same `adjustment` rows — the word that differs is the one that says *how many*. The page it opens is titled to match (`Bulk Adjust Cabinet 3`, was `Count Cabinet 3`), which also closes the seam where the button named the outcome and the page named the tool. The shop-wide entry keeps `Count Inventory`: it is reached from Parts, where the noun is the items rather than the places. |
| **A found part needs a BIN, not the cabinet** — fixed 2026-08-10 | *"Found something not listed?"* targeted the sheet's own `?location=`, which on a subtree sheet is the **container**. `adjust_stock_at_location` refuses one, so the row could be ticked, counted, and only then rejected with *"That place has sub-locations, so stock goes in one of those rather than in it"* — after the count, the one moment a person is least willing to redo. A `…into which place?` picker now sits beside it, offering the leaves the sheet spans, and the add is refused up front without one. The duplicate guard went row-scoped with it: finding the same o-ring in Shelf A *and* Shelf B is an ordinary morning, and the per-part guard would have made the more thorough count the one the software refuses to record. |
| **All four verbs take several parts** — 2026-08-10 | `Adjust` had always taken a number per part; the other three were single-part, so putting a delivery of six things away meant six openings of the same form and emptying the put-away pile meant one part per trip. They now share one table: a quantity per row, and **a blank row is not an instruction**. `Remove` and `Move` list what is in the bin; `Add` builds its rows from the catalogue, since that list is unbounded. A `Move` takes one destination for the batch — carrying a handful of things to one shelf is the act it models. **This is what closes the put-away regression**: emptying `Unassigned` is selecting several parts and sending them to a shelf, which is what `Put these away` did before the rename. |
| **One transfer per row, and the atomicity rule survives it** — 2026-08-10 | The worksheet's put-away is one atomic `bulk_put_away` and records why: *"a half-moved pile is worse than no move, because you can't tell what you already did."* The batch `Move` commits row by row instead and **names every row that failed beside the count that landed**, which answers that objection rather than ignoring it — each `transfer_stock` is itself atomic, so no single part is ever left half-moved. It also *cannot* use `bulk_put_away`, which moves whole balances by part id and has nowhere to put a quantity; taking three of the twelve on a shelf is the ordinary case here. |
| **`Bulk Adjust` is a drawer, not a page** — 2026-08-10 | The last control on Storage that navigated, and it did it for the operation you are most likely to run *while looking at the cabinet*. Everything else had already stopped: a unit is a selection, a place is a drawer, the verbs open in place. Same write from both doors — `commitCount`, one `adjustStockAtLocation` per line — so the rows and their notes are identical and the split is in the surface only. The worksheet keeps the jobs it was built for: the shop-wide sheet from Parts, and one part at one place from its balance row. |
| **A filled row is exempt from the filter** — 2026-08-11 | Above eight rows the batch forms offer a filter, because the put-away pile is 57 rows at a real shop and a bin's three parts are not. **The batch is derived from every row** — the blank-row rule requires it — while the filter narrows what renders, and left alone those two disagree: type a count into an o-ring, filter to "bearing", and the button reads `Save 1 count` over a list showing nothing to save. That shipped in [`UnitAdjustDrawer`](../../components/inventory/locations/place/UnitAdjustDrawer.tsx) and was caught in review before anyone used it. A row carrying a value is now exempt from the filter, structurally rather than by warning, and the helper says so. Nothing reorders either — a list that rearranges under someone mid-count is a second way to lose your place. |
| **One list, not two** — 2026-08-11 | The drawer painted a read-only `What's here` above a form whose rows were a strict superset of it: same names, same quantities, plus a field. On a 57-part pile that is two screens of the same information with the verb you just pressed a screen and a half above the rows it applies to. The read-only list steps aside for `Remove`, `Move` and `Adjust`, and stays for `Add` — whose rows are the parts going *in*, so without it nothing on screen would say what is already there. |
| **`All` on Remove and Move, and deliberately not on Adjust** — 2026-08-11 | Emptying a bin should not mean typing `2,099` correctly. Each row carries an `All` that fills its whole on-hand, and `Everything here` above the list fills every row on screen — the whole-bin case, and the one-press way to empty the put-away pile. **It fills the FIELD; it is not a mode**, so no everything-flag reaches the write path and the number you are about to commit is on screen where you can see and change it. `Everything here` fills only what the filter is SHOWING, and since a filled row is exempt from the filter, everything it fills stays visible — the set written is never larger than the set you can see. **`Adjust` gets neither, by decision:** its equivalent value is `0`, and calling zero "all" is the opposite word for the same button; it would save one character rather than five; the audit's other reading — *everything matches* — writes nothing at all, since zero-delta lines are dropped; and a one-tap way to zero a whole shelf is the most destructive thing in this module, which is not what a convenience button is for. `Add` has no on-hand to take all of. |
| **A partial batch disarms what landed** — fixed 2026-08-11 | The batch forms stay open after a partial failure so a bad line can be fixed without re-typing the others — and the successful lines' quantities stayed in their boxes, so the button still read `Remove stock (5)` and pressing it, the obvious next move, ran the four that had already landed. `add_stock_at_location` is a **delta, not a set**, so adding 12 twice leaves 24 and nothing undoes it. The comment sitting over that code named this exact hazard as the reason the form stays open. Succeeded rows are now cleared from `qty` before the failures render, and the saved count is captured rather than recomputed from a list it has just been removed from. |
| **A clean count writes nothing** — fixed 2026-08-11 | `adjust_stock_at_location` inserts unconditionally, and neither adjust surface used [`committableVariances`](../../lib/inventoryCountPlan.ts) where the worksheet does — so counting a five-part bin that all matched wrote five `adjustment` rows, which the bin's history renders as *"set to N"*. One clean audit buried a bin's real history under twenty rows saying nothing happened. |
| **#656 reaches the unit drawer** — fixed 2026-08-11 | `contestedParts` guards a part counted at SEVERAL places where stock moved between them mid-count: both counts true, the pair not, because an absolute write replays a once-true observation over a movement that came after it. The unit drawer spans several bins **by construction**, so it is squarely that case, and it shipped without the guard the worksheet has. It now gates on it — named, not tallied, and overridable. |
| **Notes came back, and dismissal is guarded** — 2026-08-11 | The batch rewrite silently dropped the movement note, which is often the only record of *why* ("scrapped, bad heat"); it is back, one per batch, because the reason is the same for everything carried in one trip. And a cabinet audit is twenty minutes of walking, so Escape and a backdrop click no longer discard typed counts — the backdrop is the cabinet you are auditing and the most clickable thing on screen. The header `×` is disabled mid-commit, which it was not: closing let the remaining writes land with the which-ones-failed report thrown away. |
| **One box, not two** — 2026-08-11 | Storage is place-first by design, which left the know-the-part-not-the-place question unanswerable: the only search matched storage-unit names, so typing a part number into it returned *"Nothing matches"* — a dead end wearing the clothes of an answer, in the box a person tries first. A separate `Find a part` beside it would have added the capability and kept the trap; **a box that answers whatever you type cannot be the wrong box.** Backed by [`searchPartPlacements`](../../utils/inventoryLocationsAccess.ts), which returns one row per (part, place). |
| **The dropdown picks a part; the drawer says where it is** — 2026-08-12 | The first cut listed a row per **(part, place)** — the same part repeated once per shelf, each carrying a path and a quantity. That answered the question *inside a menu*: it made you choose a shelf before you had seen what the choices were, and put the answer somewhere that vanishes the moment you look away. A dropdown is for picking a thing, and the thing is the **part**. Where it lives is what you came to find out, so it goes on a surface that stays — the same kind of drawer a place opens into. The drawer re-reads with `getBalancesForPart` rather than reusing the search's rows, which are capped, so a part in more places than the cap is not quietly shown short. It also **marks the put-away pile** rather than listing it as a shelf: omitting it would answer "nowhere" for a part sitting in the pile, and showing it plainly would send someone looking for a shelf that is not one. |
| **Act on a part where you found it** — 2026-08-12 | Clicking a place in the part drawer used to navigate to that bin — which discards half of what you arrived with. **You hold two facts, and every other surface keeps only one**: the place drawer makes you re-find the part among everything in the bin, the part page makes you re-pick the place you already knew. The row now expands into `Add` · `Remove` · `Move` · `Adjust` scoped to **(part, place)**, the same expand-in-place rule the place drawer follows one level up. It **reuses the same two forms** with their rows narrowed by `restrictTo` / `restrictToPartId` rather than being a third code path to the same four RPCs — one blank-row rule, one disarm-what-landed rule, one place they can drift from. `Open bin` sits INSIDE the section, not on the row: two hit targets on one 48px row is the ambiguity this module removed from the grid. |
| **Three scopes, three places** — 2026-08-11 | The top row held `Find a place` and `Add storage` (which act on the LIST) beside `Print all labels` (which acts on the SHOP), while the unit's own actions sat down in the pane. Straddling two scopes is why the page read flat. The page bar now holds only what belongs to neither column — the search and `Print all labels` — and `Add` moved into the list's own header, beside the thing it adds to. It shows `Add` because the heading beside it says Storage; its accessible name is `Add storage`, which also stops it colliding with the drawer's `Add` verb. |

---

### 5.13 `Change layout` changes the layout — 2026-08-15

Reported by the founder: *"when you try changing the layout of a storage space it seems to just add
additional cells instead of reshaping the storage unit, we also don't have a clear user journey for
the user to be told or confirm what happens to any parts that might be in a storage unit when
re-configurated."* Both halves were exactly right.

| Decision | Why |
|---|---|
| **The append was the design, and the design was wrong** | `Change layout` was [`VisualLocationBuilder`](../../components/inventory/locations/builder/VisualLocationBuilder.tsx) — the CREATE wizard — pointed at an existing unit. It opened on `DEFAULT_LEVELS` (5 rows × Left/Right) whatever the cabinet actually was, and `LocationsManager` handed it `existingSiblingNames` + `startSortOrder` **precisely so the generated names would continue past what was there**. Asking a five-row cabinet for three rows produced eight, and the confirm button said `Create 8 places`. Three tests pinned it and passed; §5.5 decision 3 called it "what the operator meant". It is what someone *subdividing* meant. It is the one thing `Change layout` cannot do. |
| **A key may carry a location id** | The diff turns on telling "this is Row 3, renamed" from "this is a new location that happens to be called Row 3", and only [`LocationSpecNode.key`](../../types/inventoryLocations.ts) can carry it. [`locationReshape`](../../utils/locationReshape.ts) owns one encoding — `id:<uuid>` — and is the only decoder. A prefix rather than a bare uuid, because the other key minters emit `0/1` and `e3`, and "does this look like a uuid?" is a guess where a prefix is a fact. Everything else falls out: a removal is an id the edited tree stops mentioning; a create is a key that never was one; `cloneSubtree` already mints fresh keys, so duplicating an existing subtree correctly reads as a create with no change at all. |
| **The whole diff is pure, and that is why the impact is live** | `planReshape` takes the tree, the edited spec and the occupancy map the Storage page **already had and had never passed to this dialog** — which is a large part of why the old flow could not warn about anything. So "Removing 2 locations, 1 of which holds stock" appears as you change a number, not one round trip later, and "5 rows → 3 removes rows 4–5 and keeps 1–3's ids" is a unit test rather than a click-through. |
| **Ask, and do not proceed** | Three answers were on the table for stock in a location that is disappearing: refuse until it is empty, sweep it into `Unassigned`, or ask. Ask — the same conclusion `DistributeContentsStep` reached for a loaded subdivide, and **sweeping is now worse than it was**: someone reshaping a cabinet has just told you they still want it, and emptying its contents into the pile mid-reorganisation is the opposite of what they asked for. Three independent things enforce it: the confirmation cannot open, the RPC refuses by name, and the pile is a root so it can never be a destination inside the unit at all. |
| **Sources are plural, and one of them is not a removal** | A surviving leaf that gains children may no longer hold stock either (20260806160053), so it is a source as much as a doomed bin is. Both are derived from occupancy with no extra read. Rows key on `part@location`: the same part in two doomed bins is two decisions, the same rule the count sheet learned when it moved to `partId::locationId`. |
| **One RPC, and it could not have been anything else** | [`apply_location_layout`](../../supabase/migrations/20260815192344_apply_location_layout_rpc.sql). Two of its steps are illegal outside a transaction that defers the container/bin invariant — verbatim `subdivide_location`'s own argument. And **a name swap has no valid ordering at all**: `inventory_locations_unique_sibling_name` is a UNIQUE *INDEX* on the EXPRESSION `lower(btrim(name))`, so `SET CONSTRAINTS` cannot defer it, `ADD CONSTRAINT UNIQUE` cannot recreate it as deferrable, and Postgres checks a unique index per TUPLE — `Row 1` ↔ `Row 2` fails even as one `UPDATE … FROM (VALUES …)`. Hence the **parking pass**, which is also the second reason this cannot be client-sequenced: a browser that parked a name and then died would leave a location literally called `~reshaping~<uuid>` on a shop's shelf. |
| **`subdivide_location` dropped, not kept** | A reshape is a strict superset — all-creates plus moves. Two browser-callable `SECURITY DEFINER` functions permitted to defer the same invariant doubles the surface over which "deferring is not skipping" has to hold, and keeping it would leave `subdivideLocation()` an unreferenced write path — the exact state §5.12 records as the hazard that made a mis-parented cabinet permanent. |
| **Re-ordering is neither reported nor counted** | "Re-ordering 12 locations" is not something anyone reads as information, so it stays out of the summary — and therefore out of `isNoop`, or **opening** the dialog on a unit built one location at a time would claim an edit it could not describe (`sort_order` defaults to 0 while spec positions are 0,1,2). It still rides in the payload, so positions normalise whenever a real change is applied. |
| **It opens on the NUMBERS, not on the locations** — corrected 2026-08-15, same day | The first version opened on the per-location editor, reasoning that a real cabinet is rarely uniform. The founder, on seeing it: *"the change layout doesn't make any sense… I was expecting that it would bring up the same modal you use when creating a storage unit and just let you change it. So let's say you created something that was 5x5, you could just change it to 4x4 and it just recreated easily as opposed to the custom thing you've created now."* Right, and it is what `inferLevelsFromSubtree` was written for — the reasoning was sound about ragged units and wrong about which case to optimise for. `Change layout` is now the CREATE modal, pre-filled: 5 × 5 → change two numbers → 4 × 4. `Edit locations one by one…` is the escape hatch, where it belongs. |
| **A unit the numbers cannot describe falls back, and the code decides by asking** | Production has one ragged unit (rows 1–5 bare, rows 6–10 split three ways). Opening THAT on the numbers would read "Creating 15 locations" before anyone touched a control, and accepting it would quietly even the unit out. [`numbersCanDescribe`](../../utils/locationReshape.ts) infers the levels, reconciles them back, and compares — so the fallback uses the same two functions the editor uses and cannot drift from what the editor would actually do. The fallback says why it is there, and offers the numbers as a deliberate choice that states what evening-out costs. |
| **Nothing is said until something changes** | It opened with *"test is unchanged so far. Edit the names, add or remove locations, or reshape it by the numbers"* stacked above a second info alert about the editing mode — two boxes of prose, before one number had been touched, describing controls already on screen. The founder: *"these texts… are also hard to understand."* The disabled `Review changes` button already says nothing has changed and the live location count already says what the numbers add up to, so the impact strip now renders **only** when there is an impact. |
| **A row's label is not a control** — 2026-08-15 | Clicking a band opened it, and opening a CONTAINER makes it the pane's subject — so a mis-aimed click on `Sector 3` replaced the cabinet you were reading with one row of it, and the way back was a breadcrumb that is easy to miss. *"We should simply not make that clickable since every thing can be viewed on the grid."* Nothing is orphaned: a row is renamed and removed in `Change layout` → `Edit locations one by one…`, and its printed label is already collected by the unit's `Print QR` (`collectLabels` walks the subtree). A row that IS a location was never this branch — it is the full-width cell, and still opens. `onOpenBand` is gone from `UnitGridView` entirely. |
| **The shop floor acts on a part where it found it, like the office** — 2026-08-15 | `PartPlacesDrawer` stopped navigating on 2026-08-12 for a stated reason — *"you hold two facts, and every other surface keeps only one"* — and the operator lookup kept navigating for three more days, which is exactly how the two surfaces drifted the first time. Tapping a location in the operator lookup now expands `Add` · `Remove` · `Move` · `Adjust` scoped to **(part, location)**, reusing `PlaceStockActionForm` / `PlaceAdjustForm` with `restrictTo` / `restrictToPartId` rather than being a third code path to the same four RPCs. `Open this location` sits INSIDE the section, never as a second target on the row. Removal stays `graceful` here, as everywhere on the shop floor. **Measured against §Density before shipping**: at 390×844 the form's submit clears the tab bar by ~290px and `Open this location` by ~225px. |
| **The grid draws what the wizard builds, and the database enforces it** — 2026-08-15 | `LevelConfigStep.MAX_LEVELS` allowed **4 levels under a unit**; `readUnitLayout` drew **3** and rendered the rest as a flat list captioned *"this one nests deeper than the grid draws"*. So the founder built a 320-location cabinet at exactly the depth the wizard offered, and the app could neither draw it nor move around inside it. `readUnitLayout` now has a `nested` case — two choosers over one grid — and [`assert_location_depth`](../../supabase/migrations/20260815224349_enforce_location_depth_cap.sql) refuses a sixth level. **The two numbers are the same number on purpose.** Existing deeper rows are not migrated (the trigger fires on write, not as a CHECK) and the `list` fallback stays for them: rewriting somebody's cabinet to satisfy a new rule is not a migration. |
| **The place drawer is not modal on a wide screen** — 2026-08-15 | *"once you click row 1 and then the tabs and their cells, you can't go back anywhere to click row 2 unless you first click on another root storage unit."* The drawer was `temporary`, so `Modal` made everything behind it inert — and the pane behind it IS the navigation. The tabs were on screen the whole time, greyed out. `hideBackdrop` does **not** fix it: `Modal` sets `aria-hidden` on the background regardless, measured in a browser before the fix was written. Only a non-`Modal` variant does, so it is `persistent` from `sm` up, and the page reserves `PLACE_DRAWER_WIDTH` while it is open because a persistent drawer overlays rather than reflows. It stays modal on a phone, where the drawer is full width and there is nothing behind it to reach. |
| **A drilled-into container has a path back** — 2026-08-15 | Clicking a container makes it the pane's subject (`openCell` → `showUnit`), and a container is not in the list beside it — while the `All storage` button is `display: { xs: 'inline-flex', md: 'none' }`. So on a wide screen, drilling in had **no way out at all** except picking a different root unit. The pane now carries `Storage › Grid Cabinet › Row 1` with every step clickable, rendered only when the subject is not a root (a root's way back is the list, already beside it). |
| **The list column is a surface, and `Add` is a primary action** — 2026-08-15 | The list, the pane and the page were one flat colour, so a master–detail layout read as one column of stuff with a gap in it; the list now sits on `action.hover` with a `divider` rule, from `md` up only (on a phone it is the whole screen, so a tint separates it from nothing). And `Add` was `variant="text"` — the lowest emphasis the system has — for the one thing the column is for, beside a contained `Bulk Adjust`. The decision log recorded why the LABEL is `Add`; nothing ever argued for the emphasis. |
| **Park only the name somebody else wants** | The first version parked every renamed, re-parented or removed row, and it leaked: `transfer_stock` reads the SOURCE's name for its ledger note and `location_name` is snapshotted then immutable, so moving stock out of a parked bin wrote `Transfer from ~reshaping~<uuid>` into history **permanently**. Parking is reversible inside the transaction; the history it poisons on the way past is not. **Found by reading the operator's activity feed after a real reshape** — every test passed, because none of them looked at the ledger's text. Parking now covers exactly the rows a DIFFERENT row wants the name of, so an ordinary rename or removal never parks at all. Residual, stated in the migration: a reshape that genuinely REUSES a removed location's name still parks it, and no ordering avoids that — the stock cannot leave before its destination exists, and the destination cannot take the name while the old row holds it. |
| **A pre-existing bug this walked into** | `delete_location` has been unable to delete any location with ledger history since **20260731235450**. `inventory_transactions.location_id` is `ON DELETE SET NULL`, and 20260622034847 removed that column from the notes-only immutability guard for exactly that reason, saying so in a section header. The photo migration rebuilt the guard, read the absence as an oversight — *"the other three were mutable by omission"* — and put it back. Every removal here is a bin whose stock has just moved out, so the reshape cannot ship over it. **Same trap the execute-grant allowlist has sprung three times: an allowlist by omission, rebuilt from a stale copy, silently reverts a decision.** |

---

## 6. Sequencing

**Phase 1 ✅ 2026-07-28** — J1 (closes FR-16), J9, J4, then J7 issue-to-job **job-first on the operator surface** (an earlier draft aimed it at the owner), plus the #59 patch. **Zero new tables, migrations or flags**: the figures already existed on `parts_bom`, `parts`, `inventory_transactions` — the gap was never schema. §5.2 resolved: a job is not a place. Carried: recursive BOM explode (J4), `job_part_id` on the ledger (J7), atomicity debt (§5.4).

**Phase 2 ✅ 2026-07-30** — reshaped locations (§5.5), plus **`bulk_put_away`** (atomic RPC, whole-balance, capped 1000) and **place-scoped counting**, both inside J9's worksheet: counting a bin and moving what doesn't belong are one visit. **Rollout gate cleared.** Two pre-existing bugs no test caught: `storage.objects` had no SELECT policy in any migration (it existed only in the prod snapshot), so every attachment read broke on fresh local stacks and preview branches; `friendlyErrorMessage` ignored `check_violation`, flattening every stock RPC message to "Failed to update stock."

Filed: ~~**#618**~~ **fixed 2026-08-10**: `materializeLocationSpec` was sequential and non-transactional — a 12 × 15 cabinet was 240 awaited round trips, and a failure partway left a partial tree. A loaded parent had already moved to `subdivide_location`; the remaining paths (root create, duplicate, empty parent) now go through **`create_location_tree`**, a sibling RPC that takes the same flat `{ref, parent_ref}` node list. Deliberately a new function rather than a wider `subdivide_location`: that one derives `company_id` from its parent row, so a root create needs a `p_company_id`, and the arity change would make `CREATE OR REPLACE` an **overload** — the SQLSTATE 42725 trap 20260731235450 already sprang here. It also needs none of subdivide's hard parts: no moves, and **no constraint deferral**, since a fresh subtree never passes through the illegal intermediate state · ~~**#619**~~ **fixed 2026-08-01**: `getBalancesForParts` now pages each chunk with a total order (the arithmetic is ≥1,001 rows in one chunk, not 500×2, and only a dropped **non-zero** row misroutes) · **#620** the board drops `TOP_LIMIT`, so windowing past a few hundred units. Deferred: §5.10 spike · bar-rack card · drag-to-reparent (118/121 flat; a **picker** landed 2026-08-01 instead — `moveLocation` had shipped with cycle detection and tests and never had a caller, so a mis-parented cabinet was permanent) · recurring/assignable counts (§5.11) · service worker (offline stock writes ≫ a cache).

**Filed 2026-08-01:** **#645** every location-stock RPC bypassed the billing write-gate — `SECURITY DEFINER` runs as the owner, no table sets `FORCE ROW LEVEL SECURITY`, and `part_location_stock` was exempt on the false rationale *"writes never come from the browser"*. Entitlement therefore depended on a feature flag. Fixed the same day across seven functions, plus `definer_writers_missing_write_gate()` and a CI test, because the existing guard checks whether a *policy exists* and cannot see a definer function walking past one. · **#649** `create_shipment_with_line_items` has the identical bug; left open because whether a lapsed shop may ship an order it will invoice for is a billing policy call. · **#646** / **#647** / **#648** the counting, owner-ledger and board-vs-table work from that audit.

**Phase 3 — purchasing:** J5 · J6 · J10 = **#571**; merge, don't parallelise. **Phase 4:** traceability and lots cut (no certs, heat, regulated customers), halving it — left: J8 remnants (*confirm they reuse drops first*), reconciliation (unspecced until real drift shows; J9 covers correctness), J4's customer-material exclusion *only if* service jobs carry such BOM lines, §5.4 engine collapse + §5.9 `job_materials` drop (stop writing, drop table, un-gate billing).

---

## 7. Gap analysis — what we missed

Twelve journeys plus the two cut. "Docs said" = this doc **before the rewrite** — what we had actually written down.

| Journey | PRD says | Docs said | Built? |
|---|---|---|---|
| J1 opening balances | FR-16 `Should` — CSV upload | silent | ✅ 2026-07-28 |
| J2 where it lives | *absent* | AC only, no user story | ✅ 2026-07-30 (was ⚠️ inverted) — board, inline create, put-away |
| J3 quote cost | FR-11 | in parts/routings docs | ✅ |
| J4 material check | Flow 3 step 2 | silent | ✅ 2026-07-28, top level only |
| J5 buy it | Flow 3 steps 4–5 | silent | ❌ |
| J6 receive it | Admin persona; Flow 3 step 6 | silent | ❌ |
| J7 issue to job | **Open Question 2 — the primary path**; FR-3 / Flow 1 step 1 | "Planned (#550)" | ✅ 2026-07-28 bin checkout + job tag, read back by J4; job-first entry built then reverted |
| J8 remnants | *absent* | silent | ❌ |
| J9 count | metric: 100% accuracy | silent | ✅ 2026-07-28, place-scoped 2026-07-30 (§5.11's actual ask) |
| J10 don't run out | **FR-2 `Must`** | FR-2 `Should`, partial, proposed hiding | ⚠️ badge only |
| J11 find it | *absent* | AC only | ✅ 2026-07-31 — operator part lookup; the office half predated it |
| Traceability *(cut)* | *absent* | silent | ⛔ cut — no regulated customers |
| Customer-supplied *(cut)* | *absent* | *absent* | ⛔ cut — frequent, never stocked |

Three structural misses, costliest first:

1. **We shipped the only journey with no requirement behind it and skipped the one marked primary.** J2/J11 got six PRs; J4/J7/J9 got nothing.
2. **The doc could only describe what was built.** As an implementation audit it had nowhere to put receiving, purchasing, counting, shortage, remnants or traceability — they appear not even as gaps.
3. **Validated feedback had no protection.** #59 shipped, was deleted by an unrelated refactor, unnoticed for two months — no test, no AC.

### Stale-doc reconciliation

| File | Wrong | Action |
|---|---|---|
| [`jobs.md`](jobs.md) §material tracking | `job_materials` columns that don't exist (`inventory_item_id`, `actual_quantity`, `status`, `consumed_at`), a `JobMaterialsCard` with consume/skip, `create_job_operations_from_routing` — then links here, which says none of it exists | Rewrite |
| [`architecture.md`](../architecture.md) | `routing_materials` (removed); `job_materials … actual consumption` | Correct both |
| `docs/build-sequence.md` | 3,910 lines superseded, incl. a `GET/POST /api/inventory` that never existed | **Deleted** |
| `demo-company.md` | Seed SQL against dead `inventory_items` / `inventory_unit_conversions` | **Deleted** (Aug 2026) — it specified a v1 demo design that was never built |
| `usability-test-script-v1.md` Task 4 | Targeted `/inventory/[itemId]`, deleted May 2026 | **Deleted Aug 2026** — a spent one-off, and its observer script read out an "Operations" sidebar item that is now Work Centers |
| `docs/modules/inventory-locations.md` | Promised by PR #414, never written | Folded in here |

---

## 8. Acceptance criteria — what is actually verified

Pinned by tests, not by prose.

| Area | Enforced by |
|---|---|
| Stock status + chip; delete-as-archive, single and bulk | `__tests__/components/inventory/StockStatusChip.test.tsx`, `__tests__/utils/partsAccess.test.ts` |
| Locations — balances, RPC wrappers, unit conversion, board request budget, contents paging, `bulkPutAway`, **transfer folding** | `__tests__/utils/inventoryLocationsAccess.test.ts` |
| J11 lookup (three answers, put-away picker), bin + shop-wide history, movement photo | `__tests__/components/operator/{OperatorPartLookup,OperatorWarehouseHome,PutAwayPickerDialog,BinHistory,MovementPhotoField}.test.tsx` |
| Grid read model — the three real Contour shapes (uniform 12 × 15, ragged, flat), a synthetic 4-level unit, roll-up, and places-in-use counting leaves rather than nodes | [`__tests__/lib/locationGrid.test.ts`](../../__tests__/lib/locationGrid.test.ts) |
| Grid rendering — the **44px touch floor**, ragged drawn as ragged, the 4-level chooser, declining to draw past four levels, and occupancy named rather than colour-only | `__tests__/components/inventory/locations/{StorageUnitList,UnitGridView}.test.tsx` |
| Occupancy roll-up, subdivide numbering, sheet/builder/form/picker rules | `__tests__/utils/{locationOccupancy,locationSpec}.test.ts`, `__tests__/components/inventory/locations/*.test.tsx` |
| One-transaction subtree create: 192 nodes in one call, rollback leaves nothing, forward-ref refused, node cap, cross-company parent refused, and that it does **not** inherit subdivide's constraint deferral | [`test_create_location_tree.py`](../../api/tests/integration/test_create_location_tree.py) |
| Container/bin invariant — both directions, subdivide rollback, and the **write-skew race** | [`api/tests/integration/test_location_children_hold_no_stock.py`](../../api/tests/integration/test_location_children_hold_no_stock.py) (psycopg2, not the Supabase client: the race needs two open transactions, which PostgREST cannot give) |
| Which places may be offered as a destination, for stock vs for a location | [`__tests__/utils/locationDestinations.test.ts`](../../__tests__/utils/locationDestinations.test.ts) |
| Counting a container — subtree gathering, split parts staying per-bin, commit targeting the bin | `__tests__/components/inventory/InventoryCountPage.test.tsx` (`counting a container`) |
| J9 count plan, commit routing, bin-scoped count, draft resume | `__tests__/lib/inventoryCountPlan.test.ts`, `__tests__/utils/inventoryCountAccess.test.ts`, `__tests__/components/inventory/InventoryCountPage.test.tsx` |
| J4 material check | `__tests__/components/jobs/JobPartMaterialsCard.test.tsx`, `__tests__/utils/materialCheckAccess.test.ts` |
| J7 bin remove/receive + job-tagged depletion; owner-side job tag (#59) | `__tests__/components/operator/{OperatorBinView,OperatorReceivePartModal,OperatorLocationActionModal}.test.tsx`, `__tests__/components/parts/PartTransactionJobTag.test.tsx` |
| Label → real `zxing-wasm` decode → location id; foreign-code rejection; camera errors | `__tests__/components/scanner/{scannerRoundTrip.test.ts,LocationScanner.test.tsx}` |
| J1 opening balances via import | `api/tests/integration/test_parts_import_api.py` |

**J1 asymmetry, pinned.** A location-tracked part's quantity is skipped *and the skip reported* — but a **brand-new** part at a locations-on company *does* get its quantity written, because the guard is `BEFORE UPDATE`, so `trg_auto_track_stocked_part` seeds the balance straight from the insert (`test_execute_writes_quantity_for_a_brand_new_part_even_with_locations_on`). Read J1's "deliberately not written" without this and you will "fix" the importer and silently zero opening balances for exactly the shops that turned locations on.

**Numbers pinned:** board load = **2 requests exactly**, at 40 and 400 locations; put-away = **one** RPC at any count, DB-capped at **1,000** parts; reshape of 5 rows → 3 **removes rows 4–5 and keeps 1–3's ids** (was: continued Row 4–6); a reshape re-places at most **200** parts before it refuses; **7** foreign codes rejected; `referencedTable` must be the embed *alias* or paging fails at runtime with `PGRST108`; `Unassigned` is unrenameable — the stock RPCs resolve it by literal name.

**Holes.** Automation-pending: aggregate-path unit conversion — the skew runs the wrong way, the newer location path is tested and the **older, more-used** aggregate path is not, `add`/`remove`/`adjustPartStock`, note-only transaction edits (DB-enforced by `restrict_transaction_update_to_notes`), list search and `is_stocked`/`deleted_at` filtering. **iOS `standalone` camera permission across navigation: unverified, unverifiable from a desk** — §5.10's spike, hence `display: 'browser'`. J4's read costs **one query per table**, never one per BOM line (`__tests__/utils/materialCheckAccess.test.ts`). Live-only, never CI: put-away rollback, its DB guards — same source and destination, empty selection, **cross-company destination**, each refused, where CI only checks the wrapper propagates the error — the `Unassigned` dedupe migration, storage read on a fresh stack, flag-on count writes (580→575, 180→178, 0→4). Built-and-deferred, not missing: cross-job on-hand-counted-once (`rollUpShortages`, git `87df208`, awaiting a buy list) and sub-assembly explosion (level 1 only, captioned).

---

## 9. What we know, and what we still don't

Founder observation, **Contour Tool & Machine**, 2026-07-27 — reliable on structure, weak on frequency/pain-ranking; the founder's model, not the shop's words.

> **Device model corrected, 2026-07-31:** *"No one used a shop tablet in Contour or any shop I've seen"* — machine **HMI**, **personal phone**, or **office computer**; canon in [CLAUDE.md](../../CLAUDE.md#who-uses-what-on-what--the-device-model). Docs assumed tablets in ~a dozen places, two as *"our primary device"*. Touch conclusions survive (a phone is at least as constrained). **Withdrawn:** §5.5's device reason for cutting drag-to-reparent (*"drag on a shop tablet is the most failure-prone interaction available"*) — admin work happens at a desk with a mouse; the cut may still stand on 118/121-flat. Same withdrawal for **#421**. Unknown: **whose** phone, and whether operators mind.

| Answered | Decided |
|---|---|
| **Grabbed at the machine**, not staged | §5.2: job ≠ place |
| **They stock** (rush jobs) | J4 = *"can I say yes to this rush job?"* |
| **Operator** moves material | J7 on the operator path |
| **Mixed units** — `each`, ft/in | FR-1 conversion load-bearing |
| **Balances start at zero**; legacy *"questionable"* | J1 out of Phase 1; J9 = onboarding |
| **No certs/heat/regulated** *(2026-07-27, re-confirmed 2026-08-01 — they do not want it either)* | Traceability + lots cut. Live only as a **customer-#2** consideration ([#642](https://github.com/debola31/Jigged/issues/642)), not a Contour need. |
| **Customer-supplied: lots, never stocked** | Job attribute; no ownership flag |
| **~10 ±4 places** (cabinets, shelving) | Wizard's 16 over-built |
| **Tried counting before** | J9 rescues a lapsed practice |
| Locations **already failed them** — *"badly designed and not really intuitive"* | One more §5.5 attempt |

**Measured, two legacy ERP exports, 2026-07-27** — behavioural, outranks the above.

| Measure | Value | Settled |
|---|---|---|
| Legacy locations | **121** | — |
| …job/work-order/part numbers | **97 (80%)** | Users hand-built J7 in a location field |
| …genuine places | **22** (12–18 net of tooling sizes) | Confirms ~10 ±4 |
| …using `/` hierarchy | **3 of 121** | Nesting never used; flat-first |
| Near-duplicates | `STOCK`/`ST0CK`, `JEFF'S DESK`/`JEFFS DESK`, `J-52818-01`/`J52818-01`, 3× dated `MISC` | Create-on-the-fly must dedupe |
| Parts rows | **9,428** | Scale vs NFR-8's 10,000 |
| …`onHand` set | **43 (0.5%)** | ⛔ No opening balances → J9 door |
| …`price1`/`custCode` | **88% / 51%** | Quoting catalogue, not inventory record |
| …`lastEditDate` | **28%** | Imported numbers drift from day one |

> **Withdrawn:** an earlier revision read *"rare data was populated"* as *"raw data … for a lot of parts"* and proposed importing quantities into a count sheet's **expected** column. Dead — 0.5%, and verification belongs in **Review & Fix**.

**Still open, none blocking Phase 1:** do service jobs carry a BOM line for the customer's material (J4 needs an exclusion if so, else false shortages — `custCode`'s 51% likely means *"made for customer X"*; don't conflate) · a **bar rack**? their 22 places (`STOCK`, `SHELF`, `YARD`, `CABINET 3-10`) hold none, so *weakly refuted*, but they buy in feet — shipped without the card, reasoning in a `storageTypes.tsx` comment · what `ZAPP`, `SMD`, `SBS`, `DB BOX`, `0-5` mean (one card-sort) · do they reuse drops (J8) · scanning: ten in a row, dead zones, whose phones (§5.10) · label durability · frequency/pain ranking, which neither observation nor exports reach · **scrap** — does it consume material, and how does it relate to `has_discrepancy` ([operator-view.md](operator-view.md#scrap-and-defect-capture-discovery)).

**Closed:** bulk exit from `Unassigned` — built 2026-07-30 as all-of-part-X plus a **search-driven** bulk assign (nobody assigns 9,428 parts; they assign what they hold). **#541** — #496 means *beyond* locations.

**No interview reaches** whether they sustain counting, or whether a shortage view changes behaviour: predictive, so ship J9 and watch. Two Sortly reports (*2026 State of Inventory*; *Do You Need to Track Inventory?*, which speaks to #541) are gated downloads, **not obtained** — cite nothing from them until read.

---

## 10. Next steps

Six of eleven journeys closed, two partial, three untouched. Open: **Phase 3 (#571)** and **Phase 4** — biggest gap **J10**, FR-2 `Must`, still an alert badge with no buy list · **§5.10's spike** (needs their handsets; flipping `display: 'browser'` is the deliverable) · a **rollout call** on `inventory_locations` for Contour, judgement now rather than blocked · **close #541, #550, #59** and re-scope **#496** onto §6 — #550 was *folded into* J7, not built as written (wrong actor, a flag that never existed), so read it as superseded · the [discovery script](../usability-tests/inventory-discovery-script-v1.md), trimmed to vocabulary, bar rack, scanning, never a gate.
