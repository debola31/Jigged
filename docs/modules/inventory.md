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
  [`PartTransactionModal.tsx`](../../components/parts/PartTransactionModal.tsx) tags removals via
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
| Name the places we already have | Storage | `Add storage` in the toolbar → name it. Flat. `Divide it up…` on a row only if it needs rows/bins. |
| Make a place recognisable | Storage → tap tile → sheet | `Add a photo`. |
| **Reorganise a place** | Storage → click a place | `Rename`, `Duplicate`, `Add one inside`, **`Move into…`** (re-parent), `Delete` (empty subtrees only). |
| Print labels | Storage toolbar / row selection / place drawer | `Print all labels`, **tick rows → `Print N labels`**, or `Print QR` for one place and everything under it. |
| **See what happened in one place** | Storage → click a place → `Recent activity` | Movements with author and photo. Offered for `Unassigned` too. |
| Count one place | Storage → the ✓ on a row, or click the place → `Count or put away` | Worksheet scoped to that place, paginated. |
| **Count one part at one place** | `/parts/{id}` → Inventory tab → the icon on a balance row | Offered on **every** row including zeros. |
| **Count one part everywhere** | Same tab → `Count all N places` | One sheet, one row per place. Appears once the part is in more than one place. |
| Put stray parts away | Place worksheet, at `Unassigned` | Tick rows → `Send the ticked parts to…` → `Put N away`. Moves each part's **whole** balance. |
| Count the whole shop | `/parts` → `Count Inventory`, or Storage → `Count everything` | Two doors, both unconditional. |
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
| `part_location_stock` | `(part_id, location_id)` UNIQUE, both FKs RESTRICT, RLS **SELECT-only**. |
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
- **Part → Inventory tab** ([`InventoryTab.tsx`](../../components/parts/workspace/tabs/InventoryTab.tsx)) when `is_stocked`: untracked → Add/Remove/Adjust (`PartTransactionModal`), tracked → `PartLocationInventory` (+ move). **No longer a gap** — this said "no job selector … only an operator at a bin can tag a job", which was true when written and was repaired on 2026-07-28: `JobTagPicker` is on both engines (`PartTransactionModal`, `PartLocationActionModal`). §1 already recorded the repair; §3 did not, and the two sat contradicting each other.
- **`/inventory/locations`** (flag-gated) — [`LocationsManager`](../../components/inventory/locations/LocationsManager.tsx): board only (list view **deleted 2026-07-30**, §5.5), `LocationDetailSheet` owning every action, the in-grid **Add storage** tile the only way in, toolbar just **Print all labels** · **Count everything** (§5.11).
- **Subdivide** — one [`VisualLocationBuilder`](../../components/inventory/locations/builder/VisualLocationBuilder.tsx) modal: storage type, then ≤4 levels against a read-only preview → `materializeLocationSpec`. `parentId` swaps in `SUBDIVISION_TYPES`, so subdividing Cabinet 3 can't yield `Cabinet 3 › Cabinet 1`. **"Build visually" is NOT live** — `subdividing = parentId !== null` is always true because the only caller passes a parent, so the 10-card `STORAGE_TYPES` palette and the title `Build storage visually` never render. This line used to claim both were live; §5.5 says the opposite and §5.5 is right. **Superseded 2026-08-01:** the founder has decided the drawn board and this builder are both to be replaced — see the open question below.
- **Operator** — `/operator/{companyId}/inventory` is the warehouse home (browse top-level places; the flag hides this nav tab); `…/inventory/locations/{locationId}` is **the QR target** (leaf = contents with Add/Remove/Set), reached through `…/login?location={id}`. Operator removals are always graceful (clamp to 0, flag `has_discrepancy`), stamped `operator_id`, job tag optional.
- QR labels encode the location **UUID**, never `code` (`locationLabelPdf.buildLocationScanUrl`): A4, 2 × 5, 34 mm at error-correction H, `kind='system'` excluded.

### Access layer

Supabase + RLS via `getTypedSupabase()`, **no FastAPI**: `partsAccess.ts`, `inventoryLocationsAccess.ts`, `inventoryCountAccess.ts`, `locationOccupancy.ts`, `alertsAccess.ts`. Non-obvious:

- `getLocationContents` caps at 200 (`LOCATION_CONTENTS_LIMIT`) and shows the exact total: uncapped, PostgREST `max_rows` clipped it silently — invisible on a 14-row seed, wrong on a 9,428-part shop. Archived parts excluded, matching the `inventory_location_occupancy` view.
- `bulkPutAway` — **one atomic RPC, never chunked** (a half-moved pile is worse than none); it moves whole balances, so N parts cost one request, not 2N — every *other* location-stock wrapper first loads the part's conversion context and sends **both** display and converted quantities, which is the second read that makes an ordinary stock write cost 2; the 1000-part cap sits in the RPC, not the UI.
- `occupancyFor` **zero-defaults** so render code never branches on `undefined` — an optional `?.hasStock` reads an *unknown* location as "empty", which is exactly how the roll-up bug comes back.
- `refreshSystemQuantities` reads the all-bin roll-up, so a shelf count using it flags variance on every row; `refreshLocationQuantities` is the per-place one.
- `getLowStockPartsAlerts` — `quantity <= reorder_point` filtered in JS; `critical` at 0, `high` at ≤50%, else `medium`; feeds the header `AlertBadge`.
- `setLocationPhoto` / `clearLocationPhoto` / `getLocationPhotoUrl` order their writes so a failure anywhere leaves a *readable* location rather than a row pointing at a file that isn't there.
- `LocationScanner` is wired into the operator Scan tab and the put-away destination picker on the place-scoped count worksheet. **Not the owner's Storage board** — an earlier revision of this line said it was; grep says two references, both above. It reads our location labels only (parts have no barcode) and refuses foreign codes; its `zxing-wasm` `.wasm` is self-hosted, not from the library CDN, because the consumer is a phone on shop wifi.

### Flag · archive · dead code

**`inventory_locations`** ([`lib/featureFlags.ts`](../../lib/featureFlags.ts)) — opt-in, **default off for every tenant**, at `companies.settings → features`, toggled per company from `/admin/companies`. Gates the Locations entry, the route, the operator Inventory tab and the auto-enrol trigger. Caveats: the operator bin *route* has no flag check, so a stale printed QR still resolves; `KNOWN_FEATURES` holds four keys — `inventory_locations`, `ai_insights`, `data_import`, `machine_maintenance` (earlier revisions said three, before machine maintenance). There is **no `inventory_transactions` flag**, despite #550 and earlier revisions citing one.

**Archive** — `deletePart`/`bulkDeleteParts` → `archive_parts` stamps `deleted_at`, never blocking on references (architecture.md §16); children (conversions, balances) are kept and return on revive, transactions keep their name snapshots, and re-importing the same `part_name` **revives** rather than duplicating. `delete_location` differs: **empty** subtrees only, no delete-and-relocate.

**Dead/unreachable** — `removePartStockGraceful` · `enableLocationTracking`/`disableLocationTracking` (superseded by auto-track; both now billing-gated anyway, #645) · `enable_location_tracking_for_company`, `inv_location_path_label` · `job_materials`. Deleted 2026-07-29: `getLocationTree`, `buildLocationUrl` (duplicated `buildLocationScanUrl`), `bulkGenerateChildren`/`BulkGenerateModal` (Subdivide is a strict superset with live preview, and it had **zero tests**, so deleting beat porting), `PartLocationBalance`. Path-walking is reimplemented **five times** in TS plus once in unused SQL — worth extracting.

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

Anyone naming a place as they need it. **Closed (Phase 2, 2026-07-30):** permanent board of real places (photos, fill state, "Add storage" tile), `LocationPicker`'s *"Create «name»"* inside the where-is-it field, batch put-away, label scanning; the wizard demoted to an optional *"Subdivide this unit"*. Create-on-the-fly waited on the sibling-name unique index — a bare freeSolo field is what produced `ST0CK` beside `STOCK`, now structurally prevented. [§5.5](#55-locations-keep-them-visual-change-when-they-appear).

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

The earlier separate J9 (issue **#550**) is folded in — the take-record *is* the consumption, and confirming again at operation completion would restate it against a complete-only UX ([`operator-paperless-flow.md`](../operator-paperless-flow.md) §5.2). Shipped 2026-07-28, **no new table**: a depletion row tagged `job_id`, expected from the live BOM, actual their sum, variance on read; `job_materials` not revived ([§5.9](#59-job_materials--resolved-drop-it-consumption-backs-onto-the-ledger)). **#550 closed by folding in, not as written** — it specified an operation-completion step behind an `inventory_transactions` flag that never existed, and named the wrong actor. **Deliberately not delivered:** "issued" is job-level, not job-part-level (no `job_part_id`), so two parts drawing one material show the same figure — hence *"issued to this job"*; one nullable column + index fixes it, omitted to keep Phase 1 migration-free. Reopen a separate confirmation only for variance the take-event can't express (consumed by one operator, reconciled by another).

### J8 — Cut it, return the remnant

Operator at the saw returns the drop to a place with its **remaining length**, findable before the next bar is opened. **Missing** — the most shop-specific gap and clearest cash value ([reuse instead of scrap](https://www.peptechnology.com/product/inventory-management/)). Mirror the habit: machinists already [mark both ends and re-mark the cut end](https://www.practicalmachinist.com/forum/threads/solution-for-raw-material-inventory-management.404375/).

### **J9 — Count it**

Whoever is assigned, on a schedule or on distrust of a number. **Built 2026-07-28** at `/dashboard/{companyId}/inventory/count`: pick parts, then a **count sheet** (*Part · Recorded · Counted · Change*, tabular figures, change as you type). Save commits — no confirm, no review; both restated numbers just typed. **Place-scoped 2026-07-30** via `?location=<id>` from a tile, sheet or scanned label, because you walk a shop bin by bin ([§5.11](#511-design-for-the-sustain-not-the-setup) asked for it).

**Made reachable 2026-08-01** (#646), after the founder looked for it and concluded it did not exist — a fair reading, since both doors were on the Storage board and enabling locations *removed* the Parts toolbar button. Now: **Count here** on every balance row of the part page including zero rows, an unconditional Parts toolbar entry (`?from=parts`), a one-part-at-one-place sheet (`?location=&part=`) that also makes the excluded-part chips land where their own copy promised, real **pagination** past `LOCATION_PAGE_SIZE` (the 100-row cap made `Unassigned` — every stocked part, by the auto-track trigger — impossible to work through), and **"Found something not listed?"**, which adds a part the bin read cannot return because it filters `.gt('quantity',0)`. `loadPartAtLocationCandidate` READS the balance rather than assuming 0: counting 0 against an assumed 0 is a zero delta, and `committableVariances` drops it, so confirming an empty shelf would commit nothing.

**Counting a part in EVERY place it sits, 2026-08-01** — `?part=<id>` with no location. A split part is kept off the company-wide sheet (a single total has no unambiguous home) and the picker offered a chip per place; but each chip was its own one-row sheet, so a part in three places meant three trips through the picker. Now one sheet, one row per place, each row targeting its own location — `commitCount` already routes every line to its own shelf. Reachable from **Count all N places** on the part page and from the held-back notice, which also moved **above** the list: it sat under all 14 rows, which is why the capability read as missing.

This forced `CountEntries` off part-id keys onto **`countRowKey`** (`partId::locationId` for a location row). Keyed by part alone, two rows for one part shared a single number — typing 800 for Shelf A silently committed 800 to Shelf B against a different recorded quantity. The same root cause produced a React duplicate-key warning on the sheet rows and made the pre-save re-read fetch `partId::locationId` strings instead of part ids. That re-read is now driven off **each row's own target**, so a location row is re-read at its bin and never against the `parts.quantity` roll-up. `DRAFT_VERSION` went 3 → 4 so a stored draft in the old key format is discarded rather than half-restored.

The same PR fixed **live data loss**: `save()` built variances by mapping over `candidates`, which is replaced whenever the server list changes, so a number typed for a part that then fell out of the result set was silently never committed. The sheet now holds chosen rows by value. **Recurring** and **assignable** stay unstarted. It is the ritual keeping the others true — the PRD's *"100% inventory accuracy within 3 months"* is unmeasurable without it — and carries [QR-label maintenance](https://www.sortly.com/blog/how-to-label-inventory/).

**Put-away is the same surface:** a destination picker and *"Put N away"* sit beside *"Count N parts"*, so at `Unassigned` this empties the pile `trg_auto_track_stocked_part` creates (§5.5 decision 8 — Contour's gate); a planned separate put-away page would have duplicated it. Hence **nothing is excluded at a bin**, where company-wide a split part is uncountable (38 against 10+20+10 — no bin defensibly absorbs the −2, so `resolveCountTarget` drops it) and those held-back parts were inert chips truncated at 8 until `excluded` began linking to their places: the capability was never missing, the route was. Bin scope also needs its own read and re-read (`getLocationContentsPage`, `refreshLocationQuantities`): `Unassigned` holds every part a shop owns, against a 200-row cap with no search, and the company-wide re-read compares to the cross-bin roll-up `parts.quantity`, which would flag every line. Counting commits line-by-line with per-line failures (line 50 must not void 1–49); a move is one atomic RPC (`bulk_put_away`), a half-moved pile being worse than none.

**Wording and layout.** Headers are **Recorded/Counted** — not *On hand* (collides), *System* (product-speak) or *Expected* (Sortly's; primes toward confirming the record); the delta is **Change**, not *Variance*; the noun is **"inventory count"**, never *cycle count* ([Unleashed](https://www.unleashedsoftware.com/inventory-management-guide/cycle-count-inventory/)), *audit* ([Fishbowl](https://www.fishbowlinventory.com/blog/inventory-audit-a-comprehensive-guide-with-best-practices-and-procedures)) or "stock count" — jargon, or a second word for the nav item; the one exception is the per-part **Stocked** flag. Older ledger rows keep the old phrasing. The column sheet beat inline `5 → 7`, a one-at-a-time card + numpad (deferred: Phase 2 phone surface) and tap-to-confirm (too easy to press unlooked) as the only layout [scannable at forty rows](https://www.stockount.com/articles/how-to-do-a-cycle-count). Units show once in the footer when uniform, per-row when mixed.

**Two first-use failures worth keeping besides the review page:** the count field didn't read as a field at all (an outlined input with a floating label and no value looks like a static chip), and *"1 item needs adjusting. 0 matched"* was accounting language nobody in a shop has a model for.

**Wrong twice:** built literally as three screens (*Scope → Sheet → Review*) — design a journey, not a data flow; then over-corrected by dropping **scope** too, when that critique was about *ordering* and took the *bounding* value with it ("these five, then I'm done" versus a wall of inputs reading as a form to complete).

Two deviations from spec: **no count-session table** (localStorage, so Phase 1 adds none — giving up assignment and cross-device resume, which Sortly built a server lifecycle for citing *"lack of accountability"*, a multi-counter problem this shop lacks); and **item-scoped**, since `inventory_locations` is default-off and place-scoping would have made Phase 1 depend on Phase 2 — resolved since by `?location=`. An item count being ambiguous for a split part, `resolveCountTarget` ([`lib/inventoryCountPlan.ts`](../../lib/inventoryCountPlan.ts)) commits: untracked → `parts.quantity` via `adjustPartStock`; tracked with no stock → **Unassigned** (the opening-count case — `trg_auto_track_stocked_part` seeds stocked parts there at 0); tracked in one place → that place; two or more → **excluded and named**, linked to those places. Holding stock means `quantity > 0`, so the seeded zero-row must not make a part look placed.

**Nothing judges the size of a change.** A 50% proportional threshold, on the finding that [~30% of large variances are count errors](https://www.getonecart.com/cycle-counting-inventory/), fired on nearly every line at small-shop quantities (7 on hand, 3 found) and stopped informing. The finding is probably sound; **percentage-of-quantity is what failed** — value moved (`cost_per_unit × delta`) would scale across a $2 bearing and a $2,000 casting, but the figure is **open for discovery**. Safety doesn't rest on it: recount to fix, and every line writes an `adjustment` row naming both numbers. Quantities are re-read just before the write — not as a gate (adjust sets absolutes) but because the note records *"system said X"*; mid-count movement is reported after.

**Both doors are normal:** trustworthy figures → import ([J1](#j1--seed-the-item-master-and-opening-balances)); unknown quality → import then count; nothing usable → count only, that first session *being* the opening balance. Contour is the third (`onHand` on 43 of 9,428 rows; `price1` 88% full, `custCode` 51% — a quoting catalogue, not an inventory record) and **has counted before**, so this rescues a lapsed practice rather than teaching one — though a failed prior attempt raises the bar (§5.5). First run and hundredth are **one flow**; an onboarding-only mode is a second code path that rots.

### J10 — Don't run out

Owner: below the reorder point an item lands on the buy list, on-order visible so nobody double-orders. **Partial** — `parts.reorder_point`, `deriveStockStatus` (In stock/Low/Out) and `getLowStockPartsAlerts` → header `AlertBadge` exist; email, a real buy list and any concept of on-order do not.

**2026-08-01:** `/parts?status=low` grew **Reorder at** and **Short by** columns (`shortfall()`, derived like `deriveStockStatus` so the two cannot disagree; **0 at equality**, because a part sitting exactly on its line is on the buy list). `?status=out` gets **Reorder at** only — "short by" there would restate the reorder point on every row. That is the worksheet half of a buy list, not the buy list: no vendor grouping, no PO, no on-order. The badge read is also **bounded** now (`LOW_STOCK_SCAN_LIMIT`, ordered emptiest-first) — it was unbounded over every stocked part with a reorder point, so on a 9,428-part catalogue PostgREST truncated it at `max_rows` and a genuinely-out part could be missing from the badge with no error. **Doc conflict to settle:** PRD **FR-2 is a `Must`** (dashboard *plus* email); this doc calls it a `Should`, partly delivered, and plans to hide it behind the non-existent `inventory_transactions` flag; [`ai-insights.md`](ai-insights.md) records the badge as built and checked off.

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

Shop-stated: the only locations work with explicit demand. `buildLocationScanUrl` encodes the location UUID via `/operator/{companyId}/login?location={id}`. **No competing QR-on-lot path** — lot identity resolves *at* a scanned location; receiving tags stay human-readable (heat, item, PO).

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
| 2 | Incremental setup, create inline | After 7, inline create being finding 2's freeSolo mechanism. `LocationPicker`'s "Create «name»" is suppressed when the name exists, matched as the index compares. Creates flat, no kind or code — name is identity, QR carries the UUID. |
| 3 | Wizard survives only as **Subdivide** an existing unit | Reaches `VisualLocationBuilder`'s dormant `parentId`. Tested traps: `STORAGE_TYPES` level 0 *is* the container (→ `Cabinet 3 › Cabinet 1 › Row 1`), hence separate `SUBDIVISION_TYPES`; re-subdividing must continue numbering (Row 4–6), `materializeLocationSpec` being sequential and non-transactional. |
| 4 | Palette fixed | 10 kinds (7 + flat *floor space*, *outside/yard*, *bench*): with 118/121 flat, structures-only forces "on the floor by the saw" into a cabinet. **Withdrawn:** "a bar rack is the defining storage object in a machine shop" — Contour's 22 places contain none (§9); open question, card out until a pilot asks. |
| 5 | Fill state = the [two-bin kanban](https://businessmap.io/blog/two-bin-kanban-system) signal | **Empty-vs-has-stock only, never a percentage** — capacity is unknown and "72% full" is the invented number that costs credibility. **Amended:** unbundled from photos on cost. Photos are `inventory_locations.photo_path` (a column: one photo, inheriting the table's RLS and billing gate), **above** the compartments — photo = identity, compartments = fill state. That build exposed `storage.objects` having **no SELECT policy** in migrations: every attachment unreadable on local stacks and previews. |
| 6 | Flat default | **CLOSED by 3** — subdivide-on-demand *is* opt-in bins ([Katana](https://support.katanamrp.com/en/articles/8340252-basics-of-storage-bins) makes bins opt-in inside a location; [MRPeasy](https://www.mrpeasy.com/resources/user-manual/stock/settings/locations/) has no nesting, names locations `"Room 1, A1"`). `parent_id` nullable → UI, not a migration. Was "revisit". |
| 7 | Names dedupe; codes deliberately don't | Finding 2 is all **names**: unique index on `lower(btrim(name))` with a NULL-safe parent sentinel, plus backfill — a plain `UNIQUE (company_id, parent_id, name)` leaves top-level rows unconstrained, NULLs comparing distinct — plus a live "already has a Shelf A" warning, nothing exact catching `ST0CK`. Codes unconstrained: nothing resolves by code, and an index could fail mid-run in `materializeLocationSpec`. |
| 8 | "Put these away" — batched move out of `Unassigned` | `trg_auto_track_stocked_part` guarantees a system `Unassigned`; Contour's holds all **9,428** parts — the likeliest repeat of attempt 1's failure (§9.3). Moves **all of part X** (partials have `transfer_stock`), which kills quantity, conversion and a per-part read: one request for N parts vs 2N looped. Search-driven selection inside J9's place-scoped worksheet, not a new page. `bulk_put_away` is one atomic RPC, DB-capped at 1000 parts to bound `part_location_stock` locks, and the wrapper **never chunks**. **Rollout gate CLEARED**; flag stays opt-in. |
| 9 | Thing-first sequencing | **CORRECTED 2026-07-30: previously "the company whose whole product is visual inventory doesn't lead with a storage hierarchy", from two Sortly pages; withdrawn — neither supports it.** The [labeling guide](https://www.sortly.com/blog/how-to-label-inventory/) labels *items*, never shelves (silence read as evidence = category error); the [stockroom method](https://www.sortly.com/blog/how-to-organize-a-stockroom/) *prescribes* hierarchy, down to *"post maps, charts… that show exactly how inventory should be stocked."* Survives: onboarding *order* only; the flat default rests on 118/121. Visual thread thereby *promoted* — photographed flat places **are** that map (backs 5, #421). |

**Reshaped 2026-07-30 — the page contradicted §5.11 ("design for the sustain, not the setup") and shipped anyway:** every toolbar control was setup.

| Amendment | Why |
|---|---|
| **One** way to add storage: the in-grid tile's form (amends 2, 3) | `Build visually` called the identical function; multi-level survives only as Subdivide |
| **List view cut**, `LocationTreeView` deleted (amends 1) | Cabinet 1 alone became 15 rows; at 12–18 places the board wins |
| **Scan** moved to an operator tab-bar action | You scan at a shelf; one scanner resolves location labels *and* job travelers |
| **`Count everything`** lands here | `/inventory` folded into Parts, leaving no sibling page |
| **Photos are a place's identity** (amends 5) | Unphotographed tiles get a passive glyph; the tile is one tap target |
| Sidebar says **Storage** | In [Sortly](https://www.sortly.com/business-inventory-app/)/Katana/MRPeasy "locations" means sites/warehouses; Jigged is single-site |

Under full material control locations get *more* load-bearing: a remnant is a physical thing in a place, and *"is there a drop I can use"* is a spatial query.

**#421 (3D diorama) — spiked 2026-07-30; three findings outlive it.** (1) Cost rules out real 3D: gzipped `three` **123 KB**, +`@react-three/fiber` **230 KB**, +`drei` **289 KB** on the least-frequent screen, against **~1.4 KB** of inline-SVG isometric with zero dependencies. (2) CSS 3D flattens silently inside our own chrome — `overflow:hidden`, `opacity<1`, `filter` or `backdrop-filter` on a `preserve-3d` root each collapse the subtree while `getComputedStyle().transformStyle` still reports `preserve-3d`; `StorageUnitShell` and our `backdrop-filter` cards hit it today, and the matrix is **Chromium-only — the WebKit run never completed, and operators are on iPhones**. (3) Depth buys recognition, spends legibility (labels collide, back rows occlude front). Post-photos the schematic's only jobs are fill-state canvas and pre-photo placeholder, both already done flat — **the falsifier: if so, an isometric is decoration on a setup screen.** Also corrected: "no stored geometry" is a product choice (a stored layout drifts once a cabinet moves), not a technical wall — and depicting a *kind* is a `kind` → shape lookup, **not** geometry, so the small version of the idea never touches the invariant.

**Drag-to-reparent: cut** — 118/121 flat serves no hierarchy, and the house pattern is arrow buttons (routings); if ever wanted, a "Move into…" `Autocomplete` over cycle-guarded `moveLocation`. **Withdrawn 2026-07-31:** previously also "drag on a shop tablet is the most failure-prone interaction available" — withdrawn because there is no shop tablet; setup happens at an office computer with a mouse ([device model](../../CLAUDE.md#who-uses-what-on-what--the-device-model)). Two legs, not three, and the same false premise was used against a drag-to-place floor plan for #421, so that falls too. Still against a facility map: its value scales with what you *can't* see from where you stand, and 12–18 places are learned in a week.

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
skipped *or* not-yet-done. Don't model completeness (operator UX is complete-only, one tap —
[operator-paperless-flow.md](../operator-paperless-flow.md) §5.2); add skip only on real need, never
by reviving a per-job row.

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
| Sidebar says **Storage**, not Inventory | Industry usage: inventory = the items and quantities, not the places. Sortly's own feature is *"Inventory Photos: visually track inventory by adding photos of your **items**"*; its category is "inventory management" (stock levels), "physical inventory" is counting items, and its stockroom method says "storage space"/"shelving" for places. (§5.5 decision 9 misread this citation twice — Sortly photographs and scans *items*, the opposite of our photos-on-places, locations-only scanner.) Decisive: after the merge **Parts *is* the inventory**, so `Parts` (quantities) beside `Inventory` (shelves) reads swapped; familiarity argued for the old word only while Parts wasn't the inventory. |
| Routes stay `/inventory/*` | Churn for no user-visible gain; QR payloads encode `/operator/...`. |
| Flag off (`inventory_locations`) | **Storage** nav hides. `Count Inventory` is on the Parts toolbar **always** as of 2026-08-01 — gating it on the flag meant enabling locations took counting away, which is how the founder concluded place-scoped counting did not exist. |
| One scanner for every Jigged QR — [`lib/jiggedScan.ts`](../../lib/jiggedScan.ts) | Both are login-passthrough deep links differing only by query string: `?location={uuid}` vs `?job={uuid}&part={uuid}`; before, a traveler sent the operator out to the phone camera. **Trap:** older sheets carry a third param, `operation=`, jumping to that step's action view (current sheets omit it so the operator picks) — dropping it would silently downgrade them to the traveler index, worse than the camera path they were printed for; caught by reading `login/page.tsx`'s `postLoginPath`. Refusals: a job id without a part id isn't a traveler; a bare UUID is always a location (travelers need two ids, so guessing is a coin flip). |
| Operator tabs **Jobs · Inventory · Scan · Maintenance · Me** (PR #636) | Scan is a tab (most frequent physical gesture) opening a **dialog, not a navigation**, so scanning never loses the screen — the point for continuous flows. It had to take a slot: Material caps bottom nav at 3–5 and both flags on already filled five. `Me` merges My work + Profile and **leads with work**, identity demoted to one compact row and Logout last — Material disallows a settings tab outright, NN/g measured hidden nav at 44–56% usage vs 89% visible, and YouTube's "You" / Strava's "You" are the exact precedent (both also pulled the avatar out of the header). The earlier withdrawal ("burying work behind settings") was right about the risk and wrong about the only fix.
| ~~The board draws nothing on a flat shop~~ → **board deleted 2026-08-01, replaced by a table** | The measurement that forced it: `unitKind` has exactly ONE consumer (`boardChrome.tsx:278`), and for a childless node the only thing `kind` changes is the rack border — the whole body is behind `children.length > 0`, whose own comment says *"most real locations are flat (118 of 121 in their legacy export), so that was the common case looking broken."* So the board was already a grid of labels for almost every real place, with worse density than a table and no sorting, multi-select or bulk anything. The sentence that had killed the list — *"Cabinet 1 alone exploded into 15 rows"* — was a **wizard artefact**: the cabinet template generates 1 × 5 × 2 = 16 nodes in one pass. Stop making that the default and a flat shop's table is 12–18 rows total. Twelve of twelve surveyed tools present locations as a tree or table; none draws them — convergent evolution, **not** user evidence, and no user has ever been observed using any storage UI here. Also deleted: the icon palettes (`STORAGE_TYPES` was unreachable for its entire life), `LocationBoardPreview`, `specToBoard`, `BoardNode`, `unitKind`. The generator survives as the valuable half. #421 (3D) closed, not deferred. |
| ~~Operators render the same `LocationBoard`~~ → **operator board removed 2026-07-31** | The reasoning that put it there was sound (whoever most needs to *recognise* a place stands in front of it, and `CAB3-A` isn't recognisable) and it still holds — for the **owner's** Storage page, which keeps the board. What it never established is that an operator needs a *map of places* at all. Industry usage is consistent: *inventory* = items and quantities, *storage* = places, and every operator action here is an item action. The tab was Storage content under an Inventory label. It also competed with Scan, which reaches a place faster **and** proves you are standing at it — and with 12–18 places you are among, walking beats scrolling a picture of furniture three feet away. Replaced by a part lookup (J11) over a shop-wide activity feed; the one thing the board did that nothing else did — reach a bin whose label came off — survives as the tap target on every activity row. |

---

## 6. Sequencing

**Phase 1 ✅ 2026-07-28** — J1 (closes FR-16), J9, J4, then J7 issue-to-job **job-first on the operator surface** (an earlier draft aimed it at the owner), plus the #59 patch. **Zero new tables, migrations or flags**: the figures already existed on `parts_bom`, `parts`, `inventory_transactions` — the gap was never schema. §5.2 resolved: a job is not a place. Carried: recursive BOM explode (J4), `job_part_id` on the ledger (J7), atomicity debt (§5.4).

**Phase 2 ✅ 2026-07-30** — reshaped locations (§5.5), plus **`bulk_put_away`** (atomic RPC, whole-balance, capped 1000) and **place-scoped counting**, both inside J9's worksheet: counting a bin and moving what doesn't belong are one visit. **Rollout gate cleared.** Two pre-existing bugs no test caught: `storage.objects` had no SELECT policy in any migration (it existed only in the prod snapshot), so every attachment read broke on fresh local stacks and preview branches; `friendlyErrorMessage` ignored `check_violation`, flattening every stock RPC message to "Failed to update stock."

Filed: **#618** `materializeLocationSpec` non-transactional · ~~**#619**~~ **fixed 2026-08-01**: `getBalancesForParts` now pages each chunk with a total order (the arithmetic is ≥1,001 rows in one chunk, not 500×2, and only a dropped **non-zero** row misroutes) · **#620** the board drops `TOP_LIMIT`, so windowing past a few hundred units. Deferred: §5.10 spike · bar-rack card · drag-to-reparent (118/121 flat; a **picker** landed 2026-08-01 instead — `moveLocation` had shipped with cycle detection and tests and never had a caller, so a mis-parented cabinet was permanent) · recurring/assignable counts (§5.11) · service worker (offline stock writes ≫ a cache).

**Filed 2026-08-01:** **#645** every location-stock RPC bypassed the billing write-gate — `SECURITY DEFINER` runs as the owner, no table sets `FORCE ROW LEVEL SECURITY`, and `part_location_stock` was exempt on the false rationale *"writes never come from the browser"*. Entitlement therefore depended on a feature flag. Fixed the same day across seven functions, plus `definer_writers_missing_write_gate()` and a CI test, because the existing guard checks whether a *policy exists* and cannot see a definer function walking past one. · **#649** `create_shipment_with_line_items` has the identical bug; left open because whether a lapsed shop may ship an order it will invoice for is a billing policy call. · **#646** / **#647** / **#648** the counting, owner-ledger and board-vs-table work from that audit.

**Phase 3 — purchasing:** J5 · J6 · J10 = **#571**; merge, don't parallelise. **Phase 4:** traceability and lots cut (no certs, heat, regulated customers), halving it — left: J8 remnants (*confirm they reuse drops first*), reconciliation (unspecced until real drift shows; J9 covers correctness), J4's customer-material exclusion *only if* service jobs carry such BOM lines, §5.4 engine collapse + §5.9 `job_materials` drop (stop writing, drop table, un-gate billing).

---

## 7. Gap analysis — what we missed

Twelve journeys plus the two cut. "Docs said" = this doc **before the rewrite** — what we had actually written down.

| Journey | PRD says | Docs said | Built? |
|---|---|---|---|
| J1 opening balances | FR-16 `Should` — CSV upload | silent | ✅ 2026-07-28 |
| J2 where it lives | *absent* | AC only, no user story | ✅ 2026-07-30 (was ⚠️ inverted) — board, inline create, put-away, photos |
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
| [`demo-company.md`](demo-company.md) | Seed SQL against dead `inventory_items` / `inventory_unit_conversions` | Correct |
| [`usability-test-script-v1.md`](../usability-tests/usability-test-script-v1.md) Task 4 | Targets `/inventory/[itemId]`, deleted May 2026 | Superseded by the discovery script |
| `docs/modules/inventory-locations.md` | Promised by PR #414, never written | Folded in here |

---

## 8. Acceptance criteria — what is actually verified

Pinned by tests, not by prose.

| Area | Enforced by |
|---|---|
| Stock status + chip; delete-as-archive, single and bulk | `__tests__/components/inventory/StockStatusChip.test.tsx`, `__tests__/utils/partsAccess.test.ts` |
| Locations — balances, RPC wrappers, unit conversion, board request budget, contents paging, `bulkPutAway`, photo signed URLs, **transfer folding** | `__tests__/utils/inventoryLocationsAccess.test.ts` |
| J11 lookup (three answers, put-away picker), bin + shop-wide history, movement photo | `__tests__/components/operator/{OperatorPartLookup,OperatorWarehouseHome,PutAwayPickerDialog,BinHistory,MovementPhotoField}.test.tsx` |
| Occupancy roll-up, subdivide numbering, board/sheet/builder/form/picker rules | `__tests__/utils/{locationOccupancy,locationSpec}.test.ts`, `__tests__/components/inventory/locations/*.test.tsx` |
| J9 count plan, commit routing, bin-scoped count, draft resume | `__tests__/lib/inventoryCountPlan.test.ts`, `__tests__/utils/inventoryCountAccess.test.ts`, `__tests__/components/inventory/InventoryCountPage.test.tsx` |
| J4 material check | `__tests__/components/jobs/JobPartMaterialsCard.test.tsx`, `__tests__/utils/materialCheckAccess.test.ts` |
| J7 bin remove/receive + job-tagged depletion; owner-side job tag (#59) | `__tests__/components/operator/{OperatorBinView,OperatorReceivePartModal,OperatorLocationActionModal}.test.tsx`, `__tests__/components/parts/PartTransactionJobTag.test.tsx` |
| Label → real `zxing-wasm` decode → location id; foreign-code rejection; camera errors | `__tests__/components/scanner/{scannerRoundTrip.test.ts,LocationScanner.test.tsx}` |
| J1 opening balances via import | `api/tests/integration/test_parts_import_api.py` |

**J1 asymmetry, pinned.** A location-tracked part's quantity is skipped *and the skip reported* — but a **brand-new** part at a locations-on company *does* get its quantity written, because the guard is `BEFORE UPDATE`, so `trg_auto_track_stocked_part` seeds the balance straight from the insert (`test_execute_writes_quantity_for_a_brand_new_part_even_with_locations_on`). Read J1's "deliberately not written" without this and you will "fix" the importer and silently zero opening balances for exactly the shops that turned locations on.

**Numbers pinned:** board load = **2 requests exactly**, at 40 and 400 locations; put-away = **one** RPC at any count, DB-capped at **1,000** parts; repeat subdivide continues `R04`–`R06`; **7** foreign codes rejected; `referencedTable` must be the embed *alias* or paging fails at runtime with `PGRST108`; `Unassigned` is unrenameable — the stock RPCs resolve it by literal name.

**Holes.** Automation-pending: aggregate-path unit conversion — the skew runs the wrong way, the newer location path is tested and the **older, more-used** aggregate path is not, `add`/`remove`/`adjustPartStock`, note-only transaction edits (DB-enforced by `restrict_transaction_update_to_notes`), list search and `is_stocked`/`deleted_at` filtering. **iOS `standalone` camera permission across navigation: unverified, unverifiable from a desk** — §5.10's spike, hence `display: 'browser'`. J4's read costs **one query per table**, never one per BOM line (`materialCheckAccess.test.ts > 'reads one query per table regardless of BOM size'`). Live-only, never CI: put-away rollback, its DB guards — same source and destination, empty selection, **cross-company destination**, each refused, where CI only checks the wrapper propagates the error — the `Unassigned` dedupe migration, storage read on a fresh stack, flag-on count writes (580→575, 180→178, 0→4). Built-and-deferred, not missing: cross-job on-hand-counted-once (`rollUpShortages`, git `87df208`, awaiting a buy list) and sub-assembly explosion (level 1 only, captioned).

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

**Still open, none blocking Phase 1:** do service jobs carry a BOM line for the customer's material (J4 needs an exclusion if so, else false shortages — `custCode`'s 51% likely means *"made for customer X"*; don't conflate) · a **bar rack**? their 22 places (`STOCK`, `SHELF`, `YARD`, `CABINET 3-10`) hold none, so *weakly refuted*, but they buy in feet — shipped without the card, reasoning in a `storageTypes.tsx` comment · what `ZAPP`, `SMD`, `SBS`, `DB BOX`, `0-5` mean (one card-sort) · do they reuse drops (J8) · scanning: ten in a row, dead zones, whose phones (§5.10) · label durability · frequency/pain ranking, which neither observation nor exports reach · **scrap** — does it consume material, and how does it relate to `has_discrepancy` ([operator-paperless-flow.md](../operator-paperless-flow.md) §5.4).

**Closed:** bulk exit from `Unassigned` — built 2026-07-30 as all-of-part-X plus a **search-driven** bulk assign (nobody assigns 9,428 parts; they assign what they hold). **#541** — #496 means *beyond* locations.

**No interview reaches** whether they sustain counting, or whether a shortage view changes behaviour: predictive, so ship J9 and watch. Two Sortly reports (*2026 State of Inventory*; *Do You Need to Track Inventory?*, which speaks to #541) are gated downloads, **not obtained** — cite nothing from them until read.

---

## 10. Next steps

Six of eleven journeys closed, two partial, three untouched. Open: **Phase 3 (#571)** and **Phase 4** — biggest gap **J10**, FR-2 `Must`, still an alert badge with no buy list · **§5.10's spike** (needs their handsets; flipping `display: 'browser'` is the deliverable) · a **rollout call** on `inventory_locations` for Contour, judgement now rather than blocked · **close #541, #550, #59** and re-scope **#496** onto §6 — #550 was *folded into* J7, not built as written (wrong actor, a flag that never existed), so read it as superseded · the [discovery script](../usability-tests/inventory-discovery-script-v1.md), trimmed to vocabulary, bar rack, scanning, never a gate.
