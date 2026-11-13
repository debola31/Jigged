# Purchasing — vendor POs, receiving, approved vendors, RFQs

**Jigged can buy things.** A purchase order **to a vendor** for material, bought parts, outside
services and anything else (a machine repair, tooling, freight); receiving it into stock with heat,
lot and cert; an approved vendor list with price sheets; RFQs to several vendors; and an optional,
explicit push of the PO to QuickBooks Online or Desktop. Issue
[#571](https://github.com/debola31/Jigged/issues/571), revived. It closes inventory
[J5, J6 and J10](inventory.md#j5--buy-it) and PRD FR-2's buy list.

**As-built 2026-11-12, branch `feature/purchasing`.** Built and tested: the database, the pure rules,
the access layer, every screen and PDF, the QuickBooks push, the MCP tools and Jigged chat's reach
to them, the insights-AI context, and 42 end-to-end journeys in eight `e2e/purchasing-*.spec.ts`
specs ([below](#acceptance-criteria)).

> **"PO" alone already means the customer's PO** (`jobs.customer_po_number`, "Accept customer PO",
> the MCP `create_job` tool). So every new identifier says *vendor* or *purchasing* —
> `vendor_purchase_orders`, `vendorPo*`, `*_vendor_po*` — and no MCP tool name contains a bare
> `purchase_order`.

**Tables:** `vendor_purchase_orders` (+ `_lines`, `_receipts`, `_revisions`),
`purchasing_document_series`, `part_vendors`, `part_vendor_price_breaks`, `vendor_rfqs` (+ `_lines`,
`_invitations`, `_responses`), `quickbooks_vendor_map`, `quickbooks_purchasing_setup`,
`quickbooks_purchase_order_links`, `quickbooks_purchase_order_line_links`, and two columns:
`outside_shipments.vendor_purchase_order_line_id`, `vendors.default_payment_terms`. **Migrations:**
[`20261110043600`](../../supabase/migrations/20261110043600_purchasing_tables.sql) tables ·
[`20261110043700`](../../supabase/migrations/20261110043700_purchasing_views_and_helpers.sql) views
and helpers · [`20261110043800`](../../supabase/migrations/20261110043800_vendor_purchase_order_rpcs.sql)
PO writers · [`20261110043900`](../../supabase/migrations/20261110043900_vendor_rfq_and_sourcing_rpcs.sql)
RFQ and sourcing writers ·
[`20261110044000`](../../supabase/migrations/20261110044000_purchasing_allowlist_and_demo_reset.sql)
allowlist and demo reset. Their `COMMENT`s are the precise contract; this doc carries the why.

---

## Why it exists

- **The gap.** Jigged could not buy anything. FR-2 was a `Must` marked partial because there was *"no
  buy list and no on-order concept"*, and #571 was closed `not_planned` in the 7–9 September 2026
  sweep with no comment.
- **The demand is L&L's** (QuickBooks Desktop Enterprise, Manufacturing & Wholesale). Three asks on
  #571: anodizing as an outside operation; *"can Jigged create a PO to send out for an outside
  service"* — a machine sent out for maintenance; and markup on purchased material and outside
  services (the charge-basis half shipped as #727, closed 2026-08-11). They do POs in QuickBooks
  Desktop today and did not need them in Jigged — **unless they move to QuickBooks Online**, which
  has POs only on Plus/Advanced and whose Desktop→Online conversion drops PO receipt links. Intuit
  stopped selling Desktop Pro/Premier Plus to new US subscribers after 2024-09-30.
- **The founder's framing:** *"a commodity that already exists in other tools that might be
  required"* — QuickBooks-Desktop parity for a 5–50 person shop, built once, usable from the browser
  and from a shop's own AI assistant.

**Withdrawn:** *"No purchase orders — the slip is the outside-work document, and it works with no
accounting system connected, which the purchase-order plan could not"*
([outside-processing.md decision 4](outside-processing.md#the-four-decisions), 2026-09-03) — wrong
on its own ground once the PO is a native, Jigged-numbered document whose QuickBooks push is
optional: it now works with no accounting system too. The half of that decision that was right
stands: **the slip stays the only record of movement** ([below](#outside-processing-one-source-of-truth-for-received)).

---

## Decisions

### The founder's, 2026-11-09 — their answers quoted

| Question | Decision | Their answer |
|---|---|---|
| Scope | All of #571: POs for material, bought parts, outside services and other purchases; receiving with heat, lot and cert; purchase vs stock units (per 100, per 1000); on-order and a buy list; an approved vendor list; per-vendor price sheets; RFQs with comparison and award; an **explicit** "use as part cost"; revisions; PO and RFQ PDFs | "Everything in #571" |
| QuickBooks | **Push the PO; bills stay in QuickBooks.** An explicit Send / Update / Close, in the UI and in MCP, to Online (Plus/Advanced) and Desktop (Conductor). Vendors matched or created the way customers are. Jigged never creates a bill or an item receipt and never sets Billable or `CustomerRef` | "Push the PO; bills stay in QB" |
| Reading QuickBooks | **One read of the QuickBooks PO, only inside the Update/Close click** — its version token, line ids and billed flags. No read on load, preflight or create, no polling, and nothing stored but the new token. It reversed their earlier "never read or poll PO status": a bill entered against the PO very likely moves the token, and a write with the old one fails | "Allow one read inside the click" |
| QuickBooks items | **Non-inventory and service items only, no categories.** One "QuickBooks item for purchases" fills all three line kinds; a per-kind split is a secondary option. Jigged owns the stock count, so a QuickBooks inventory item would count it twice | "Non-inventory/service only" · on categories: *"Do we need to categorize items?. maybe just 1 general thing until we get a request for diversity?"* |
| Permissions | **Admins and users; no approval step.** Operators are refused in the database functions, the MCP tools and the FastAPI routes | "Admins and users, no approval" |
| Sending | **PDF plus mailto, like quotes.** "Mark as sent" stamps the send; there is no server email | "PDF + mailto, like quotes" |
| Numbering and terms (2026-11-12, reversing a planner default) | **POs and RFQs number themselves, `PO-0001` and `RFQ-0001` on, like quotes and jobs; there is no settings screen and no standing terms and conditions.** Anything a vendor must know rides in the PO's "Notes to vendor". `PO-99999999` is the last number that fits QuickBooks Desktop's 11-character `refNumber`, and Jigged's `PO-` numbers cannot collide with QuickBooks' own plain-number POs | *"i don't understand why we have these purchase settings. We don't do something like this for any other module"* |

**Follow-up, before L&L moves its POs to Jigged:** confirm with L&L's bookkeeper that expensing PO
material through non-inventory items is acceptable — if QuickBooks tracks their raw material as
inventory items, bills against pushed POs expense it instead of adding to inventory (the
bookkeeper's [step 9](#what-the-bookkeeper-does-differently)).

### Accepted with the plan

| Decision | Why |
|---|---|
| Receiving is office-only; the operator's ad-hoc receive is unchanged | A PO is office paperwork; the floor already has a receive that needs none |
| A bought part on a job keeps today's production status — no "received" gate; the job shows its POs | A gate would block shipping on paperwork; it is out of scope, not forgotten |
| No FOB field ([PR #737](https://github.com/debola31/Jigged/pull/737) found it unused), no buyer field; ship via and notes instead | Fields nobody fills are fields nobody keeps true |
| No approvals, returns to vendor, receiving inspection, landed cost or import of open POs | [Out of scope](#out-of-scope) |
| **A PO price is a frozen term of the document, never a cost record** | It is the price of one order — a rush premium, a minimum. Only the explicit, previewed ["Use as part cost"](#approved-vendors-price-sheets-use-as-part-cost) writes `part_pricing_tiers` |
| A part line takes any live part, made or bought; sourcing applies to bought parts only | A subcontracted whole part is a real case |
| **The vendor is locked once a PO is marked sent**; to change vendor, close and duplicate | The vendor holds the document |
| Edits after a send bump **Rev N on the same number**; no void-and-reissue | The number is what the vendor files it under |
| No new toolbar menu on the job page | POs show where they bear on the job: the bought-part line, the operation card, the Materials card, one row in the details card |

---

## Journeys

### Bar stock bought in feet, stocked in inches

BAR's stock unit is `inches`; the vendor sells by the foot. A part line in `feet` gets
`stock_factor` 12, **frozen on the line**, so a later conversion edit never moves it. A purchase unit
is the stock unit or carries **exactly one** factor for that part: a `parts_unit_conversions` row,
or a same-kind preset the access layer writes as that row before the RPC (the `PartBomPanel`
precedent); "Another unit…" adds a custom one (`bar` = 144 in). One unit name cannot carry two
factors. Aliases (`ea`→`each`, `in`→`inches`) normalise the same way in TypeScript and in SQL
(`unit_name_key`, keep in step with `UNIT_ALIASES` in [`lib/unitPresets.ts`](../../lib/unitPresets.ts)).
Fasteners priced "per C" / "per M" use the `hundred` and `thousand` presets: 2.5 hundred lands 250
each.

**Never `convertToBaseUnit`** — it returns the unconverted number when it cannot convert, so "3 bars"
would land as 3 inches. [`lib/purchasing/purchaseUnits.ts`](../../lib/purchasing/purchaseUnits.ts)
calls a pair it cannot relate *incomparable*, never factor 1.

The price defaults in this order, and the line stores its `price_source`
([`lib/purchasing/priceDefault.ts`](../../lib/purchasing/priceDefault.ts), the one implementation):

1. this vendor's **valid** price sheet (`valid_until` null or today or later): the highest break at
   or below the quantity, compared in stock units — an expired sheet is named and not used;
2. **Last PO price** from this vendor: the newest priced line on a *sent*, unarchived PO;
3. the estimate: the part's tier `cost_per_unit` at the stock quantity × the factor;
4. blank — **to be confirmed**: the PDF prints TBC and a QuickBooks push is refused.

### Anodize on a job operation, through the VPS slip

Op 30 on J-1042 is an outside step at the plater. The operation card's **Create PO** opens an
*outside service* line prefilled from the step: quantity in pieces, the description "Anodize —
1234-A — Job J-1042, Op 30", the price from the vendor service's **current** price, else the
operation's frozen one, with "Job costed at $X" when the two differ
([vendor-services.md](vendor-services.md)). Any PO can ship to our shop, to another vendor
(drop-ship to the plater) or to a customer.

The PO moves nothing. The parts still go out on a `VPS-` slip, which **links itself** to the line,
and come back on the slip's receipts; the line's sent, at-vendor and received figures are read off
its linked slips. The slip prints `PO: PO-1042`; receiving it short offers an unticked *"Also close
PO-1042 line 2 — nothing more expected"*. Operators send and receive exactly as before, and the slip
still links. The mechanics are [below](#outside-processing-one-source-of-truth-for-received).

### A machine repair

The spindle goes out for rebuild: an **other** line, optionally on a work centre (the machine) and/or
a job. Receiving one records a quantity and nothing else — no stock. A line that never arrives (a
fee, freight) sets `expects_receipt = false` and **never holds the PO open**; a PO of nothing but
such lines stays Sent until someone closes it. In QuickBooks it posts to the general purchases item
— the founder's *"1 general thing"*. **Leak guard:** an other line linked to a job that has an open
outside step for this vendor is prompted *"Use an Outside service line so it follows the vendor
slips"* — otherwise that step's money and its movement would part company.

### Receive a partial delivery, with a heat and a mill cert

**Office only, against a sent PO**; a draft asks once, *"Mark it sent today and receive?"*. One
delivery is **one atomic, idempotent** `receive_vendor_purchase_order` call: the dialog mints a
`receipt_group_id` once per opening, and a replay returns the first result and writes nothing.

- Rows prefill with what is outstanding and say what lands: *"= 432 in into stock"*. A cleared row is
  skipped; 0 is refused; **"+ another heat or place"** splits a line. Each quantity goes **exactly
  as typed**, in purchase or stock units, and the RPC computes `stock_quantity` with the frozen
  factor — so there is no round-trip drift (100 in → bars → back was 99.999936).
- The place is required and must be a **leaf** ([a container holds no stock](inventory.md#a-place-is-a-container-or-a-bin-never-both)); it
  defaults to the largest holding, else the last receipt place.
- **A first heat on an untracked part turns heat tracking on for good** — the field says so, and the
  receipt records `started_tracking`. Within one delivery, **entries with a heat go first, per part**:
  a heat moves the part's lot-less balances into a PRE-TRACKING lot, and a no-heat entry processed
  before it would be stranded there. A **new** lot is stamped with the vendor and receipt date; an
  existing lot is left alone.
- The cert uploads **after** the write — `CertAfterBatchPanel` appears only on a failure, and Done is
  always enabled, the receiving rule from [inventory.md](inventory.md#certs-are-collected-at-receiving--2026-09-09).
- **Over-receipt is allowed**, amber, recorded, and reads "Received +N". A short row offers *"That's
  everything — close the remaining N"* (`close_remaining`).
- **Possible double receipt** is a notice, never a block: the dialog lists this part's no-PO stock
  additions from the last 14 days (*"3 bars into Rack A on 3/4 — was that this delivery?"*).
- A **void** reverses the stock through `deplete_stock_at_location`, from the receipt's own place and
  lot. It is refused, changing nothing, when that stock is no longer there; it is idempotent; it
  never switches tracking off. A receipt is append-only: a correction is a void plus a new receipt.

### Find what is late

**Late is one predicate**, `is_vendor_purchase_order_late(status, expected_on, today)`: still owed
something (`sent` / `partially_received` for a PO, `open` / `partially_received` for a line) with an
expected date **before the caller's local date**. `today` is never `CURRENT_DATE` — Postgres runs in
UTC, which rolls into tomorrow every evening in the Americas, so a PO due today would read overdue at
8 pm. The TypeScript mirror ([`lib/purchasing/late.ts`](../../lib/purchasing/late.ts)) and the SQL
read one golden fixture, [`__tests__/fixtures/vendorPoLateCases.json`](../../__tests__/fixtures/vendorPoLateCases.json).

Expected date: part and other lines `COALESCE(promised_on, need_by_on)`; outside lines the earliest
due-back among linked slips with pieces still out, else `need_by_on` (an outside line has **no
promised date of its own** — the slip carries it). A PO's `next_expected_on` is the minimum over
outstanding lines. **Overdue is a flag beside the status, amber, never a status** — a late PO is
behind, not broken.

### The buy list

**To buy only proposes**; nothing in it writes. Per part, in stock units
([`lib/purchasing/buyList.ts`](../../lib/purchasing/buyList.ts), pinned by
[`__tests__/fixtures/buyListCases.json`](../../__tests__/fixtures/buyListCases.json)):

| | |
|---|---|
| demand | top-level BOM material on open jobs still to issue (issued counted once per job and part) **+ bought job parts still to ship** |
| position | on hand (counted once, however many jobs want it) + on order + on draft − demand |
| listed when | position ≤ reorder point; with no reorder point, position < 0 |
| suggested | with a reorder point, the fewest whole purchase units that lift the position **strictly above** it (exactly up to the point lands on it, and a part at its point is listed, so it came straight back asking for one more); with none, enough to cover −position, rounded up to whole purchase units. Either way at least the minimum order, and **at least one** |

- **Bought job parts are demand because they read `completed` the moment the job is created**
  ([jobs.md](jobs.md#bought-parts-on-jobs-no-operations)) — without them, a job waiting on a part
  nobody ordered reads "nothing to buy".
- **Drafts are netted**, so the same shortage is never drafted twice.
- Grouped by the preferred vendor (unless it is Do not use or archived), else the **only** Approved
  vendor, else *No vendor chosen*, whose group offers *Ask for prices (RFQ)*. "Buy from" switches a
  part; edited quantities survive a refresh; a group offers *Create draft PO for {vendor}* or *Add to
  draft PO-1043* when a draft to that vendor exists.
- **Six reads, in parallel, never one per row** ([`utils/buyListAccess.ts`](../../utils/buyListAccess.ts),
  pinned by `buyListAccess` › `getBuyList — request budget`); each takes one page with an exact count,
  so a capped read is named rather than silently clipped.
- It is the shop-wide *Short for this week* roll-up deferred in [inventory.md J4](inventory.md#j4--job-kickoff-material-check),
  hand-ported from `87df208`'s `rollUpShortages` **without the date window** — "this week" usually
  reported nothing; rows sort by need date instead. Captions say what it is not: *top-level materials
  only*, and *only POs in Jigged count as on order*.

### Approved vendors, price sheets, "Use as part cost"

A bought part's **Buying tab** ([`BuyingTab`](../../components/parts/workspace/tabs/BuyingTab.tsx),
`?tab=buying`, bought parts only) lists its vendors (`part_vendors`): status, the preferred star,
vendor P/N, purchase unit with its factor label ("1 bar = 144 in"), lead time, minimum order, sheet
dates with an *Expired* chip, price breaks and Last PO price — edited inline
([`ApprovedVendorsCard`](../../components/parts/ApprovedVendorsCard.tsx),
[`PriceSheetRowEditor`](../../components/parts/PriceSheetRowEditor.tsx)), archived only after asking,
with the part's POs beside them ([`PartPurchaseHistoryCard`](../../components/parts/PartPurchaseHistoryCard.tsx)).

- **Status is Approved / Conditional / Do not use** (`approved` / `conditional` / `disapproved`).
  Do not use **blocks** a new PO line, in the RPC and the UI; Conditional is an amber caption; a
  vendor not on the list is a quiet caption with *Add to list*.
- **`parts.preferred_vendor_id` stays the only "preferred" marker.** It already had four writers (the
  part form, the importer, MCP's `partsWrites`, `seed_demo_data`), and a second flag would need
  two-way sync. The trigger `ensure_preferred_vendor_is_listed` keeps a live list row for it,
  refuses a vendor of another company — a latent hole it closed — and refuses a Do-not-use one;
  archiving the preferred row clears the preference.
- **The factor lives in `parts_unit_conversions`, never on the list row**, so one unit name cannot
  mean two amounts on one part. A price sheet is in the purchase unit, replaced as a whole, with
  `quoted_on` / `valid_until` per sheet. Adding the same vendor again revives the same row.

**"Use as part cost"** (bought parts only) previews every existing cost tier — quantity · cost now →
new · markup unchanged · price now → new — and what follows in plain words: *"Quotes keep their
prices; N open quotes with this part will show Pricing changed"*, *"M parts using it as material
re-cost"*, *"Existing jobs keep their frozen cost"*. **A count that failed reads "couldn't count",
never 0** — 0 claims nothing is affected. Apply refuses with *"changed since you previewed"* unless
it would write exactly what was previewed, then sets `cost_per_unit` **in place**, keeping tier ids
and quantities; a part with no tiers gets them inserted at markup 0, the starter-tier convention
([`UseAsPartCostDialog`](../../components/parts/UseAsPartCostDialog.tsx) writes nothing before the
confirm). **So a part can become quotable at 0% markup:** besides those inserts, the workspace's
existing starter-tier rule (`ensureStarterPricingTier`) fills 0% into any costed tier that had no
markup set — today's convention, a new part sells at cost until someone sets its markup on the
Pricing card. The dialog says so when it adds tiers; either way, the markup is the shop's to set
there.
`apply_part_cost_from_vendor` is **the only purchasing writer of `part_pricing_tiers`** — a catalogue
check in `test_purchasing_sourcing` § V3 enforces it, and the access layer never touches that table
([the cost side](parts.md#cost-build-up--pricing-partpricing)).

### An RFQ to three vendors, and the award

An RFQ (`RFQ-0001`, fixed series) asks for prices on lines — a part, or ad-hoc text — each with **one
to four quantities in one unit**. Each invited vendor's contact is frozen (sales, else primary); each
gets its own PDF — **its** part numbers, the quantities, no prices — and a mailto; *Mark sent* and
*Declined* are per vendor, and a declined vendor's answers are refused until undone.

- Responses are a price **per the RFQ line's unit** at one of its quantities, or *No bid*, with lead
  time, minimum order, valid until and vendor P/N; editable until awarded, frozen after. **A save
  replaces that vendor's whole quote** — its unawarded answers, upserted on line and quantity so ids
  stay put.
- **The comparison** ([`lib/purchasing/rfqCompare.ts`](../../lib/purchasing/rfqCompare.ts)): rows are
  line × quantity, columns are vendors. *Lowest* is a **word**, never colour alone; an expired quote
  is never Lowest; a price tie goes to the shorter lead time, and a full tie marks every tied cell
  rather than silently picking one.
- **The award is one atomic call by response id**, one per line: one **draft** PO per vendor, ad-hoc
  lines becoming other lines, priced per the RFQ line unit with `price_source = rfq`. *Save to price
  sheets* starts unticked; ticked, it writes that vendor's sheet and creates its list row as Approved
  when missing. Anything failing leaves nothing.
- The screens: [`RfqList`](../../components/purchasing/RfqList.tsx),
  [`RfqForm`](../../components/purchasing/RfqForm.tsx), [`RfqDetail`](../../components/purchasing/RfqDetail.tsx)
  with [`RfqVendorsCard`](../../components/purchasing/RfqVendorsCard.tsx),
  [`RfqResponseEditor`](../../components/purchasing/RfqResponseEditor.tsx),
  [`RfqCompareMatrix`](../../components/purchasing/RfqCompareMatrix.tsx) and
  [`RfqPreviewDialog`](../../components/purchasing/RfqPreviewDialog.tsx); the PDF is
  [`utils/rfqPdf.ts`](../../utils/rfqPdf.ts).

### Send to QuickBooks

From the PO page, **Send to QuickBooks** — a click, never anything else. The dialog's preflight runs
when it opens; the server mints the request id. The PO must be sent, its current revision sent, not
archived, every line priced. The vendor is the mapped one, else the exact-name match, else **the
person's explicit choice among similar names — the dialog never preselects one** — else created.
Later edits show *Out of date in QuickBooks* without asking QuickBooks; **Update** reads the
QuickBooks PO once and writes; **Close in QuickBooks** follows a close in Jigged. On Desktop the wait
text names the shop computer, because that is where the answer comes from. Detail:
[QuickBooks push](#quickbooks-push).

---

## Data model

### The posture, the same for every table

- `company_id → companies ON DELETE CASCADE`, so **one company DELETE removes the whole graph**.
- **The browser holds SELECT and nothing else.** Every write is a `SECURITY DEFINER` RPC
  ([write doors](#write-doors)), because the office-role decision has to hold in the database and
  RLS has no role predicate.
- RLS on, one SELECT policy over `get_user_company_ids()`, and **the billing write-gate on every
  table** — never evaluated for a role with no write grant, but it satisfies
  `tenant_tables_missing_write_gate()` without an exempt claim a reviewer must re-check.
- **Named revokes** — `TRUNCATE, REFERENCES, TRIGGER, MAINTAIN` from anon and authenticated, the
  privileges a new `public` table actually arrives with — never `REVOKE ALL` (CLAUDE.md).
- **Composite foreign keys keep every child on the same parent and company**, so a mismatched id is
  unrepresentable rather than a rule an RPC must remember.
- Actor columns (`*_by`) reference `auth.users ON DELETE SET NULL`; the **state is the `*_at`
  column**, so deleting a login never breaks a row.

### The tables — non-obvious bits only

| Table | Grain | Non-obvious |
|---|---|---|
| `purchasing_document_series` | company × kind | The counter and nothing else: `next_number` only moves forward. No row until first use. There are no numbering settings and no standing terms (founder, 2026-11-12) |
| `vendor_purchase_orders` | one PO | `po_number` UNIQUE per company, **full** — an archived PO keeps its number. `vendor_id` RESTRICT; the vendor's name, contact, address and the ship-to (`shop` / `vendor` / `customer`) frozen at create, their ids SET NULL beside the copies. `ordered_on` is the **browser's** local date. A draft cannot be closed — archive it. "Sent" is one fact in three columns (`issued_at`, `sent_revision`, `last_sent_at`), held by CHECK |
| `vendor_purchase_order_lines` | one line | `line_kind` `part` / `outside_service` / `other`, each shape held by CHECK. `line_number` printed and never reused. Snapshots (part, job, operation, service, work centre) freeze at insert. `stock_unit` + `stock_factor` frozen. `unit_price numeric(16,5)`, NULL = to be confirmed, and `price_source` NULL exactly then. `promised_on` internal; `expects_receipt` false only on other lines. Part, job, job part and operation RESTRICT |
| `vendor_purchase_order_receipts` | one entry of one delivery | Append-only, corrected by void. **Part or other only — an outside receipt is unrepresentable.** `(receipt_group_id, entry_index)` UNIQUE is the replay guard. Stores the quantity and unit as typed plus the exact `stock_quantity`, and links the ledger row and its reversal. Count with `voided_at IS NULL` |
| `vendor_purchase_order_revisions` | PO × revision | The vendor-visible document as sent, and its hash. Not AI-readable: a superseded price would read as current |
| `part_vendors` | part × vendor, UNIQUE **full** | The approved vendor list. Archived and revived on that key — the pair is identity |
| `part_vendor_price_breaks` | sheet × `min_quantity` | In purchase units; a save replaces the sheet; `source` `manual` or `rfq` |
| `vendor_rfqs` · `_lines` · `_invitations` · `_responses` | RFQ; line; vendor; line × quantity × vendor | `quantities numeric[]`, 1–4, all > 0. A response's two composite FKs point into the **same** RFQ, and its quantity must be one of the line's. A line with responses cannot be removed |
| `quickbooks_vendor_map` · `_purchasing_setup` · `_purchase_order_links` · `_purchase_order_line_links` | per company file | Members read, only the service role writes; billing-gated; AI-exempt and in `SENSITIVE_TABLES`. Setup rows hang off the connection row `ON DELETE CASCADE` — **disconnect clears them**; the vendor map is kept, like the customer map |
| `outside_shipments.vendor_purchase_order_line_id` | slip → line | SET NULL. See [outside processing](#outside-processing-one-source-of-truth-for-received) |
| `vendors.default_payment_terms` | | Standing terms, copied onto a new PO when its create names none; **an existing PO never re-reads it** |

### Derived state — computed once, in SQL

Status, progress, on-order and "late" are **computed, never stored, and computed once**: the UI,
the MCP tools and the insights AI read the same views, so there is no second definition to drift
(the `is_job_late` / `is_quote_open` lesson). Every view is `security_invoker`, readable by
`jigged_ai_readonly`, and carries no actor column.

| View | Answers |
|---|---|
| `vendor_purchase_order_line_status` | Each line's status and progress. **Part lines measure in stock units**, so progress is exact (ordered = quantity × factor; received = Σ live `stock_quantity`), and report purchase units too; outside lines measure from their linked slips; other lines count quantity. `open_quantity` / `open_amount` are 0 once received, closed or archived |
| `vendor_purchase_order_status` | Each PO's status, `next_expected_on`, `ordered_amount`, `open_amount` ("Open value (at PO price)"), `has_unpriced_lines`, `has_unsent_changes`, `quickbooks_state`, its jobs, and `search_text` (number, vendor, part numbers, vendor P/Ns, job numbers) |
| `part_on_order` | Per part, in its stock unit: `on_order_quantity` (sent, open, unarchived part lines), `on_draft_quantity` **separately**, `next_expected_on`, and `unit_mismatch_line_count` — lines whose frozen stock unit no longer matches the part's, which are in neither total |
| `part_vendor_last_purchase` | "Last PO price" per (part, vendor): the newest priced part line on a sent, unarchived PO. Drafts and archived POs never count |
| `vendor_rfq_status` | Each RFQ's status — draft · sent · quoted · awarded · closed — and its counts |

**A PO's status, first match wins** (labels Draft · Sent · Partly received · Received · Closed):

| Status | When |
|---|---|
| `draft` | never sent |
| `closed` | closed by hand, **or** nothing outstanding and a line closed short |
| `received` | at least one line expects a receipt, and every such line is received |
| `partially_received` | anything received or closed |
| `sent` | otherwise — including a PO whose lines all expect no receipt, until it is closed |

**A line's, first match wins:** `draft` · `received` (received ≥ ordered; the UI adds "+N" for over)
· `closed` (the line or the whole PO, short) · `no_receipt` · `partially_received` · `open`.
`quickbooks_state` is `not_sent` · `in_quickbooks` · `out_of_date` · `pending` · `needs_checking` ·
`failed`, from `quickbooks_purchase_order_state()` — `SECURITY DEFINER` because the views call it as
the insights AI, which may not read the links table; it returns no QuickBooks id.

### Numbering

**POs and RFQs number themselves, `PO-0001` and `RFQ-0001` on, like quotes and jobs.** There is no
settings screen: the founder removed it (2026-11-12), because no other module has one.
`next_purchasing_document_number` mints inside the create RPC under a `FOR UPDATE` lock on the
series row, held to commit:
- **a number that already exists is skipped, and a number is never reissued** (archived POs included);
- **a rolled-back create consumes nothing**;
- four digits grow rather than truncate (`PO-9999`, then `PO-10000`);
- past `PO-99999999`, the last number that fits QuickBooks Desktop's 11 characters, the create
  refuses in a sentence.

The series is not the shared `Q-`/`J-` counter: a quote and its job share a number on purpose, and a
PO is a separate document. Jigged's `PO-` numbers cannot collide with QuickBooks' own plain-number
POs.

### Two counters: `revision` and `content_version`

| | Bumped by | Never by | Means |
|---|---|---|---|
| `revision` | the **first** vendor-visible change after a send — the md5 of `vendor_purchase_order_document()` no longer matches the sent revision's — **once per send cycle** | drafts; internal notes, promised dates, closing, `price_source`, `expects_receipt` (none of them are in the document) | "Rev N". `revision > sent_revision` is *Rev N not sent*, and a QuickBooks push is refused until it is sent |
| `content_version` | every change that moves `vendor_purchase_order_pushed_projection()` — **including close and reopen**, and the receipt or void (on the PO, or on a linked vendor packing slip) that moves the PO into or out of its **derived** *closed*, the status the push closes and reopens from. Counted against `content_hash`, the md5 the current version stands for: every writer ends with `vendor_purchase_order_settle_versions`, and a trigger settles a slip receipt | an ordinary receipt, internal notes, promised dates | `content_version >` the link's `pushed_content_version` is *Out of date in QuickBooks* — no QuickBooks call needed |

**The vendor-visible field list is one list in three copies, pinned together:**
[`lib/purchasing/vendorPoVisibleFields.ts`](../../lib/purchasing/vendorPoVisibleFields.ts) (the
form's "Save as Rev N+1" prediction), [`__tests__/fixtures/vendorPoVisibleFields.json`](../../__tests__/fixtures/vendorPoVisibleFields.json),
and the tuples in [`purchasing_support.py`](../../api/tests/integration/purchasing_support.py) that the
DB tests parametrize over. The database still decides by hashing the document; the list only predicts
it.

**What settling against a stored hash means in practice:**

- **A receipt or void that closes or reopens a PO moves its `updated_at`** — the settle writes the
  header — so a PO form left open across it is refused as stale the next time it saves
  vendor-visible fields. Reload and edit again.
- **An archived PO can read *Out of date in QuickBooks*:** archiving unlinks its slips, which can
  move it into or out of its derived *closed*. Pushing it stays refused (`vendor_po_archived`);
  close it in QuickBooks by hand, as the archive dialog says.
- **A migration that changes what `vendor_purchase_order_pushed_projection()` contains must
  re-record `content_hash` for every existing PO**, deciding on purpose whether they should read out
  of date — otherwise each one reads out of date at its next write of any kind, an internal note
  included. The `content_hash` `COMMENT` in
  [`20261110043600`](../../supabase/migrations/20261110043600_purchasing_tables.sql) carries the same
  rule.

### Money

- `unit_price numeric(16,5)`, shown with trailing zeros trimmed down to two places. **Line amount =
  `round(qty × price, 2)`; a PO's total is the sum of line amounts**, never a rounding of the
  unrounded sum.
- One rule in three places — `vendor_po_line_amount` in SQL, [`lib/purchasing/amount.ts`](../../lib/purchasing/amount.ts),
  and the Python builder's `line_amount` — pinned by [`__tests__/fixtures/vendorPoAmountCases.json`](../../__tests__/fixtures/vendorPoAmountCases.json).
- **Why exact decimal:** a JavaScript number is binary, so a typed 1.005 is 1.00499999… and
  `toFixed(2)` rounds it down to 1.00 where Postgres says 1.01. [`lib/money.ts`](../../lib/money.ts)
  rounds the decimal as written, with BigInt — and Python's float `round()` has the same flaw, hence
  `Decimal` there. `lib/money.ts` is the formatter for new code; the older per-component copies are
  not migrated here.

---

## Write doors

**Every writer's body, in this order** — written out in each body, never hoisted into a helper:

1. **Derive the company** from the row, vendor or part. Only RFQ create and the settings save take a
   `p_company_id`.
2. `PERFORM assert_office_member(company)`: **P0001 "That record is not available."** for not-found
   and non-member alike — one sentence, so it cannot probe whether a record exists in another
   company — and **42501** for an operator.
3. **The literal `company_can_write` check** → 42501. `definer_writers_missing_write_gate()`
   text-matches the literal in each writer's body, so it is deliberately **not** inside
   `assert_office_member`: hoisting it would turn the guard red for a reason nobody could find.
4. Lock the header `FOR UPDATE` — then the per-job outside-shipment advisory locks, **sorted by key**,
   then lines. `create_outside_shipment` takes the same job lock and no PO lock, so the two cannot
   deadlock, and a slip and a line insert for one job serialise.
5. **Scope every id inside an array or jsonb to this document.**
6. Pre-validate every CHECK and raise it as a sentence (P0001).
7. `p_today` comes from the caller, never `CURRENT_DATE`.

**SQLSTATEs carry meaning:** P0001 is a sentence a person is shown (`ErrorAlert`, never Sentry; a
refusal in MCP); 42501 only for an operator or a lapsed company; **XX000 only for our own bug** — a
jsonb key the RPC does not recognise; 23514 a slip linked to the wrong line.

| RPC | Non-obvious |
|---|---|
| `create_vendor_purchase_order` | Live vendor only. Contact defaults to the sales contact, then the primary; address to the default; payment terms from the vendor's standing terms; the number minted here. Returns `(id, po_number)` |
| `save_vendor_purchase_order` | **Patch semantics**; new lines carry no id. The staleness check (`p_expected_updated_at`, the string passed through exactly as read) runs **only when vendor-visible fields change**, so an auto-saved promise or note never collides with an edit. Refuses: quantity below received; removing a received line; changing kind, part, unit or factor after a receipt; changing an existing line's kind or routing step at all (add a new line); the vendor once sent; anything on a closed or archived PO but internal notes and promised dates |
| `set_vendor_purchase_order_state` | `mark_sent` (needs a line; snapshots the revision) · `close` (a sent PO) · `reopen` (re-checks one open outside line per operation and vendor) · `archive` — **never blocked**, idempotent, and unlinks the slips of its outside lines |
| `set_vendor_purchase_order_line_state` | Close short or reopen a batch of lines of one sent PO, atomically. Reopen re-checks one open outside line per (operation, vendor). Moves `content_version` (QuickBooks closes lines too), never the revision |
| `receive_vendor_purchase_order` / `void_vendor_purchase_order_receipt` | [Above](#receive-a-partial-delivery-with-a-heat-and-a-mill-cert). Outside lines refused: *"Outside work is received on its vendor packing slip"* |
| `set_outside_shipment_vendor_purchase_order_line` | Office-only relink or unlink of a live slip; changes no status; the PO page's *Unlink* and *Link a slip…* call it |
| `create_outside_shipment` | Same 8-argument signature, rebuilt from its newest body plus the auto-link. **No office assertion — operators send** |
| `add_stock_at_location` / `deplete_stock_at_location` | Rebuilt **word for word** from their newest bodies, plus `transaction_id` in the result so a receipt links its ledger row. Same signatures, so the ACLs survive; the one-overload and grant guards repeated |
| `save_part_vendor` / `archive_part_vendor` | Upsert and revive on (part, vendor). A non-null `p_price_breaks` replaces the whole sheet |
| `preview_part_cost_from_vendor` (INVOKER) / `apply_part_cost_from_vendor` | [Above](#approved-vendors-price-sheets-use-as-part-cost) |
| `create_vendor_rfq`, `save_vendor_rfq`, `set_vendor_rfq_state`, `set_vendor_rfq_invitation_state`, `save_vendor_rfq_responses`, `award_vendor_rfq` | [Above](#an-rfq-to-three-vendors-and-the-award) |

**Rebuilding a shared function is the risk this module carries most.** `CREATE OR REPLACE` does not
validate a plpgsql body, so a stock RPC, `create_outside_shipment`, `reset_demo_company` or a guard
rebuilt from anything but its **newest** body reverts every fix since, silently. Each is exercised
by a test, and each must be re-diffed against `main`'s newest definition before merge. The demo
reset rebuild fixed one on the way: it now deletes heat lots and certs, without which **a reset
aborted for any demo user who had recorded a heat** — `material_lots` RESTRICTs parts and nothing
deleted it.

**Named gap — operators can read PO prices through the raw API.** Writes are refused three ways, but
reads are membership RLS, like every other money column: the "money is a UI rule" precedent of
[`20261109011133`](../../supabase/migrations/20261109011133_remove_money_feature_flags.sql).

---

## Outside processing: one source of truth for "received"

**The PO is an optional commercial layer over outside work; the slip stays the only record of
movement.** Nothing on a PO table writes a slip or a slip receipt, and an outside receipt cannot be
represented in `vendor_purchase_order_receipts` at all — two records of one movement is how the
status cascade and the paperwork would come to disagree ([outside-processing.md](outside-processing.md)).

- **At most one open outside line per (operation, vendor)** — re-checked on reopen.
- **How a slip gets its line:** `create_outside_shipment` links the single eligible line (draft or
  sent, not closed, not archived, same operation and vendor); inserting a line links that step's
  existing live, unlinked slips; the PO page corrects it by hand under the line's slips: *Unlink*
  (asks first; the slip stops counting toward the line's received quantity) and *Link a slip…* (the
  step's live, unlinked slips to this vendor). Archiving the PO or removing the line unlinks.
- **A mismatched link is unrepresentable**, whoever writes it — the service role included: a BEFORE
  trigger refuses a line of another company, kind, operation or vendor (23514).
- **Linking changes no status.** The column is in no status trigger's `UPDATE OF` list, so it fires
  nothing in the operation → part → job cascade and stays clear of the
  [trigger-depth trap](outside-processing.md#the-write-surface-and-why-it-is-shaped-this-way).
- **The line's figures come from its slips:** sent = Σ live slip quantities; received = good back on
  live receipts of live slips; at vendor = what open slips still owe — **a short-closed slip owes
  nothing**. Closing the slip short and closing the line are independent acts; the receive dialog's
  *Also close the line* is the one place they meet, unticked.

---

## QuickBooks push

[`api/routes/quickbooks_purchasing_routes.py`](../../api/routes/quickbooks_purchasing_routes.py) owns
the state machine, once, for both providers; [`api/services/accounting/purchase_order.py`](../../api/services/accounting/purchase_order.py)
is the pure projection, hash, descriptions and refusals both builders read;
[`api/services/quickbooks_purchasing.py`](../../api/services/quickbooks_purchasing.py) (Online) and
[`api/services/quickbooks_desktop_purchasing.py`](../../api/services/quickbooks_desktop_purchasing.py)
(Desktop) are the provider primitives. Desktop specifics: [quickbooks-desktop.md](quickbooks-desktop.md#purchase-orders).

**Every route checks the office role and the billing gate before any QuickBooks call**
(`verify_office_write_access`); setup writes and the on-click QuickBooks lists need an admin. Only
`GET …/purchasing/setup` is safe on mount — a database read, not billing-gated because nothing it
does costs or writes.

| Endpoint | Runs |
|---|---|
| `POST …/vendor-pos/{po}/preflight` | when the dialog opens — a click |
| `POST …/vendor-pos/{po}/push` | Send / Update / Close / Reopen, decided server-side; body `{vendor?: {action, qb_vendor_id?}}` |
| `POST …/vendor-po-links/{id}/verify` | *Check again* on an unconfirmed Desktop send |
| `GET …/purchasing/setup` | on mount — Jigged's rows only |
| `GET …/purchasing/accounts` · `…/items`; `POST …/items` · `…/ap-account` · `…/check-preferences` | an admin's click in Settings |

**A push requires**, in this order: not archived; sent; the current revision sent (*"Rev 2 of PO-1042
hasn't gone to Acme — send it to them first"*); every line priced; and for Desktop a number ≤ 11
characters.

| Jigged | QuickBooks Online | QuickBooks Desktop |
|---|---|---|
| PO number | `DocNumber` | `refNumber` — Jigged's number, **the opposite of invoices** |
| The attempt | `?requestid=` | `externalId` (a GUID; immutable after create) |
| Notes to vendor | `Memo` — prints | `vendorMessage` — prints, 99 characters, cut with "…" |
| `Jigged PO-1042 Rev 2 · link` | `PrivateNote` | `memo` — does not print |
| Order date | `TxnDate` | `transactionDate` |
| Need-by | **not sent** — `DueDate` means *payment* due there | `expectedDate` |
| Line | `Qty`, `UnitPrice`, `Amount = round(qty × price, 2)` | `quantity`, `rate` — **never `amount`**, which makes Conductor ignore `rate` |

- **Item lines only**, on the setup item for the line's kind; a line keeps the item it was first
  pushed with. Quantity and rate are in the **purchase** unit, and what QuickBooks has no field for
  travels **in the description**: the unit (`bar (= 144 inches)`), part number, vendor P/N, machine,
  job and operation — each appended only when the description does not already carry it.
- **Never sent:** `CustomerRef`, `BillableStatus`, `payeeId`, `customerId`, `unitOfMeasure` — a
  recursive key scan in the payload tests forbids them, and a static test proves no new module
  references a bill or item-receipt endpoint.
- Terms through `resolve_term_id`. Ship method: Online takes the string; **Desktop matches an
  existing method by name and never creates one** — a typo would become a permanent entry in the
  shop's company file — else omits it with a warning. A ship-to over QuickBooks' caps is cut, with a
  warning: the vendor's PDF has it whole.

**Vendors:** a mapped vendor is used; else an exact name match is linked; else several candidates
need the person's choice; else the vendor is created. **A Desktop name over 41 characters, or with a
colon, tab or line break, is refused, never truncated** — two vendors can share their first 41
characters, and a cut name would link the wrong one. Online's display names are unique across
vendors, customers **and employees**, so a 6240 is re-queried: the vendor if it is one, else
*inactive* or *name taken*. **Searches use `nameContains` only:** Desktop's `names`, `fullNames`,
`refNumbers` and `ids` filters fail the whole request on any miss.

**Items and the accounts-payable account**
([`QuickBooksPurchasingPanel`](../../components/settings/quickbooks/QuickBooksPurchasingPanel.tsx)):
one setup row per line kind, and the panel shows **one "QuickBooks item for purchases" picker that
fills all three**, with *"Use different items for parts, outside services and other"* as the
secondary choice. An item must post to an expense, cost-of-goods-sold or other-expense account —
verified; **the invoice item is refused by id and by its name "Machined Parts"**, since it posts to
income and would book a cost as negative revenue. A same-named item is reused only when it already
posts to the chosen account — as Desktop's invoice item has been since 2026-11-12
([quickbooks-desktop.md](quickbooks-desktop.md#changing-the-income-account)); Online's invoice lookup
still reuses by name, having no chosen account to check against. Only the kinds on
the PO are required. The AP account is picked automatically when Online has exactly one — Desktop
POs carry none. **Check QuickBooks** stores two answers: are POs on, and are custom transaction
numbers on — off, QuickBooks numbers the PO itself, and the page shows *In QuickBooks as 1043* with a
warning. Online is sent `include=allowduplicatedocnum`, so a colliding number is accepted as Desktop
accepts it. Non-admins see the setup, and no buttons.

**The state machine is the invoice push's:** one link per (PO, company file) in four states —
`pending` · `created` · `error` · `needs_verification` — a compare-and-set claim, and a **server-minted
request id**, so a double-click or two tabs make one QuickBooks PO.

- **Online:** a stale or ambiguous attempt resumes with the **same** request id, which Intuit
  replays; a rejected one gets a new id.
- **Desktop has no request key, and a create that timed out was measured to land anyway.** An
  unknown outcome is probed **once** — the vendor's POs in a one-day window, matched on `externalId`
  — then adopted, or parked as `needs_verification` with one Sentry message. **It is never retried
  automatically**; it blocks only that PO; *Check again* (`/verify`) is the only way out.
- Created in QuickBooks but not recorded in Jigged: a 500 with the ids in context, and the next push
  updates rather than creating again.

**Update, close and reopen read the QuickBooks PO once, by id** — token, line ids, Desktop's
received and billed flags — and store nothing but the new token. Online gets a sparse update with
the full `Line` array; Desktop its `revisionNumber`, the existing line ids and `-1` for a new line.
Refused with a 409 and **nothing written** when QuickBooks holds lines Jigged never sent, when the
edit would remove or shrink a received or billed line, when the PO is gone from QuickBooks, or on
reopening a Desktop PO received in full. Close is Online's `POStatus: Closed`, Desktop's
`isManuallyClosed` — per line too for lines closed short — driven by the view's `closed`. **Archive
never calls QuickBooks**, and warns that the PO stays open there. A line removed in Jigged after a
push keeps its line-link row with a NULL line: that row is what tells the next push the QuickBooks
line is Jigged's to drop, not one the bookkeeper added.

**A push with no changes makes zero provider calls** — not even a term or ship-method lookup —
because the stored hash is of **Jigged's projection, never the resolved QuickBooks payload**:
resolving a payload is itself QuickBooks calls. The same fact gives *Out of date* (`content_version >
pushed_content_version`) for free.

**Refusals the shop can fix are 409s with a code and a sentence naming where to fix it**
(`PO_ERROR_SENTENCES`), shown in amber and **kept out of Sentry**. Any other QuickBooks rejection is a
502 in QuickBooks' own words, which Sentry gets.

| Area | Codes | The sentence sends you to |
|---|---|---|
| Connection and plan | `qb_not_connected` · `qbd_offline` · `qbo_purchase_orders_unavailable` · `qbo_busy` | Settings → QuickBooks; the QuickBooks computer; Plus/Advanced and Settings → Expenses; wait a minute |
| The PO | `vendor_po_draft` · `vendor_po_unsent_revision` · `vendor_po_archived` · `vendor_po_line_unpriced` · `qbd_po_number_too_long` | Mark as sent; send the revision; close it in QuickBooks; price the line; shorten the numbering |
| Setup | `qb_setup_required` · `qb_item_name_taken` · `qb_reference_inactive` | Settings → QuickBooks → Purchasing (an admin) |
| Vendors | `qb_vendor_choice_required` · `qb_vendor_name_invalid` · `qb_vendor_name_taken` · `qb_vendor_inactive` | choose one; link an existing vendor or rename; reactivate in QuickBooks |
| QuickBooks state | `qb_po_missing` · `qb_foreign_lines` · `qb_line_in_use` · `qb_cannot_reopen` · `qb_changed_in_quickbooks` | QuickBooks, by hand; close the line short in Jigged; a new PO; try again |
| Unconfirmed | `qbd_verify` · `qbd_blocked_unverified` | *Check again* on the PO |

**Fake mode:** `QUICKBOOKS_FAKE` covers every PO call — vendor search and create, items, accounts,
terms, ship method, read and update ([`purchasing_fake.py`](../../api/services/accounting/purchasing_fake.py)).

**Unverified until the manual checks against a real company file** (M-1 Online sandbox, M-2 Desktop
sample via Conductor; results go in the PR): the fault codes (Online's "purchase orders are off",
Desktop's stale-revision 3200), whether a bill entered against the PO advances its `SyncToken`,
Online's sparse-update line semantics, whether Online accepts a non-inventory item with only an
expense account, and whether `vendorMessage` prints while `memo` does not. An unknown fault falls to
a 502 with QuickBooks' own words; the classifier fixtures fill in once captured.

---

## What the bookkeeper does differently

Written for whoever enters bills. **Jigged now writes the purchase order; QuickBooks still pays it.**

1. **Stop creating shop purchase orders in QuickBooks.** Raise them in Jigged and press **Send to
   QuickBooks** on the PO.
2. **Enter the vendor's bill in QuickBooks against the open PO**, as you do now — Jigged never makes
   bills, item receipts or payments.
3. **Don't use Receive Items for these POs.** Jigged records what arrived, with heat and cert. Their
   lines are non-inventory or service items, so QuickBooks' *Rcv'd* column fills **when you bill** —
   read it as "billed"; Jigged's *Received* is what came in the door.
4. **Never edit a pushed PO in QuickBooks.** Change it in Jigged and press **Update in QuickBooks**.
   If QuickBooks has lines Jigged did not send, or a line you billed would shrink, Jigged refuses and
   changes nothing there.
5. **Close in Jigged, then Close in QuickBooks** from the same dialog. Archiving a PO in Jigged does
   **not** close it in QuickBooks — close it there.
6. **Finish 1099 details on any vendor Jigged creates** — it sends the name and the vendor's address,
   nothing else.
7. **Raise POs only in Jigged from now on.** Jigged numbers them `PO-0001` on. QuickBooks numbers
   its own POs with plain numbers, so a `PO-` number never collides with one it made, but it
   accepts a duplicate silently, so a PO typed into QuickBooks by hand could. On QuickBooks Online,
   turn **custom transaction numbers** on, or QuickBooks renumbers every PO.
8. **Old QuickBooks POs stay in QuickBooks.** Nothing imports them; finish them there.
9. **Before the first PO, check how your material is booked.** These POs post through a non-inventory
   "purchases" item to an expense or cost-of-goods account. If QuickBooks tracks your raw material as
   inventory items, billing these POs **expenses** that material instead — agree that with your
   accountant first.

---

## MCP tools and the insights AI

Reads in [`lib/mcp/tools/purchasing.ts`](../../lib/mcp/tools/purchasing.ts), writes in
[`purchasingWrites.ts`](../../lib/mcp/tools/purchasingWrites.ts), served on `/mcp` with the rest of
the catalogue. The hints are the MCP annotations an assistant reads before it calls — all 23 pinned
by `tools/purchasing` › `the purchasing catalogue`:

| Hints | Tools |
|---|---|
| read | `list_vendor_pos` · `get_vendor_po` · `get_buy_list` · `get_part_vendors` · `list_vendor_rfqs` · `get_vendor_rfq` (with the comparison) · `preview_part_cost_from_vendor` |
| read, open-world | `preview_vendor_po_push` — the dialog's preflight: what a push would do, sending nothing |
| write | `create_vendor_po` · `update_vendor_po` · `receive_vendor_po` · `save_vendor_rfq` |
| write, idempotent | `mark_vendor_po_sent` · `reopen_vendor_po` · `save_part_vendor` · `mark_vendor_rfq_sent` · `record_vendor_rfq_response` |
| write, destructive | `award_vendor_rfq` |
| write, destructive, idempotent | `void_vendor_po_receipt` · `close_vendor_po` (whole or lines) · `set_part_cost_from_vendor` |
| write, idempotent, open-world | `verify_vendor_po_push` |
| write, destructive, idempotent, open-world | `push_vendor_po_to_quickbooks` |

- **Each tool calls the UI's access function with the UI's arguments**, company-scoped before any
  id-only lookup. By id finds an archived record; a list never shows one. Pages hold at most 50
  rows; every record carries a `url` to a real page, built by
  [`lib/purchasingRoutes.ts`](../../lib/purchasingRoutes.ts) as the screens build theirs; no person
  fields (`*_by`); non-blocking conditions come back in `warnings`; writes return `get_vendor_po`'s
  shape.
- **Prices go to admins and users** — they see them in the app. Inventory cost and value stay
  admin-only; the money rule in [`lib/mcp/tools/shared.ts`](../../lib/mcp/tools/shared.ts) is amended
  to say so.
- `receive_vendor_po` refuses a part line with no place, and derives its `receipt_group_id` from the
  PO, lines, quantities and UTC day — **a retried tool call cannot receive twice**, at the cost that
  an identical second delivery the same day needs the app.
- Existing tools gain the purchasing facts: `archive_record` takes `vendor_po`, `vendor_rfq` and
  `part_vendor`; `send_outside` and `receive_outside` **report** the linked line (there is no input
  for it); `list_outside_shipments` gains `po_number`; `get_part`, `search_inventory` and
  `get_job_material_check` gain on order; `get_job` gains its PO lines; `get_vendor` gains its open
  POs, and its `parts_supplied` (formerly `preferred_parts`) now come **from the approved vendor
  list**, as the vendor page's do — a second source counts, not only the parts naming it preferred;
  `create_job` now says *customer's* PO and points to `create_vendor_po`.
- **No tool, and why:** purchasing numbering and the QuickBooks setup (one-time admin choices, named
  in every refusal); slip relink (a rare correction); duplicate (`create_vendor_po` covers it).
- **Jigged chat reaches all of them with no registration of its own:**
  [`lib/mcp/chatCatalog.ts`](../../lib/mcp/chatCatalog.ts) is every company tool `/mcp` serves,
  minus the two the chat does its own way, and every write waits for the person's approval (or
  their *Always allow*) in [`api/services/chat_actions.py`](../../api/services/chat_actions.py).
  Its `ACTIONS_PROMPT` now names buying from vendors — POs, receiving, RFQs, a part's approved
  vendors, vendor POs to QuickBooks — and says *"PO" alone is the customer's purchase order; buying
  is a vendor PO*.

**`query_shop_data` reads purchasing column by column** ([ai-insights.md](ai-insights.md#adding-a-table-to-ai-scope)):
headers through `apply_ai_read_access`, children through hand-written policies that inherit the
parent's `deleted_at`. **Withheld:** actor columns, internal notes, contact and address snapshots,
notes and void reasons. The views and the late and amount functions are
readable, and `SELECT *` works on every view. **Exempt:** the revisions (a superseded price would read
as current), the numbering series (plumbing, twin of `company_order_counters`) and the `quickbooks_*`
purchasing tables (third-party ids, also in `SENSITIVE_TABLES`). Fixed on the way: the AI could not
read `outside_shipments.closed_at`, so a short-closed slip looked still at the vendor.

**What the model is told, kept lean.** [`SCHEMA_CONTEXT`](../../api/tools/schema_context.py)
describes ten purchasing objects (`PURCHASING_CONTEXT_OBJECTS` in `test_ai_read_access` pins which):
the PO and line tables only as pointers to their status views — *"never re-derive them"* — then the
receipts (count `voided_at IS NULL`), `part_on_order`, `part_vendor_last_purchase`, `part_vendors`,
its price breaks and `vendor_rfq_status`. The RFQ's lines, invitations and responses are readable
but not described. It also says late is `is_vendor_purchase_order_late(status, expected_on, $2)`,
outside-service lines come back on slips, `customer_po_number` is the *customer's* PO, and a vendor
"supplies materials" when a `part_vendors` row names it, no longer only as some part's preferred
vendor. [`semantics.md`](../../api/services/ai/semantics.md) defines five terms with reference SQL —
On order, Open PO, Late PO, Last PO price, Open value (at PO price) — and each new table has its
one-line purpose in [`purposes.json`](../../api/services/insights_pipeline/data/purposes.json),
which retrieval refuses to load unless it matches `SCHEMA_CONTEXT` name for name. **Measured
2026-11-12: the system prompt grew 20.9%** (≈11.8K → ≈14.3K tokens by `_estimate_tokens`), and a
500-character question still got the full 5,000-token history budget. The two outside-slip
sections added after it ([below](#found-while-building-fixed-here)) took the prompt to ≈14.6K and
that budget to 4,771, clear of the 4,000 floor that `test_insights_conversation` § budget holds
against the real prompt.

---

## Screens

Routes are relative to `/dashboard/{companyId}`. **One sidebar row, Purchasing, after Storage, for
every office role** — not `adminOnly`. Page titles and every link to a purchasing page — the
header's, the feedback dialog's, each MCP `url` — come from one table,
[`lib/purchasingRoutes.ts`](../../lib/purchasingRoutes.ts).

| Surface | What is non-obvious |
|---|---|
| Hub `/purchasing?view=orders\|receipts\|to-buy\|rfqs` | A tab switch is `router.replace` and drops the last tab's filters; an unknown `view` opens Orders. There is no settings button: POs and RFQs number themselves |
| Orders ([`VendorPoList`](../../components/purchasing/VendorPoList.tsx)) | Default Draft + Sent + Partly received, due soonest first, the status choice remembered per company — a status in the URL wins. Every filter lives in the URL, written with `router.replace`: status, vendor, a job chip, overdue only, **QuickBooks state** (the bookkeeper's worklist), search over `search_text`. Sorted on the server by real view columns only, so every derived column is `sortable: false`; *Overdue* amber, in words; CSV export. A failed load offers Retry and never reads as "no purchase orders"; empty, no-match and capped each say their own sentence |
| Receipts ([`VendorPoReceiptsList`](../../components/purchasing/VendorPoReceiptsList.tsx)) | For month-end: a date range read from local midnight to before the day after, vendor, PO, packing slip — all in the URL; each receipt in the unit it was typed in; a void marked in words |
| `/purchasing/orders/new` ([`VendorPoForm`](../../components/purchasing/VendorPoForm.tsx)) | Opens bare or **prefilled by ids** ([`newVendorPoPath`](../../lib/purchasingRoutes.ts)) from the operation card's *Create PO*, the job page's *Buy it*, the vendor page and an approved-vendor row. Vendor defaults — sales contact, default address, standing terms — fill only fields not yet touched; ship-to Our shop / Another vendor / A customer; [`PaymentTermsPicker`](../../components/common/PaymentTermsPicker.tsx) in its **lazy mode** — QuickBooks terms load when it opens, never on mount; *+ Part · + Outside service · + Other*, a part line taking its unit, price and vendor P/N from the sheet and naming the source; the approved-vendor caption or block; the leak prompt; Save off while `MissingFieldsNotice` says why; `beforeunload` armed only while something is unsaved |
| `/purchasing/orders/[poId]` (Pattern B) | **One amber next-step line**, the first that applies — send it → resend the revision → update QuickBooks. Actions by state: a draft can be received, edited, previewed, marked sent, duplicated and archived, never closed or pushed; a closed PO offers Reopen, neither Edit nor Receive. **Edit swaps the page for the form — there is no `/edit` route**; a sent PO saves as *Rev N+1* with a banner to resend, lines with receipts locked with the reason shown. Parties from the frozen copy, with mailto and tel links; internal notes and promised dates auto-save and never take the vendor-visible save path; every write, the QuickBooks dialog's included, runs one refresh with no loading flash. An outside line's slips open in their preview **with** Void, and the receive dialog hands outside lines to the job's own receive. Under each outside line, [`OutsideLineSlips`](../../components/purchasing/OutsideLineSlips.tsx) corrects which slips it counts: *Unlink* asks first and says what changes; *Link a slip…* reads the step's live, unlinked slips to this vendor only when opened. Neither appears on an archived or closed PO, and Link not on a closed line. A refusal stays in the dialog; each runs the one refresh. *Close…* ([`CloseVendorPoLinesDialog`](../../components/purchasing/CloseVendorPoLinesDialog.tsx)) lists the lines still expecting something, all ticked: all ticked closes the PO, fewer close those lines in one batch. Duplicate says what it leaves behind; Archive goes through `DeleteImpactDialog`, not revivable by name; an archived PO opened by id is read-only with a banner |
| Receive ([`ReceiveVendorPoDialog`](../../components/purchasing/ReceiveVendorPoDialog.tsx)) | [The journey](#receive-a-partial-delivery-with-a-heat-and-a-mill-cert). A failed delivery retries with the **same** group id, so a lost reply can never add the stock twice; a cert is staged and uploaded only after the receipt resolves, only against the lot that landed, and [`CertAfterBatchPanel`](../../components/inventory/CertAfterBatchPanel.tsx) counts it under the surface `office_po_receipt` |
| PO preview and PDF ([`VendorPoPreviewDialog`](../../components/purchasing/VendorPoPreviewDialog.tsx), [`utils/vendorPoPdf.ts`](../../utils/vendorPoPdf.ts)) | Print · Download · Email contact (the frozen contact, number and revision in the subject) · *Mark as sent & download*, which re-reads the PO and downloads it **without** the DRAFT band; sending a new revision counts as a resend; an archived PO is never offered for sending. DRAFT and CLOSED banners; `PO-1042-rev2.pdf`; TBC for an unpriced line; the due date is the need-by date — **internal notes and promised dates never print**. Built on the [`packingSlipPdf.ts`](../../utils/packingSlipPdf.ts) primitives |
| To buy ([`BuyList`](../../components/purchasing/BuyList.tsx)) | [The journey](#the-buy-list). *Create draft PO* makes **one** draft per vendor from the ticked rows; a group with a draft already open adds to it; *Another vendor…* moves a row to a vendor not on the part's list; `?job=` narrows to one job, with a chip — the Materials card links here when something is short. Edited quantities survive another group's write. It never writes on its own |
| `/purchasing/rfqs/new`, `/purchasing/rfqs/[rfqId]` | Form, per-vendor preview and PDF, response grid, comparison matrix with *Lowest* as a text chip, award with *Save to price sheets* unticked ([the journey](#an-rfq-to-three-vendors-and-the-award)) |
| Send to QuickBooks ([`SendVendorPoToQuickBooksDialog`](../../components/purchasing/SendVendorPoToQuickBooksDialog.tsx)) | Nothing before it opens; preflight on open; **no preselection among similar vendor names**; a Desktop name QuickBooks cannot take refused up front; setup wording by role; only the pressed button shows busy; *Check again* for an unconfirmed send; on Desktop the wait names the shop computer |
| Settings → QuickBooks → Purchasing ([`QuickBooksPurchasingPanel`](../../components/settings/quickbooks/QuickBooksPurchasingPanel.tsx)) | Reads Jigged's setup on mount and calls QuickBooks only on a click. It appears once a company file is connected; Desktop's panel says *Purchasing setup needed* beside its own setup ([`QuickBooksDesktopPanel`](../../components/settings/quickbooks/QuickBooksDesktopPanel.tsx)). The integration card now says *"Jigged never deletes anything in QuickBooks, and changes only the POs it sent there"* — "never changes anything" stopped being true once a PO can be updated — and Disconnect says the purchasing setup is cleared ([`QuickBooksIntegrationCard`](../../components/settings/QuickBooksIntegrationCard.tsx)) |
| Part → Buying tab | Bought parts only: the list, sheets, purchase history (on order, on draft, recent lines), *Use as part cost* ([the journey](#approved-vendors-price-sheets-use-as-part-cost)); the workspace's unsaved-changes exit guard covers it |
| Vendor page | [`VendorTermsCard`](../../components/vendors/VendorTermsCard.tsx): the standing terms (`default_payment_terms`), saved as soon as chosen, QuickBooks terms read only when the picker opens. [`VendorPurchaseOrdersCard`](../../components/vendors/VendorPurchaseOrdersCard.tsx): open POs, *Overdue* in words, *New PO* to this vendor. [`VendorRfqsCard`](../../components/vendors/VendorRfqsCard.tsx): RFQs by vendor id, so one sent under an old name still lists. *Parts supplied* from the approved vendor list. A capped card says how many there are; a failed read offers Retry and never reads as "none" |
| Job page | **No new toolbar menu.** [`JobPartBuyingLine`](../../components/jobs/JobPartBuyingLine.tsx) under a part with no operations — bought, or made and bought whole from a subcontractor: *"Bought · PO-1042 (Acme) · 40 of 100 ea received · due 3/4/26"*, *Overdue* in words, a draft or a short close said so, or *"Not on a purchase order · Buy it"* — **never on a failed read**, which would offer to buy a part already on order. A *Vendor POs* row in the details card, each PO once. An **On order** column on the Materials card — sent with PO numbers, drafts muted, an em dash for nothing, *Short by* unchanged, a link to To buy for this job when something is short, a failed load an error with Retry |
| Outside-work surfaces | The operation card links its PO line (*Overdue* in words) or offers *Create PO*, never on a finished step, with Send and Receive still there. Send dialog: read-only *"Ships against PO-1042 line 2"* as a link, or *Create PO for this step*; Due back prefilled from the line's need-by. The slip prints `PO: …`, found by join; the drawer names each slip's PO; receiving short offers *Also close the line*, unticked, and closes it only after the receipt — saying the receipt stands if the close fails; a receipt that completes the line counts as done — no close is sent when the screen knows what the line still expects, and *Line N has nothing left to receive.* (or *is already closed.*) reads as done where it doesn't (the drawer); so does a whole PO closed first (*PO-1042 is closed. Reopen it first.*), said as *PO-1042 was already closed.* The drawer's *service · PO* text truncates with an ellipsis and keeps its full wording in a `title` |
| Storage → a part's places | The drawer's *Also on order*: the quantity with its PO and due date, as a link; drafts apart; *"Couldn't check what's on order."* on a failed read, never silence |
| `/activity` → Purchasing | One *sent* row per revision the vendor received; a delivery folded to one *received* row, however many lines; archived POs and voided receipts out |
| Copy | *Customer PO* on the jobs list (*New Job from Customer PO*), the accept modal (*Accept customer PO*) and the operator traveler (*Customer PO #*); the reorder-point help becomes *"Puts this part on To buy when stock plus orders reach it."* |

Telemetry: the `vendor po …`, `vendor rfq …`, `part vendor …`, `part cost sourced`, `buy list loaded`,
and `quickbooks purchase item chosen` rows of the
[registry](../telemetry.md#the-registry), each with its stated reason. Deliberately not counted, with
the reasons there: RFQ edit, close, reopen, archive and decline, the preferred star, and an outside
line's *Unlink* / *Link a slip…*.

---

## Acceptance criteria

**Tests are cited as file + section or `describe`, with a count** — `def test_` functions, `it`s or
Playwright `test`s, taken 2026-11-12; a parametrized test, an `it.each` or an `it` in a loop counts
once. Python files are organised by `# ── <criterion>` section comments, which stand in for a
`describe`. Where only some of a section's tests bear on a row, the count reads *N of M*. **E2E:** 42
journeys in eight specs, each walking its journey and reloading to prove it persisted —
[`purchasing-po`](../../e2e/purchasing-po.spec.ts) (7) ·
[`purchasing-receive`](../../e2e/purchasing-receive.spec.ts) (7) ·
[`purchasing-outside`](../../e2e/purchasing-outside.spec.ts) (5) ·
[`purchasing-buy-list`](../../e2e/purchasing-buy-list.spec.ts) (4) ·
[`purchasing-vendors-sourcing`](../../e2e/purchasing-vendors-sourcing.spec.ts) (6) ·
[`purchasing-rfq`](../../e2e/purchasing-rfq.spec.ts) (6) ·
[`purchasing-first-po`](../../e2e/purchasing-first-po.spec.ts) (1) ·
[`purchasing-quickbooks`](../../e2e/purchasing-quickbooks.spec.ts) (6, against `QUICKBOOKS_FAKE`); P10
rests on them alone. They run in the whole E2E suite, on a fresh database with one worker, as CI
runs it. Two pieces are **automation-pending
([#367](https://github.com/debola31/Jigged/issues/367))**, each with its reason in its row: the cert
upload on the receive path (R6) and choosing the QuickBooks item through Settings (QB7).

The rows below cite each file by the short name it is linked under here, so a renamed file fails the
docs check.

| Layer | Files |
|---|---|
| Database — pytest against a real local stack, psycopg2 helpers in [`purchasing_support`](../../api/tests/integration/purchasing_support.py) | [`test_purchasing_numbering`](../../api/tests/integration/test_purchasing_numbering.py) · [`test_vendor_purchase_orders`](../../api/tests/integration/test_vendor_purchase_orders.py) · [`test_vendor_purchase_order_receiving`](../../api/tests/integration/test_vendor_purchase_order_receiving.py) · [`test_vendor_purchase_order_outside_service`](../../api/tests/integration/test_vendor_purchase_order_outside_service.py) · [`test_purchasing_on_order`](../../api/tests/integration/test_purchasing_on_order.py) · [`test_part_vendors_and_price_sheets`](../../api/tests/integration/test_part_vendors_and_price_sheets.py) · [`test_purchasing_sourcing`](../../api/tests/integration/test_purchasing_sourcing.py) · [`test_vendor_rfqs`](../../api/tests/integration/test_vendor_rfqs.py) · [`test_purchasing_access_and_guards`](../../api/tests/integration/test_purchasing_access_and_guards.py) · [`test_purchasing_seed`](../../api/tests/integration/test_purchasing_seed.py) · [`test_quickbooks_purchasing_tables`](../../api/tests/integration/test_quickbooks_purchasing_tables.py) |
| QuickBooks routes — integration, the provider boundary monkeypatched | [`test_quickbooks_vendor_po_routes`](../../api/tests/integration/test_quickbooks_vendor_po_routes.py) · [`test_quickbooks_purchasing_setup`](../../api/tests/integration/test_quickbooks_purchasing_setup.py) |
| QuickBooks builders and services — unit | [`test_vendor_po_payload`](../../api/tests/unit/test_vendor_po_payload.py) · [`test_vendor_po_projection`](../../api/tests/unit/test_vendor_po_projection.py) · [`test_vendor_po_errors`](../../api/tests/unit/test_vendor_po_errors.py) · [`test_vendor_po_probe`](../../api/tests/unit/test_vendor_po_probe.py) · [`test_quickbooks_purchasing_service`](../../api/tests/unit/test_quickbooks_purchasing_service.py) |
| Existing suites, extended | [`test_demo_lifecycle`](../../api/tests/integration/test_demo_lifecycle.py) · [`test_ai_read_access`](../../api/tests/integration/test_ai_read_access.py) · [`test_accounting_provider`](../../api/tests/unit/test_accounting_provider.py); unchanged, and cited because purchasing now runs through them: [`test_insights_conversation`](../../api/tests/unit/test_insights_conversation.py) · [`test_chat_actions`](../../api/tests/unit/test_chat_actions.py) |
| Pure rules — Vitest | [`amount`](../../__tests__/lib/purchasing/amount.test.ts) · [`buyList`](../../__tests__/lib/purchasing/buyList.test.ts) · [`late`](../../__tests__/lib/purchasing/late.test.ts) · [`poReceipt`](../../__tests__/lib/purchasing/poReceipt.test.ts) · [`priceDefault`](../../__tests__/lib/purchasing/priceDefault.test.ts) · [`purchaseUnits`](../../__tests__/lib/purchasing/purchaseUnits.test.ts) · [`rfqCompare`](../../__tests__/lib/purchasing/rfqCompare.test.ts) · [`sourcing`](../../__tests__/lib/purchasing/sourcing.test.ts) · [`vendorPoStatus`](../../__tests__/lib/purchasing/vendorPoStatus.test.ts) · [`vendorPoVisibleFields`](../../__tests__/lib/purchasing/vendorPoVisibleFields.test.ts) · [`money`](../../__tests__/lib/money.test.ts) · [`purchasingRoutes`](../../__tests__/lib/purchasingRoutes.test.ts) · [`unitPresets`](../../__tests__/lib/unitPresets.test.ts); extended [`materialRequirements`](../../__tests__/lib/materialRequirements.test.ts) |
| Access layer — Vitest | [`vendorPoAccess`](../../__tests__/utils/vendorPoAccess.test.ts) · [`partVendorsAccess`](../../__tests__/utils/partVendorsAccess.test.ts) · [`vendorRfqAccess`](../../__tests__/utils/vendorRfqAccess.test.ts) · [`buyListAccess`](../../__tests__/utils/buyListAccess.test.ts) · [`purchasingShared`](../../__tests__/utils/purchasingShared.test.ts); extended [`materialCheckAccess`](../../__tests__/utils/materialCheckAccess.test.ts) · [`outsideShipmentsAccess`](../../__tests__/utils/outsideShipmentsAccess.test.ts) · [`dashboardAccess`](../../__tests__/utils/dashboardAccess.test.ts) · [`quickbooksAccess`](../../__tests__/utils/quickbooksAccess.test.ts) |
| PDFs — Vitest, jsPDF mocked | [`vendorPoPdf`](../../__tests__/utils/vendorPoPdf.test.ts) · [`rfqPdf`](../../__tests__/utils/rfqPdf.test.ts); extended [`outsideShipmentPdf`](../../__tests__/utils/outsideShipmentPdf.test.ts) |
| Purchasing screens — Vitest | [`PurchasingHubPage`](../../__tests__/app/dashboard/purchasing/PurchasingHubPage.test.tsx) · [`NewVendorPoPage`](../../__tests__/app/dashboard/purchasing/NewVendorPoPage.test.tsx) · [`VendorPoDetailPage`](../../__tests__/app/dashboard/purchasing/VendorPoDetailPage.test.tsx) · [`VendorPoList`](../../__tests__/components/purchasing/VendorPoList.test.tsx) · [`VendorPoForm`](../../__tests__/components/purchasing/VendorPoForm.test.tsx) · [`PurchaseUnitField`](../../__tests__/components/purchasing/PurchaseUnitField.test.tsx) · [`VendorPoPreviewDialog`](../../__tests__/components/purchasing/VendorPoPreviewDialog.test.tsx) · [`CloseVendorPoLinesDialog`](../../__tests__/components/purchasing/CloseVendorPoLinesDialog.test.tsx) · [`OutsideLineSlips`](../../__tests__/components/purchasing/OutsideLineSlips.test.tsx) · [`ReceiveVendorPoDialog`](../../__tests__/components/purchasing/ReceiveVendorPoDialog.test.tsx) · [`VendorPoReceiptsList`](../../__tests__/components/purchasing/VendorPoReceiptsList.test.tsx) · [`BuyList`](../../__tests__/components/purchasing/BuyList.test.tsx) · [`RfqList`](../../__tests__/components/purchasing/RfqList.test.tsx) · [`RfqForm`](../../__tests__/components/purchasing/RfqForm.test.tsx) · [`RfqDetail`](../../__tests__/components/purchasing/RfqDetail.test.tsx) · [`RfqVendorsCard`](../../__tests__/components/purchasing/RfqVendorsCard.test.tsx) · [`RfqResponseEditor`](../../__tests__/components/purchasing/RfqResponseEditor.test.tsx) · [`RfqCompareMatrix`](../../__tests__/components/purchasing/RfqCompareMatrix.test.tsx) · [`RfqPreviewDialog`](../../__tests__/components/purchasing/RfqPreviewDialog.test.tsx) · [`SendVendorPoToQuickBooksDialog`](../../__tests__/components/purchasing/SendVendorPoToQuickBooksDialog.test.tsx) |
| Screens elsewhere — Vitest | **Job:** [`JobDetailPage`](../../__tests__/app/dashboard/jobs/JobDetailPage.test.tsx) · [`JobPartBuyingLine`](../../__tests__/components/jobs/JobPartBuyingLine.test.tsx) · [`OperationsPanel`](../../__tests__/components/jobs/OperationsPanel.test.tsx) · [`OutsideWorkDrawer`](../../__tests__/components/jobs/OutsideWorkDrawer.test.tsx) · [`SendToVendorDialog`](../../__tests__/components/jobs/SendToVendorDialog.test.tsx); extended [`JobPartMaterialsCard`](../../__tests__/components/jobs/JobPartMaterialsCard.test.tsx) · [`OperationCard`](../../__tests__/components/jobs/OperationCard.test.tsx) · [`ReceiveFromVendorDialog`](../../__tests__/components/jobs/ReceiveFromVendorDialog.test.tsx) · [`AcceptPurchaseOrderModal`](../../__tests__/components/jobs/AcceptPurchaseOrderModal.test.tsx). **Part:** [`BuyingTab`](../../__tests__/components/parts/workspace/tabs/BuyingTab.test.tsx) · [`UseAsPartCostDialog`](../../__tests__/components/parts/UseAsPartCostDialog.test.tsx); extended [`PartWorkspaceExitGuard`](../../__tests__/components/parts/workspace/PartWorkspaceExitGuard.test.tsx) · [`PartIdentitySection`](../../__tests__/components/parts/PartIdentitySection.test.tsx). **Vendor:** [`VendorTermsCard`](../../__tests__/components/vendors/VendorTermsCard.test.tsx) · [`VendorPurchaseOrdersCard`](../../__tests__/components/vendors/VendorPurchaseOrdersCard.test.tsx) · [`VendorRfqsCard`](../../__tests__/components/vendors/VendorRfqsCard.test.tsx). **Storage:** [`CertAfterBatchPanel`](../../__tests__/components/inventory/CertAfterBatchPanel.test.tsx); extended [`PartPlacesDrawer`](../../__tests__/components/inventory/locations/place/PartPlacesDrawer.test.tsx). **Settings:** [`QuickBooksPurchasingPanel`](../../__tests__/components/settings/quickbooks/QuickBooksPurchasingPanel.test.tsx) · [`PaymentTermsPicker`](../../__tests__/components/common/PaymentTermsPicker.test.tsx) (its lazy mode); extended [`QuickBooksIntegrationCard`](../../__tests__/components/settings/QuickBooksIntegrationCard.test.tsx) · [`QuickBooksDesktopPanel`](../../__tests__/components/settings/quickbooks/QuickBooksDesktopPanel.test.tsx). **Shell:** [`ActivityPage`](../../__tests__/app/dashboard/ActivityPage.test.tsx); extended [`Sidebar`](../../__tests__/components/layout/Sidebar.test.tsx) · [`Header`](../../__tests__/components/layout/Header.test.tsx) |
| MCP — Vitest | [`tools/purchasing`](../../__tests__/lib/mcp/tools/purchasing.test.ts) · [`tools/purchasingWrites`](../../__tests__/lib/mcp/tools/purchasingWrites.test.ts) · [`tools/purchasingQuickBooks`](../../__tests__/lib/mcp/tools/purchasingQuickBooks.test.ts) · [`tools/purchasingSourcing`](../../__tests__/lib/mcp/tools/purchasingSourcing.test.ts); extended [`catalogue`](../../__tests__/lib/mcp/catalogue.test.ts) · [`tools/archive`](../../__tests__/lib/mcp/tools/archive.test.ts) · [`tools/inventory`](../../__tests__/lib/mcp/tools/inventory.test.ts) · [`tools/jobs`](../../__tests__/lib/mcp/tools/jobs.test.ts) · [`tools/jobsWrites`](../../__tests__/lib/mcp/tools/jobsWrites.test.ts) · [`tools/parts`](../../__tests__/lib/mcp/tools/parts.test.ts) · [`tools/shipping`](../../__tests__/lib/mcp/tools/shipping.test.ts) · [`tools/shippingWrites`](../../__tests__/lib/mcp/tools/shippingWrites.test.ts) · [`tools/vendors`](../../__tests__/lib/mcp/tools/vendors.test.ts); unchanged, and cited because purchasing now runs through them: [`chatCatalog`](../../__tests__/lib/mcp/chatCatalog.test.ts) · [`company`](../../__tests__/lib/mcp/company.test.ts) |
| Standards — Vitest | Extended [`documentPreviewActions`](../../__tests__/standards/documentPreviewActions.test.ts) · [`gridSortableColumns`](../../__tests__/standards/gridSortableColumns.test.ts) · [`interactionStandards`](../../__tests__/standards/interactionStandards.test.ts); unchanged, and run over the new code: [`analyticsEvents`](../../__tests__/standards/analyticsEvents.test.ts) · [`docLinkCheck`](../../__tests__/standards/docLinkCheck.test.ts) |

| ID | Criterion | Tests |
|---|---|---|
| **N1** | A PO and an RFQ series per company, `PO-0001` / `RFQ-0001` | `test_purchasing_numbering` § N1 (1); [`purchasing-first-po`](../../e2e/purchasing-first-po.spec.ts) (1) |
| **N2** | The format is fixed, like quotes and jobs: no settings screen, no writer and nothing configurable on the series; four digits grow rather than truncate; past `PO-99999999` (QuickBooks Desktop's 11 characters) a create refuses in a sentence | `test_purchasing_numbering` § N2 (3); `PurchasingHubPage` › `has no purchasing settings to open` (1); [`purchasing-first-po`](../../e2e/purchasing-first-po.spec.ts) (1) |
| **N3** | Concurrency-safe; never reissued, archived included; a rollback consumes nothing | `test_purchasing_numbering` § N3 (5) |
| **P1** | Company from the vendor; archived vendor refused; parties and ship-to frozen | `test_vendor_purchase_orders` § P1 (8) |
| **P2** | Line-kind rules in the RPC and the CHECKs; Do not use refused; archived references refused | `test_vendor_purchase_orders` § P2 / L4 (6) |
| **P3** | Revision: never on a draft; snapshot at mark-sent; once per send cycle; never for notes, promises or closing; one shared field list | `test_vendor_purchase_orders` § P3 (10); `vendorPoVisibleFields` (19); `VendorPoForm` › `VendorPoForm — editing` (its *Save as Rev 1* prediction; 1 of 7); `VendorPoDetailPage` › `VendorPoDetailPage — the internal fields save themselves, never as a revision` (2). E2E: `purchasing-po` (2 of 7) |
| **P4** | Edit guards, the vendor lock, read-only closed/archived POs, the staleness check only on vendor-visible fields | `test_vendor_purchase_orders` § P4 (9); `vendorPoAccess` › `updateVendorPo`, `the auto-saved internal fields never take the vendor-visible path` (6); `VendorPoForm` › `VendorPoForm — editing` (7, one of them P3's). E2E: `purchasing-po` (1 of 7) |
| **P5** | Mark-sent needs a line; close/reopen per line and whole; archive never blocked, unlinks slips; archived by id read-only | `test_vendor_purchase_orders` § P5 (8); `vendorPoAccess` › `state changes` (3); `VendorPoDetailPage` › `VendorPoDetailPage — actions per state` (5), `VendorPoDetailPage — duplicate and archive` (2, one of them P9's); `CloseVendorPoLinesDialog` › `CloseVendorPoLinesDialog` (6). E2E: `purchasing-po` (3 of 7), `purchasing-receive` (1 of 7) |
| **P6** | The status and line-state matrix, over-receipt, voids, no-receipt lines | `test_vendor_purchase_orders` § P6 (14); `vendorPoStatus` › `PO statuses (P6)`, `overdue is a flag beside the status, not a status (P6)`, `line states (P6)` (15). E2E: `purchasing-receive` (4 of 7) |
| **P7** | Late and amount: one rule in SQL, TypeScript and Python, each on its fixture | `test_vendor_purchase_orders` § P7 (6); `late` (8); `amount` (12); `money` (21); `test_vendor_po_payload` § the shared amount fixture (P7) (2) |
| **P8** | List, form, detail, preview and PDF as in [Screens](#screens) | `PurchasingHubPage` › `Purchasing hub` (5, one of them N2's); `VendorPoList` (14); `NewVendorPoPage` › `New purchase order page` (3); `VendorPoForm` › `VendorPoForm — a new PO` (9), `VendorPoForm — prefilled from another screen` (4, shared with O4), `VendorPoForm — leaving with unsaved changes` (1); `VendorPoDetailPage` › `VendorPoDetailPage — what it shows` (3), `VendorPoDetailPage — one next step at a time` (4), `VendorPoDetailPage — every write runs the one refresh` (9); `VendorPoPreviewDialog` (7); `vendorPoPdf` (18); `purchasingRoutes` › `PURCHASING_PAGE_TITLES (P8)` (2), `purchasingPageTitle (P8)` (4), `purchasing paths (P8, M1)` (2), `newVendorPoPath — the new-PO form, prefilled by ids` (4); `Header` › `purchasing page titles` (3); `Sidebar` › `Sidebar` (its one Purchasing row, after Storage, for each role; 1 of 6). E2E: `purchasing-po` (3 of 7) |
| **P9** | Duplicate: new number; drops job links, dates and outside lines, and says so | `vendorPoAccess` › `duplicateVendorPo` (2); `VendorPoDetailPage` › `VendorPoDetailPage — duplicate and archive` (2, one of them P5's). E2E: `purchasing-po` (1 of 7) |
| **P10** | Create, edit, receive, close, reopen, archive, duplicate persist after a reload | E2E: `purchasing-po` (7), `purchasing-receive` (7) |
| — | The job page: the bought-part line, the *Vendor POs* row, what sits under a part with no operations | `JobPartBuyingLine` › `JobPartBuyingLine` (8), `JobVendorPosSummary — the "Vendor POs" row in Job Details` (3), `noOperationsSlot — what sits under a part with no operations` (7); `JobDetailPage` › `JobDetailPage — a part with no operations` (3) |
| — | The vendor page: standing terms, open POs, RFQs, parts supplied | `VendorTermsCard` › `VendorTermsCard` (5, one of them QB1's); `VendorPurchaseOrdersCard` › `VendorPurchaseOrdersCard` (6); `VendorRfqsCard` › `VendorRfqsCard` (5); `partVendorsAccess` › `listVendorParts` (1) |
| — | `/activity` → Purchasing: a *sent* row per revision, a delivery as one *received* row, archived POs and voided receipts out | `dashboardAccess` › `purchasing activity` (6); `ActivityPage` › `ActivityPage` (1) |
| — | *Customer PO* copy; the reorder-point help | `AcceptPurchaseOrderModal` › `AcceptPurchaseOrderModal — expected (sell) price` (its customer's-PO title; 1 of 4); `PartIdentitySection` › `existing mode` (its To buy help; 1 of 3). The jobs list's and the operator traveler's labels have no test |
| **L1** | A purchase unit is the stock unit or one conversion; presets become rows and aliases normalise first; the factor frozen; one factor per unit name | `test_vendor_purchase_orders` § L1 (5); `test_part_vendors_and_price_sheets` § V2 / L1 (8); `purchaseUnits` (49); `purchasingShared` (5); `vendorPoAccess` › `createVendorPo` (9); `PurchaseUnitField` › `PurchaseUnitField (L1)` (5) |
| **L2** | The price default's precedence and caption; expired sheet named, not used; `price_source` stored; NULL is TBC | `priceDefault` › `defaultPartLinePrice — the precedence (L2)`, `defaultPartLinePrice — the price sheet (L2)`, `defaultPartLinePrice — the Last PO price (L2)`, `defaultPartLinePrice — the estimate (L2)`, `defaultOutsideLinePrice (L2)` (29); `test_vendor_purchase_orders` § L2 (3); `test_purchasing_on_order` (Last PO price; 1 of 6); `vendorPoAccess` › `price defaults` (2); `VendorPoForm` › `VendorPoForm — a new PO` (the sheet default naming its source, and a typed price kept as typed; 2 of 9) |
| **L3** | `hundred` and `thousand`; per-100 end to end — PO, receipt, stock | `test_vendor_purchase_order_receiving` § R1 / L3 (3); `test_purchasing_on_order` (the `hundred` line; 1 of 6); `purchaseUnits` › `resolvePurchaseUnit (L1, L3)` (13); `unitPresets` › `count presets — hundred and thousand (L3)` (7), `the Python importer mirrors the canonical units (L3)` (1) |
| **L4** | Approved-vendor warnings: quiet / amber / blocked | `priceDefault` › `partVendorLineNotice — approved-vendor warnings on a PO line (L4)` (4); the block in `test_vendor_purchase_orders` § P2 / L4; `BuyingTab` › `BuyingTab — the approved vendor list (V1, V2, L4)` (9, shared with V1–V2); `VendorPoForm` › `VendorPoForm — approved vendors (L4)` (2) |
| **R1** | A receipt moves the balance, the roll-up and the ledger, and links the ledger row; `stock_quantity` exact in either unit | `test_vendor_purchase_order_receiving` § R1 / L3 (3). E2E: `purchasing-receive` (2 of 7) |
| **R2** | Heats normalised; a new lot stamped once; `started_tracking`; heats first; a container refused | `test_vendor_purchase_order_receiving` § R2 (4); `poReceipt` › `the heat caption (R2, R6)` (1). E2E: `purchasing-receive` (1 of 7) |
| **R3** | Atomic; a replay writes nothing; splits; over-receipt flagged; `close_remaining`; outside refused, other quantity-only | `test_vendor_purchase_order_receiving` § R3 (9); `poReceipt` › `planVendorPoReceipt — which rows are sent (R3, R6)`, `planVendorPoReceipt — per-line totals and captions (R3, R6)` (17); `vendorPoAccess` › `receiveVendorPo` (5). E2E: `purchasing-receive` (1 of 7) |
| **R4** | A void reverses through the stock engine; refused when the stock is gone; idempotent; tracking stays on | `test_vendor_purchase_order_receiving` § R4 (4); `vendorPoAccess` › `voidVendorPoReceipt and relinkOutsideShipment` (2). E2E: `purchasing-receive` (1 of 7) |
| **R5** | Both stock RPCs keep one overload and their grants; every existing caller unchanged | `test_vendor_purchase_order_receiving` § R5 (2) |
| **R6** | The receive dialog's prefill, defaults, cert-after-write, draft confirmation and no-PO notice; the Receipts tab | `poReceipt` › `prefillVendorPoReceiptRows — one row per open line, prefilled with what is outstanding (R6)`, `defaultReceiptLocationId — the largest holding, else the last receipt place (R6)` (6); `vendorPoAccess` › `listVendorPoReceipts`, `getRecentNoPoReceipts` (2); `ReceiveVendorPoDialog` › `ReceiveVendorPoDialog — rows` (10), `ReceiveVendorPoDialog — the write` (6), `ReceiveVendorPoDialog — what it does not do` (2); `CertAfterBatchPanel` › `CertAfterBatchPanel` (3); `VendorPoReceiptsList` › `VendorPoReceiptsList` (8). E2E: `purchasing-receive` (its draft and Receipts-tab journeys; 2 of 7) — the cert upload on this path is automation-pending: it goes up after the write through the `uploadLotCertificate` that `e2e/storage-certificates.spec.ts` drives end to end into the bucket, and `ReceiveVendorPoDialog — the write` pins the order |
| — | Founder default: a receipt on a job-linked part line leaves the job's statuses alone | `test_vendor_purchase_order_receiving` § Founder default (1) |
| **O1** | Auto-link at send and at line insert; relink; a mismatch unstorable; one open outside line per (operation, vendor), reopen included | `test_vendor_purchase_order_outside_service` § O1 (8); `OutsideLineSlips` › `OutsideLineSlips — the slips and what they say` (2), `OutsideLineSlips — Unlink` (5), `OutsideLineSlips — Link a slip…` (5), `OutsideLineSlips — where the corrections are offered` (2); `VendorPoDetailPage` › `VendorPoDetailPage — correcting which slips an outside line counts` (3); `vendorPoAccess` › `listUnlinkedOutsideSlips — what "Link a slip…" offers` (2). E2E: `purchasing-outside` (2 of 5) |
| **O2** | The line's figures from its slips; slip and line close independently; a slip void lowers received | `test_vendor_purchase_order_outside_service` § O2 (4); `ReceiveFromVendorDialog` › `ReceiveFromVendorDialog — the vendor PO line behind the slip` (7), `closePoLineAfterReceipt` (9), `receivePoLineFor — the PO line a slip read names` (4); `vendorPoAccess` › `isNothingLeftToReceiveRefusal — a close refused because the line is received in full (O2)`, `isAlreadyClosedRefusal — a close refused because the line was closed first (O2)`, `isPoClosedRefusal — a close refused because the whole PO was closed first (O2)` (3); `OutsideWorkDrawer` › `OutsideWorkDrawer — the vendor PO on each slip` (8, shared with O4); `OperationsPanel` › `OperationsPanel — outside steps on a vendor PO` (7, shared with O4). E2E: `purchasing-outside` (1 of 5) |
| **O3** | Linking changes no status; the cascade still reaches the job; operators still send and receive, and the slip links | `test_vendor_purchase_order_outside_service` § O3 (4). E2E: `purchasing-outside` (1 of 5) |
| **O4** | The send caption, operation-card link, drawer PO number, `PO:` on the slip, due-back prefill, leak prompt | `outsideShipmentsAccess` › `the vendor PO line a slip ships against (purchasing, criterion O4)` (5); `SendToVendorDialog` › `SendToVendorDialog — the PO line it ships against` (6); `OperationCard` › `OperationCard — the vendor PO an outside step ships against` (6), `outsidePoLineForOperation — the one line a slip would link to` (4); `OperationsPanel` › `OperationsPanel — outside steps on a vendor PO` (7, shared with O2); `OutsideWorkDrawer` › `OutsideWorkDrawer — the vendor PO on each slip` (8, shared with O2); `outsideShipmentPdf` › `generateOutsideShipmentPdf — the vendor PO it ships against (plan §3.6, criterion O4)` (3); `VendorPoForm` › `VendorPoForm — a new PO` (the outside-line default and the leak prompt; 2 of 9), `VendorPoForm — prefilled from another screen` (4, shared with P8). E2E: `purchasing-outside` (2 of 5) |
| **B1** | On order in stock units, sent open unarchived part lines only; drafts apart; receipts lower it, voids restore it; unit mismatches counted apart | `test_purchasing_on_order` (6, one of them L2's); `vendorPoAccess` › `getOnOrderForParts` (2). E2E: `purchasing-buy-list` (1 of 4) |
| **B2** | The buy-list rule on its fixture; ordering the suggestion takes the part off the list | `buyList` › `the buy-list rule — golden cases (B2)`, `ported from 87df208 (B2)`, `job needs on a row (B2, B3)`, `suggestPurchaseQuantity (B2)`, `order the suggestion, it doesn't come back (B2)` (12). E2E: `purchasing-buy-list` (2 of 4) |
| **B3** | Grouping, Buy from, edits surviving refresh, Create or Add to draft, the RFQ start, the incomparable bucket, captions; never writes | `buyList` › `vendor grouping and "Buy from" (B3)`, `the counts the page reports (B3)` (9); `buyListAccess` (11); `BuyList` › `BuyList — ported from the 87df208 shortages page` (8), `BuyList — grouping and ordering` (2), `BuyList — ordering from a group` (9), `BuyList — what it says about itself` (4). E2E: `purchasing-buy-list` (3 of 4) |
| **B4** | The Materials card, the places drawer and MCP agree with `part_on_order` | `materialCheckAccess` › `getJobPartMaterialCheck` (the on-order case; 1 of 6); `materialRequirements` › `buildRequirement — on order and on draft (B4)` (4); `JobPartMaterialsCard` › `JobPartMaterialsCard — on order (plan §3.10, criterion B4)` (6); `PartPlacesDrawer` › `PartPlacesDrawer — also on order (plan §3.10, criterion B4)` (4); `tools/parts` › `get_part` (its two on-order tests; 2 of 8); `tools/inventory` › `search_inventory` (its on-order test; 1 of 6); `tools/jobs` › `get_job_material_check` (1, extended to on order). E2E: `purchasing-buy-list` (1 of 4) |
| **V1** | List uniqueness; archive and revive one row; the preferred-vendor trigger, backfill, cross-company and Do-not-use refusals; archiving the preferred clears it | `test_part_vendors_and_price_sheets` § V1: identity, archive and revive (4) and § V1: the preferred vendor is always on the list (7); `test_demo_lifecycle` (its seeded-preferred-vendors test; 1 of 21); `partVendorsAccess` › `listPartVendors`, `savePartVendor`, `archivePartVendor` (8); `BuyingTab` › `BuyingTab — the approved vendor list (V1, V2, L4)` (9), `BuyingTab — archive asks first (V1)` (2), `BuyingTab — purchase orders for this part` (6); `PartWorkspaceExitGuard` › `PartWorkspace — the Buying tab` (4). E2E: `purchasing-vendors-sourcing` (3 of 6) |
| **V2** | Per-sheet dates; sheets replaced whole; breaks in purchase units | `test_part_vendors_and_price_sheets` § V2 / L1 (8); `BuyingTab` › `BuyingTab — inline editing (V2)` (8). E2E: `purchasing-vendors-sourcing` (2 of 6) |
| **V3** | Preview writes nothing; apply in place, refused when stale, refused for made parts, inserts at markup 0 only without tiers; nothing else writes tiers | `test_purchasing_sourcing` § V3 (8); `sourcing` › `sourcingPreviewRows (V3)` (4); `partVendorsAccess` › `"Use as part cost"`, `consequence counts throw — "couldn't count" is never 0` (8); `UseAsPartCostDialog` › `UseAsPartCostDialog — the preview (V3)` (5), `UseAsPartCostDialog — apply only on confirm (V3)` (3); `BuyingTab` › `BuyingTab — Use as part cost` (1). E2E: `purchasing-vendors-sourcing` (1 of 6) |
| **V4** | After apply: quote lines unchanged, *Pricing changed* above 0.005; existing job cost frozen; new job parts take the new cost | `test_purchasing_sourcing` § V4 (2); `sourcing` › `sourcingConsequences — in plain words (V3, V4)` (4) |
| **Q1** | Structure, number, invitations with frozen contacts, 1–4 quantities, derived status, the per-vendor PDF | `test_vendor_rfqs` § Q1 (5) and § Q1 / Q2 (6); `vendorRfqAccess` (17); `rfqPdf` › `generateRfqPdf — addressed to ONE vendor (Q1)` (9) and its other three describes (6); `RfqForm` › `RfqForm — a new RFQ (Q1)`, `RfqForm — editing an RFQ` (8); `RfqDetail` (8); `RfqVendorsCard` (8); `RfqPreviewDialog` (7); `RfqList` (6). E2E: `purchasing-rfq` (3 of 6) |
| **Q2** | Responses per line unit with No bid; editable until awarded; a declined vendor refused | `test_vendor_rfqs` § Q1 / Q2 (6); `RfqResponseEditor` › `RfqResponseEditor — the grid (Q2)`, `RfqResponseEditor — what it must keep` (9). E2E: `purchasing-rfq` (2 of 6) |
| **Q3** | The matrix rules; the award atomic, one draft per vendor, ad-hoc lines as other lines, no double award, sheets only when asked | `test_vendor_rfqs` § Q3 (5); `rfqCompare` (21); `RfqCompareMatrix` › `RfqCompareMatrix — reading the quotes (Q3)`, `RfqCompareMatrix — award (Q3)` (11). E2E: `purchasing-rfq` (2 of 6) |
| **QB1** | QuickBooks is called only by Send/Update/Close, Check, Verify and the setup clicks — never on mount, render, poll, trigger, create, send, receive, close or archive | `test_quickbooks_purchasing_setup` § the mount read (QB1) (3); `SendVendorPoToQuickBooksDialog` › `SendVendorPoToQuickBooksDialog — nothing reaches QuickBooks before it opens` (2); `QuickBooksPurchasingPanel` › `QuickBooksPurchasingPanel — nothing reaches QuickBooks on mount` (3); `PaymentTermsPicker` › `PaymentTermsPicker` (3); the PO form: `VendorPoForm` › `VendorPoForm — a new PO` (its terms-picker test; 1 of 9); the PO page: `VendorPoDetailPage` › `VendorPoDetailPage — every write runs the one refresh` (its QuickBooks-dialog test; 1 of 9); the vendor page: `VendorTermsCard` › `VendorTermsCard` (its picker test; 1 of 5). E2E: `purchasing-quickbooks` (3 of 6) |
| **QB2** | Office role and billing gate before any QuickBooks call; operators and lapsed companies 403; setup writes admin-only | `test_quickbooks_vendor_po_routes` § access (QB2) (4); `test_quickbooks_purchasing_setup` § who may click (QB2) (1) |
| **QB3** | A create sends exactly the mapping; never a bill or item receipt | `test_vendor_po_payload` § QuickBooks Online create (QB3) (7), § QuickBooks Desktop create (QB3) (6), § never billable (QB3) (1), § descriptions (6); `test_vendor_po_projection` § the projection (5), § money and units (3); `test_quickbooks_vendor_po_routes` § create (QB3, QB4) (8); `test_quickbooks_purchasing_service` § never bills or item receipts (QB3) (1). E2E: `purchasing-quickbooks` (2 of 6) |
| **QB4** | One QuickBooks PO per Jigged PO per file under double-clicks and concurrency; a no-change push makes zero calls; the request-id rules | `test_quickbooks_vendor_po_routes` § create (QB3, QB4) (8, shared with QB3); `test_vendor_po_errors` § ambiguous vs rejected (QB4) (6); `test_vendor_po_projection` § the operation (QB4, QB9) (6); `test_quickbooks_purchasing_tables` § QB4 / QB11 (7) |
| **QB5** | A Desktop unknown outcome probed once, adopted or parked with one capture, never auto-retried; verify adopts or releases | `test_quickbooks_vendor_po_routes` § the Desktop unknown outcome (QB5) (6); `test_vendor_po_probe` § the create probe (QB5) (4), § the update probe (QB5) (5); `test_vendor_po_errors` § QuickBooks Desktop (QB5, QB10) (9) |
| **QB6** | The vendor branches and name rules | `test_quickbooks_vendor_po_routes` § vendors (QB6) (6); `test_vendor_po_probe` § vendor search (QB6) (5); `test_vendor_po_projection` § vendor names (QB6) (3); `test_quickbooks_purchasing_service` § vendors (QB6) (8); `test_accounting_provider` § vendor purchase orders: both providers (QB12) (its vendor-name rules; 1 of 8); `SendVendorPoToQuickBooksDialog` › `SendVendorPoToQuickBooksDialog — the vendor` (8). E2E: `purchasing-quickbooks` (1 of 6) |
| **QB7** | One general item by default, split optional; posting accounts verified; the invoice item refused; the AP account; the preferences check stored and warned | `test_quickbooks_purchasing_setup` § items (QB7) (9) and § the AP account and the preferences check (4); `test_quickbooks_vendor_po_routes` § setup the push needs (QB7) (2); `test_quickbooks_purchasing_service` § accounts (QB7) (4), § items (QB7) (10), § ship method and preferences (5); `QuickBooksPurchasingPanel` › `QuickBooksPurchasingPanel — the purchases item` (8), `QuickBooksPurchasingPanel — the accounts-payable account` (3), `QuickBooksPurchasingPanel — Check QuickBooks` (3), `QuickBooksPurchasingPanel — waiting and permissions` (3); `QuickBooksIntegrationCard` › `QuickBooksIntegrationCard — status` (its three Purchasing-panel tests; 3 of 6); `QuickBooksDesktopPanel` › `QuickBooksDesktopPanel — the purchasing step` (2). E2E: `purchasing-quickbooks` (its Settings-panel journey; 1 of 6) — choosing the item through Settings is automation-pending: the spec seeds the item rows through the service role, because `test_quickbooks_purchasing_setup` § items (QB7) covers choose-and-verify; the panel is opened only to prove it reads the seeded choice without calling QuickBooks |
| **QB8** | Update, close and reopen read once and send the right line ids; foreign or billed lines and a missing PO 409 with nothing written; an unsent revision refused | `test_quickbooks_vendor_po_routes` § update, close, reopen, archive (QB8, QB9) (8, one of them QB9's); `test_vendor_po_payload` § update, close, reopen (QB8) (8); `test_vendor_po_projection` § push preconditions (7); `SendVendorPoToQuickBooksDialog` › `SendVendorPoToQuickBooksDialog — what has to happen first` (5). E2E: `purchasing-quickbooks` (2 of 6) |
| **QB9** | *Out of date* exact; an ordinary receipt and internal notes never set it, and a receipt or void that moves the PO into or out of its derived *closed* (nothing outstanding beside a line closed short, the status the push closes and reopens from) always does, on the PO or on a linked vendor packing slip | `test_vendor_purchase_orders` § QB9 (4); `test_vendor_purchase_order_outside_service` § QB9 (8); `test_vendor_po_projection` § the hash (QB9) (7); `test_quickbooks_purchasing_tables` § QB9 (3); `test_quickbooks_vendor_po_routes` § update, close, reopen, archive (QB8, QB9) (1 of 8); `test_purchasing_seed` (1 of 7). E2E: `purchasing-quickbooks` (2 of 6) |
| **QB10** | Every error-map row's status, code, sentence and Sentry behaviour | `test_quickbooks_vendor_po_routes` § the error map (QB10) (6); `test_vendor_po_errors` § QuickBooks Online faults (QB10) (8), § every code has a sentence (QB10) (4); `quickbooksAccess` › `vendor PO QuickBooks access` (13, its tests tagged QB1, QB4, QB7 and QB10); `SendVendorPoToQuickBooksDialog` › `SendVendorPoToQuickBooksDialog — the send button` (5), `SendVendorPoToQuickBooksDialog — the outcome` (6) |
| **QB11** | Disconnect deletes the setup, keeps the vendor map; the QuickBooks tables' RLS, grants, gate and AI exemption | `test_quickbooks_purchasing_tables` § QB11: who reads, who writes (2), § QB11: disconnect (2); `test_quickbooks_purchasing_setup` § disconnect (QB11) (1); `test_ai_read_access` (its sensitive-QuickBooks-tables test; 1 of 18) |
| **QB12** | Fake mode covers every call; provider parity; pure builders | `test_quickbooks_purchasing_service` § fake mode (QB12) (3); `test_vendor_po_payload` § refusals and purity (3); `test_accounting_provider` § vendor purchase orders: both providers (QB12) (8, one of them QB6's) |
| **M1** | The catalogue: names, hints, no person fields, no bare `purchase_order`, *to a vendor* in every `vendor_po` description, every `url` a real page | `tools/purchasing` › `the purchasing catalogue` (3); `catalogue` › `the MCP tool catalogue` (8, three of them added for purchasing; its per-tool hint and no-person tests run over all 23); `tools/archive` › `archive_record` (its to-a-vendor test; 1 of 7); `purchasingRoutes` › `purchasing paths (P8, M1)` (2, shared with P8) |
| **M2** | Each tool calls the UI's access function with the UI's arguments; company-scoped before any id-only call; by id finds an archived record, a list never shows one; the exact refusal sentences; `warnings`; outputs parse with every nullable field null | One `describe` per tool, named for it: `tools/purchasing` (15 of 18, in five describes — the other three are M1's); `tools/purchasingWrites` (31, in eleven); `tools/purchasingQuickBooks` (8, in three); `tools/purchasingSourcing` (9, in four) |
| **M3** | Prices to admins and users; inventory cost and value admin-only; operators refused twice | `tools/purchasing` › `get_vendor_po` (its every-price-to-a-user test; 1 of 6); `tools/purchasingSourcing` › `get_part_vendors` (1 of 3); `tools/parts` › `get_part` (its to-a-user-too test; 1 of 8); `tools/inventory` › `search_inventory` (its no-money-for-a-user and admin-value tests, older; 2 of 6); `VendorPoDetailPage` › `VendorPoDetailPage — what it shows` (its prices-to-a-user test; 1 of 3). Operators: `company` › `resolveCompany` (its operator refusal, older; 1 of 7), then the RPCs, `test_purchasing_access_and_guards` § S1 (7) |
| **M4** | The existing tools' purchasing facts | `tools/archive` › `archive_record` (3 of 7: the three new entities in its parametrized test, a vendor PO's QuickBooks and slip warnings, a cleared preferred vendor); `tools/shippingWrites` › `send_outside` (1 of 4), `receive_outside` (1 of 5); `tools/shipping` › `list_outside_shipments` (1 of 5); `tools/jobs` › `get_job` (1 of 5); `tools/vendors` › `get_vendor` (3 of 6: open POs, `parts_supplied` from the approved list, its cap); `tools/jobsWrites` › `create_job` (1 of 4); the on-order fields under B4 |
| — | Jigged chat reaches every purchasing tool; each write waits for the person's approval | `chatCatalog` › `the chat catalogue` (4, older: every company tool `/mcp` serves, writes marked as writes); `test_chat_actions` (19, older) |
| **M5** | Only the listed columns as `jigged_ai_readonly`, archived rows invisible, `SELECT *` on every view, exempt tables denied; `SCHEMA_CONTEXT` truthful; `semantics.md` SQL runs | `test_purchasing_access_and_guards` § M5 (9); `test_ai_read_access` (18, all passing: two are purchasing's own, one is QB11's, one the outside slips' and five the soft-delete guard's — approved vendors, price breaks, PO receipts and RFQ responses among the children they hide ([below](#found-while-building-fixed-here)) — and three older ones hold every described column (to its own grant, since 2026-11-12), named object and `semantics.md` reference query to the database — the new entries included); `test_insights_conversation` § budget (its floor, held against the real prompt; 1 of 3) |
| **S1** | Every writer refuses operators and non-members with the stated codes; browser-callable, anon not; helpers unreachable | `test_purchasing_access_and_guards` the writer-list contract (1), § S1 (7) |
| **S2** | A lapsed company refused by every writer before anything is written | `test_purchasing_access_and_guards` § S2 (1) |
| **S3** | An id from another company or document, anywhere in the arguments, refused, changing nothing | `test_purchasing_access_and_guards` § S3 (2) |
| **S4** | No browser INSERT, UPDATE, DELETE or TRUNCATE on any purchasing table | `test_purchasing_access_and_guards` § S4 (4) |
| **S5** | Every CI guard empty: write gate, definer gate, execute leaks, AI decision, AI soft-delete | `test_purchasing_access_and_guards` § S5 (1) |
| **S6** | Demo reset twice with the whole graph present; one company DELETE removes it; the seed loads; types regenerate clean | `test_purchasing_access_and_guards` § S6 (1); `test_demo_lifecycle` (its twice-reset purchasing test; 1 of 21); `test_purchasing_seed` (6 of 7; the seventh is QB9's); CI's `gen:db-types` diff |
| — | `p_today` required; an unknown jsonb key is XX000 | `test_purchasing_access_and_guards` § §3.3 rule 7 and the jsonb-key rule (2) |
| **D1–D3** | Registry rows for every capture, both directions; this doc and `docLinkCheck`; every machine standards check | `analyticsEvents` › `analyticsEventsCheck — the live tree` (2); `docLinkCheck` › `docLinkCheck — docs are clean` (3); `documentPreviewActions` › `a document preview offers the same actions wherever it is opened` (1, looped over four previews — the PO's and the RFQ's must be handed `onMarkedSent`); `gridSortableColumns` › `server-sorted grids never offer a sort that cannot reach the database` (3, `VendorPoList` now among its pages); `interactionStandards` › `silent busy buttons (§5)` (its purchasing-paths test; 1 of 6); CI: `schemaEmbedCheck` and the `gen:db-types` diff |

**Manual, by design:** the PDF render checks (a 40-line PO onto page 2, a 60-character legal vendor
name, a vendor with no address, a long note to the vendor, Rev 3 + CLOSED, TBC lines, with and
without a logo) and M-1 / M-2 above. A mocked jsPDF cannot see overflow — the lesson of
[outside-processing.md](outside-processing.md#the-document). The render checks ran on 2026-11-12
against the real jsPDF, along with an RFQ of 30 lines and a slip carrying its PO number, and all
pass. They found four layout faults, now fixed in the builders:
- a long PO line split across a page break, its tail landing on the next page with no line
  number (both tables now keep a row whole);
- the RFQ table ran into its footer (it now reserves the PO's bottom margin);
- the RFQ's *Your part #* column broke a 13-character vendor number mid-token;
- the shop's logo shrank with the meta column beside it. A PO with only its number and date
  printed none, an RFQ with both dates printed it at 18pt, and a vendor slip with no due-back
  date printed it at 4pt (that one is older than purchasing). With a logo, the column now
  measures at least seven rows ([`metaColumnBottom`](../../utils/packingSlipPdf.ts)), which
  leaves a three-line letterhead about 60pt.

---

## Found while building, fixed here

Older than purchasing unless the row says otherwise, and fixed in the same PR at the founder's
request.

| Found | Fixed | Tests |
|---|---|---|
| **Nothing linked to the count worksheet.** The Parts toolbar's *Count Inventory* went 2026-08-18 (`6738cf07`) and the part page's Storage tab, its last door, 2026-09-09 (`7f4477f6`), leaving [`/inventory/count`](../../app/dashboard/[companyId]/inventory/count/page.tsx) reachable only by typed URL | *Count Inventory* on the Storage → Inventory toolbar ([`StorageInventoryTable`](../../components/inventory/StorageInventoryTable.tsx)); *Count all N locations* in a split part's side rail ([`PartPlacesDrawer`](../../components/inventory/locations/place/PartPlacesDrawer.tsx)); every sheet goes back to Storage; [inventory.md §1a](inventory.md#1a-who-does-what-and-where) names a real door on every row | `StorageInventoryTable` › `the shop-wide count is reached from this tab` (2); `PartPlacesDrawer` › `PartPlacesDrawer — counting a split part everywhere` (2); `InventoryCountPage` › `counting one part at one place` (2 of 4), `counting one part everywhere` (1 of 4) |
| **`/activity`'s Inventory rows** (`2dad4536`) **and the part-first count sheets' "Back to part"** (`8670efb6`) **named the Storage tab's `?tab=` slug**, dead since `7f4477f6`, so both landed on Workspace | The rows open the part's Activity tab (`?tab=history`), its ledger; the sheets go back to Storage; the tab slugs are one list, [`lib/partWorkspaceTabs.ts`](../../lib/partWorkspaceTabs.ts), read by the workspace | `dashboardAccess` › `inventory activity` (1 of 5); `partWorkspaceTabLinks` › `links into the part workspace name a real tab` (3), every literal `?tab=` on a `/parts/` link in `app/`, `components/`, `utils/` and `lib/` |
| **Comments promised a *Count Inventory* button on the Parts toolbar** | They name the Inventory tab's toolbar: [`LocationsManager.tsx`](../../components/inventory/locations/LocationsManager.tsx) twice, the [`UnitAdjustDrawer.tsx`](../../components/inventory/locations/place/UnitAdjustDrawer.tsx) header, the count page | — |
| **`outside_shipments` and `outside_shipment_receipts` were AI-readable but never described** (`611ee902`), so *"what is out at the plater?"* had no table to query | A [`SCHEMA_CONTEXT`](../../api/tools/schema_context.py) section each, granted columns only ([`20260903203741`](../../supabase/migrations/20260903203741_outside_processing_shipping_and_receiving.sql); actor columns, notes and address snapshots withheld), voided rows dropped; a `purposes.json` line each; the history budget 5,000 → 4,771 | `test_ai_read_access` (2 of 18: the slips' own, and the described-columns test, which now holds each column to its grant); `test_insights_conversation` § budget (1 of 3); `test_insights_pipeline_cards` (7); `test_insights_pipeline_retrieval_live` (8, against Ollama) |
| **The insights AI could read what belonged to an archived record** — an archived vendor's contacts and services, an archived part's tiers and approved vendors, an archived job's packing slips — because the soft-delete guard, `ai_policies_missing_soft_delete_filter()`, judged a policy by its own table's `deleted_at` alone | The guard now also requires the parent a policy reads through, and the parent its rows belong to by a `NOT NULL` key, to be live, and the policies it caught are rebuilt ([`20261112193919`](../../supabase/migrations/20261112193919_ai_hides_children_of_archived_parents.sql)); its branches, the reviewed exceptions and the list are in [ai-insights.md](ai-insights.md#adding-a-table-to-ai-scope) | `test_ai_read_access` (5 of 18: three archive a parent and find what belonged to it gone, a live parent's rows the control; two plant a leaking policy and find the guard names it) |
| **The routing step picker offered an archived vendor's services**: [`getVendorServicesForRouting`](../../utils/vendorServicesAccess.ts) filtered only the service's own `deleted_at`, so the routing editor, the drawing station strip and the MCP routing writer offered them, and the routings importer resolved step names against them — a name shared with a live vendor's service read as ambiguous | `vendor:vendors!inner`, filtered on the vendor's `deleted_at`, there and in `getVendorServicesForCompany` (whose two callers hid the gap by joining live vendors); the importer skips the same services ([`routings_import_routes.py`](../../api/routes/routings_import_routes.py)); the vendor page and the by-id read still resolve them ([vendor-services.md](vendor-services.md#access-layer)) | [`vendorServicesAccess`](../../__tests__/utils/vendorServicesAccess.test.ts) › `getVendorServicesForRouting — the routing step picker` (3), `getVendorServicesForCompany — every live service, for the Vendors list` (1), `the vendor page and the by-id read keep resolving what an archived vendor offered` (1); [`test_routings_import_api`](../../api/tests/integration/test_routings_import_api.py) § `TestRoutingsExecute` (1 of 6) |
| **"Also close" on a slip whose whole PO was closed first warned** that the line *"could not be closed: PO-1042 is closed. Reopen it first."* — reopening a PO to close one of its lines contradicts the box, since nothing more is expected either way. Purchasing's own, found in review | That refusal, matched by its P0001 code and whole sentence for the slip's PO ([`isPoClosedRefusal`](../../utils/vendorPoAccess.ts)), counts as done in `closePoLineAfterReceipt` beside *nothing left to receive* and *already closed*, and reads *"PO-1042 was already closed."*; no surface warns | `vendorPoAccess` › `isPoClosedRefusal — a close refused because the whole PO was closed first (O2)` (1); `ReceiveFromVendorDialog` › `closePoLineAfterReceipt` (2 of 9); `test_vendor_purchase_orders` § P5 (1 of 8, pinning the sentence) |

---

## Out of scope

| | |
|---|---|
| **Accounting in Jigged** | Bills, accounts payable and item receipts · QuickBooks inventory items · categories on other lines · multi-currency and tax |
| **Purchasing workflow** | Approvals · returns to vendor, receiving inspection, landed cost · server-side email · importing open POs · blanket POs and releases · vendor scorecards |
| **Surfaces** | A "received" gate on bought job parts · changes to operator-side receiving · a demo template with seeded POs · migrating the existing per-component money formatters · QuickBooks Online custom fields |

## See also

[inventory.md](inventory.md) (J5, J6, J10 — the journeys this closes) ·
[outside-processing.md](outside-processing.md) · [vendors.md](vendors.md) ·
[vendor-services.md](vendor-services.md) · [parts.md](parts.md) · [jobs.md](jobs.md) ·
[quickbooks-desktop.md](quickbooks-desktop.md#purchase-orders) · [invoicing.md](invoicing.md) ·
[ai-insights.md](ai-insights.md) · [billing.md](billing.md) — the write gate every writer calls by hand
