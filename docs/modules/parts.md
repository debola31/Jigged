# Parts Module

> **Condensed 2026-08-03 (issue #634).** 6,264 → 4,842 words (`wc -w`), −22.7%. As-built, verified
> against the code on that date.
>
> **Cut:** the Acceptance-Criteria block (~1,900 words — Given/When/Then bullets that only
> re-described the test they cited; the citations are folded into one **Verification** table); the
> "AI-Powered Bulk Import" walkthrough (delegated to [data-import.md](data-import.md), keeping only
> the parts-specific conflict rule); the Delete-Behavior section, which appeared **twice** (once as
> prose, once as an AC preamble); the User-Stories table; prose restating component internals.
>
> **Kept deliberately:** every withdrawn argument, every measured number, every "why not the obvious
> alternative", and the `#cost-determination-logic` heading — [quotes.md §Pricing](quotes.md#quote_line_items)
> links to it, so **do not rename it**.
>
> **Corrections (7), each marked ⚠ inline:** `is_location_tracked` listed as a live column;
> per-vendor procurement tier sheets described beside the part-level ones that replaced them;
> Count Inventory said to be flag-gated; the bought-part Save button said to be disabled rather than
> absent; two of **five** routing warning types missing; the CSV E2E said to be CI-skipped; and four
> rotted test-citation names (nested `it` titles that no longer exist).
>
> **Verified 2026-08-03 (adversarial pass over the condensation).** Every cited path, `describe`
> name and anchor was re-checked against the tree. Fixed: the warning-type count (the condense pass
> said four; `CostWarning` has **five** — `no_operations` was missed) and a miscounted
> `partsAccess.test.ts` describe total. Restored from the pre-condense text: row-click navigation,
> the `get_priceable_part_ids` source behind the ⚠ marker, Cancel/Back on create,
> `replaceTiersForPart` as the tier write path, and the import's **unit-resolution** validation
> (`missing_primary_unit` / `unknown_unit`) plus the `unknown_vendor` reference check — the
> condense pass had reduced parts-import validation to `part_name` alone.

## Overview

Parts are **company-wide**, never customer-scoped — the customer relationship lives on quotes and
jobs. Four layers on a part drive quoting:

| Layer | What it is | Where it lives |
|---|---|---|
| **Routing** | Linear sequence of operations — how the part is made | [routings.md](routings.md); edited inline by `PartRoutingPanel` |
| **BOM** | Materials consumed — a **separate** layer, *not* attached to the routing | `parts_bom`, edited by `PartBomPanel` |
| **Cost breakdown** | labor + setup + materials, derived live from routing + BOM | Summary at the top of the Pricing card. No standalone Cost Breakdown card and no Recalculate button — it reloads on every routing/BOM auto-save |
| **Pricing** | Quantity break-points (1, 2, 4 …), each with its own markup % | `part_pricing_tiers` |

Mirrors how shops already think: cost the part once, set break-points once, then point quotes at
the tiers that apply.

**Markup % is the source of truth on a tier.** Unit price is *always* derived as
`base_cost × (1 + markup/100)` and is never stored; typing a unit price back-calculates the markup.
Quotes snapshot the resolved prices as immutable line items.

**Priority:** Must Have (Build Second). **Dependencies:** none.

**Tables:** `parts`, `part_pricing_tiers`, `part_attachments`, `parts_bom`,
`part_procurement_tiers` (bought-part costs), `parts_unit_conversions`, `part_comments`.

> `part_comments` was renamed from `part_notes` in `20260728040701`
> to free the `notes` name for shop-floor knowledge. The table is unchanged and is **not** the
> operator notes feed — see [operator-view.md](operator-view.md#data-model).

**Who uses it.** *Owner/Admin* runs the catalog (list, search, create, edit, archive, CSV import) and
defines how a part is made (routing + BOM from the detail page). *Salesperson* sets quantity tiers
with per-tier markup, sanity-checks the cost build-up without leaving the part, and cuts a one-off
deal by overriding a price **on the quote**, never on the part. Both surfaces are the office desktop
— see CLAUDE.md's device model; no part screen is operator-facing.

---

## Data Model

### `parts`

| Field | Type | Notes |
|---|---|---|
| id | UUID | PK |
| company_id | UUID FK | Tenant isolation |
| part_name | Text | The part number, e.g. `AE36589E-RT` |
| description | Text | Nullable |
| source | Text | `made` \| `bought` (CHECK, default `made`). Made → routing + BOM; bought → procurement tiers |
| primary_unit | Text | Stocking/costing unit. Effectively NOT NULL via the `parts_requires_unit` CHECK |
| quantity | Numeric | On-hand (default 0). Only ever changed through `inventory_transactions`, never the part form |
| reorder_point | Numeric | Low-stock threshold, nullable |
| preferred_vendor_id | UUID FK | Supplier **label** for a bought part — see the procurement note below |
| costing_batch_quantity | Numeric | Batch size the part is costed at as a made child (`compute_part_cost_at_qty`) |
| deleted_at | Timestamp | Archive marker; nullable. See [Delete](#delete--archive-soft-delete-never-blocks) |
| created_at / updated_at | Timestamp | — |

**`updated_at` includes satellite writes.** Edits to the routing, pricing tiers, BOM, or
procurement tiers bump it via AFTER triggers
(`20260720191253_touch_parts_updated_at_on_satellite_writes`).
**Withdrawn:** leaving `updated_at` to the part row alone — wrong because recency-sort then missed
exactly the parts people had just worked on.

**Unique:** `(company_id, part_name)` — the identity key the CSV importer upserts on
(`ON CONFLICT (company_id, part_name)`), so re-importing an export updates in place.

**Removed April 2026:** `category_id` + the `part_categories` table. **Withdrawn:** a shared
category default markup — wrong because the entity was anemic (one number,
`default_markup_percent`); each part now owns its markup on its own tier rows.

> ⚠ *This doc previously listed `is_location_tracked` as a live column. It was dropped by
> `20260802015837_every_part_has_a_place`
> — every part can be received anywhere now. (The old `supabase/schema.prod.sql` snapshot still
> showed the column; it has since been **deleted** for exactly this class of lie — see
> [CLAUDE.md, "Schema source-of-truth"](../../CLAUDE.md#schema-source-of-truth).)*

### `part_pricing_tiers`

One row per quantity break. **Only tier metadata is stored** — `quantity` and `markup_percent`.
Base cost and unit price are **not columns**; they are recomputed on every read
(`getTiersWithComputedPrices` / `calculateTierPricing`) so stored data can never drift from the
routing + BOM.

| Field | Type | Notes |
|---|---|---|
| id / part_id / company_id | UUID | `part_id` cascade-deletes |
| sequence | Integer | Display order within the part (10, 20, 30…) |
| quantity | Numeric | Break qty, `> 0` CHECK. Widened from `integer` to **unbounded numeric** (`20260623143220`) so parts sold by length/weight/volume can set a fractional break; the UI enters up to 4 dp |
| markup_percent | Numeric(10,6) | **Source of truth.** Widened from `numeric(5,2)` (`20260623134506`) — 0.01% quantization visibly moved the price |
| created_at / updated_at | Timestamp | — |

**Unique:** `part_pricing_tiers_unique_seq` on `(part_id, sequence)`.

> **Dropped columns:** `base_cost_per_unit` and `unit_price`, both now derived at read time. The
> drop predates the `20260527151536_baseline`
> and was folded into it — there is no standalone migration file to look up. *(This doc previously
> cited migration `20260514`; no such file exists.)*

**A cost basis is something that says what a part COSTS, and silence is not zero.** For a bought
part that is a procurement tier; for a made part, priced operations or BOM children. Two rules make
that literal rather than aspirational, and both replaced a state where a part computed **$0.00 and
read as ready to quote**:

- `part_has_cost_basis` — a made part with no operations and no BOM children has no basis
  ([`20260816231611`](../../supabase/migrations/20260816231611_part_cost_basis_predicate.sql)).
  Measured in production before it: **3,300 live parts across two companies** in exactly that state.
- An operation with a rate but **no times** is not a cost either
  ([`20260819011705`](../../supabase/migrations/20260819011705_untimed_operation_is_not_a_cost.sql)).
  `part_rollup_at_qty` COALESCEs both times to 0, so a part routed through four stations priced out
  at nothing. Either time alone is a real answer — a setup-only operation is a fixed charge, a
  cycle-only one is the ordinary case — so only *both* being null counts as silence. `saveRouting-
  WithOperations` stopped coercing a blank setup to `0` for the same reason: blank means nobody has
  said, and zero is a claim.

**Single-direction flow.** `markup_percent` in → `unit_price` out, always against the *current*
cost basis (routing + BOM for made; procurement tiers for bought). A cost change moves unit prices.
**There is no lock concept on the part** — if you need a price stable across routing changes, lock
it on the quote ([Quotes — per-quote overrides](quotes.md#quote_line_items)). Typing a unit price is
shorthand for "compute the markup that yields this"; nothing else needs keeping in lockstep because
there is no stored `unit_price`.

### `parts_bom`

One row per material consumed when making the parent. Part-attached, not routing-attached, so a
sub-assembly can be a child of several parents without per-routing duplication.

| Field | Type | Notes |
|---|---|---|
| parent_part_id / child_part_id | UUID | The edge. A `BEFORE INSERT/UPDATE` trigger rejects cycles (depth 50) |
| quantity + unit | Numeric + text | Per parent unit. Below 1 is a yield ("1 strip makes 20"); a unit other than the child's primary resolves through `parts_unit_conversions` |
| consume_whole_units | Boolean | Ceiling to discrete stock. **Derived from the unit** (count → whole), not a manual toggle |
| charge_basis | Text | `'cost'` (default) or `'price'` — see below |

#### Charge basis — what a child contributes to the parent's rollup ([#727])

The rollup used to always take the child's **cost**, so a child's declared markup evaporated the
moment it was consumed. The only way to express "markup on material, straight cost on machining"
was padding the child's cost with hidden margin, which falsifies the cost field.

Each line now declares one of:

- **`'cost'`** (default) — our cost of the child.
- **`'price'`** — the child's marked-up price.

**A line's basis governs how that child is charged into its parent at every level.** A `'cost'`
line contributes the child's *charge base* — its rollup honoring its own declarations — not its true
cost, so a material markup declared deep in a tree survives the hop upward instead of evaporating
one level higher. Two modes, one function body:

| Function | Mode | Means |
|---|---|---|
| `compute_part_cost_at_qty` | bases ignored | TRUE cost. Unchanged by #727. The margin denominator |
| `compute_part_charge_base_at_qty` | bases honored | What a PRICE is built on. `quote_line_items.base_cost_per_unit` |
| `compute_part_price_explain_at_qty` | — | A child's charged rate from its own tier, **and the markup that produced it** (frozen onto the quote) |

Both are `part_rollup_at_qty(part, qty, apply_charge_basis)` with the flag flipped, so the math has
one implementation and the two can't drift.

**The price rule.** The child's own pricing tier, with the base evaluated at *that tier's* quantity
(the tier-band rule, so the number equals what the child's Pricing card lists) — and nothing else.
No tier means **NULL, un-priceable, flagged**: never a silent fall back to cost, and never a
shop-wide number.

**There is deliberately no shop-wide markup inside this rollup.** A draft of #727 had one, for
bought children with no tier of their own, and it was removed before shipping: a shared default
resolved at *read* time with nothing on screen to say where the number came from is exactly what
got the `markup_rates` module deleted in July 2026
([`20260713011616`](../../supabase/migrations/20260713011616_remove_markup_rates_module.sql)). The
setup problem it solved — a part being costed but not quotable until someone types a markup — is
solved at **write** time instead, by the starter tier below. A markup lives in one place: the part's
own Pricing page.

> Worked example. Default 25%. `BAR` bought, cost $10, no tier. `BRACKET` made, labor $30, BOM =
> 1 × BAR **at price**. `ASSEMBLY` made, labor $20, own markup 40%, BOM = 1 × BRACKET **at cost**.
> BAR charges $12.50; BRACKET's charge base is $42.50 (true cost $40); ASSEMBLY takes $42.50 —
> **not** $42.50 × 1.25 — for a base of $62.50 and a price of $87.50 against a true cost of $60.
> The $2.50 uplift is counted exactly once. Put BRACKET on a `'price'` line with its own 15% tier
> and the price becomes $96.43 — stacked deliberately, and the quote breakdown shows the effective
> margin (37.8%) so the stacking is seen rather than discovered.

**Priceability moves with it.** `20260715180446` had established that only the root needs a markup.
A `'price'` line makes that false for that edge, so `compute_part_cost_explain` and
`get_priceable_part_ids` both encode *the root needs a markup, and so does any child charged at
price* — nothing covers for a missing tier. An agreement test holds the two views together.

**One control, per part, over every material.** The Materials panel carries a single toggle —
*Charge the N materials at: Our cost | Their marked-up price* — and it shows state rather than
offering two actions, because which way a part is set is what you come there to check. How much each
one marks up still comes from its own Pricing card.

**And a shop-wide default behind it**, `companies.default_material_charge_basis`, so a shop that
always values materials one way says so once instead of on every new part. Precedence for a newly
added line is named in [`chargeBasisForNewLine`](../../types/bom.ts): the part's own existing stance
→ otherwise the shop default. Like the starting markups, it is a **seed read at line-creation
time**, never by the rollup, so changing it reprices nothing.

**Made and bought children are treated identically**, and that is the whole point of the model: both
carry costs and pricing tiers, and the rollup has never distinguished them — the price rung resolves
any part with a markup tier, whatever its source. Charging a sub-assembly at its own price is
ordinary transfer pricing.

> ⚠ *An earlier draft forced made children to cost. That was inherited from the read-time shop-wide
> material markup this design no longer has, where the argument was that a default applied at bought
> leaves would double-mark if applied again at a made part above them. With no such default the
> argument has nothing to stand on, and the restriction only ever lived in the UI — never in the
> engine. Stacking stays visible either way: the Cost card's **Material markup / unit** row counts
> every child charged above cost, whatever its source.*

⚠ *There was also briefly a per-row **Charge at** select in the material editor. It was removed: the
answer is the same for every line on a part, so a fourth control on every row bought nothing but
width. The issue justified per-line granularity with "material at price on customer jobs but at cost
on internal stock-making work orders" — but that distinction is **per-job**, and a BOM line cannot
see which job consumes it, so the granularity never served the case that motivated it.*

**The column stays per-line**, which is why none of this needed a migration and why an import can
still set lines individually. A part whose lines disagree renders as "mixed" (neither option
selected) rather than the toggle picking one and misreporting the rest.

### `part_attachments`

Engineering files — drawings (PDF **and DXF**), CAD (STEP), legacy CAD (DWG). Bytes live in the **private**
`attachments` bucket at `{companyId}/parts/{partId}/{uuid}_{filename}`; this table is the metadata
index. Mirrors `job_attachments`, widened to multiple kinds. Access layer:
`utils/partAttachmentsAccess.ts`.

Columns: `id`, `company_id`, `part_id` (both cascade), `storage_path`, `file_name`, `kind`
(`pdf|step|dwg|dxf|other` CHECK, computed from the extension at upload — drives viewer dispatch;
`dxf` is the file the title-block extractor READS, kept beside the part it came from, and is
download-only until a viewer exists),
`mime_type` (advisory; STEP/DWG often report `application/octet-stream`), `size_bytes`,
`uploaded_by` (→ `user_company_access`, `ON DELETE SET NULL`), `created_at`.
**Index:** `(part_id, created_at DESC)` — the newest-first list query.

**RLS** (mirrors `part_comments`): SELECT any member; INSERT only as yourself
(`uploaded_by = get_operator_access_id(company_id)`); DELETE uploader **or** admin
(`… OR is_company_admin(company_id)`).
**SET NULL consequence:** once an uploader's access row is gone their name shows "Unknown" and only
admins can delete that attachment. Accepted — admins retain control.

**Size caps:** PDF **25 MB**; STEP/DWG **100 MB** (CAD runs large). Enforced in
`validatePartAttachmentFile` — the number lives with the check.

---

## UI

### Parts list — `/dashboard/{companyId}/parts`

AG Grid. Columns: **Part Name** (inline ⚠ marker when not yet priceable), **Description**,
**Source** (Made/Bought chip), **Updated**. No Category column (removed) and no Cost column —
engineering/cost signals live on the detail page.

**Parts is the item master. It carries no quantities.** `/dashboard/{companyId}/inventory` was
folded in on 2026-07-30 and now 307-redirects here (a plain `redirect`, not `permanentRedirect`, so
nothing caches if it is ever revisited). **Withdrawn:** `/inventory` as its own list — wrong because
it was `parts WHERE is_stocked` plus three columns with no unique capability. See
[inventory.md §5.12](inventory.md#512-two-nouns-parts-is-what-we-have-storage-is-where-it-lives--2026-07-30).

⚠ **The stock columns are gone, and that is the rule rather than an omission.** Until
`parts.is_stocked` was dropped this grid also carried **On hand**, a derived **Status** chip, a
**Stock filter** (All / Stocked / Low / Out, seeded from `?status=`) and two shortage-lens columns
(**Reorder at**, **Short by**), plus a **Count Inventory** toolbar button. All of it moved to
Storage, which went GA in the same change so it is somewhere every tenant can reach. Parts says what
the shop makes and buys; Storage says how much there is and where. Do not add "just a quantity
column" back — that split is the whole point of the removal.

| Element | Behaviour + why |
|---|---|
| **Default sort** | Updated descending — people care about what they just worked on, not the alphabetical top; alphabetical is one click away. Server-side for the real columns (`part_name`, `source`, `updated_at`) |
| **Search** | Server-side `ilike` across `part_name` **or** `description` |
| **Client-side filters** | Source (All/Made/Bought), Completeness (All/Complete/Incomplete) |
| **⚠ incomplete marker** | The marker and the Completeness filter read one set — `getPriceablePartIds` over the `get_priceable_part_ids` RPC, the same structural rule `getPartSetupStatus` applies on the detail page, so list and page can't disagree. Tooltip: *"Incomplete — needs setup before it can be quoted"*, with a legend under the grid spelling out what setup means (*"routing/materials, or a vendor cost"*) |
| **Row click** | Opens the part workspace, `/parts/{id}?from=parts` — the `from` is what the workspace's Back link reads to name the list it came from |
| **Toolbar** | Add Part, Import |
| **Bulk (rows selected)** | **Delete (N)**, Export CSV |
| **Pagination** | 25/page; selector 25 / 50 / 100 |
| **Empty states** | `"No parts yet. Add your first part — made in-house or bought from a vendor."` (+ Add Part, and the `ImportAllDataLink` text link to the guided importer). Filtered-but-empty: `"No parts match these filters."` |

**Where Count Inventory went.** It sat on this toolbar, unconditionally, precisely because
gating it on `inventory_locations` had once *removed* the entry point most people look for — the
founder looked here and concluded place-scoped counting did not exist. Dropping the stock columns
took the button with it, so that lesson had to be paid for a second way: `inventory_locations` is
now **on by default**, which makes the Storage board a place every tenant actually has. Counting is
reached from Storage, and from a part's own Inventory tab. `/inventory/count` itself is unchanged
and still accepts `?from=`.

### Part create — `/dashboard/{companyId}/parts/new`

Renders the same `PartWorkspace` in **create mode** — the create view *is* the saved view, so there
is no create modal. Identity fields (`PartIdentitySection`): Part Name (required, unique in
company), Description, Source, Primary unit (required), stocking options, and — **only in create
mode** — Preferred Vendor for a bought part.

**Create part** inserts the row and redirects into the live `/parts/{id}` (preserving quote-return
and list-origin context). **Cancel** / **Back** return to the list. Cost, pricing, routing, BOM and
files are all edited there. There is **no** `/parts/{id}/edit` route.

### Part detail workspace — `/dashboard/{companyId}/parts/{id}`

An **editable, maturity-adaptive workspace** (`PartWorkspace`) — no "Edit" mode, no Edit button;
identity fields auto-save on blur via `updatePart`. Sticky header carries the part name, a
completeness/priceability chip, and Delete.

Tabs, URL-addressable via `?tab=`:

| Tab | Slug | Shown |
|---|---|---|
| Workspace (default) | *(none)* | Always — identity, cost/pricing, routing, BOM |
| Inventory | `inventory` | Always — every part is stockable |
| Usage | `usage` | Always — jobs and quotes referencing this part |
| Files | `files` | Always |
| Activity | `history` | Always. Slug stays `history` for deep-link back-compat |

**Activity permissions** ([#628](https://github.com/debola31/Jigged/issues/628)): a `user` comment is
**editable by its author, deletable by author or company admin**; an edited one renders "· edited".
Edit is author-only *on purpose*, asymmetric with delete — an admin who could reword someone else's
comment would change what it says without changing whose name is on it. Auto-logged `pricing`
entries are neither editable nor deletable (they are the audit trail), and the RLS policies exclude
them by `note_type` in **both** `USING` and `WITH CHECK` rather than trusting the UI to hide the
control. `part_comments` carries a column-scoped `GRANT UPDATE (body)` plus a guard trigger, so an
edit cannot reach `author_id` or `note_type`; the legacy blanket `GRANT ALL` (which included
`TRUNCATE`, and therefore made append-only-ness UI convention rather than enforcement) was narrowed
in the same migration,
`20260801012019_notes_editable_body`.

#### Inline routing editor (`PartRoutingPanel`)

Embedded on the Workspace tab — no separate page. Linear **Operations** list (materials are the
separate `PartBomPanel`) with auto-save: each modal save, reorder click or delete persists
immediately via `saveRoutingWithOperations`, with a "Saving… / All changes saved" indicator in the
panel header. The first add implicitly creates the routing record. Full editor behaviour:
[routings.md](routings.md).

#### Cost build-up + Pricing (`PartPricing`)

One card. There are no separate `PartCostBreakdown` / `PartPricingTiers` components.

- **Cost summary rows** above the tier table, from `calculateRoutingCost(partId)`: run labor / unit,
  setup (one-time, amortized across tier qty), materials / unit. No per-operation or per-material
  tables and no `@ qty 1` / `@ qty 10` preview rows.
- **Warnings surface inline** so data-quality gaps catch the salesperson's eye before quoting.
  **Five** types on `CostWarning` in `utils/routingCostCalculation.ts`: `empty_operation`,
  `missing_labor_rate`, `missing_material_cost`, `no_operations` (a routing record exists but holds
  zero operations), `missing_external_pricing` (an external/vendor work-center op with no
  `external_unit_price`). ⚠ *This doc previously listed only the first three.* Only
  `missing_material_cost` carries a `child_part_id`, so only it renders as a link to the offending
  BOM child; the others fall back to a bare message because they point at no navigable target. The
  whole alert renders for **made** parts only (`!isBought && breakdown`) — a bought part has no
  routing to warn about.
- **Tier table** — always-editable rows: Qty, Base / unit (derived, read-only), Markup %, Unit
  price, delete icon; header **Add tier**.
  **The table is identical for made and bought parts.** **Withdrawn:** hiding Base / unit and Unit
  price on bought parts because cost depended on "which vendor wins" — wrong since PR #567 collapsed
  procurement to deterministic part-level tiers, which makes the unit-price-after-markup
  well-defined. Bought base cost comes from the part's procurement tiers via `getComputedPartCost`,
  the same engine made parts use.
- A **new part opens with one unfilled row** (Min qty 1, Markup blank) and stays not-priceable —
  **until it has a cost.** The moment the part's first priced operation or material lands, the card
  writes that row for itself at the **shop's starting markup** (0% out of the box), and the part
  becomes quotable with nobody having typed anything.

  **Where the number comes from.** `companies.default_markup_made_percent` /
  `default_markup_bought_percent` — the shop's *starting* markup, split by source because a shop
  marks up purchased goods and its own labour at different rates. Both are `numeric(10,6) NOT NULL
  DEFAULT 0`, so out of the box a starter tier is 0% and the part sells at cost.

  **They are seed values, not a pricing rule.** They are read at exactly one moment — when a costed
  part has no tiers — and written into that part's own tier row. Nothing reads them again, so
  raising the made markup to 30% reprices nothing that already exists; it changes what the *next*
  part starts at. That write-time boundary is the whole design, and it is why the rollup (above) has
  no shop-wide fallback: `lib/companyDefaults.ts` records that resolving a shared default at read
  time, with nothing on screen to say where the number came from, is what got `markup_rates`
  deleted.

  **Why a default rather than a prompt.** Before this, the answer to "why can't I quote the part I
  just set up?" was a blank box on a card the user had no reason to open. The step taught nothing —
  the answer is always *some* markup.

  **It is written by the save that created the cost, not by the Pricing card.**
  `ensureStarterPricingTier` runs inside the workspace's post-mutation refresh — the one choke point
  every cost-creating panel (routing, materials, bought-part cost sheet) already goes through — and
  it runs BEFORE the refresh lands, so priceability is re-derived once with the tier already there.
  It never overwrites a decision: only a part with **no tiers at all** and a real cost qualifies, and
  it logs a `pricing` note saying the app wrote it.

  ⚠ *This lived as an effect inside `PartPricing` first, and both problems it caused are worth not
  repeating. Running after the refresh made the workspace flash "this part isn't ready to quote"
  for a second and then correct itself — the app visibly changing its mind about a part the user had
  just set up. And an automatic write inside an explicit-Save card kept reaching around that card's
  own isolation guard: it ate a staged Min qty once and a staged operation edit once, both caught by
  E2E rather than by unit tests. The card is explicit-Save only again, which is what
  [interaction-standards §2](../interaction-standards.md#2-saving) asks of it.*

  **The gate is "is there a cost", not "is there a routing".** A made part whose operations were all
  deleted still has a routing row and rolls up to $0; seeding a markup there would make it quotable
  **for nothing** — worse than not being quotable at all. So the trigger is a priced labor or
  material item in the breakdown (bought parts: a resolved procurement cost at qty 1).

  While that starter tier is still the only tier and still sitting at the shop's number, a caption
  under the table names its source — *"…your shop's starting markup for parts you make, from
  Settings. Change it here for this part alone."* — and, at 0%, says what that means in money
  ("this part sells for what it costs"), because selling at cost is not something a shop should
  discover on an accepted quote. It disappears the moment the markup is changed.

  **The CSV importer seeds it too**, for rows it creates that arrive with a cost (a bought row with
  `cost_per_unit`). A made row has no routing yet, so it gets its tier from the part page later.
  Without this an onboarding import lands un-quotable, because nobody opens 8,000 part pages — and
  the read-time fallback that used to cover that case is gone. It never touches a part that already
  has tiers.

  ⚠ *This doc previously said "Nothing is auto-applied on create" — still true of **create**; the
  starter tier is written on first **cost**, not on create.*

**Editing model** — markup % is the source of truth. Editing **quantity** recomputes the displayed
base cost (setup amortization moves) and unit price follows the current markup; editing
**markup %** recomputes unit price; editing **unit price** back-calculates markup
(`handleUnitPriceChange` → `calculateMarkupFromUnitPrice`) and stores *that*. No lock concept —
later routing changes still propagate.

**Explicit save, not auto-save** ([interaction-standards §2](../interaction-standards.md#2-saving)):
pricing feeds quotes, so tiers commit on **Save pricing** (`replaceTiersForPart` — the payload *is*
the new set: rows missing from it are deleted **before** the insert/update pass, which frees the
`(part_id, sequence)` slots so a full replacement can't 409 against the rows it is obsoleting), and
each save auto-logs a `pricing` note
to Activity. Unsaved work is marked twice — a `3px` amber left accent on the edited row (the same
accent incomplete BOM/routing rows use, one rung below their red) plus the shared
`UnsavedChangesBar` (count + Discard + Save), sticky at the card's bottom and rendered **only when
dirty**, so its appearance is itself the signal. Amber not red: an unsaved edit is not a mistake.
**Withdrawn:** a caption-sized grey "Unsaved changes" hint — wrong because it sat below the fold and
went unread, which is how a staged edit got silently discarded.

**Dirty state is derived, never latched.** The card snapshots the persisted values it was seeded
from and compares live rows, so reverting by hand (1 → 10 → 1) clears the state rather than demanding
a write that would change nothing.

**`refreshKey` invalidates derived data only.** A routing/BOM auto-save bumps the page-level counter
and the breakdown plus every tier's displayed base cost recompute — but it deliberately does *not*
re-seed the editable tier rows or clear the dirty flag while an edit is staged. Before this guard,
saving an operation while a Min qty sat unsaved silently reverted it (§2 invariant 1). A genuine
part change still reloads, since the dirty flag belongs to the part being edited.

**Batch size has its own explicit Save** (`updatePartCostingBatchQuantity`), not blur. It reads like
a harmless scalar, but `compute_part_cost_at_qty` values this part as a made child *at exactly this
quantity* in every parent's BOM — a fat-fingered 30 → 300 silently re-costs every parent and flows
into their quotes. That is financial data, and financial data does not auto-save. Same affordance as
the tier table (amber outline on the field + `UnsavedChangesBar` / **Save batch size**).
**Withdrawn:** a lone Save button with no unsaved marker — wrong because "some cards prompt you,
some don't" is the inconsistency the standard exists to remove.

#### Bought-part Cost card (`PartProcurementPricingPanel`)

A **Preferred vendor** picker plus a **part-level** qty-break cost-tier sheet (Min qty / Unit cost).

> ⚠ *This doc previously described a **per-vendor** tier sheet ("when the selected vendor has no
> saved tier…"). `part_procurement_tiers.vendor_id` was dropped by
> `20260714173443_drop_per_vendor_procurement_tiers`,
> which re-keyed the unique index to `(part_id, min_quantity)`.* **Withdrawn:** cost tiers as a
> property of the (part, vendor) pair — wrong because it forced a which-vendor-wins resolution step
> for no gain. Cost is a property of the **part**; the vendor is a pure supplier label
> (`parts.preferred_vendor_id`) and switching it does **not** swap or discard the sheet. Multi-vendor
> sheets / RFQ / POs are deferred to a future purchasing module ([#571]).

- **Preferred vendor lives here only.** It is no longer duplicated on the part-details/identity card
  — that field renders only in the create flow (`showVendor = source === 'bought' && mode === 'create'`).
- **Explicit Save (`Save costs`)** — cost is financial data. Deletes and additions are reconciled
  against the persisted sheet on save. Same amber row accent + `UnsavedChangesBar` as Pricing.
- **The vendor picker is auto-save, and now looks like it.** Two save models in one card is what
  [interaction-standards §2](../interaction-standards.md#2-saving) forbids *when the user can't tell
  them apart*. The picker keeps auto-save (a single non-financial label — the right mode) but sits in
  its own bordered block with its own `SaveStatus` and helper text ("Saved as soon as you pick it.
  Cost tiers below apply regardless of vendor."), so the two models read as two sections.
- **No-cost state** — one empty starter row highlighted red plus a short red prompt ("Add at least
  one cost tier so this part can be priced and quoted."), using the theme `error` palette, never a
  hardcoded hex. **Withdrawn:** a yellow banner + "Add first tier" bubble.
  ⚠ *This doc previously said "Save disabled until edited". The Save affordance is **absent** until
  dirty, not disabled* — with nothing staged the action is genuinely irrelevant, not blocked
  (interaction-standards §4 rule 3).
- **Indicator clears on save** — the panel fires `onSaved`, so the workspace re-derives priceability
  and the "Needs cost" chip clears **without a page reload**. It previously lingered until reload
  because the panel had no refresh callback.

#### Files tab (`FilesTab`)

Part of the **office/admin dashboard** — nothing here is operator-facing.

- **Upload**: multi-file picker accepting `.pdf,.step,.stp,.dwg`. Validated client-side (allowlist +
  per-kind cap) *before* upload; rejected files surface a message and are not stored. Immediate, no
  draft staging.
- **List**: newest-first — filename, kind chip (PDF/STEP/DWG), size, uploader + date.
- **Row actions**: Open (see dispatch below), Download (every kind, fresh signed URL), Delete (shown
  to uploader or admin; RLS enforces the same rule; removes the row **first**, then the stored file,
  so a row-delete failure leaves the file intact).

| Kind | Viewer | Notes |
|---|---|---|
| PDF | Native `<iframe>` + signed URL | No library; renders inline in `AttachmentViewerModal` |
| STEP (`.step`/`.stp`) | In-app 3D viewer | `online-3d-viewer@^0.18` (three.js + occt-import-js WASM), lazy-loaded via `next/dynamic({ ssr: false })` because the engine touches `window`. In v0.18 it fetches occt-import-js from the **jsdelivr CDN at runtime** — there is no self-hosting hook. Single-threaded build, so no COOP/COEP headers needed |
| DWG | Download-only | No in-browser render; Contour standardizes on PDF, so DWG is converted upstream. Experimental in-browser viewer: [#411] |

**Upload-after-creation:** part creation has no draft row — the part id exists only after
`createPart` → redirect. So files are uploaded on the live detail page; the redirect supports
`?tab=files` to land there. No temp-path staging.

---

## Cost Determination Logic

> Anchor is load-bearing — [quotes.md §Pricing](quotes.md#quote_line_items) links to
> `parts.md#cost-determination-logic`.

| Layer | Produced by | Shape |
|---|---|---|
| 1. Routing cost | `calculateRoutingCost(partId)`, live | per-op run + setup, per-material line costs **at two rates** (charged and true — see [`parts_bom`](#parts_bom)), warnings |
| 2. Tier cost | `calculateTierPricing(breakdown, quantity, markup)` | `base_cost_per_unit = run_labor/unit + charged material/unit + (total_setup / quantity)`; `unit_price = base × (1 + markup/100)`. `trueCostPerUnit` is the same figure at true cost — the margin denominator |
| 3. Quote line item | Frozen at quote creation | `(part_id, quantity, unit_price, total_price, markup_percent, base_cost_per_unit, true_cost_per_unit, is_quote_override)` — see [quotes.md](quotes.md#quote_line_items) |
| 4. Job part | Copied at quote→job conversion | `(quantity, unit_price, total_price)`. Unlike the quote line, `job_parts.quantity` is **editable** post-conversion (with fulfillment guardrails) and `total_price` re-derives as `quantity × unit_price`. **Invoicing and revenue read the job part, not the quote snapshot** — it is the post-conversion source of truth. See [jobs.md](jobs.md) |

**Base is the CHARGE base, not true cost** ([#727]). Markup applies to what the materials are
charged into the part at, so `getTiersWithComputedPrices` and `getPartPriceAtQty` both resolve
through `compute_part_charge_base_at_qty`. The two numbers are identical until a BOM line is set to
charge its child at price; when they diverge, the Cost card grows a **Material markup / unit** row
and a **Price base / unit** total so the Pricing card's Base is traceable from the same screen.

**Bought parts** have no routing: base cost comes from procurement tiers via
`compute_part_cost_at_qty`. The shared resolver `getTiersWithComputedPrices` falls back to that when
a part has no routing/BOM, so a bought tier resolves `procurement_cost(qty) × (1 + markup/100)`.
`getPartPriceAtQty` is the single price source used by the quote form, quote line and preview.

A **made** part with no routing/BOM shows an "Add operations or materials to calculate pricing"
empty state rather than a fabricated $0; tiers can still be added and unit prices typed (the
back-calculated markup will look unusual until a cost basis exists).

---

## Bulk import — how parts arrive from a CSV

Parts are imported through the one guided importer at `/dashboard/{companyId}/import`; the flow,
confidence scoring and Review-and-Fix step are documented once in
[data-import.md](data-import.md) — not repeated here. **There is no parts-specific import page or
Import button any more** — `/parts/import` and its `analyze` / `validate` endpoints were removed
once the guided importer covered parts end to end.

Endpoint: `POST /api/parts/import/execute`, which the guided importer posts to. The rules below
are what that write enforces (via `validate_import`, now an internal step of execute rather than a
route of its own).

**The parts-specific rule — what counts as a conflict:**

- **Duplicate `part_name` within the same CSV** (`csv_duplicate`) → the second and later rows
  collapse into one; they do not import twice.
- **A `part_name` that already exists in the company is NOT a conflict — it is an update.** Execute
  upserts `ON CONFLICT (company_id, part_name)`, so re-importing the same export is idempotent
  rather than duplicating or skipping. **No `legacy_id` is involved.**
- **An unresolvable reference** — a row naming a vendor the company doesn't have — is
  `unknown_vendor`.

**Validate also resolves units, and does it for every row.** `part_name` is required
(`missing_part_name`); `quantity` / `cost_per_unit` / `reorder_point` must be non-negative
(`invalid_quantity` / `invalid_cost` / `invalid_reorder_point`); and every row's unit is normalized
through `resolve_units_for_rows` — no unit at all is `missing_primary_unit`, a unit that won't
normalize is `unknown_unit`.

> **Withdrawn:** resolving units only for rows inferred as stocked — wrong because
> `parts_requires_unit` makes a unit mandatory for **every** part, made or bought, stocked or not.
> A filled unit on such a part was never resolved, so it fell into the "has a raw unit but no
> resolved unit" branch and was rejected as `unknown_unit` and skipped — even a perfectly good
> "each". That is why filling in units still skipped ~7,700 parts of the Tangle export. (The
> inference this describes is itself gone now: `is_stocked` was dropped and every part is
> stockable, so there is no stocked/non-stocked split for the importer to get wrong.)

---

## Add parts from drawings — `/dashboard/{companyId}/parts/drawings`

On for every company — no flag. Drop a folder of engineering drawings, review one row per part,
create. Built because a shop that receives 31 drawings from a customer types 31 parts by hand.
Measured on the real package: **93 files become 31 parts, and the read is instant.**

**Filing is the outcome, and the screen says so.** It opens as a plain list of parts and
descriptions — no columns about work, nothing to expand. **Add operations** and **Add materials**
are checkboxes; ticking one grows its column and makes the rows expandable, and *unticking it clears
what it added*, which is the only undo "apply to the other 30 parts" has.

**No AI.** Names, descriptions and cut lists all come from the deterministic pass, which runs in the
tab and touches no network — so the import waits on nothing, costs nothing, and cannot half-fail.
`api/routes/drawing_routes.py` and the title-block model remain, unreferenced, for when this is
revisited; the measurement that justified them is in the PR.

**The deterministic pass runs in the browser.** `lib/dxfTextExtract.ts` or `lib/pdfTextExtract.ts`
produce `(text, x, y, height)` items; `lib/drawingText.ts` assigns them to title-block roles;
`lib/drawingCutList.ts` reads a weldment's bill of materials. No file ever leaves the tab.

### What the rules are, and why

**One part per basename stem, but the folder matters.** `File.name` carries no path, so a
folder-per-part export arrives as one repeated filename; grouping keys on the directory too or two
parts land in one row. A leading `NN_` index comes off only when dropping it is what makes two
stems meet.

**A 3D model joins its drawing by part number.** The real package names them differently —
`1011770-…-60082-10-0000.dxf` is the drawing and `1011770-…-60078-02-0000.step` is the model — so a
group with nothing readable is adopted by a readable group whose leading token matches, only in the
same folder and only when exactly one candidate does.

**DXF before PDF, always.** A DXF carries attribute tags that name their own fields; a PDF carries
only what was printed. A group with both reads the DXF. A PDF with no text operators is a scan, and
says so rather than showing a blank row — the row is still created with its files attached.

**Identity keys on `(customer_id, customer_part_number)`, never on `part_name`.** Two OEMs
legitimately use the same number, so a name-keyed import would merge one customer's part onto
another's. See `part_customer_references` above and `utils/drawingImportIdentity.ts`: a live part
belonging to another customer is never written to (the row is renamed and says so), and a failed
lookup reports "we couldn't check" rather than "clear to create". An archived namesake is not a
match at all — reuse **reclaims** rather than revives (§16), so the archived row is renamed aside
and this import gets a clean part.

**Material and finish compose into the description.** `parts` has no material column;
`part_comments` would bury the value and a spec card is unverified, so the row reads
`plate · AL · ZINC PLUS TRIVALENT CHROMATE`.

**The drawing sits beside the row it produced.** `DrawingFilePanel` renders the PDF through pdf.js
with zoom and drag-to-pan, and the STEP model through the part page's own viewer — from the `File`
still held in memory, so no upload and no network. Checking a package is a comparison, so the panel
follows the selected row rather than covering it.

### Routing without timing, and why they are separate

**Which stations a part visits is recall; how long it takes there is a consensus.** Anyone who knows
the part says "mill, lathe, deburr" without pausing; times get agreed, sometimes measured, sometimes
argued. Bundling them made the fast answer wait on the slow one — and under time pressure that
produces a typed-in cycle time nobody believes, which reaches a customer looking exactly like a real
one.

So `StationStrip` asks only the first: one line of work centres that bleeds off the right edge,
ordered by how often this shop has actually routed through each (`work_center_usage`), so the six it
really uses are already in view. Search filters the strip in place; arrows and arrow-keys-plus-Enter
are the other two doors. No numbers at all. Work is entered on ONE part and spread with **Apply this
routing to the other N parts** — starting from a concrete part rather than an abstract routing,
because people reason far more reliably from *this part works like so*. "Set times and rates" swaps
in the full editor for anyone who already knows.

**The part comes out routed, NOT costed, and the database agrees.** An operation with no times is
not a cost basis — see [architecture.md §16](../architecture.md) and
`20260819011705_untimed_operation_is_not_a_cost.sql`. Before that rule it computed $0.00 and read as
ready to quote.

### Materials are entered, not inferred

A cut list only exists on the odd weldment, so deriving materials meant "Add materials" had nothing
to offer for twenty-nine parts out of thirty-one. Any part takes a material now (`MaterialLines`):
pick one the shop already buys and it brings its own price, or type a new one and give it a cost.
The cost field appears only for a new material, and says what happens if it is left blank — **a BOM
line to a child with no cost basis takes its parent from quotable to not**, so a priceless material
is created but deliberately not attached.

Units come from the child part, never from the line: `part_rollup_at_qty` raises rather than guess a
conversion, and these sheets print `1803.2` beside a tube described in inches.

### Ending in a quote

Creating is one press, and every created part can go on a quote — priced or not. `QuotePartPicker`
lists them all (ticked by default), marks which lines will want a number, and hands the lot to
`/quotes/new?parts=…`. Filtering to the priceable ones silently dropped exactly the parts that
needed attention.

The quote form is where that work finishes: every line links to its part in a new tab, and
**Recheck prices** re-reads each block in place. A reload would have thrown away the quote being
written, which is why the prices are re-read rather than the page refreshed.

## Delete — archive (soft-delete), never blocks

`deletePart` / `bulkDeleteParts` call the `archive_parts` RPC, which in one transaction sets
`parts.deleted_at` **and** detaches the part as a BOM child (deletes `parts_bom` rows where it is the
child) so dependent parts' costs recompute. It is **never** disabled or refused — a part on
quotes/jobs or used in another part's BOM archives like any other.

Nothing cascades away: pricing tiers, attachments and files are kept, so every quote line / job /
document referencing the part still resolves; the part is just hidden from lists, search and pickers
(reads filter `deleted_at IS NULL`). `DeleteImpactDialog` shows an impact summary from
`parts_deletion_impact` — quotes/jobs referencing the parts (kept for history) and how many **other**
parts hold them as a BOM component and will be re-costed — but never prevents the delete.

Name is the part's natural identity, but re-creating or re-importing an archived `part_name` makes a
**new part**: `reclaim_part_name` renames the archived row to `<name> (archived)` and the insert is
retried. Parts diverge from customers/vendors/work centres here, which still revive — a part number
on a customer's drawing belongs to whoever sent it, and reviving handed the new part the old one's
stock, costs and BOM history.

The rename fires on the collision, **never on archive**. `quote_line_items` and `job_parts` store no
name snapshot, so a part rename changes how its past quotes and invoices read; doing it lazily means
only a number somebody deliberately reassigned ever moves. Full standard: `docs/architecture.md` §16.

---

## Verification

Cited as **file → `describe`** (checkable; nested `it` titles are deliberately not cited — four of
them had already rotted in this doc). Everything not listed is `automation-pending (#367)`.

| Area | Test |
|---|---|
| List / search / sort / pagination, create, name-uniqueness, update, archive, bulk archive, delete impact, revive-on-collision, notes CRUD, activity | `__tests__/utils/partsAccess.test.ts` → `partsAccess utilities` (16 nested describes, one per exported function) |
| Tier pricing through one engine for made **and** bought; null-price guards (unresolvable base, null markup, NaN markup); single-round rounding | `__tests__/utils/partPricingTiersAccess.test.ts` → `getTiersWithComputedPrices — one engine for made and bought` (5 its) |
| The price the quote form / line / preview all read; tier selection at qty; `below_min` | same file → `getPartPriceAtQty — the single source used by form/line/preview` (3 its) |
| Routing cost build-up, warnings, setup amortization at tier qty, yield / ceiling / batch pinning | `__tests__/utils/routingCostCalculation.test.ts` → `calculateRoutingCost`, `calculateTierPricing`, `calculateRoutingCost — yield / ceiling / batch pinning` |
| Unit-price → markup back-calculation (incl. negative markup, zero base, NaN) | `__tests__/types/quote.test.ts` → `calculateMarkupFromUnitPrice` |
| Create-mode validation (empty name, duplicate name, success) and existing-mode blur auto-save | `__tests__/components/parts/PartIdentitySection.test.tsx` → `PartIdentitySection` |
| Staged tier edits surviving a `refreshKey` bump from a sibling save | `__tests__/components/parts/PartPricing.test.tsx` → `PartPricing — staged tier edits survive sibling saves` (13 its) |
| Starter tier: written once on first cost at the shop's markup for the part's source; **not** written for a routing with no priced work, no cost basis at all, an existing tier ladder, or a bought part with no vendor cost; the source caption clearing on a changed markup | `__tests__/components/parts/PartPricing.test.tsx` → `PartPricing — starter tier from the shop default` |
| Part-level procurement tiers, explicit Save, red no-cost starter row, vendor pick not discarding staged edits | `__tests__/components/parts/PartProcurementPricingPanel.test.tsx` → `PartProcurementPricingPanel — part-level tiers, explicit save` (3 its) |
| Priceability / completeness derivation | `__tests__/components/parts/partSetupStatus.test.ts` → `getPartSetupStatus` (5 its) |
| Completeness banner render | `__tests__/components/parts/workspace/tabs/WorkspaceTab.test.tsx` → `WorkspaceTab completeness banner` (4 its) |
| Navigating away with unsaved work | `__tests__/components/parts/workspace/PartWorkspaceExitGuard.test.tsx` → `PartWorkspace — unsaved-changes exit guard` (4 its) |
| Upload with computed kind + uploader, extension allowlist, 25 MB / 100 MB caps, row-first delete | `__tests__/utils/partAttachmentsAccess.test.ts` → `detectAttachmentKind`, `validatePartAttachmentFile`, `uploadPartAttachment`, `listPartAttachments`, `getPartAttachmentUrl`, `deletePartAttachment` |
| Kind chips, PDF-inline vs STEP-3D vs DWG-download dispatch, delete visibility (uploader vs admin), rejected-file message | `__tests__/components/parts/FilesTab.test.tsx` → `FilesTab` (7 its) |
| Fresh signed URL per attachment on key remount (no stale URL) | `__tests__/components/parts/workspace/tabs/AttachmentViewerModal.test.tsx` → `AttachmentViewerModal — parent key-remount fetches a fresh URL per attachment` (2 its) |
| Create part → add routing → verify cost → pricing isolation (end-to-end) | `e2e/parts-and-routing.spec.ts` → `Parts and Routing workflow` |
| Server-side reads of `parts_bom` | `__tests__/utils/bomAccess.test.ts` |

Historical doc-vs-code divergences from the 2026 audit are on [#334]; automation gaps on [#367].

[#334]: https://github.com/debola31/Jigged/issues/334
[#367]: https://github.com/debola31/Jigged/issues/367
[#411]: https://github.com/debola31/Jigged/issues/411
[#571]: https://github.com/debola31/Jigged/issues/571
[#727]: https://github.com/debola31/Jigged/issues/727
