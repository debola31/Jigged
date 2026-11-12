# Purchasing — vendor POs, receiving, approved vendors, RFQs

**Jigged can buy things.** A purchase order **to a vendor** for material, bought parts, outside
services and anything else (a machine repair, tooling, freight); receiving it into stock with heat,
lot and cert; an approved vendor list with price sheets; RFQs to several vendors; and an optional,
explicit push of the PO to QuickBooks Online or Desktop. Issue
[#571](https://github.com/debola31/Jigged/issues/571), revived. It closes inventory
[J5, J6 and J10](inventory.md#j5--buy-it) and PRD FR-2's buy list.

**As-built 2026-11-12, branch `feature/purchasing`.** Built and tested: the database, the pure rules,
the access layer, the QuickBooks push and its two screens, the RFQ screens and PDF, and the part's
Buying tab. **Being written in this PR:** the other screens, the PO PDF, the MCP tools, the
insights-AI context and the E2E specs. Rows below that depend on those say *being written*; a final
pass replaces each with its citation.

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

### The founder's, 2026-11-09 — his answers quoted

| Question | Decision | His answer |
|---|---|---|
| Scope | All of #571: POs for material, bought parts, outside services and other purchases; receiving with heat, lot and cert; purchase vs stock units (per 100, per 1000); on-order and a buy list; an approved vendor list; per-vendor price sheets; RFQs with comparison and award; an **explicit** "use as part cost"; revisions; PO and RFQ PDFs | "Everything in #571" |
| QuickBooks | **Push the PO; bills stay in QuickBooks.** An explicit Send / Update / Close, in the UI and in MCP, to Online (Plus/Advanced) and Desktop (Conductor). Vendors matched or created the way customers are. Jigged never creates a bill or an item receipt and never sets Billable or `CustomerRef` | "Push the PO; bills stay in QB" |
| Reading QuickBooks | **One read of the QuickBooks PO, only inside the Update/Close click** — its version token, line ids and billed flags. No read on load, preflight or create, no polling, and nothing stored but the new token. It reversed his earlier "never read or poll PO status": a bill entered against the PO very likely moves the token, and a write with the old one fails | "Allow one read inside the click" |
| QuickBooks items | **Non-inventory and service items only, no categories.** One "QuickBooks item for purchases" fills all three line kinds; a per-kind split is a secondary option. Jigged owns the stock count, so a QuickBooks inventory item would count it twice | "Non-inventory/service only" · on categories: *"Do we need to categorize items?. maybe just 1 general thing until we get a request for diversity?"* |
| Permissions | **Admins and users; no approval step.** Operators are refused in the database functions, the MCP tools and the FastAPI routes | "Admins and users, no approval" |
| Sending | **PDF plus mailto, like quotes.** "Mark as sent" stamps the send; there is no server email | "PDF + mailto, like quotes" |

**Open, and the founder's to close before L&L goes live:** their bookkeeper confirms that material
expensed through non-inventory items is acceptable — if QuickBooks tracks their raw material as
inventory items, bills against pushed POs expense it instead of adding to inventory.

### Accepted with the plan

| Decision | Why |
|---|---|
| Receiving is office-only; the operator's ad-hoc receive is unchanged | A PO is office paperwork; the floor already has a receive that needs none |
| A bought part on a job keeps today's production status — no "received" gate; the job shows its POs | A gate would block shipping on paperwork; it is out of scope, not forgotten |
| No FOB field ([PR #737](https://github.com/debola31/Jigged/pull/737) found it unused), no buyer field; ship via and notes instead | Fields nobody fills are fields nobody keeps true |
| No approvals, returns to vendor, receiving inspection, landed cost or import of open POs | [Out of scope](#out-of-scope) |
| Per-company numbering, prefix and next number settable, **PO number ≤ 11 characters**; RFQs a fixed `RFQ-` series | 11 is QuickBooks Desktop's `refNumber`; a settable sequence lets a shop continue the one QuickBooks was numbering |
| **A PO price is a frozen term of the document, never a cost record** | It is the price of one order — a rush premium, a minimum. Only the explicit, previewed ["Use as part cost"](#approved-vendors-price-sheets-use-as-part-cost) writes `part_pricing_tiers` |
| A part line takes any live part, made or bought; sourcing applies to bought parts only | A subcontracted whole part is a real case |
| **The vendor is locked once a PO is marked sent**; to change vendor, close and duplicate | The vendor holds the document |
| Edits after a send bump **Rev N on the same number**; no void-and-reissue | The number is what the vendor files it under |
| Numbering and terms & conditions on the Purchasing hub (any office user); QuickBooks item mapping in Settings → QuickBooks (admin) | Purchasing settings are office work; QuickBooks setup is an admin's |
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
| suggested | max(reorder point − position (or −position), minimum order), rounded up to whole purchase units, **at least one** |

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
| `purchasing_document_series` | company × kind | Prefix `^[A-Za-z0-9-]{0,6}$`, may be empty; `next_number` only moves forward; 1–8 minimum digits; for POs prefix + digits ≤ 11. No row until first use — the defaults are the contract. Terms & conditions copied onto each new document at create |
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

`next_purchasing_document_number` mints inside the create RPC under a `FOR UPDATE` lock on the series
row, held to commit: **a number that already exists is skipped, a number is never reissued**
(archived POs included), and **a rolled-back create consumes nothing**. The settings save refuses a
next number at or below the highest already issued under that prefix, and a PO number over 11
characters. **An empty prefix plus a next number is how a shop continues its QuickBooks sequence**
("1043").

### Two counters: `revision` and `content_version`

| | Bumped by | Never by | Means |
|---|---|---|---|
| `revision` | the **first** vendor-visible change after a send — the md5 of `vendor_purchase_order_document()` no longer matches the sent revision's — **once per send cycle** | drafts; internal notes, promised dates, closing, `price_source`, `expects_receipt` (none of them are in the document) | "Rev N". `revision > sent_revision` is *Rev N not sent*, and a QuickBooks push is refused until it is sent |
| `content_version` | every writer whose change moves `vendor_purchase_order_pushed_projection()` — **including close and reopen** | receipts, internal notes, promised dates, terms & conditions | `content_version >` the link's `pushed_content_version` is *Out of date in QuickBooks* — no QuickBooks call needed |

**The vendor-visible field list is one list in three copies, pinned together:**
[`lib/purchasing/vendorPoVisibleFields.ts`](../../lib/purchasing/vendorPoVisibleFields.ts) (the
form's "Save as Rev N+1" prediction), [`__tests__/fixtures/vendorPoVisibleFields.json`](../../__tests__/fixtures/vendorPoVisibleFields.json),
and the tuples in [`purchasing_support.py`](../../api/tests/integration/purchasing_support.py) that the
DB tests parametrize over. The database still decides by hashing the document; the list only predicts
it.

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
| `create_vendor_purchase_order` | Live vendor only. Contact defaults to the sales contact, then the primary; address to the default; terms from the vendor's standing terms; T&Cs from the series; the number minted here. Returns `(id, po_number)` |
| `save_vendor_purchase_order` | **Patch semantics**; new lines carry no id. The staleness check (`p_expected_updated_at`, the string passed through exactly as read) runs **only when vendor-visible fields change**, so an auto-saved promise or note never collides with an edit. Refuses: quantity below received; removing a received line; changing kind, part, unit or factor after a receipt; changing an existing line's kind or routing step at all (add a new line); the vendor once sent; anything on a closed or archived PO but internal notes and promised dates |
| `set_vendor_purchase_order_state` | `mark_sent` (needs a line; snapshots the revision) · `close` (a sent PO) · `reopen` (re-checks one open outside line per operation and vendor) · `archive` — **never blocked**, idempotent, and unlinks the slips of its outside lines |
| `set_vendor_purchase_order_line_state` | Close short or reopen a batch of lines of one sent PO, atomically. Reopen re-checks one open outside line per (operation, vendor). Moves `content_version` (QuickBooks closes lines too), never the revision |
| `receive_vendor_purchase_order` / `void_vendor_purchase_order_receipt` | [Above](#receive-a-partial-delivery-with-a-heat-and-a-mill-cert). Outside lines refused: *"Outside work is received on its vendor packing slip"* |
| `set_outside_shipment_vendor_purchase_order_line` | Office-only relink or unlink of a live slip; changes no status |
| `create_outside_shipment` | Same 8-argument signature, rebuilt from its newest body plus the auto-link. **No office assertion — operators send** |
| `add_stock_at_location` / `deplete_stock_at_location` | Rebuilt **word for word** from their newest bodies, plus `transaction_id` in the result so a receipt links its ledger row. Same signatures, so the ACLs survive; the one-overload and grant guards repeated |
| `save_part_vendor` / `archive_part_vendor` | Upsert and revive on (part, vendor). A non-null `p_price_breaks` replaces the whole sheet |
| `preview_part_cost_from_vendor` (INVOKER) / `apply_part_cost_from_vendor` | [Above](#approved-vendors-price-sheets-use-as-part-cost) |
| `create_vendor_rfq`, `save_vendor_rfq`, `set_vendor_rfq_state`, `set_vendor_rfq_invitation_state`, `save_vendor_rfq_responses`, `award_vendor_rfq` | [Above](#an-rfq-to-three-vendors-and-the-award) |
| `save_purchasing_document_settings` | Any office user, not only admins |

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
  existing live, unlinked slips; the office relink does the rest. Archiving the PO or removing the
  line unlinks.
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
posts to the chosen account (the invoice path's lookup does not check; this must). Only the kinds on
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
7. **Pick PO numbering QuickBooks will not reuse.** QuickBooks accepts a duplicate PO number
   silently. Either keep a prefix QuickBooks never uses (the default `PO-`), or continue QuickBooks'
   own sequence — empty prefix, next number above QuickBooks' highest — and from then on number POs
   only in Jigged. On QuickBooks Online, turn **custom transaction numbers** on, or QuickBooks
   renumbers every PO.
8. **Old QuickBooks POs stay in QuickBooks.** Nothing imports them; finish them there.
9. **Before the first PO, check how your material is booked.** These POs post through a non-inventory
   "purchases" item to an expense or cost-of-goods account. If QuickBooks tracks your raw material as
   inventory items, billing these POs **expenses** that material instead — agree that with your
   accountant first.

---

## MCP tools and the insights AI

**Being written in this PR** (`lib/mcp/tools/purchasing.ts`, `purchasingWrites.ts`).

| Kind | Tools |
|---|---|
| Reads | `list_vendor_pos` · `get_vendor_po` · `get_buy_list` · `get_part_vendors` · `list_vendor_rfqs` · `get_vendor_rfq` (with the comparison) · `preview_part_cost_from_vendor` · `preview_vendor_po_push` |
| Writes | `create_vendor_po` · `update_vendor_po` · `mark_vendor_po_sent` · `receive_vendor_po` · `void_vendor_po_receipt` · `close_vendor_po` (whole or lines) · `reopen_vendor_po` · `save_part_vendor` · `set_part_cost_from_vendor` · `save_vendor_rfq` · `mark_vendor_rfq_sent` · `record_vendor_rfq_response` · `award_vendor_rfq` · `push_vendor_po_to_quickbooks` · `verify_vendor_po_push` |

- **Each tool calls the UI's access function with the UI's arguments**, company-scoped before any
  id-only lookup. By id finds an archived record; a list never shows one. Pages hold at most 50
  rows; every record carries a `url` to a real page; no person fields (`*_by`); non-blocking
  conditions come back in `warnings`; writes return `get_vendor_po`'s shape.
- **Prices go to admins and users** — they see them in the app. Inventory cost and value stay
  admin-only; the money rule in [`lib/mcp/tools/shared.ts`](../../lib/mcp/tools/shared.ts) is amended
  to say so.
- `receive_vendor_po` refuses a part line with no place, and derives its `receipt_group_id` from the
  PO, lines, quantities and UTC day — **a retried tool call cannot receive twice**, at the cost that
  an identical second delivery the same day needs the app.
- Existing tools gain the purchasing facts: `archive_record` takes `vendor_po`, `vendor_rfq` and
  `part_vendor`; `send_outside` and `receive_outside` **report** the linked line (there is no input
  for it); `list_outside_shipments` gains `po_number`; `get_part`, `search_inventory` and
  `get_job_material_check` gain on order; `get_job` gains its PO lines, `get_vendor` its open POs;
  `create_job` now says *customer's* PO and points to `create_vendor_po`.
- **No tool, and why:** purchasing numbering and the QuickBooks setup (one-time admin choices, named
  in every refusal); slip relink (a rare correction); duplicate (`create_vendor_po` covers it).

**`query_shop_data` reads purchasing column by column** ([ai-insights.md](ai-insights.md#adding-a-table-to-ai-scope)):
headers through `apply_ai_read_access`, children through hand-written policies that inherit the
parent's `deleted_at`. **Withheld:** actor columns, internal notes, contact and address snapshots,
terms and conditions, notes and void reasons. The views and the late and amount functions are
readable, and `SELECT *` works on every view. **Exempt:** the revisions (a superseded price would read
as current), the numbering series (plumbing, twin of `company_order_counters`) and the `quickbooks_*`
purchasing tables (third-party ids, also in `SENSITIVE_TABLES`). Fixed on the way: the AI could not
read `outside_shipments.closed_at`, so a short-closed slip looked still at the vendor. The
`SCHEMA_CONTEXT` entries ([`api/tools/schema_context.py`](../../api/tools/schema_context.py): statuses
from the views, late through the predicate, outside lines received on slips, receipts filtered
`voided_at IS NULL`, `customer_po_number` the *customer's* PO) and the
[`semantics.md`](../../api/services/ai/semantics.md) terms — On order, Open PO, Late PO, Last PO
price, Open value (at PO price) — are **being written**; their tests are already in place.

---

## Screens

Routes are relative to `/dashboard/{companyId}`. **One sidebar row, Purchasing, for every office
role** — not `adminOnly`.

| Surface | What is non-obvious | State |
|---|---|---|
| Hub `/purchasing?view=orders\|receipts\|to-buy\|rfqs` | Orders list (`VendorPoList`): default Draft + Sent + Partly received, remembered per company; every filter in the URL; *Overdue* amber; search over `search_text`; load failure, empty and capped read differently. Receipts tab for month-end: date range, vendor, PO, packing slip. Settings dialog for any office user, previewing *"Next: PO-1043 · 7 of 11 characters"* | being written |
| `/purchasing/orders/new`, `/purchasing/orders/[poId]` | **Form:** vendor defaults fill only fields not yet touched; ship-to Our shop / Another vendor / A customer; [`PaymentTermsPicker`](../../components/common/PaymentTermsPicker.tsx) in its **lazy mode** (built) — QuickBooks terms load when it opens, never on mount; *+ Part · + Outside service · + Other*; explicit Save; a sent PO saves as *Rev N+1* with a banner to resend; lines with receipts are locked, the reason shown. **Detail** (Pattern B): **one amber next-step line**, the first that applies — send it → resend the revision → update QuickBooks; parties from the frozen copy; internal notes and promised dates auto-save and never take the vendor-visible save path; an archived PO opened by id is read-only with a banner; Archive through `DeleteImpactDialog`, not revivable by name | being written |
| PO preview and PDF | Print · Download · Email contact (mailto) · *Mark as sent & download*; DRAFT and CLOSED banners; `PO-1042-rev2.pdf`; TBC for an unpriced line; **internal notes and promised dates never print**. Built on the [`packingSlipPdf.ts`](../../utils/packingSlipPdf.ts) primitives | being written |
| `/purchasing/rfqs/new`, `/purchasing/rfqs/[rfqId]` | Form, per-vendor preview and PDF, response grid, comparison matrix with *Lowest* as a text chip, award with *Save to price sheets* unticked ([the journey](#an-rfq-to-three-vendors-and-the-award)) | **built** |
| Send to QuickBooks ([`SendVendorPoToQuickBooksDialog`](../../components/purchasing/SendVendorPoToQuickBooksDialog.tsx)) | Nothing before it opens; preflight on open; **no preselection among similar vendor names**; a Desktop name QuickBooks cannot take refused up front; setup wording by role; only the pressed button shows busy; *Check again* for an unconfirmed send; on Desktop the wait names the shop computer | **built** |
| Settings → QuickBooks → Purchasing ([`QuickBooksPurchasingPanel`](../../components/settings/quickbooks/QuickBooksPurchasingPanel.tsx)) | Reads Jigged's setup on mount and calls QuickBooks only on a click. The integration card now says *"Jigged never deletes anything in QuickBooks, and changes only the POs it sent there"* — "never changes anything" stopped being true once a PO can be updated — and Disconnect says the purchasing setup is cleared ([`QuickBooksIntegrationCard`](../../components/settings/QuickBooksIntegrationCard.tsx)) | **built** |
| Part → Buying tab | Bought parts only: the list, sheets, purchase history (on order, on draft, recent lines), *Use as part cost* ([the journey](#approved-vendors-price-sheets-use-as-part-cost)); the workspace's unsaved-changes exit guard covers it | **built** |
| Vendor page | Standing terms card (`default_payment_terms`), POs card, RFQs card, *Parts supplied* from the approved list | being written |
| Job page | **No new toolbar menu.** The bought-part line (*"Bought · PO-1042 (Acme) · 40 of 100 received"* / *"Not on a purchase order · Buy it"*); a *Vendor POs* row in the details card; an **On order** column on the Materials card — sent with PO numbers, drafts muted, *Short by* unchanged, a failed load an error with Retry; the operation card's PO link or *Create PO* | being written |
| Outside-work surfaces | Send dialog: read-only *"Ships against PO-1042 line 2"* or *Create PO for this step*, due back prefilled from the line's need-by; the slip prints `PO: …`, found by join; the drawer shows the PO number; receive offers *Also close the line* | being written |
| `/activity` → Purchasing | Sent and received rows, a delivery folded to one row, archived POs out — the access half is built in `dashboardAccess` | being written |
| Copy | *Customer PO* on the jobs list, the accept modal and the operator traveler; the reorder-point help becomes *"Puts this part on To buy when stock plus orders reach it."* | being written |

Telemetry: the `vendor po …`, `vendor rfq …`, `part vendor …`, `part cost sourced`, `buy list loaded`,
`purchasing settings saved` and `quickbooks purchase item chosen` rows of the
[registry](../telemetry.md#the-registry), each with its stated reason. Deliberately not counted, with
the reasons there: RFQ edit, close, reopen, archive and decline, and the preferred star.

---

## Acceptance criteria

**Tests are cited as file + section or `describe`, with a count** — `def test_` functions (a
parametrized test counts once) or `it`s, taken 2026-11-12. Python files are organised by `# ── <criterion>`
section comments, which stand in for a `describe`.

The rows below cite each file by the short name it is linked under here, so a renamed file fails the
docs check.

| Layer | Files |
|---|---|
| Database — pytest against a real local stack, psycopg2 helpers in [`purchasing_support`](../../api/tests/integration/purchasing_support.py) | [`test_purchasing_numbering`](../../api/tests/integration/test_purchasing_numbering.py) · [`test_vendor_purchase_orders`](../../api/tests/integration/test_vendor_purchase_orders.py) · [`test_vendor_purchase_order_receiving`](../../api/tests/integration/test_vendor_purchase_order_receiving.py) · [`test_vendor_purchase_order_outside_service`](../../api/tests/integration/test_vendor_purchase_order_outside_service.py) · [`test_purchasing_on_order`](../../api/tests/integration/test_purchasing_on_order.py) · [`test_part_vendors_and_price_sheets`](../../api/tests/integration/test_part_vendors_and_price_sheets.py) · [`test_purchasing_sourcing`](../../api/tests/integration/test_purchasing_sourcing.py) · [`test_vendor_rfqs`](../../api/tests/integration/test_vendor_rfqs.py) · [`test_purchasing_access_and_guards`](../../api/tests/integration/test_purchasing_access_and_guards.py) · [`test_purchasing_seed`](../../api/tests/integration/test_purchasing_seed.py) · [`test_quickbooks_purchasing_tables`](../../api/tests/integration/test_quickbooks_purchasing_tables.py) |
| QuickBooks routes — integration, the provider boundary monkeypatched | [`test_quickbooks_vendor_po_routes`](../../api/tests/integration/test_quickbooks_vendor_po_routes.py) · [`test_quickbooks_purchasing_setup`](../../api/tests/integration/test_quickbooks_purchasing_setup.py) |
| QuickBooks builders and services — unit | [`test_vendor_po_payload`](../../api/tests/unit/test_vendor_po_payload.py) · [`test_vendor_po_projection`](../../api/tests/unit/test_vendor_po_projection.py) · [`test_vendor_po_errors`](../../api/tests/unit/test_vendor_po_errors.py) · [`test_vendor_po_probe`](../../api/tests/unit/test_vendor_po_probe.py) · [`test_quickbooks_purchasing_service`](../../api/tests/unit/test_quickbooks_purchasing_service.py) |
| Existing suites, extended | [`test_demo_lifecycle`](../../api/tests/integration/test_demo_lifecycle.py) · [`test_ai_read_access`](../../api/tests/integration/test_ai_read_access.py) · [`test_accounting_provider`](../../api/tests/unit/test_accounting_provider.py) |
| Pure rules — Vitest | [`amount`](../../__tests__/lib/purchasing/amount.test.ts) · [`buyList`](../../__tests__/lib/purchasing/buyList.test.ts) · [`late`](../../__tests__/lib/purchasing/late.test.ts) · [`numbering`](../../__tests__/lib/purchasing/numbering.test.ts) · [`poReceipt`](../../__tests__/lib/purchasing/poReceipt.test.ts) · [`priceDefault`](../../__tests__/lib/purchasing/priceDefault.test.ts) · [`purchaseUnits`](../../__tests__/lib/purchasing/purchaseUnits.test.ts) · [`rfqCompare`](../../__tests__/lib/purchasing/rfqCompare.test.ts) · [`sourcing`](../../__tests__/lib/purchasing/sourcing.test.ts) · [`vendorPoStatus`](../../__tests__/lib/purchasing/vendorPoStatus.test.ts) · [`vendorPoVisibleFields`](../../__tests__/lib/purchasing/vendorPoVisibleFields.test.ts) · [`money`](../../__tests__/lib/money.test.ts) |
| Access layer — Vitest | [`vendorPoAccess`](../../__tests__/utils/vendorPoAccess.test.ts) · [`partVendorsAccess`](../../__tests__/utils/partVendorsAccess.test.ts) · [`vendorRfqAccess`](../../__tests__/utils/vendorRfqAccess.test.ts) · [`buyListAccess`](../../__tests__/utils/buyListAccess.test.ts) · [`purchasingSettingsAccess`](../../__tests__/utils/purchasingSettingsAccess.test.ts); extended [`materialCheckAccess`](../../__tests__/utils/materialCheckAccess.test.ts) · [`outsideShipmentsAccess`](../../__tests__/utils/outsideShipmentsAccess.test.ts) · [`dashboardAccess`](../../__tests__/utils/dashboardAccess.test.ts) |
| Screens — Vitest | [`SendVendorPoToQuickBooksDialog`](../../__tests__/components/purchasing/SendVendorPoToQuickBooksDialog.test.tsx) · [`QuickBooksPurchasingPanel`](../../__tests__/components/settings/quickbooks/QuickBooksPurchasingPanel.test.tsx) · [`PaymentTermsPicker`](../../__tests__/components/common/PaymentTermsPicker.test.tsx) (its lazy mode) · [`RfqList`](../../__tests__/components/purchasing/RfqList.test.tsx) · [`RfqForm`](../../__tests__/components/purchasing/RfqForm.test.tsx) · [`RfqDetail`](../../__tests__/components/purchasing/RfqDetail.test.tsx) · [`RfqVendorsCard`](../../__tests__/components/purchasing/RfqVendorsCard.test.tsx) · [`RfqResponseEditor`](../../__tests__/components/purchasing/RfqResponseEditor.test.tsx) · [`RfqCompareMatrix`](../../__tests__/components/purchasing/RfqCompareMatrix.test.tsx) · [`RfqPreviewDialog`](../../__tests__/components/purchasing/RfqPreviewDialog.test.tsx) · [`rfqPdf`](../../__tests__/utils/rfqPdf.test.ts) · [`BuyingTab`](../../__tests__/components/parts/workspace/tabs/BuyingTab.test.tsx) · [`UseAsPartCostDialog`](../../__tests__/components/parts/UseAsPartCostDialog.test.tsx) · [`PartWorkspaceExitGuard`](../../__tests__/components/parts/workspace/PartWorkspaceExitGuard.test.tsx) |

| ID | Criterion | Tests |
|---|---|---|
| **N1** | A PO and an RFQ series per company, PO-0001 / RFQ-0001 by default | `test_purchasing_numbering` § N1 (1); `numbering` › `defaults (N1)` (2) |
| **N2** | Prefix, next number and digits settable by any office user; character set, 6-character prefix, 11-character total and "above the highest issued" validated; live preview | `test_purchasing_numbering` § N2 (7); `numbering` › `formatPurchasingDocumentNumber (N2)`, `the prefix character set (N2)`, `previewPurchasingDocumentNumber — the live preview (N2)`, `validatePurchasingNumbering — refused before the database refuses it (N2)` (16); `purchasingSettingsAccess` (7). Settings dialog, E2E: being written |
| **N3** | Concurrency-safe; never reissued, archived included; a rollback consumes nothing | `test_purchasing_numbering` § N3 (5) |
| **P1** | Company from the vendor; archived vendor refused; parties, ship-to and T&Cs frozen | `test_vendor_purchase_orders` § P1 (8) |
| **P2** | Line-kind rules in the RPC and the CHECKs; Do not use refused; archived references refused | `test_vendor_purchase_orders` § P2 / L4 (6) |
| **P3** | Revision: never on a draft; snapshot at mark-sent; once per send cycle; never for notes, promises or closing; one shared field list | `test_vendor_purchase_orders` § P3 (10); `vendorPoVisibleFields` (19) |
| **P4** | Edit guards, the vendor lock, read-only closed/archived POs, the staleness check only on vendor-visible fields | `test_vendor_purchase_orders` § P4 (9); `vendorPoAccess` › `updateVendorPo`, `the auto-saved internal fields never take the vendor-visible path` (6) |
| **P5** | Mark-sent needs a line; close/reopen per line and whole; archive never blocked, unlinks slips; archived by id read-only | `test_vendor_purchase_orders` § P5 (5); `vendorPoAccess` › `state changes` (3). Banner: being written |
| **P6** | The status and line-state matrix, over-receipt, voids, no-receipt lines | `test_vendor_purchase_orders` § P6 (14); `vendorPoStatus` › `PO statuses (P6)`, `overdue is a flag beside the status, not a status (P6)`, `line states (P6)` (15) |
| **P7** | Late and amount: one rule in SQL, TypeScript and Python, each on its fixture | `test_vendor_purchase_orders` § P7 (6); `late` (8); `amount` (12); `money` (21); `test_vendor_po_payload` § the shared amount fixture (P7) (2) |
| **P8** | List, form, detail, preview and PDF as in [Screens](#screens) | `dashboardAccess` › `purchasing activity` (6); the rest being written |
| **P9** | Duplicate: new number; drops job links, dates and outside lines, and says so | `vendorPoAccess` › `duplicateVendorPo` (2); page being written |
| **P10** | Create, edit, receive, close, reopen, archive, duplicate persist after a reload | E2E being written |
| **L1** | A purchase unit is the stock unit or one conversion; presets become rows and aliases normalise first; the factor frozen; one factor per unit name | `test_vendor_purchase_orders` § L1 (5); `test_part_vendors_and_price_sheets` § V2 / L1 (8); `purchaseUnits` (49); `vendorPoAccess` › `createVendorPo` (9) |
| **L2** | The price default's precedence and caption; expired sheet named, not used; `price_source` stored; NULL is TBC | `priceDefault` › its four `defaultPartLinePrice — …` describes and `defaultOutsideLinePrice (L2)` (29); `test_vendor_purchase_orders` § L2 (3); `test_purchasing_on_order` (Last PO price; 1 of 6); `vendorPoAccess` › `price defaults` (2) |
| **L3** | `hundred` and `thousand`; per-100 end to end — PO, receipt, stock | `test_vendor_purchase_order_receiving` § R1 / L3 (3); `test_purchasing_on_order` (the `hundred` line; 1 of 6); `purchaseUnits` › `resolvePurchaseUnit (L1, L3)` (13) |
| **L4** | Approved-vendor warnings: quiet / amber / blocked | `priceDefault` › `partVendorLineNotice — approved-vendor warnings on a PO line (L4)` (4); the block in `test_vendor_purchase_orders` § P2 / L4; `BuyingTab` › `BuyingTab — the approved vendor list (V1, V2, L4)` (9, shared with V1–V2). PO-form captions being written |
| **R1** | A receipt moves the balance, the roll-up and the ledger, and links the ledger row; `stock_quantity` exact in either unit | `test_vendor_purchase_order_receiving` § R1 / L3 (3) |
| **R2** | Heats normalised; a new lot stamped once; `started_tracking`; heats first; a container refused | `test_vendor_purchase_order_receiving` § R2 (4); `poReceipt` › `the heat caption (R2, R6)` (1) |
| **R3** | Atomic; a replay writes nothing; splits; over-receipt flagged; `close_remaining`; outside refused, other quantity-only | `test_vendor_purchase_order_receiving` § R3 (9); `poReceipt` › both `planVendorPoReceipt — …` describes (17); `vendorPoAccess` › `receiveVendorPo` (5) |
| **R4** | A void reverses through the stock engine; refused when the stock is gone; idempotent; tracking stays on | `test_vendor_purchase_order_receiving` § R4 (4); `vendorPoAccess` › `voidVendorPoReceipt and relinkOutsideShipment` (2) |
| **R5** | Both stock RPCs keep one overload and their grants; every existing caller unchanged | `test_vendor_purchase_order_receiving` § R5 (2) |
| **R6** | The receive dialog's prefill, defaults, cert-after-write, draft confirmation and no-PO notice; the Receipts tab | `poReceipt` › `prefillVendorPoReceiptRows — …`, `defaultReceiptLocationId — …` (6); `vendorPoAccess` › `listVendorPoReceipts`, `getRecentNoPoReceipts` (2). Dialog and tab being written |
| — | Founder default: a receipt on a job-linked part line leaves the job's statuses alone | `test_vendor_purchase_order_receiving` § Founder default (1) |
| **O1** | Auto-link at send and at line insert; relink; a mismatch unstorable; one open outside line per (operation, vendor), reopen included | `test_vendor_purchase_order_outside_service` § O1 (8) |
| **O2** | The line's figures from its slips; slip and line close independently; a slip void lowers received | `test_vendor_purchase_order_outside_service` § O2 (4). *Also close the line*: being written |
| **O3** | Linking changes no status; the cascade still reaches the job; operators still send and receive, and the slip links | `test_vendor_purchase_order_outside_service` § O3 (4) |
| **O4** | The send caption, operation-card link, drawer PO number, `PO:` on the slip, due-back prefill, leak prompt | `outsideShipmentsAccess` › `the vendor PO line a slip ships against (purchasing, criterion O4)` (5); the screens being written |
| **B1** | On order in stock units, sent open unarchived part lines only; drafts apart; receipts lower it, voids restore it; unit mismatches counted apart | `test_purchasing_on_order` (6, one of them L2's); `vendorPoAccess` › `getOnOrderForParts` (2) |
| **B2** | The buy-list rule on its fixture | `buyList` › `the buy-list rule — golden cases (B2)`, `ported from 87df208 (B2)`, `job needs on a row (B2, B3)`, `suggestPurchaseQuantity (B2)` (10) |
| **B3** | Grouping, Buy from, edits surviving refresh, Create or Add to draft, the RFQ start, the incomparable bucket, captions; never writes | `buyList` › `vendor grouping and "Buy from" (B3)`, `the counts the page reports (B3)` (9); `buyListAccess` (11). Page being written |
| **B4** | The Materials card, the places drawer and MCP agree with `part_on_order` | `materialCheckAccess` › `getJobPartMaterialCheck` (the on-order case among 6); the rest being written |
| **V1** | List uniqueness; archive and revive one row; the preferred-vendor trigger, backfill, cross-company and Do-not-use refusals; archiving the preferred clears it | `test_part_vendors_and_price_sheets` § V1 identity (4) and § V1 preferred (7); `test_demo_lifecycle` (its seeded-preferred-vendors test, 1); `partVendorsAccess` › `listPartVendors`, `savePartVendor`, `archivePartVendor` (8); `BuyingTab` › `BuyingTab — the approved vendor list (V1, V2, L4)` (9), `BuyingTab — archive asks first (V1)` (2), `BuyingTab — purchase orders for this part` (6); `PartWorkspaceExitGuard` › `PartWorkspace — the Buying tab` (4) |
| **V2** | Per-sheet dates; sheets replaced whole; breaks in purchase units | `test_part_vendors_and_price_sheets` § V2 / L1 (8); `BuyingTab` › `BuyingTab — inline editing (V2)` (8) |
| **V3** | Preview writes nothing; apply in place, refused when stale, refused for made parts, inserts at markup 0 only without tiers; nothing else writes tiers | `test_purchasing_sourcing` § V3 (8); `sourcing` › `sourcingPreviewRows (V3)` (4); `partVendorsAccess` › `"Use as part cost"` and the consequence-count describe (8); `UseAsPartCostDialog` › `UseAsPartCostDialog — the preview (V3)` (5), `UseAsPartCostDialog — apply only on confirm (V3)` (3); `BuyingTab` › `BuyingTab — Use as part cost` (1) |
| **V4** | After apply: quote lines unchanged, *Pricing changed* above 0.005; existing job cost frozen; new job parts take the new cost | `test_purchasing_sourcing` § V4 (2); `sourcing` › `sourcingConsequences — in plain words (V3, V4)` (4) |
| **Q1** | Structure, number, invitations with frozen contacts, 1–4 quantities, derived status, the per-vendor PDF | `test_vendor_rfqs` § Q1 (5) and § Q1 / Q2 (6); `vendorRfqAccess` (17); `rfqPdf` › `generateRfqPdf — addressed to ONE vendor (Q1)` (9) and its other three describes (6); `RfqForm` › `RfqForm — a new RFQ (Q1)`, `RfqForm — editing an RFQ` (8); `RfqDetail` (8); `RfqVendorsCard` (8); `RfqPreviewDialog` (7); `RfqList` (6) |
| **Q2** | Responses per line unit with No bid; editable until awarded; a declined vendor refused | `test_vendor_rfqs` § Q1 / Q2 (6); `RfqResponseEditor` › `RfqResponseEditor — the grid (Q2)`, `RfqResponseEditor — what it must keep` (9) |
| **Q3** | The matrix rules; the award atomic, one draft per vendor, ad-hoc lines as other lines, no double award, sheets only when asked | `test_vendor_rfqs` § Q3 (5); `rfqCompare` (21); `RfqCompareMatrix` › `RfqCompareMatrix — reading the quotes (Q3)`, `RfqCompareMatrix — award (Q3)` (11) |
| **QB1** | QuickBooks is called only by Send/Update/Close, Check, Verify and the setup clicks — never on mount, render, poll, trigger, create, send, receive, close or archive | `test_quickbooks_purchasing_setup` § the mount read (QB1) (3); `SendVendorPoToQuickBooksDialog` › `… — nothing reaches QuickBooks before it opens` (2); `QuickBooksPurchasingPanel` › `… — nothing reaches QuickBooks on mount` (3); `PaymentTermsPicker` › `PaymentTermsPicker` (3). PO form, PO and vendor pages, E2E: being written |
| **QB2** | Office role and billing gate before any QuickBooks call; operators and lapsed companies 403; setup writes admin-only | `test_quickbooks_vendor_po_routes` § access (QB2) (4); `test_quickbooks_purchasing_setup` § who may click (QB2) (1) |
| **QB3** | A create sends exactly the mapping; never a bill or item receipt | `test_vendor_po_payload` § QuickBooks Online create (QB3) (7), § QuickBooks Desktop create (QB3) (6), § never billable (QB3) (1), § descriptions (6); `test_vendor_po_projection` § the projection (5), § money and units (3); `test_quickbooks_vendor_po_routes` § create (QB3, QB4) (8); `test_quickbooks_purchasing_service` § never bills or item receipts (QB3) (1) |
| **QB4** | One QuickBooks PO per Jigged PO per file under double-clicks and concurrency; a no-change push makes zero calls; the request-id rules | `test_quickbooks_vendor_po_routes` § create (QB3, QB4); `test_vendor_po_errors` § ambiguous vs rejected (QB4) (6); `test_vendor_po_projection` § the operation (QB4, QB9) (6); `test_quickbooks_purchasing_tables` § QB4 / QB11 (7) |
| **QB5** | A Desktop unknown outcome probed once, adopted or parked with one capture, never auto-retried; verify adopts or releases | `test_quickbooks_vendor_po_routes` § the Desktop unknown outcome (QB5) (6); `test_vendor_po_probe` § the create probe (QB5) (4), § the update probe (QB5) (5); `test_vendor_po_errors` § QuickBooks Desktop (QB5, QB10) (9) |
| **QB6** | The vendor branches and name rules | `test_quickbooks_vendor_po_routes` § vendors (QB6) (6); `test_vendor_po_probe` § vendor search (QB6) (5); `test_vendor_po_projection` § vendor names (QB6) (3); `test_quickbooks_purchasing_service` § vendors (QB6) (8); `test_accounting_provider` (its vendor-name-rules test, 1); `SendVendorPoToQuickBooksDialog` › `… — the vendor` (8) |
| **QB7** | One general item by default, split optional; posting accounts verified; the invoice item refused; the AP account; the preferences check stored and warned | `test_quickbooks_purchasing_setup` § items (QB7) (9) and § the AP account and the preferences check (4); `test_quickbooks_vendor_po_routes` § setup the push needs (QB7) (2); `test_quickbooks_purchasing_service` § accounts (QB7) (4), § items (QB7) (10), § ship method and preferences (5); `QuickBooksPurchasingPanel` › `… — the purchases item` (8), `… — the accounts-payable account` (3), `… — Check QuickBooks` (3), `… — waiting and permissions` (3) |
| **QB8** | Update, close and reopen read once and send the right line ids; foreign or billed lines and a missing PO 409 with nothing written; an unsent revision refused | `test_quickbooks_vendor_po_routes` § update, close, reopen, archive (QB8, QB9) (7); `test_vendor_po_payload` § update, close, reopen (QB8) (8); `test_vendor_po_projection` § push preconditions (7); `SendVendorPoToQuickBooksDialog` › `… — what has to happen first` (5) |
| **QB9** | *Out of date* exact; receipts and internal notes never set it | `test_vendor_purchase_orders` § QB9 (2); `test_vendor_po_projection` § the hash (QB9) (7); `test_quickbooks_purchasing_tables` § QB9 (2) |
| **QB10** | Every error-map row's status, code, sentence and Sentry behaviour | `test_quickbooks_vendor_po_routes` § the error map (QB10) (6); `test_vendor_po_errors` § QuickBooks Online faults (QB10) (8), § every code has a sentence (QB10) (4); `SendVendorPoToQuickBooksDialog` › `… — the send button` (5), `… — the outcome` (6) |
| **QB11** | Disconnect deletes the setup, keeps the vendor map; the QuickBooks tables' RLS, grants, gate and AI exemption | `test_quickbooks_purchasing_tables` § QB11 who reads (2), § QB11 disconnect (2); `test_quickbooks_purchasing_setup` § disconnect (QB11) (1); `test_ai_read_access` (its sensitive-QuickBooks-tables test, 1) |
| **QB12** | Fake mode covers every call; provider parity; pure builders | `test_quickbooks_purchasing_service` § fake mode (QB12) (3); `test_vendor_po_payload` § refusals and purity (3); `test_accounting_provider` (its purchase-order Protocol and deep-link tests, 3) |
| **M1–M4** | The MCP catalogue rules, UI parity, roles, the existing-tool changes | being written |
| **M5** | Only the listed columns as `jigged_ai_readonly`, archived rows invisible, `SELECT *` on every view, exempt tables denied; `SCHEMA_CONTEXT` truthful; `semantics.md` SQL runs | `test_purchasing_access_and_guards` § M5 (9); `test_ai_read_access` (its `SCHEMA_CONTEXT` and `semantics.md` purchasing tests, 2) — **red until those entries land** |
| **S1** | Every writer refuses operators and non-members with the stated codes; browser-callable, anon not; helpers unreachable | `test_purchasing_access_and_guards` the writer-list contract (1), § S1 (7) |
| **S2** | A lapsed company refused by every writer before anything is written | `test_purchasing_access_and_guards` § S2 (1) |
| **S3** | An id from another company or document, anywhere in the arguments, refused, changing nothing | `test_purchasing_access_and_guards` § S3 (2) |
| **S4** | No browser INSERT, UPDATE, DELETE or TRUNCATE on any purchasing table | `test_purchasing_access_and_guards` § S4 (4) |
| **S5** | Every CI guard empty: write gate, definer gate, execute leaks, AI decision, AI soft-delete | `test_purchasing_access_and_guards` § S5 (1) |
| **S6** | Demo reset twice with the whole graph present; one company DELETE removes it; the seed loads; types regenerate clean | `test_purchasing_access_and_guards` § S6 (1); `test_demo_lifecycle` (its twice-reset purchasing test, 1); `test_purchasing_seed` (6); CI's `gen:db-types` diff |
| — | `p_today` required; an unknown jsonb key is XX000 | `test_purchasing_access_and_guards` § §3.3 rule 7 and the jsonb-key rule (2) |
| **D1–D3** | Registry rows for every capture, both directions; this doc and `docLinkCheck`; every machine standards check | CI: `analyticsEventsCheck`, `docLinkCheck`, `interactionStandardsCheck`, `gridSortableColumnsCheck`, `documentPreviewActions`, `schemaEmbedCheck` |

**Manual, by design:** the PDF render checks (a 40-line PO onto page 2, a 60-character legal vendor
name, a vendor with no address, 1,500 characters of terms, Rev 3 + CLOSED, TBC lines, with and
without a logo) and M-1 / M-2 above. A mocked jsPDF cannot see overflow — the lesson of
[outside-processing.md](outside-processing.md#the-document).

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
