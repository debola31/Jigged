# Quotes Module

## Overview

The Quotes module handles the sales quoting process — the entry point for work into the shop. Quotes capture what a customer wants, at what price, and when they need it. A quote can be converted directly into one or more jobs at any time; there is no separate approval step.

**The quote is the customer-facing document; the part owns the pricing math.** A quote references parts and snapshots one or more **quantities** per part into `quote_line_items` at creation, including the tier-break table that produced each price (the **pricing basis**). The salesperson types whichever quantities they want to present — they need not match the part's tier breakpoints (e.g. quote 5, 15, 25 against tiers of 1/10/20). Each quantity's unit price is resolved by snapping to the highest tier whose breakpoint is ≤ the quantity (`resolveTier`, in [utils/quotePricingResolver.ts](../../utils/quotePricingResolver.ts)); there is no interpolation, and the pricing engine is unchanged. On edit, the quote line items are reconciled **by line item id** — new quantities insert, removed quantities delete, edited quantities update — but **pricing is frozen by default**: existing lines keep their snapshotted `unit_price` unless the user explicitly chooses to update it, and quantity changes recompute against the snapshotted basis curve, not against the current tier table. The only condition that gets flagged in the UI is **drift** — when the current tier table differs from the snapshot.

See the [Edit policy AC section](#edit-policy-line-item-reconcile-frozen-pricing-drift) for the full set of bullets and their verification clauses.

A single quote can include:

- **Multiple parts** (the customer asked for both a holder and a clamp), and
- **Multiple quantities per part** (e.g., 5, 15, 25 pieces of the holder, each at its own unit price).

**Firm vs. price-options is implicit — decided by quantity count, with no mode toggle:**

- When **every** part has exactly **one** quantity, the quote is a **firm order** — the detail view and PDF show a line-item table with a **grand total**.
- When **any** part has **two or more** quantities, the quote is a **price-options menu** — the detail view and PDF show one quantity-break table per part and **omit the grand total**; the customer hasn't yet picked which quantity to order. They pick at conversion time, and one job is created per (part, selected quantity).

**Priority:** Must Have (Build Third)

**Dependencies:**

- Customers module (quotes require a customer)

- Parts module — quotes select from each part's pricing tiers (see [Parts — Pricing Tiers](parts.md#part-pricing-tiers-table-part_pricing_tiers))

**Database Tables:** `quotes`, `quote_line_items`, `quote_operations`, `quote_materials`

---

## Quote Status Workflow

```
 ACTIVE ──(date > expiration_date)──▶ EXPIRED
   │                                     │
   └──────────── Convert to Jobs ────────┘
                     │
                     ▼
              (quote stays in its status;
               converted_at set; jobs reference
               line items via source_quote_line_item_id)
```

**Status Definitions:**

- **Active** — the quote is open. Editable (metadata AND line items, via the reconcile policy below), attachable, convertible.
- **Expired** — past `expiration_date`. Read-only, but can still be converted with a warning (the price is no longer guaranteed).

**Conversion is multi-pass (one job per customer PO).** A quote is not a single all-or-nothing conversion. A customer typically accepts a quote by issuing **one or more POs over time**, each PO for some of the quoted parts, so the quote can be converted in **several passes** — each pass creates **one job** carrying **one customer PO** and covering a chosen subset of the still-unconverted line items. Each `job_part` records `source_quote_line_item_id` for the line it came from, and a line can only be converted **once** (a line already on a live job is skipped). The first job off a quote keeps the mirror number (Q-NNNN → J-NNNN); a later PO on the same quote draws a fresh J-N from the shared order counter. For a price-options quote the salesperson picks the accepted quantity per part in the convert dialog (firm quotes convert all their remaining lines as-is).

**Conversion flag:** `converted_at` marks the **first** conversion (and from then on locks the quote from edits); it is not re-stamped on later passes, so it reads "acceptance began at". The quote is **fully converted** when every line is on a live job — a state derived from the job linkage, not from `converted_at`. `getQuoteConversionState(quoteId)` (in `utils/quotesAccess.ts`) is the source of truth for which lines are converted and by which job/PO — a line is converted when it has a **non-cancelled** job_part (matching the `job_parts_one_active_per_quote_line` unique index). Cancelling a job frees its line for re-conversion; archiving a job does not. Loading a converted quote shows every linked job — with its PO — in the "Jobs" banner; the quote itself stays intact as the record of every option that was offered.

**Post-conversion quantities:** the quote's line-item quantities are **frozen** once converted (the quote is read-only), but the *job's* `job_parts.quantity` is **editable** — customers often change quantity after the fact. The job is the post-conversion source of truth. The read-only quote reflects the live job quantity inline ("now N on job", with the originally quoted figure kept) so the divergence is visible without making the quote writable. See [Jobs Module — Editing order quantity](jobs.md).

The pending-approval / approved / rejected states were removed in April 2026. For small shops the salesperson and the approver are the same person; the state machine added friction without adding value.

---

## User Stories

| As a... | I want to... | So that... |
|---|---|---|
| Salesperson | Create a quote for a customer | I can respond to customer inquiries |
| Salesperson | Add multiple parts to a single quote | I can quote a complete request without splitting it across documents |
| Salesperson | Enter the quantities (5, 15, 25 …) I want to present for each part | I can give the customer price breaks at the quantities they're considering, even ones that aren't tier breakpoints |
| Salesperson | Set a lead time and expiration date | The customer knows when and for how long |
| Salesperson | Expand a cost breakdown to see per-op / per-material costs grouped by part | I can explain the price if asked |
| Salesperson | Convert a quote directly to a job (one work cell per part) | Production can begin without a ceremony step |
| Salesperson | Pick which quantity the customer chose at conversion time | The work order reflects exactly what the customer agreed to |
| Owner | View all active quotes | I can see the sales pipeline |
| Owner | Filter quotes by active/expired and customer | I can focus on what's still live |
| Owner | See per-tier override chips when a price was manually locked | I know which prices are negotiated vs computed |

---

## Data Model

### `quotes` (header)

The quote is now a thin header. Per-part, per-tier pricing lives on `quote_line_items`.

| Field | Type | Required | Description |
|---|---|---|---|
| id | UUID | Yes | Primary key |
| company_id | UUID (FK) | Yes | Multi-tenant isolation |
| quote_number | Text | Auto | Auto-generated: Q-0001, Q-0002, … |
| legacy_quote_number | Text | No | Original quote number from legacy system (migrated quotes) |
| customer_id | UUID (FK) | Yes | Link to customer |
| lead_time_text | TEXT | No | Free-text lead time as stated (e.g. "2–3 weeks", "In stock"); does not drive the job due date |
| payment_terms | Text | Yes | Payment terms shown on the quote (preset or custom free text), e.g. `Net 30`, `2/10 Net 30`. Required at the form level — every quote carries payment terms |
| expiration_date | Date | No | When the quoted price stops being honored. Defaults to `created_at + 10 days` |
| status | Text | Yes | `active` or `expired` |
| status_changed_at | Timestamp | No | When `status` last changed |
| converted_at | Timestamp | No | When the quote was converted to one or more jobs |
| created_by | UUID | No | User who created the quote |
| created_at | Timestamp | Yes | Auto-generated |
| updated_at | Timestamp | Yes | Auto-updated on changes |

**Removed in April 2026 (replaced by line items):** `part_id`, `quantity`, `base_cost`, `markup_percent`, `estimated_labor_cost`, `estimated_material_cost`, `unit_price`, `total_price`, `converted_to_job_id`. The `description` free-text field was removed earlier; the part itself carries descriptive detail.

### Snapshotted Line Items (`quote_line_items`)

One row per **(part, quantity)** on a quote. Created at quote creation by resolving each quantity's price against the part's `part_pricing_tiers` (snap to the highest breakpoint ≤ quantity) and freezing the tier-break table that produced it. A part quoted at several quantities (a price-options quote) has several rows sharing a `part_id` — there is **no unique-part constraint**; the only uniqueness rule is `(quote_id, sequence)`. Rows are reconciled on edit per the [Edit policy](#edit-policy-line-item-reconcile-frozen-pricing-drift) (reconcile matches by **line item id**), but each row's `unit_price` is **frozen by default** — never silently repriced when the source tier changes.

| Field | Type | Required | Description |
|---|---|---|---|
| id | UUID | Yes | Primary key |
| quote_id | UUID (FK) | Yes | Parent quote (cascade delete) |
| company_id | UUID (FK) | Yes | Multi-tenant isolation |
| part_id | UUID (FK) | Yes | Snapshot of the part this line item priced |
| source_tier_id | UUID (FK) | No | Soft reference to the originating `part_pricing_tiers` row (set null if the tier is later deleted) |
| sequence | Integer | Yes | Display/print order (10, 20, 30 …) |
| quantity | Numeric | Yes | Quoted order quantity, > 0 (need not match a tier breakpoint). **Fractional** — supports parts sold by the dozen, ounce, pound, or length, so it is not restricted to whole numbers |
| unit_price | Decimal(12,4) | Yes | Snapshotted unit price (matches tier or the user's quote-form override) |
| total_price | Decimal(12,4) | No | `quantity × unit_price` |
| markup_percent | Decimal(5,2) | No | Snapshotted markup at creation time |
| base_cost_per_unit | Decimal(12,4) | No | Snapshotted base cost — useful for internal cost-vs-sell reports |
| is_quote_override | Boolean | Yes | `true` when the salesperson typed a one-off price on the quote form that diverged from the part tier. Drives the green "✏ adjusted for this quote" chip on the cost-breakdown view |
| created_at | Timestamp | Yes | Auto-generated |

**Unique Constraint:** `(quote_id, sequence)`

### Cost Breakdown Snapshots (`quote_operations`, `quote_materials`)

Per-operation and per-material snapshots of the part's routing at quote creation. Multi-part quotes capture one snapshot set per distinct `part_id` on the quote — both tables carry a `part_id` column for that scoping. Snapshots are immutable; later routing edits do not affect them.

`writeCostSnapshotsForPart(quote_id, company_id, part_id)` is called once per distinct part during `createQuote`.

### Reverse link to jobs (`jobs.source_quote_line_item_id`)

Each job knows which line item it came from. To list every job spawned from a quote, follow `quote_line_items.id → jobs.source_quote_line_item_id`. The detail page surfaces this as a "Jobs" banner once `quote.converted_at` is set.

---

## UI Screens

### 1. Quotes List

**Route:** `/dashboard/{companyId}/quotes`

**Features:**

- Table showing: Quote #, Customer, Status, Created By, Expires, Created, **Jobs**

- No Total column — many quotes are price-options (no single grand total), so a per-row total is misleading; the total lives on the quote detail page / PDF for firm quotes

- Jobs column shows links to every job spawned from the quote (one per converted line item)

- Search box (matches quote number, customer name, and part name/description — client-side)

- Filter dropdown: Status (All / Active / Expired)

- Filter dropdown: Customer (All / specific customer)

- "+ New Quote" button

- Click row to view/edit

- Pagination (25 per page)

**Status Pills:**

- Active = Primary

- Expired = Warning

**Empty State:**

"No quotes yet. Create your first quote to get started."

### 2. Quote Create/Edit

**Route:** `/dashboard/{companyId}/quotes/new` or `/dashboard/{companyId}/quotes/{id}/edit`

**Note:** Both header metadata (customer, lead time, expiration) AND line items are editable while the quote is active and unconverted. Line items are reconciled on save with pricing frozen by default — see the [Edit policy](#edit-policy-line-item-reconcile-frozen-pricing-drift).

**Form Sections:**

▸ **Customer** (required)

- Customer dropdown with search and "+ New Customer" inline create

▸ **Parts** (repeating block)

The form has a "Parts" card with one block per part on the quote, plus an "+ Add part" button at the top of the card.

Each block:

- Part picker (autocomplete; "+ New Part" opens the inline creator and auto-selects the new part)
- An editable **list of quantity rows** — one row per quantity being quoted. A new block starts with a single empty row; an **"Add quantity"** button appends more, and every row past the first has a delete button. The salesperson types any quantities they want (5, 15, 25 …); they need not match the part's tier breakpoints.
- Each row shows its resolved price inline — `Tier {n} ea · {unit price} / unit` plus the line `Total` (firm) or `Extended` (options). A row whose quantity is below the lowest tier shows a "below minimum break" hint and snaps to the lowest tier price.
- "Remove part" trash icon to drop the whole block

There is **no separate "Pricing tiers" reference section** — the editable quantity rows replace it. The block still warns ("This part has no pricing tiers yet…") when the part has no priced tiers, linking to the part page.

**Per-part price override (`✏ Use custom price`):** each part block has a **single** "✏ Use custom price" toggle (not one per quantity) that reveals a `Custom unit price` input applying to **every** quantity of that part. Each resulting `quote_line_items` row carries `is_quote_override = true` at that price, and the block shows a green **"adjusted for this quote"** chip; the part's tier is never touched. (Markup % is no longer a quote-form input.)

**Firm vs. price-options is implicit:** if every part has exactly one quantity row, the sticky footer shows a **grand total**; if any part has two or more rows, the footer shows "Price options quote — prices shown per quantity" with no grand total.

**Order matters:** the order of part blocks, then rows within a block, drives the `sequence` field on the resulting `quote_line_items`, which in turn drives detail/PDF row order.

▸ **Terms**

- Lead time — a single **required** free-text field (type anything, e.g. "2–3 weeks", "In stock"). No number field, no unit dropdown; stored verbatim as `lead_time_text` and does not drive the job due date.
- Expiration date (defaults to today + 10 days)
- Payment terms — a combobox of common presets (Net 15, Net 30, 2/10 Net 30, Net 45/60/90, Due on Receipt, COD, 50% Deposit / Balance Net 30) that also accepts custom free text (e.g. "Net 30, 1% late charge"). Required — the form blocks submission until a preset or custom value is entered.

**Actions:**

- Create quote / Save changes → returns to detail page
- Cancel → returns to the previous page

**Validation guards:**

- At least one part block is required; each block must have a part selected.
- A part may appear in only one block (its quantities go in that block's rows).
- Every quantity row must be a number > 0 (fractional allowed, for parts sold by the dozen / weight / length); quantities must be unique within a part.
- Each non-override row must resolve to a priced tier, or use a custom price.
- Lead time is required: any non-empty free text.

**Inline address add:** the shipping / billing address selectors include a "+ Add new address" option that opens the `CustomerAddressForm` **inline** (in a `Collapse` below the selector) rather than navigating to the customer page. On save the new address is added to the customer and auto-selected into the field that opened it (and mirrored to billing when "billing same as shipping" is on).

### 3. Quote Detail View

**Route:** `/dashboard/{companyId}/quotes/{id}`

**Header:**

- Quote number (large)
- Status pill (Active / Expired)
- Created date, expires-in, lead time (the raw text as entered, e.g. "2–3 weeks"), payment terms (always present — **payment terms are required** on every quote). The creator is no longer shown here — a **"Prepared by {name}"** line sits below the line items (mirroring the PDF, now that acceptance is by PO rather than signature).

**Content cards:**

- **Converted-to-Jobs banner** — only when `converted_at` is set. Lists every linked job by number with click-through links.
- **Customer card** — three columns in the order **Customer** (name + billing address) · **Ship to** (only when the shipping address differs from billing) · **Customer contact**. When shipping == billing the card is just two columns (Customer + Contact). Customer name click-throughs to the customer record.
- **Line items** — one table for the whole quote (Part, Description, Order qty, Unit price, Total). A part with several quantities shows its name + description **once**, spanning its quantity rows, with one line per quantity.
  - **Firm quote** (every part has one quantity): a **grand total** row at the bottom.
  - **Price-options quote** (any part has 2+ quantities): **no grand total** (the customer picks a quantity).
  - A custom-price line shows a "custom" chip next to its unit price.
- The old standalone **"Pricing tiers (reference)"** section was removed — the quantity rows are the price-break display now.

**Actions — one row of standalone buttons (no overflow menu):** a contained
**primary "Convert to Job"**, an outlined **Edit**, an outlined **View PDF**, and a
red **Delete** icon button, laid out on a single row. Labelled buttons (rather than
a hidden `⋮` icon menu) read better for the shop-floor tablet / older-user audience
([NN/G](https://www.nngroup.com/articles/icon-usability/) on icon ambiguity).
`Back to Quotes` stays top-left. **Edit** is gated by `converted_at` (locked after the first conversion so already-converted lines can't drift), but the convert action follows the **remaining unconverted lines**, not the binary flag:

| Current State | Buttons shown |
|---|---|
| Active or Expired, nothing converted | **Convert to Job**, Edit, View PDF, Delete |
| Partially converted (some lines still open) | **Create Another Job**, View PDF, Delete (Edit hidden) |
| Fully converted (every line on a job) | View PDF, Delete (convert + Edit hidden) |

The convert button relabels to **Create Another Job** once at least one job exists, and disappears only when every line is on a live job. Expired quotes still show it; the expired-price warning surfaces in
the Convert modal rather than gating the button. **View PDF** is always available;
see [Printing Quotes](#printing-quotes) below. (Email was descoped — there is no
Email action on the detail page.)

### 4. Convert to Job Modal

**Trigger:** "Convert to Job" / "Create Another Job" button on the detail page (active or expired quote, while any line is still unconverted).

**Prerequisite:** Every part being converted must have a routing. If any does not, conversion is blocked, reporting how many parts are missing routings.

**Modal Content:**

Parts already on a job are shown read-only at the top ("Already on a job: Part — Job J-0002 (PO 5567)") and excluded from selection — this pass only offers the **remaining** parts. Each remaining part has a **checkbox** deciding whether it goes on *this* job/PO. **All boxes start checked** — so the common case (one PO for the whole quote) is a single click — but the user can uncheck parts to leave them on the quote for a later job under a different PO.

**Quantity — one editable field for every part.** Every selected part shows an **editable Order qty field** (pre-filled with the quoted / lowest-break quantity), so the customer can order any quantity — including one *between* the quoted breaks (partial acceptance: quote 15, order 5). The job records the ordered figure; the quote line stays frozen. Pricing follows the part's kind:

- **Firm part (single quoted quantity):** it has one committed price, so the agreed unit price is **kept by default** (frozen-pricing philosophy). If the ordered quantity crosses a break in the line's frozen tier snapshot, a **"Reprice to the qty-N tier ($X)"** opt-in appears — the same keep-vs-reprice choice `updateJobPartQuantity` offers post-conversion (shared `resolveJobPartUnitPrice`), so at-conversion and on-job edits behave identically.
- **Price-options part (several quoted quantities):** the quoted breaks render as **one-tap quick-pick chips** (`7 ea · $127.12` / `80 ea · $119.79`) that fill the qty field; the editable field also accepts any in-between quantity, and the price **always resolves to the tier that applies at the ordered quantity** (there's no single committed price to keep — that's what a price-options quote *is*). This matches CPQ / B2B-commerce practice (order any quantity, price follows the break table) and the proven cart-quantity UX of quick-picks + a free field.

```
☑ Holder                              ← price-options: quoted breaks are quick-picks
    [7 ea · $127.12] [80 ea · $119.79]   (tap to fill) 
    Order qty [ 50 ]  ea @ $127.12 = $6,356.00   (any qty; priced at the tier)

☑ Clamp                               ← firm: editable qty, price kept from quote
    Order qty [ 5 ]   ea @ $9.00 = $45.00   (quoted 100 — price kept)

☐ Bracket                             (unchecked — stays on the quote for the next PO)
    Order qty [ 40 ]  ea @ $3.00 = $120.00
```

The header shows "Parts on this job: {checked} of {remaining}". This is the user journey for **multiple jobs per quote**: check the parts covered by the first PO, adjust each ordered quantity → set that PO# + due date → **Create** the job; the quote then shows **Create Another Job**, and reopening the modal offers whatever is still unchecked/unconverted for the next PO.

Multi-quantity parts start with **no** radio selected; the user must pick deliberately. A **required Due date** — a not-in-the-past date picker that starts **empty** (no prefill; the user types the job's due date, which is no longer derived from lead time) — and a **required Customer PO #** are captured here — the PO is the work-order authorization, so a job cannot be created without it. An **optional PO PDF** can also be attached; it uploads to the new job after conversion (see [Jobs](jobs.md) → Attachments) and is non-fatal if the upload fails.

**Actions:**

- Create Job → calls `convertQuoteToJob(quoteId, { dueDate, customerPoNumber, selectedLineItemIds })`, where `selectedLineItemIds` is the one chosen line per remaining part. Conversion creates **one job** (with this pass's PO) with one `job_part` per selected line, clones each part's routing via the `create_job_part_operations_from_routing` RPC, sets `quote.converted_at` on the first pass, and redirects to the new job. Any lines left unconverted stay available for a later pass under a different PO. The quote stays intact as the record of all options offered.
- Cancel → closes the modal without changes.

The Create button stays disabled until **at least one part is checked**, every *checked* multi-quantity part has a quantity selected, the due date is valid, **and a Customer PO is entered**. A `MissingFieldsNotice` above the button lists whatever is still blocking conversion. `convertQuoteToJob` also hard-rejects any set that resolves to more than one line for a part ("This is a price-options quote. Pick a single quantity per part before converting."), so a malformed job can never be created via the API.

> **Invoicing moved to Jobs.** Creating / viewing a QuickBooks invoice is no longer on the quote page — invoicing is **job-keyed** and lives on the job detail page. The quote shows only the "Converted to J-NNNN →" link. See [Jobs](jobs.md) and [Architecture](../architecture.md).

---

## Quick Create: Inline Customer & Part Creation

To streamline the quoting workflow, users can create new customers and parts directly from the quote form without navigating away. This keeps the user in context and enables rapid quote creation for new business.

### User Stories

| As a... | I want to... | So that... |
|---|---|---|
| Salesperson | Create a new customer while creating a quote | I don't lose my quote context when a new customer calls |
| Salesperson | Create a new part while creating a quote | I can quote new work immediately without switching screens |
| Salesperson | See the newly created customer/part auto-selected | I can continue creating the quote seamlessly |

### UI Implementation

### Customer Quick Create

**Trigger:** "+ New Customer" button next to customer dropdown

**Modal: Quick Create Customer**

```javascript
┌─────────────────────────────────────────────┐
│  Quick Create Customer                   ✕  │
├─────────────────────────────────────────────┤
│                                             │
│  Customer Code *    [____________]          │
│  Customer Name *    [____________]          │
│                                             │
│  ─────── Optional ───────                   │
│  Contact Name       [____________]          │
│  Contact Email      [____________]          │
│  Contact Phone      [____________]          │
│                                             │
│           [Cancel]  [Create Customer]       │
└─────────────────────────────────────────────┘
```

**Behavior:**

1. User clicks "+ New Customer" button

2. Modal opens with minimal required fields (code, name)

3. Optional fields collapsed or shown below divider

4. On success:
  - Modal closes

  - New customer auto-selected in dropdown

  - Toast: "Customer created successfully"

1. On error: Show inline validation errors

**Required Fields:**

- Customer Code (unique within company)

- Customer Name

**Optional Fields (for quick entry):**

- Contact Name

- Contact Email

- Contact Phone

> **Note:** Full customer details (address, website, etc.) can be added later by editing the customer record.

### Part Quick Create

**Trigger:** "+ New Part" button next to a part picker inside a part block.

**Modal:** asks for **Part Name** (required, unique within the company) and optional **Description**. That's it — no category, no routing, no pricing in this modal. After save, the new part is auto-selected in the part block. The user must then open the part detail page to add a routing and pricing tiers (or use "Copy pricing from another part" on the part detail page) before the part is quotable. The quote form will warn ("This part has no pricing tiers yet…") until they do.

### Edge Cases

| Scenario | Behavior |
|---|---|
| Quick create customer with duplicate code | Show error: "Customer code already exists" |
| Quick create part with duplicate part name | Show error: "Part number already exists in this company" |
| Modal closed without saving | Form state preserved, no changes made |
| Network error during creation | Show error, keep modal open for retry |

### Acceptance Criteria (Quick Create)

- [ ] "+ New Customer" button visible next to customer dropdown — *(automation-pending)*
- [ ] Quick Create Customer modal opens with required fields — *(automation-pending)*
- [ ] New customer auto-selected after creation — *(automation-pending)*
- [ ] "+ New Part" button visible inside a part block — *(automation-pending)*
- [ ] Quick Create Part modal asks for name + description only — *(automation-pending)*
- [ ] New part auto-selected in the part block after creation — *(automation-pending)*
- [ ] Block warns "no pricing tiers yet" until the user adds tiers on the part detail page — *(automation-pending)*
- [ ] Validation errors display inline in modals — *(automation-pending)*
- [ ] Success toast shown after creation — *(automation-pending)*

---

## Pricing Logic

The math lives on the part's pricing tiers, not on the quote. The quote is a snapshot.

**On the part (see [Parts — Cost Determination](parts.md#cost-determination-logic)):**

```
total_setup_cost = Σ over routing nodes of (setup_min / 60 × labor_rate)
run_per_unit     = Σ over routing nodes of (run_min  / 60 × labor_rate)
material_per_unit = Σ over routing materials of (qty × cost_per_unit)

base_cost_per_unit (at tier qty Q) = run_per_unit + material_per_unit + (total_setup_cost / Q)
unit_price                         = base_cost_per_unit × (1 + markup_percent / 100)
```

Markup % is the source of truth on a part tier. Typing a unit price in the part Pricing card back-calculates and stores the markup; routing changes still propagate to every tier's unit price. For **bought parts** (no routing) the `base_cost_per_unit` comes from the part's procurement tiers via `compute_part_cost_at_qty` rather than the routing rollup above — so bought parts resolve a tier price (`cost × (1 + markup/100)`) and no longer require a manual per-line override.

**On the quote (createQuote):**

For each `(part, quantity)` the user entered in the form, insert one `quote_line_items` row. The unit price is resolved by snapping the entered quantity to the part's tiers (highest breakpoint ≤ quantity, via `resolveTier`):

```
resolved                            = resolveTier(part_tiers, quantity)
quote_line_items.quantity           = entered quantity
quote_line_items.unit_price         = resolved.unit_price          (the matched tier's price)
quote_line_items.markup_percent     = matched tier's markup_percent
quote_line_items.base_cost_per_unit = getComputedPartCost(part, quantity)  (historical record)
quote_line_items.total_price        = quantity × unit_price
quote_line_items.source_tier_id     = resolved.source_tier_id      (soft reference)
quote_line_items.pricing_basis_snapshot = frozen tier table at create time
quote_line_items.is_quote_override  = false
```

A quantity below the lowest tier snaps to the lowest tier's price (flagged `below_min` in the UI). If the salesperson typed a one-off price in the row's "✏ Use custom price" editor, that `quote_line_items` row instead carries the typed `unit_price` plus `is_quote_override = true`; the part tier is never modified.

Cost snapshots (`quote_operations`, `quote_materials`) are keyed by `(quote_id, part_id)` and written once per **distinct part** — a part quoted at three quantities still stores one cost snapshot, captured at the lowest quoted quantity (a price-options quote has no single "the" quantity).

### Setup amortization is visible

Per-tier `base_cost_per_unit` already contains the amortized setup. A 30 min engineering setup at $125/hr (= $62.50 one-time) split across:

- **Qty 1:** $62.50 of setup folded into the unit cost
- **Qty 4:** $15.625 per unit
- **Qty 10:** $6.25 per unit

This is exactly what the pilot salesperson described in the April 17 usability test: "anything I put into setup will amortize over the number of pieces."

### Setup-only operations are first-class

Operations with `setup_time > 0` and `run_time_per_unit = 0` (Engineering, Programming, …) compute `run_cost = 0` and a non-zero `setup_cost`. They are **not** dropped from the cost calculation; that bug (#224) was fixed in April 2026. See [Routings — Cost Calculation](routings.md#cost-calculation-from-routing).

### Example (multi-tier on one part)

- Part "Holder", routing total: 30 min run @ $125/hr + 30 min setup @ $125/hr + $5 in materials → run/unit = $62.50, setup-batch = $62.50, material/unit = $5.00
- User types markup = 25 on each new tier
- User adds three tiers: 1, 2, 4

Stored on `part_pricing_tiers`:

| qty | base_cost_per_unit | markup % | unit_price |
|---|---|---|---|
| 1 | 130.00 (62.50 + 5 + 62.50) | 25 | 162.50 |
| 2 | 98.75 (62.50 + 5 + 31.25) | 25 | 123.44 |
| 4 | 83.13 (62.50 + 5 + 15.625) | 25 | 103.91 |

If the salesperson quotes this part at quantities 1, 2, and 4, three `quote_line_items` are snapshotted with the resolved prices above; subsequent edits to the part's tiers do not mutate the quote. (Quoting an in-between quantity like 3 snaps to the qty-2 tier price.)

---

## Status Transition Rules

| From | To | Trigger |
|---|---|---|
| (new) | Active | `createQuote` |
| Active | Expired | Background sweep when `expiration_date` passes (idempotent on every list/detail load) |
| Active or Expired | (converted, status unchanged) | `convertQuoteToJob` sets `converted_at`; status stays where it is |

**Editing rule:** a quote is editable (metadata AND line items) while `status === 'active'` and `converted_at IS NULL`. Line items are reconciled on save (insert/update/delete by line item id) with pricing frozen by default — see the [Edit policy](#edit-policy-line-item-reconcile-frozen-pricing-drift).

---

## Convert to Job Function

`convertQuoteToJob(quoteId, { dueDate?, customerPoNumber?, selectedLineItemIds? })` — may be called multiple times per quote (one call per customer PO):

1. Refuse only if the quote has no line items. `converted_at` being set does **not** block — a partially-converted quote can be converted again.
2. Load the lines already on a live job (`getQuoteConversionState`) and exclude them. Resolve which lines to convert: `selectedLineItemIds` when provided (one chosen line per remaining part), else all still-unconverted lines. Reject an explicit selection that includes an already-converted line ("Some selected parts are already on a job…") and reject when nothing remains ("Every line item on this quote is already on a job."). **Reject if the resolved set has more than one line for any `part_id`** ("This is a price-options quote…").
3. Pre-flight: every **made** part being converted must have a routing, else fail before any write. **Bought** parts are exempt (they're purchased, not manufactured — no routing); each becomes a `job_part` with zero operations and `production_status = 'completed'`, ready to ship + invoice. See [Jobs — Bought parts on jobs](jobs.md).
4. Use the **required** due date passed from the modal — rejected if empty and it must not be in the past. It is written straight to the job and is **no longer derived from lead time**. **Reject if no `customer_po_number` is provided** — the PO is captured as a required, non-empty value, never coerced to NULL.
5. Insert **one** `jobs` row carrying `quote_id`, `customer_id`, `due_date`, `customer_po_number`, `production_status = 'not_started'`. Job number: the mirror `Q-NNNN → J-NNNN` when free (the first, common case), otherwise a fresh `J-N` from `generate_direct_job_number` (a later PO, or a mirror already held by a since-archived job).
6. For each resolved line, insert a `job_parts` row (`part_id`, `quantity`, `source_quote_line_item_id = line.id`). **Made** parts then clone the part's routing via the `create_job_part_operations_from_routing(job_part_id, routing_id)` RPC and start `production_status = 'not_started'`; **bought** parts skip the clone (no routing) and are inserted `production_status = 'completed'` (no operations to run). **`quantity` defaults to `line.quantity` but honors an `options.lineOverrides[line.id].quantity`** (partial acceptance — order fewer/more than quoted). Price defaults to the agreed `line.unit_price`; when the override sets `useTierPrice`, it re-resolves from the line's `pricing_basis_snapshot` at the ordered qty via the shared `resolveJobPartUnitPrice`. `total_price` is `unit × qty` (4dp). Overridden quantities must be `> 0`.
7. Stamp `quote.converted_at` only on the **first** conversion (status unchanged); the quote keeps all its line items as the record of every option offered.
8. Return `{ quote, job: { id, job_number, parts: [{ id, part_id, quantity, source_quote_line_item_id }, …] } }`.

A quote with three distinct parts can become one job with all three, or (say) one job under PO-A for two parts and a later job under PO-B for the third — whatever POs the customer issues. `quantity = line.quantity` is the value **at conversion**; the job's `job_parts.quantity` is editable afterward (the quote line stays frozen) — see [Jobs Module — Editing order quantity](jobs.md).

> **Concurrency:** the app-level pre-check (step 2) is a read-then-write, so on its own it could lose a race — two simultaneous conversions of the *same* line both passing the check. The hard guarantee is at the DB: the partial unique index **`job_parts_one_active_per_quote_line`** (`UNIQUE (source_quote_line_item_id) WHERE source_quote_line_item_id IS NOT NULL AND production_status <> 'cancelled'`) makes the losing insert fail with `23505`, which the function turns into the same friendly "already on a job" message. So the app check is the fast path; the index is the arbiter. The index is scoped to non-cancelled parts, which is also what defines "converted" for `getQuoteConversionState` — cancelling a job frees its line for re-conversion, archiving does not. (Full transactional atomicity of the multi-insert — so a losing race can't leave a partial job — would require moving the conversion into a single-transaction RPC; the sequential-write behavior here matches every other multi-insert flow in the app and is orthogonal to the double-conversion guarantee.)

---

## API Architecture

**All Operations → Direct Supabase Calls**

The Quotes module uses direct Supabase calls from the frontend (via `utils/quotesAccess.ts`) for all operations:

- CRUD on quote headers
- Snapshotting one line item per (part, quantity) into `quote_line_items` (price resolved from `part_pricing_tiers`) and per-part cost snapshots into `quote_operations` / `quote_materials`
- Lazy expiration sweep (`sweepExpiredQuotes`) called as a fire-and-forget side effect on list/detail loads
- Convert to Job (orchestrated in TypeScript; calls the `create_job_part_operations_from_routing` RPC for each job part)

This follows the same pattern as Customers, Parts, and Operations:

- Avoids Vercel serverless cold starts
- Leverages Supabase RLS for security
- Simpler, faster for all operations

**No FastAPI endpoints needed** — there are no AI-powered features in the Quotes module.

---

## Acceptance Criteria

### Core Functionality

- [ ] Can view paginated list of quotes — *(automation-pending)*

- [ ] Can search quotes by number, customer, or part (name/description) — *(automation-pending)*

- [ ] Can filter by status (active / expired) — *(automation-pending)*

- [ ] Can filter by customer — *(automation-pending)*

- [ ] Can create a quote with one or more parts; each part contributes one or more quantity rows (each a snapshotted line item) — *(automation-pending)*

- [ ] Form blocks submission until every part block has a part selected and at least one valid quantity row (quantities unique within a part) — *(automation-pending)*

- [ ] Quote header is editable (customer, lead time, payment terms, expiration), and all persist across reload. Line items are editable via the [Edit policy](#edit-policy-line-item-reconcile-frozen-pricing-drift) below — reconciled on save, prices frozen by default — *(automation-pending)*

- [ ] List page has no Total column (totals live on the detail page / PDF for firm quotes) — *(automation-pending)*

- [ ] List page Jobs column shows links to every job spawned from the quote — *(automation-pending)*

- [ ] Cost breakdown view groups operations + materials + tier prices per distinct part on the quote — *(automation-pending)*

- [ ] `override` chip shown on tiers whose unit price was locked manually — *(automation-pending)*

- [ ] Quote number auto-generates (Q-0001 format) — *(automation-pending)*

- [ ] Setup-only operations (run = 0, setup > 0) appear in the cost breakdown with `run_cost = 0` and a non-zero setup cost (regression test for #224) — *(automation-pending)*

### Convert to Job

- [ ] Modal groups the quote's lines by part; a multi-quantity part shows a radio per quoted quantity — *(automation-pending)*

- [ ] Each remaining part has an include checkbox (checked by default); unchecking it leaves the part on the quote for a later PO, and only checked parts convert — *verified by `__tests__/components/quotes/ConvertToJobModal.test.tsx > 'per-part selection (multiple jobs/POs per quote)' > 'converts only the checked parts, leaving the rest for a later PO'`*.
- [ ] A single-quantity part's Order qty is editable (partial acceptance); ordering fewer than quoted passes a quantity override and the job records the ordered figure — *verified by `__tests__/components/quotes/ConvertToJobModal.test.tsx > 'partial quantity acceptance' > 'lets you order fewer than quoted (10 → 5) and passes the quantity override'`*.
- [ ] A price-options part shows its quoted breaks as one-tap chips and an editable Order qty field; any quantity converts at the tier price for that quantity (`useTierPrice = true`) — *verified by `__tests__/components/quotes/ConvertToJobModal.test.tsx > 'price-options part (quick-pick breaks + editable qty)' > 'quoted breaks are one-tap chips; any qty converts at the tier price (useTierPrice)'`*.

- [ ] Convert button stays disabled until every multi-quantity part has a quantity selected — *(automation-pending)*

- [ ] Convert button stays disabled until a Customer PO is entered; `convertQuoteToJob` rejects an empty/missing PO ("Customer PO is required to convert a quote to a job.") — *(automation-pending)*

- [ ] `convertQuoteToJob` rejects a set that resolves to more than one line for any part (options-quote guard) — *(automation-pending)*

- [ ] Conversion creates ONE job with one `job_part` per selected line, each with `source_quote_line_item_id` set — *(automation-pending)*

- [ ] Quote sets `converted_at` (status unchanged) and keeps all line items; detail page shows the linked job banner — *(automation-pending)*

### Per-part price override

- [ ] Each part block exposes a single "✏ Use custom price" toggle (one per part, not per quantity) — *(automation-pending)*
- [ ] Expanding the editor shows a Custom unit price input that applies to every quantity of the part (markup % is no longer a quote-form input) — *(automation-pending)*
- [ ] When a custom price is set, the block shows a green "adjusted for this quote" chip — *(automation-pending)*
- [ ] Every resulting `quote_line_items` row for the part carries `is_quote_override = true` and the typed unit price — *(automation-pending)*
- [ ] The cost-breakdown view renders a green "✏ adjusted for this quote" chip on overridden line items — *(automation-pending)*
- [ ] The part's tier is unchanged — *(automation-pending)*

### Edit policy (line-item reconcile, frozen pricing, drift)

This section is the authoritative spec for editing an existing quote. It supersedes any older "line items are read-only" language elsewhere in this doc. Implementation tracked in [#324](https://github.com/debola31/Jigged/issues/324). Every behavior carries an `edit → save → reload → assert` verification clause; the reload step is the binding mechanism — see [docs/testing/Testing-gaps.md](../testing/Testing-gaps.md) for why.

**Pricing basis snapshot (the data shape this all depends on)**

- [ ] On create and on add-line, a `quote_line_items` row stores the **pricing basis** (the relevant tier breaks, the markup %, and the rates) that produced its `unit_price` — *verified by `__tests__/utils/quotePricingResolver.test.ts > 'buildPricingBasisSnapshot' > 'captures only priced tiers and records the resolved tier'` AND the `pricing_basis_snapshot jsonb` column present on `quote_line_items` in `supabase/schema.prod.sql`; createQuote's snapshot-write path automation-pending (`createQuote`)*.
- [ ] The pricing basis is stored as a structured snapshot, not only the resolved `unit_price` — *verified by the migration adding a `pricing_basis_snapshot jsonb` (or similarly-named) column to `quote_line_items`*.

**Existing-quote handling (Option C — locked)**

Rows that existed before the basis-snapshot migration are flagged `basis_unknown = true`. The edit UI renders a small "basis unknown" chip on those lines; drift detection on those rows falls back to comparing the resolved `unit_price` to the current tier price — a degraded signal, but visibly degraded.

Option A (backfill the basis column from current tiers at the original quantity) is **explicitly dropped**. It would fabricate a pricing history that never existed — the Contour data loaded from Tangle has no basis and would get a false-history snapshot written into it, and the system would then report "no drift" on quotes that genuinely drifted. That violates the [no-silent-fallbacks engineering principle in CLAUDE.md](../../CLAUDE.md#no-silent-runtime-fallbacks-for-data-at-rest-issues). Option B (basis-unknown with no chip) is the silent-degradation variant of C and is also rejected.

- [ ] Pre-snapshot rows are marked `basis_unknown = true` and render a "basis unknown" chip in the edit form — *verified by `__tests__/components/quotes/QuoteForm.test.tsx > 'basis-unknown chip renders on pre-snapshot lines'`*.
- [ ] On a `basis_unknown` line, drift detection compares the resolved `unit_price` to the current tier price (degraded signal) — *verified by `__tests__/utils/quotesAccess.test.ts > 'detectQuoteLineDrift' > 'basis-unknown rows use degraded comparison and surface when current resolved price differs'` AND `__tests__/utils/quotePricingResolver.test.ts > 'isDriftedDegraded — basis_unknown rows' > 'flags drift when current resolved price differs from stored unit_price'`*.

**Reconcile on save**

- [ ] Opening an existing quote, adding a part, saving, reloading the page shows the new line persisted — *verified by `e2e/quote-edit.spec.ts > 'Quote edit — reload contract' > 'add part, edit qty, remove part — all three persist across reload'`*.
- [ ] Opening an existing quote, removing a part, saving, reloading shows the line gone — *verified by `e2e/quote-edit.spec.ts > 'Quote edit — reload contract' > 'add part, edit qty, remove part — all three persist across reload'`*.
- [ ] Opening an existing quote, editing a line's quantity, saving, reloading shows the new quantity and a `unit_price` computed against the line's SNAPSHOTTED basis curve (not current tiers) — *reload persistence verified by `e2e/quote-edit.spec.ts > 'Quote edit — reload contract' > 'add part, edit qty, remove part — all three persist across reload'`; snapshotted-basis recompute verified by `__tests__/utils/quotePricingResolver.test.ts > 'resolveTierFromSnapshot — quantity change honors snapshotted basis' > 'quantity change honors snapshotted basis'`*.
- [ ] `updateQuote()` reconciles `quote_line_items` (insert new, update edited, delete removed), mirroring `createQuote()`'s pattern — *verified by `__tests__/utils/quotesAccess.test.ts > 'updateQuote — reconcile (Issue #324 / #317 policy)' > 'reconciles line items on edit — insert new, update qty, delete removed'`*.

**Frozen-by-default pricing**

- [ ] Editing only header fields (customer, lead time, expiration) and saving leaves every line's `unit_price` exactly as it was, and reloading confirms this — *closest coverage is `__tests__/utils/quotesAccess.test.ts > 'updateQuote — reconcile (Issue #324 / #317 policy)' > 'unchanged lines keep snapshotted unit_price (no reprice on edit)'`; a dedicated header-only edit → reload E2E is automation-pending (`updateQuote`)*.
- [ ] Quantity changes recompute via `resolveTier()` against the snapshotted basis — *verified by `__tests__/utils/quotePricingResolver.test.ts > 'resolveTierFromSnapshot — quantity change honors snapshotted basis' > 'quantity change honors snapshotted basis'`*.
- [ ] Lines with `is_quote_override = true` are never repriced under any circumstance (header edit, qty change, drift control, anything) — *write path verified by `__tests__/utils/quotesAccess.test.ts > 'updateQuote — reconcile (Issue #324 / #317 policy)' > 'NEVER reprices an override line, even if acceptDriftLineItemIds includes it'`; override-frozen reload-persistence E2E automation-pending (`updateQuote`)*.

**Drift detection and flag UI**

Drift = the current tier table differs from the line's snapshotted basis. Quantity-curve movement when the user changes a quantity is NOT drift; it's expected behavior computed against the snapshot.

- [ ] A detection helper returns the set of line IDs whose current tier price differs from the snapshotted basis — *verified by `__tests__/utils/quotesAccess.test.ts > 'detectQuoteLineDrift' > 'returns flagged line IDs when current tier differs from snapshot'`*.
- [ ] On the edit form, drifted lines render a chip showing snapshotted price next to current price — *verified by `__tests__/components/quotes/QuoteForm.test.tsx > 'renders per-line drift chip and Update-all bulk control on flagged lines'`*.
- [ ] The form renders a per-line "Update to current price" control on each drifted line AND an "Update all flagged" bulk control above the lines list — *verified by `__tests__/components/quotes/QuoteForm.test.tsx > 'renders per-line drift chip and Update-all bulk control on flagged lines'` AND `__tests__/components/quotes/QuoteForm.test.tsx > 'Update-all bulk control opts every flagged line in at once'`*.
- [ ] Clicking the per-line control queues that line for repricing on save; the actual reprice happens at save time — *verified by `__tests__/components/quotes/QuoteForm.test.tsx > 'per-line update marks line for reprice — drift id flows into acceptDriftLineItemIds on save'`*.
- [ ] The drift flag is NON-BLOCKING on untouched lines: a user can save a quote with drifted lines and never click any drift control — *verified by `__tests__/components/quotes/QuoteForm.test.tsx > 'untouched drifted line saves without sending its id in acceptDriftLineItemIds (keeps snapshotted price)'` AND `e2e/quote-edit.spec.ts > 'Quote edit — reload contract' > 'untouched drifted line keeps original price after reload'`*.
- [ ] **An untouched drifted line keeps its original price after reload** — *verified by `e2e/quote-edit.spec.ts > 'Quote edit — reload contract' > 'untouched drifted line keeps original price after reload'`*.
- [ ] Drifted lines reprice only on explicit user choice (per-line control or update-all) — *verified by `e2e/quote-edit.spec.ts > 'Quote edit — reload contract' > 'drifted line repriced only via explicit control'`*.
- [ ] `is_quote_override = true` lines are NEVER flagged as drifted, even if their tier has moved — *verified by `__tests__/utils/quotesAccess.test.ts > 'detectQuoteLineDrift' > 'override lines never appear in drift set'` AND `__tests__/components/quotes/QuoteForm.test.tsx > 'override line never renders drift chip'`*.

**Forced keep-or-update: DROPPED ([Issue #325](https://github.com/debola31/Jigged/issues/325) decision, 2026-06-04)**

The forced-choice path — block save on an actively-edited drifted line until the user picks keep-the-snapshot or update-to-current — was gated on Issue #325 and has been **dropped** from §0 scope. In the pilot population (Contour Tool & Machine, primary quoter Johnny), tier-price changes during an open quote's lifetime are rare enough that a save-blocking modal is more friction than the drift signal warrants. The non-blocking chip + per-line and update-all controls above already give the user a deliberate opt-in when drift does occur.

If post-pilot data shows drift is more frequent than estimated, forced-choice can be revisited as a follow-up; it is not part of #324's implementation scope.

- [x] Editing a drifted line and saving without making a drift choice uses the non-blocking chip behavior — the line keeps its snapshotted price unless the per-line control was clicked — *verified by `__tests__/components/quotes/QuoteForm.test.tsx > 'edit-time drift uses non-blocking chip only — save is enabled without making a drift choice'`*.

**Verification rule for the whole section**

Every editable behavior above has at least one `edit → save → reload → assert persists` clause. The reload step is non-negotiable — it's what closes the gap between optimistic UI updates and DB writes. The E2E spec [`e2e/quote-edit.spec.ts`](../../e2e/quote-edit.spec.ts) (authored in [#331](https://github.com/debola31/Jigged/issues/331)) is the catch-all.

---

## Printing Quotes

Quote detail pages expose a standalone **View PDF** button that generates a customer-facing PDF locally in the browser (no server round-trip).

**What the PDF contains:**

- Company logo (if uploaded in Settings → Company Branding) and company name in the header
- Large "QUOTE" heading with the quote number, date, validity / lead-time / payment-terms meta
- **Customer · Ship to (only if different from billing) · Customer contact** — columns on one row (customer name + billing address, the shipping address when it differs, and the contact's name/email/phone) pulled from the quote's snapshotted FKs; missing fields and the ship-to column (when shipping == billing) are skipped cleanly
- **Line items** — one table (Part, Description, Order qty, Unit price, Total), ordered by `sequence`. A part with several quantities spans its name + description across its quantity rows.
  - **Firm quote** (every part one quantity): a bottom-line **grand total**.
  - **Price-options quote** (any part 2+ quantities): **no grand total** (the customer hasn't yet picked a quantity, so a single bottom-line price would mislead).
- **Acceptance block** — instructs the customer to *reply with a purchase order referencing the quote*; there is **no signature/date/PO# ruled line** (acceptance is by PO). A small **"Prepared by {name} · {email}"** line sits just below it, followed by the page footer.

**Intentionally excluded** (kept off the customer's view):

- Routing / operations / run times
- Labor and material cost snapshots
- Markup percentage and base cost

**Filename:** `Quote-{quote_number}.pdf`

> **Email descoped.** An in-app "email this quote" action (a `mailto:`-backed
> dialog) was intentionally removed — the detail page has no Email button, and
> users send the downloaded PDF from their own mail client. There is no server send.

**Branding:** Upload your logo at `/dashboard/{companyId}/settings` (admin-only, Company Branding card). PNG, JPG, or WebP up to 2 MB. SVGs are accepted for storage but currently fall back to a text-only header in the PDF — use a raster format for logos that should appear. If no logo is uploaded, the PDF renders with the company name only.

**Immutability:** Line-item prices are frozen by default (never silently repriced when the part's tiers move), so the printed PDF is a faithful record of the price the customer was quoted. Re-printing the same quote tomorrow produces the same PDF.

---

## Inline Entity Creation

While creating a quote, users can create new entities without leaving the form:

- **"+ New Customer"** opens a modal that creates the customer and auto-selects it.
- **"+ New Part"** (within a part block) opens a modal that creates the part and auto-selects it in that block. Tier authoring still happens on the part detail page — a freshly-created part has no tiers, so the form will warn until the user opens the part page and adds at least one tier.

---

## Search and Filter

**Search:** the toolbar input matches on **quote number, customer name, and any line item's part** (name or description) — mirroring the jobs list. It filters **client-side** over the already-loaded rows (the list query joins `customers` and `line_items.parts`), so it's instant and needs no DB round-trip or RPC. Placeholder: `Quote #, customer, part…`.

**Filters:**

- Status dropdown: All / Active / Expired
- Customer dropdown: All / specific customer

**Sorting:** Click any column header to sort.

---

## Validation Rules

**Customer:** required

**Parts:** at least one part block; each block must have a part selected. A part may appear in only one block.

**Quantities:** each block needs at least one quantity row; every quantity must be a number > 0 (fractional allowed — parts sold by the dozen / ounce / pound / length) and unique within the part. Each non-override row must resolve to a priced tier (or use a custom price).

**Lead time:** required — any non-empty free text (e.g. "2–3 weeks", "In stock"); stored verbatim and does not drive the job due date.

**Payment terms:** required — preset or custom free text; submission is blocked until a value is entered.

**Expiration date:** ISO date (defaults to created + 10 days)

**Tier-level fields** (`quantity`, `markup_percent`) are validated on the part page when the tier is authored, not on the quote form.

---

