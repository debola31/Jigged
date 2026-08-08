# Quotes Module

**Priority:** Must Have · **Depends on:** Customers, Parts (quotes price against a part's tiers) ·
**Tables:** `quotes`, `quote_line_items`, `quote_operations`, `quote_materials`

> **Condensed 2026-08-03: 9,341 → ~4,460 words (−52%), for [#634](https://github.com/debola31/Jigged/issues/634).**
> What went: two sections describing one inline-create feature, an ASCII modal mockup, a
> Search/Filter section restating the list's own feature bullets, a Validation Rules section
> restating the form's own guards, an API Architecture section restating CLAUDE.md, and User
> Stories restating the overview. What stayed: every measured number, every **withdrawn
> argument** one line each, every citation, every named gap.
>
> **Corrected against the code:** the `/quotes/{id}/edit` route does not exist, and the
> radio-per-quantity convert mechanic was replaced by quick-pick chips — the doc described the
> replacement 20 lines above the superseded version and kept both. `fob_point` was missing from
> the field list entirely.

---

## Overview

Quotes are the entry point for work into the shop: what a customer wants, at what price, and
when. A quote converts directly into one or more jobs — **there is no approval step.** The
pending-approval / approved / rejected states were removed in April 2026: for a small shop the
salesperson and the approver are the same person, so the state machine added friction without
value.

**The quote is the customer-facing document; the part owns the pricing math.** A quote
snapshots one or more **quantities per part** into `quote_line_items`, including the tier-break
table that produced each price (the **pricing basis**). The salesperson types whatever
quantities they want to present — they need not match the part's breakpoints (quote 5/15/25
against tiers of 1/10/20). Each price resolves by **snapping to the highest tier whose
breakpoint is ≤ the quantity** ([`resolveTier`](../../utils/quotePricingResolver.ts)); there is
**no interpolation**.

> **A tier's listed price holds for its whole band, and the quote never recomputes it.** Quoting
> 180 of a part whose tier-80 break lists $33.40 quotes $33.40 — the same number
> [`PartPricing`](../../components/parts/PartPricing.tsx) shows. This is load-bearing rather than
> incidental: base cost is a *function of quantity* (setup amortizes over whatever quantity
> `compute_part_cost_at_qty` is handed), so pricing as `base(order qty) × the tier's markup`
> yields a different number at every quantity and quotes the shop's chosen price only at the exact
> break. That shipped between 2026-07-13 and 2026-08-07 and read as a bug the first time a
> salesperson compared a quote line against the part page. **The part page decides a price; the
> quote reads it.** Reaching for `resolveMarkupAtQty` + `unitPriceFromBase` on a quote path
> reintroduces it — those two are the *costing* pair that builds a tier's listed price, not the
> quote-time price path.

**Firm vs price-options is implicit — decided by quantity count, with no mode toggle:**

| Shape | Detail view + PDF |
|---|---|
| Every part has exactly **one** quantity → **firm order** | Line-item table **with a grand total** |
| Any part has **two or more** → **price-options menu** | One quantity-break table per part, **no grand total** — the customer hasn't picked yet |

They pick at conversion; one job is created per (part, selected quantity).

## Status workflow

Two statuses only: **Active** (open — editable, attachable, convertible) and **Expired** (past
`expiration_date` — read-only, still convertible with a warning, since the price is no longer
guaranteed). Expiry is a lazy sweep (`sweepExpiredQuotes`), fire-and-forget on list/detail load
and idempotent.

**Conversion is multi-pass — one job per customer PO.** A customer typically accepts by issuing
several POs over time, so a quote converts in passes: each creates **one job** carrying **one
PO** over a chosen subset of still-unconverted lines. Each `job_part` records
`source_quote_line_item_id`, and a line converts **once** (a line already on a live job is
skipped).

**Every job off a quote keeps the quote's index** — the first is the mirror `Q-NNNN → J-NNNN`,
each later PO gets a suffix (`J-NNNN-2`, `J-NNNN-3`, …) via `nextQuoteJobNumber`, so all a
quote's jobs stay grouped under one number.

`converted_at` marks the **first** conversion and from then on locks the quote from edits; it is
not re-stamped, so it reads *"acceptance began at"*. "Fully converted" is **derived from job
linkage, not from that flag** — `getQuoteConversionState(quoteId)` is the source of truth for
which lines are converted and by which job/PO. A line counts as converted when it has a
**non-cancelled** `job_part`, matching the `job_parts_one_active_per_quote_line` index: so
**cancelling a job frees its line for re-conversion; archiving does not.**

**Post-conversion quantities:** the quote's lines are frozen once converted, but the job's
`job_parts.quantity` is **editable** — customers change quantity after the fact, and the job is
the post-conversion source of truth. The read-only quote reflects the live job quantity inline
("now N on job", keeping the originally quoted figure) so divergence is visible without making
the quote writable. See [jobs.md](jobs.md).

---

## Data model

### `quotes` (header)

A thin header — per-part, per-quantity pricing lives on the line items.

| Field | Notes |
|---|---|
| `id`, `company_id`, `created_by`, `created_at`, `updated_at` | Standard |
| `quote_number` | Auto `Q-0001` |
| `legacy_quote_number` | Original number from a migrated system |
| `customer_id` | Required |
| `lead_time_text` | Free text as stated ("2–3 weeks", "In stock"). **Quote-level default**; a line item can override per part. Does **not** drive the job due date |
| `payment_terms` | Required. A single free-text string, no enum |
| `fob_point` | Free text naming a place ("FOB Cleveland, OH"), never an origin/destination enum |
| `expiration_date` | Defaults to `created_at + 10 days` |
| `status`, `status_changed_at` | `active` \| `expired` |
| `converted_at` | First conversion only |

**Terms prefill from the customer's standing commercial contract** — `default_payment_terms`,
`default_lead_time_text`, `default_fob_point` ride along on the detail select so the page can
compare what was used against what the customer normally gets. [customers.md](customers.md) owns
that mapping, including why FOB (where title and risk transfer) and `freight_terms` (who pays)
are deliberately never the same control.

**Removed April 2026, replaced by line items:** `part_id`, `quantity`, `base_cost`,
`markup_percent`, `estimated_labor_cost`, `estimated_material_cost`, `unit_price`,
`total_price`, `converted_to_job_id`. `description` went earlier — the part carries descriptive
detail.

### `quote_line_items`

One row per **(part, quantity)**, created by resolving each quantity against the part's
`part_pricing_tiers` and freezing the tier table that produced it. A part quoted at several
quantities has several rows sharing a `part_id` — **there is no unique-part constraint**; the
only uniqueness rule is `(quote_id, sequence)`.

| Field | Notes |
|---|---|
| `quote_id`, `company_id`, `part_id`, `sequence` | `sequence` (10, 20, 30 …) drives detail/PDF order |
| `quantity` | > 0, and **fractional** — parts sold by the dozen, ounce, pound or length |
| `unit_price` | Snapshotted. **Frozen by default** — never silently repriced when the source tier moves |
| `total_price`, `markup_percent`, `base_cost_per_unit` | Snapshots; base cost supports internal cost-vs-sell reporting |
| `source_tier_id` | Soft reference; set null if the tier is later deleted |
| `pricing_basis_snapshot` | jsonb — the frozen tier curve. This is what drift compares against |
| `basis_unknown` | `true` on rows predating the snapshot migration |
| `is_quote_override` | `true` when the salesperson typed a one-off price; drives the green "✏ adjusted for this quote" chip |
| `lead_time_text` | Optional **per-part** override; NULL ⇒ use the quote-level value |

### Cost snapshots and the reverse link

`quote_operations` / `quote_materials` snapshot the part's routing at quote creation, written
once per **distinct part** by `writeCostSnapshotsForPart` and captured **at the lowest quoted
quantity** (a price-options quote has no single "the" quantity). Immutable — later routing edits
don't touch them.

Jobs point back via `jobs.source_quote_line_item_id`; follow `quote_line_items.id →` it to list
every job from a quote.

---

## Screens

### List — `/dashboard/{companyId}/quotes`

Quote #, Customer, Status, Created By, Expires, Created, **Jobs** (links to every job spawned
from the quote). Search matches quote number, customer name, and any line item's part
name/description, **client-side** over already-loaded rows — the list query joins `customers`
and `line_items.parts`, so it needs no round-trip. Status and Customer dropdown filters,
25/page, click a row to open.

**No Total column, deliberately:** many quotes are price-options with no single grand total, so
a per-row total misleads. Totals live on the detail page and PDF, for firm quotes.

### Create / edit — `/dashboard/{companyId}/quotes/new`

**There is no `/edit` route.** Editing an existing quote is an in-place `editMode` branch on the
detail page (`quotes/[quoteId]/page.tsx`), gated on the quote being active and unconverted.
*(This doc described an `/quotes/{id}/edit` route that never existed.)*

**Parts card** — one block per part, plus **+ Add part**. Each block: a part picker (with **+ New
Part** inline create), an editable **list of quantity rows** (one per quoted quantity, **Add
quantity** appends, every row past the first can be deleted), each row showing its resolved price
stacked over a `From tier {n}` caption, plus Total (firm) or Extended (options). A row below the
lowest tier shows a "below minimum break" hint and snaps to the lowest tier price.

> **A new quote deliberately starts with NO part block.** Seeding one looks like a free click
> saved and isn't — **+ Add part** autofocuses the picker it creates, so a pre-seeded block still
> costs the same click to open the selector. What the button buys is teaching that a quote can hold
> **several** parts, which a form that opens mid-way through its first one never says. Tried and
> reverted 2026-08-08; `QuoteForm.test.tsx` guards it.

> **The tier caption carries no unit, deliberately.** The Qty box beside it already shows one
> wherever a unit is meaningful — `quantityUnitSuffix` returns null for count units, where a bare
> number is the convention ("10 brackets", not "10 ea"). Repeating it was redundant there, and the
> old `?? 'ea'` fallback **invented** one for parts whose Qty box shows none, which is how
> "Tier 1 ea" came to sit beside a unitless quantity.

The quantity row is **top-aligned, not centred**: the price column grows downward (caption, custom
notice, drift chip) and centring re-centred every other cell against that growth, visibly pushing
the Qty box out of line with the Unit price box the moment a price was edited. Trailing cells
re-centre themselves against one input's height instead.
Prices resolve synchronously off the tiers already loaded with the part — no per-quantity round
trip, so typing a quantity updates the row immediately.
The block warns when the part has no priced tiers, linking to the part page.

There is **no separate "Pricing tiers (reference)" section** — the editable quantity rows
replaced it, on the form and on the detail view.

- **Per-quantity price, always editable.** Each quantity row's **Unit price** is a plain text
  field carrying the matched tier's listed price. Typing over it prices that break differently;
  the row then reads `Custom · tier {n} is {auto price}` in `warning.main` with a
  **Reset** beside it, and saves with `is_quote_override = true`. The part's tier is never
  touched, and markup % is not a quote-form input.

  The field is **subordinate to Qty but never hidden** — it rests at `divider` border weight
  against Qty's default, rising to `text.secondary` on hover and `primary.main` on focus. Qty is
  the field you must fill; this one already holds the tier's answer, and the `From tier {n}`
  caption says so. **Do not take the border away entirely** (Notion-style reveal-on-hover): that
  pattern's [documented failure](https://webapphuddle.com/inline-edit-design/) is nobody
  discovering the value is editable — precisely the bug the old toggle had. Quieter, not invisible.

  Three things this shape is deliberate about, all of which the previous
  **✏ Use custom price** toggle got wrong:
  - **No control to discover.** The toggle sat at the foot of the part block, away from the price
    it changed ([NN/g — icon discoverability](https://www.nngroup.com/articles/how-to-test-digital-icons/)).
    An editable field is its own affordance, and this is the shape already shipped in
    [`AcceptPurchaseOrderModal`](../../components/jobs/AcceptPurchaseOrderModal.tsx).
  - **The auto price stays on screen.** The toggle replaced it, so the moment you overrode a
    price you lost the number you were overriding — and the only way back was to re-click the
    toggle. Naming the tier price in the caption is what makes **Reset** meaningful.
  - **Per row, not per part.** Price lives on `quote_line_items` per (part, quantity), so
    50/100/250 can carry three negotiated prices. One price for the whole part flattened exactly
    the quantity curve a price-options quote exists to show.

  A typed price equal to the tier's is **not** an override — it saves as a normal tier-priced
  line, so it stays inside drift detection and repricing.
- **Per-part lead time:** an optional free-text field so one item can read "2–3 weeks" and
  another "3–4 weeks" **without splitting the quote in two**. When *any* item has its own, the
  detail view and PDF move lead time under each item; when none do, one quote-level line shows.
- **Order matters** — part-block order, then row order within a block, drives `sequence`.

**Terms card** — lead time (required free text), expiration (defaults +10 days), and payment
terms as a **pick-only** combobox: the shop's saved custom terms first (each removable via ✕),
then the presets (Due on Receipt · Net 15 · Net 30 · Net 60 · 2/10 Net 30 · 50% Deposit /
Balance Net 30 · Prepay · Cash on Delivery — QuickBooks' built-ins plus the deposit / prepay /
COD / early-pay terms shops use). Presets are **not** removable. Saved terms live in
`companies.settings.custom_payment_terms` (a jsonb key, no migration).

**`＋ Add New` is pinned as the last row, and its input appears *below* the picker, not inside
the menu** — a menu closes on selection, so an in-menu input cannot reliably hold focus.
Presets: `PAYMENT_TERM_PRESETS` ([types/quote.ts](../../types/quote.ts)); read/write via
`getCustomPaymentTerms` / `addCustomPaymentTerm` / `removeCustomPaymentTerm`
([utils/companyAccess.ts](../../utils/companyAccess.ts)).

**Inline creates** keep the salesperson in context: **+ New Customer** (code + name required,
contact optional) and **+ New Part** (name + description only — no category, routing or pricing)
both auto-select what they create. A new part has no tiers, so the block warns until they are
added on the part page. **+ Add new address** on the shipping/billing selectors opens
`CustomerAddressForm` inline in a `Collapse` rather than navigating away.

**Guards:** at least one part block, each with a part; a part may appear in only one block; every
quantity a number > 0 (fractional allowed) and unique within its part; every row must either
resolve to a priced tier or carry a typed unit price ≥ 0 — only the absence of *both* blocks the
save; lead time and payment terms required.

### Detail — `/dashboard/{companyId}/quotes/{id}`

Header carries the quote number, status pill, dates, lead time (shown here **only when items
share one**), and payment terms. Below the line items sits **"Prepared by {name}"**, mirroring
the PDF now that acceptance is by PO rather than signature.

- **"Jobs from this quote" banner** — every live job with its PO, plus a "Some parts aren't on a
  job yet" line when lines remain. Uses the same **part-level** rule as the convert modal, so the
  two can never disagree.
- **Customer card** — Customer (name + billing address) · Ship to (**only** when it differs from
  billing) · Customer contact.
- **Line items** — one table (Part, Description, Order qty, Unit price, Total); a part with
  several quantities shows its name and description once, spanning its rows. Grand total on firm
  quotes only. A custom-price line shows a "custom" chip.

**Actions are one row of labelled buttons, no overflow menu:** contained **Convert to Job**,
outlined **Edit** and **View PDF**, red **Delete**. Labelled rather than a `⋮` icon menu because
of [NN/G on icon ambiguity](https://www.nngroup.com/articles/icon-usability/) — *the citation is
about the icon being ambiguous, not about the device; an earlier revision justified it with
"shop-floor tablet", which quotes are not edited on.*

**Edit** is gated by `converted_at`, but **convert follows the remaining unconverted lines**, not
that flag:

| State | Buttons |
|---|---|
| Nothing converted (active or expired) | **Convert to Job**, Edit, View PDF, Delete |
| Partially converted | **Create Another Job**, View PDF, Delete (Edit hidden) |
| Fully converted | View PDF, Delete |

Expired quotes still show convert; the expired-price warning surfaces in the modal rather than
gating the button. **Email was descoped** — there is no Email action, and no server send.

### Convert to Job modal

Parts already on a job appear read-only at the top and are excluded — this pass offers only the
**remaining** parts, each with a checkbox. **All start checked**, so the common case (one PO for
the whole quote) is a single click.

**Every selected part has an editable Order qty field**, pre-filled with the quoted (or
lowest-break) quantity, so the customer can order any quantity including one *between* the quoted
breaks. The job records the ordered figure; the quote line stays frozen. Pricing follows the
part's kind:

- **Firm part** (one quoted quantity): it has one committed price, so **the agreed price is kept
  by default**. If the ordered quantity crosses a break in the frozen snapshot, a *"Reprice to
  the qty-N tier ($X)"* opt-in appears — the same keep-vs-reprice choice `updateJobPartQuantity`
  offers post-conversion, via the shared `resolveJobPartUnitPrice`, so at-conversion and on-job
  edits behave identically.
- **Price-options part** (several quantities): the quoted breaks render as **one-tap quick-pick
  chips** that fill the field, and the price **always resolves to the tier applying at the
  ordered quantity** — there is no single committed price to keep, which is what a price-options
  quote *is*. Matches CPQ / B2B-commerce practice and the proven quick-picks-plus-free-field cart
  UX.

*(An earlier revision started multi-quantity parts with **no radio selected**, requiring a
deliberate pick. Radios are gone — `ConvertToJobModal` has none.)*

Also captured: a **required Due date** (not-in-the-past, starts **empty** — no prefill, and no
longer derived from lead time), a **required Customer PO #** (the authorization, so no job
without it), and an **optional PO PDF** which uploads to the job after conversion and is
non-fatal if it fails.

Create stays disabled until at least one part is checked, the due date is valid and a PO is
entered; a `MissingFieldsNotice` lists whatever still blocks. **Prerequisite:** every *made* part
being converted needs a routing, or conversion is blocked reporting how many lack one.

> **Invoicing lives on Jobs.** Creating or viewing a QuickBooks invoice is job-keyed and is not
> on the quote page. See [jobs.md](jobs.md) and [invoicing.md](invoicing.md).

---

## Pricing

The math lives on the part's tiers; the quote is a snapshot. On the part (see
[parts.md](parts.md#cost-determination-logic)):

```
total_setup_cost  = Σ (setup_min / 60 × labor_rate)
run_per_unit      = Σ (run_min   / 60 × labor_rate)
material_per_unit = Σ (qty × cost_per_unit)

base_cost_per_unit (at tier qty Q) = run_per_unit + material_per_unit + (total_setup_cost / Q)
unit_price                         = base_cost_per_unit × (1 + markup_percent / 100)
```

**Markup % is the source of truth** on a part tier — typing a unit price back-calculates and
stores the markup. **Bought parts** (no routing) take `base_cost_per_unit` from the part's
procurement tiers via `compute_part_cost_at_qty`, so they resolve a real tier price and no longer
need a manual per-line override.

On the quote, `createQuote` inserts one row per (part, quantity), with `unit_price` from
`resolveTier`, `base_cost_per_unit` from `getComputedPartCost` **at the matched break's quantity**
— not the order quantity, so the row's own `unit_price = base_cost_per_unit × (1 + markup/100)`
still holds — `source_tier_id` as a soft reference, and `pricing_basis_snapshot` as the frozen
tier table. A
quantity below the lowest tier snaps to it and is flagged `below_min` in the UI. A typed custom
price instead sets that row's `unit_price` with `is_quote_override = true`, leaving the tier
untouched.

**Setup amortisation is visible.** Per-tier `base_cost_per_unit` already contains it — a 30-minute
setup at $125/hr ($62.50 one-time) splits to **$62.50/unit at qty 1, $15.625 at qty 4, $6.25 at
qty 10.** This is what the pilot salesperson described in the April 17 usability test: *"anything
I put into setup will amortize over the number of pieces."*

**Setup-only operations are first-class.** Ops with `setup_time > 0` and `run_time_per_unit = 0`
(Engineering, Programming) compute `run_cost = 0` and a non-zero setup cost. They are **not**
dropped — that bug (**#224**) was fixed in April 2026. See
[routings.md](routings.md#cost-calculation-from-routing).

**Worked example** — part "Holder": 30 min run + 30 min setup @ $125/hr + $5 materials, markup 25,
tiers at 1 / 2 / 4:

| qty | base_cost_per_unit | unit_price |
|---|---|---|
| 1 | 130.00 (62.50 + 5 + 62.50) | 162.50 |
| 2 | 98.75 (62.50 + 5 + 31.25) | 123.44 |
| 4 | 83.13 (62.50 + 5 + 15.625) | 103.91 |

Quoting at 1, 2 and 4 snapshots three line items at those prices; later tier edits do not mutate
the quote. Quoting an in-between quantity like 3 snaps to the qty-2 price.

---

## `convertQuoteToJob`

`convertQuoteToJob(quoteId, { dueDate, customerPoNumber, selectedLineItemIds, lineOverrides })`
— callable **many times per quote**, once per customer PO:

1. Refuse only if the quote has no line items. **`converted_at` being set does not block.**
2. Exclude lines already on a live job (`getQuoteConversionState`). Resolve the set:
   `selectedLineItemIds` when given, else all unconverted lines. Reject a selection containing an
   already-converted line, reject when nothing remains, and **reject any set resolving to more
   than one line for a `part_id`** — *"This is a price-options quote. Pick a single quantity per
   part before converting."*
3. Pre-flight: every **made** part needs a routing, else fail before any write. **Bought parts
   are exempt** — purchased, not manufactured.
4. Require a due date, not in the past, written straight to the job. Require a non-empty
   `customer_po_number` — never coerced to NULL.
5. Insert **one** `jobs` row; number via `nextQuoteJobNumber`.
6. Per line, insert a `job_parts` row. Made parts clone the routing via the
   `create_job_part_operations_from_routing` RPC and start `not_started`; **bought parts skip the
   clone and start `completed`** — no operations to run, ready to ship and invoice. `quantity`
   defaults to the line's but honours `lineOverrides[line.id].quantity` (partial acceptance);
   price defaults to the agreed `unit_price`, or re-resolves from `pricing_basis_snapshot` at the
   ordered qty when `useTierPrice` is set.
7. Stamp `converted_at` on the **first** pass only; status unchanged; every line item is kept as
   the record of what was offered.

> **Concurrency.** The step-2 pre-check is a read-then-write and could lose a race on its own.
> The hard guarantee is the partial unique index **`job_parts_one_active_per_quote_line`**
> (`UNIQUE (source_quote_line_item_id) WHERE … AND production_status <> 'cancelled'`), which
> makes the losing insert fail `23505` — turned into the same friendly "already on a job"
> message. **The app check is the fast path; the index is the arbiter.** Its cancelled-scope is
> also what defines "converted", which is why cancelling frees a line and archiving does not.
> Full transactional atomicity of the multi-insert would need a single-transaction RPC; the
> sequential-write behaviour matches every other multi-insert flow and is orthogonal to the
> double-conversion guarantee.

---

## Edit policy — reconcile, frozen pricing, drift

**The authoritative spec for editing an existing quote**, superseding any older "line items are
read-only" language. Implementation tracked in
[#324](https://github.com/debola31/Jigged/issues/324).

A quote is editable while `status = 'active'` **and** `converted_at IS NULL`. On save,
`updateQuote` **reconciles line items by id** — insert new, update edited, delete removed —
mirroring `createQuote`.

**Pricing is frozen by default.** Existing lines keep their snapshotted `unit_price` unless the
user explicitly opts in, and a quantity change recomputes **against the snapshotted basis curve,
not the current tier table**.

**Drift** = the current tier table differs from the line's snapshotted basis. It renders as a
non-blocking chip (snapshotted price beside current price) with a per-line *"Update to current
price"* control and an *"Update all flagged"* bulk control; clicking queues the line, and the
reprice happens **at save time**. A user can save with drifted lines and never touch a control.

**Quantity-curve movement is NOT drift** — it is expected behaviour computed against the
snapshot. **`is_quote_override` lines are never repriced and never flagged**, under any
circumstance.

**Pre-snapshot rows** carry `basis_unknown = true`, render a "basis unknown" chip, and fall back
to comparing resolved `unit_price` against the current tier price — a degraded signal, but
**visibly** degraded.

**Withdrawn — Option A (backfill the basis from current tiers):** it would fabricate a pricing
history that never existed. The Contour data loaded from Tangle has no basis, so it would receive
a false-history snapshot and the system would then report "no drift" on quotes that genuinely
drifted — a violation of
[no silent runtime fallbacks](../../CLAUDE.md#no-silent-runtime-fallbacks-for-data-at-rest-issues).
**Option B** (basis-unknown with no chip) is the silent-degradation variant, rejected for the
same reason.

**Withdrawn — forced keep-or-update ([#325](https://github.com/debola31/Jigged/issues/325), 2026-06-04):**
blocking save on an actively-edited drifted line until the user chose. Dropped because in the
pilot population (Contour, primary quoter Johnny) tier-price changes during an open quote's life
are rare enough that a save-blocking modal is more friction than the signal warrants. Revisit
only if post-pilot data shows drift is more frequent than estimated.

---

## Printing

**View PDF** generates a customer-facing PDF in the browser — no server round-trip. Filename
`Quote-{quote_number}.pdf`.

Contains: company logo and name; the QUOTE heading with number, date, validity, lead time,
payment terms and FOB; **Customer · Ship to (only if different) · Customer contact**; the line
items table ordered by `sequence`, with a grand total **only** on firm quotes; and an acceptance
block instructing the customer to **reply with a purchase order referencing the quote** — there
is **no signature/date/PO ruled line**, because acceptance is by PO. A "Prepared by {name} ·
{email}" line sits below it.

**Deliberately excluded from the customer's view:** routing and operations, run times, labor and
material cost snapshots, markup percentage, base cost.

**Branding:** logo uploaded at Settings → Company Branding, PNG/JPG/WebP up to 2 MB. **SVGs are
accepted for storage but fall back to a text-only header** — use a raster format for a logo that
should appear.

**Immutability:** because line prices are frozen by default, re-printing tomorrow produces the
same PDF. The printed document is a faithful record of the price quoted.

---

## Acceptance Criteria

Convention stated once in [modules/README.md](README.md#the-acceptance-criteria-convention);
`automation-pending` here means [#367](https://github.com/debola31/Jigged/issues/367).

**Create, list, edit**

- [ ] **Given** the list, **when** it loads, **then** it paginates, searches by number / customer / part, filters by status and customer, and shows a Jobs column but **no Total column** — *automation-pending (#367)*.
- [ ] **Given** the quote form, **when** submitting, **then** it blocks until every part block has a part and at least one valid quantity row, quantities unique within a part — *automation-pending (#367)*.
- [ ] **Given** an existing active, unconverted quote, **when** a part is added, a quantity edited and a part removed, **then** all three persist across reload — *verified by `e2e/quote-edit.spec.ts` > `Quote edit — reload contract`*.
- [ ] **Given** `updateQuote`, **when** it saves, **then** it reconciles line items by id — insert / update / delete — *verified by `__tests__/utils/quotesAccess.test.ts` > `updateQuote — reconcile (Issue #324 / #317 policy)`*.
- [ ] **Given** a setup-only operation (run 0, setup > 0), **when** the cost breakdown renders, **then** it appears with `run_cost = 0` and a non-zero setup cost — regression for **#224** — *automation-pending (#367)*.

**Frozen pricing and drift**

- [ ] **Given** a header-only edit, **when** it saves, **then** every line keeps its snapshotted `unit_price` — *verified by `__tests__/utils/quotesAccess.test.ts` > `updateQuote — reconcile (Issue #324 / #317 policy)`; a dedicated header-edit reload E2E is automation-pending (#367)*.
- [ ] **Given** a quantity change, **when** the price recomputes, **then** it resolves against the **snapshotted basis**, not current tiers — *verified by `__tests__/utils/quotePricingResolver.test.ts` > `resolveTierFromSnapshot — quantity change honors snapshotted basis`*.
- [ ] **Given** an `is_quote_override` line, **then** it is never repriced and never appears in the drift set — even if its tier moved, even if its id is passed in `acceptDriftLineItemIds` — *verified by `__tests__/utils/quotesAccess.test.ts` > `updateQuote — reconcile (Issue #324 / #317 policy)` and `detectQuoteLineDrift`, and `__tests__/components/quotes/QuoteForm.test.tsx`*.
- [ ] **Given** current tiers differing from a line's snapshot, **when** the form loads, **then** that line renders a drift chip with a per-line update control and an "Update all flagged" bulk control — *verified by `__tests__/components/quotes/QuoteForm.test.tsx` > `QuoteForm` (6 drift/basis `it`s of 40)*.
- [ ] **Given** a drifted line the user never touches, **when** the quote is saved and reloaded, **then** it keeps its original price — the flag is **non-blocking** — *verified by `e2e/quote-edit.spec.ts` > `Quote edit — reload contract`*.
- [ ] **Given** a pre-snapshot row, **then** `basis_unknown = true`, a "basis unknown" chip renders, and drift falls back to comparing resolved price against the current tier — *verified by `__tests__/components/quotes/QuoteForm.test.tsx` and `__tests__/utils/quotePricingResolver.test.ts` > `isDriftedDegraded — basis_unknown rows`*.
- [ ] **Given** create or add-line, **then** the row stores a structured `pricing_basis_snapshot`, not merely the resolved price — *verified by `__tests__/utils/quotePricingResolver.test.ts` > `buildPricingBasisSnapshot`, and the `pricing_basis_snapshot jsonb` column in `supabase/migrations/`; `createQuote`'s write path automation-pending (#367)*.

**Convert**

- [ ] **Given** the modal, **when** parts are unchecked, **then** only checked parts convert and the rest stay on the quote for a later PO — *verified by `__tests__/components/quotes/ConvertToJobModal.test.tsx` > `per-part selection (multiple jobs/POs per quote)`*.
- [ ] **Given** a firm part, **when** fewer than quoted are ordered, **then** the quantity override passes through and the job records the ordered figure — *verified by `__tests__/components/quotes/ConvertToJobModal.test.tsx` > `partial quantity acceptance`*.
- [ ] **Given** a price-options part, **when** converting, **then** its quoted breaks render as one-tap chips, the qty field accepts any value, and the price resolves at the tier for that quantity (`useTierPrice`) — *verified by `__tests__/components/quotes/ConvertToJobModal.test.tsx` > `price-options part (quick-pick breaks + editable qty)`*.
- [ ] **Given** a missing or empty Customer PO, **then** Create stays disabled and `convertQuoteToJob` rejects — *automation-pending (#367)*.
- [ ] **Given** a set resolving to more than one line for a part, **then** `convertQuoteToJob` rejects it — *automation-pending (#367)*.
- [ ] **Given** two simultaneous conversions of one line, **then** the loser fails `23505` on `job_parts_one_active_per_quote_line` and surfaces the friendly "already on a job" message — *automation-pending (#367)*.
- [ ] **Given** conversion, **then** ONE job is created with a `job_part` per line carrying `source_quote_line_item_id`, `converted_at` is stamped on the first pass only, and the quote keeps every line — *verified by `e2e/quote-to-job.spec.ts` and `e2e/fractional-quote-to-job.spec.ts`*.

**Inline create**

- [ ] **Given** the quote form, **when** + New Customer or + New Part is used, **then** the entity is created, auto-selected, and a part with no tiers keeps the block's "no pricing tiers yet" warning — *automation-pending (#367)*.

---

## Known gaps

- **No E2E covers the convert modal's PO/qty guards** — the write path is unit-tested, the
  browser path is not.
- **Quick-create flows have no automated coverage at all** (both inline creators, the address
  `Collapse`, and the duplicate-code / duplicate-part-name error paths).
- **`createQuote`'s basis-snapshot write is asserted only through the resolver's unit tests** and
  the column's presence in the schema, not end to end.
