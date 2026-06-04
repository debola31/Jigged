# Quotes Module

## Overview

The Quotes module handles the sales quoting process — the entry point for work into the shop. Quotes capture what a customer wants, at what price, and when they need it. A quote can be converted directly into one or more jobs at any time; there is no separate approval step.

**The quote is the customer-facing document; the part owns the pricing math.** A quote references parts and snapshots one or more pricing tiers per part into `quote_line_items` at creation, including the tier-break table that produced the price (the **pricing basis**). On edit, the quote line items are reconciled — new parts insert, removed parts delete, edited lines update — but **pricing is frozen by default**: existing lines keep their snapshotted `unit_price` unless the user explicitly chooses to update it, and quantity changes recompute against the snapshotted basis curve, not against the current tier table. The only condition that gets flagged in the UI is **drift** — when the current tier table differs from the snapshot.

See the [Edit policy AC section](#edit-policy-line-item-reconcile-frozen-pricing-drift) for the full set of bullets and their verification clauses.

A single quote can include:

- **Multiple parts** (the customer asked for both a holder and a clamp), and
- **Multiple quantity tiers per part** (e.g., 1, 2, 4 pieces of the holder, each at its own unit price).

When the quote has more than one tier overall, the printed PDF intentionally omits a grand total — the customer hasn't yet picked which quantity to order. They pick at conversion time, and one job is created per (part, selected tier).

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

**Conversion flag:** `converted_at` is set when the quote becomes one or more jobs. The reverse link lives on `jobs.source_quote_line_item_id` — each created job points at the specific line item (part + tier) it came from. A quote with N selected tiers across M parts becomes M jobs (one per part), each at the tier the user picked. Loading a quote shows every linked job in the "Jobs" banner.

The pending-approval / approved / rejected states were removed in April 2026. For small shops the salesperson and the approver are the same person; the state machine added friction without adding value.

---

## User Stories

| As a... | I want to... | So that... |
|---|---|---|
| Salesperson | Create a quote for a customer | I can respond to customer inquiries |
| Salesperson | Add multiple parts to a single quote | I can quote a complete request without splitting it across documents |
| Salesperson | Pick which pricing tiers (1, 2, 4 …) of each part to include | I can present price breaks the customer asked about on one document |
| Salesperson | Set a lead time and expiration date | The customer knows when and for how long |
| Salesperson | Expand a cost breakdown to see per-op / per-material costs grouped by part | I can explain the price if asked |
| Salesperson | Convert a quote directly to one job per (part, selected tier) | Production can begin without a ceremony step |
| Salesperson | Pick which quantity tier the customer chose at conversion time | The work order reflects exactly what the customer agreed to |
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
| lead_time_days | Integer | No | Days to deliver; copied to `jobs.lead_time_days` on conversion |
| expiration_date | Date | No | When the quoted price stops being honored. Defaults to `created_at + 10 days` |
| status | Text | Yes | `active` or `expired` |
| status_changed_at | Timestamp | No | When `status` last changed |
| converted_at | Timestamp | No | When the quote was converted to one or more jobs |
| created_by | UUID | No | User who created the quote |
| created_at | Timestamp | Yes | Auto-generated |
| updated_at | Timestamp | Yes | Auto-updated on changes |

**Removed in April 2026 (replaced by line items):** `part_id`, `quantity`, `base_cost`, `markup_percent`, `estimated_labor_cost`, `estimated_material_cost`, `unit_price`, `total_price`, `converted_to_job_id`. The `description` free-text field was removed earlier; the part itself carries descriptive detail.

### Snapshotted Line Items (`quote_line_items`)

One row per (part, selected tier) on a quote. Created at quote creation by snapshotting selected `part_pricing_tiers` and **never modified after** — even if the source tier changes. Multi-part / multi-tier quotes have multiple rows.

| Field | Type | Required | Description |
|---|---|---|---|
| id | UUID | Yes | Primary key |
| quote_id | UUID (FK) | Yes | Parent quote (cascade delete) |
| company_id | UUID (FK) | Yes | Multi-tenant isolation |
| part_id | UUID (FK) | Yes | Snapshot of the part this line item priced |
| source_tier_id | UUID (FK) | No | Soft reference to the originating `part_pricing_tiers` row (set null if the tier is later deleted) |
| sequence | Integer | Yes | Display/print order (10, 20, 30 …) |
| quantity | Integer | Yes | Snapshotted tier quantity, > 0 |
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

- Table showing: Quote #, Customer, **Total**, Status, Created By, Expires, Created, **Jobs**

- Total column shows the line-item total when the quote has exactly one line item; otherwise renders `—` with a tooltip ("Multi-tier quote — pick qty to confirm total")

- Jobs column shows links to every job spawned from the quote (one per converted line item)

- Search box (searches quote number)

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

**Note:** Edit on an existing quote is **metadata-only** (customer, lead time, expiration). Line items are immutable snapshots — to change parts or tiers, create a new quote.

**Form Sections:**

▸ **Customer** (required)

- Customer dropdown with search and "+ New Customer" inline create

▸ **Parts** (repeating block)

The form has a "Parts" card with one collapsible block per part on the quote, plus an "+ Add part" button at the top of the card.

Each block:

- Part picker (autocomplete; "+ New Part" opens the inline creator and auto-selects the new part)
- After a part is selected, the form loads its `part_pricing_tiers` and renders one checkbox per tier:
  - Label: `Qty {quantity} · {formatCurrency(unit_price)} / unit` with a markup chip when set
  - User checks one or more tiers to include on the quote
- "Remove part" trash icon to drop the block

**Per-quote price overrides (`✏ Adjust price`):** when a tier is checked, an "✏ Adjust price" button appears on the row. Clicking it expands inline `Unit price` and `Markup %` inputs, pre-filled with the tier's current values. Bidirectional editing applies — typing a price back-calculates markup against the tier's base cost; typing a markup recomputes the price. When the typed price diverges from the tier's standing price, the row's chip changes from a markup chip to a green **"adjusted for this quote"** chip so the user can see at a glance which prices are one-off concessions. The override only lives on the resulting `quote_line_items` row (`is_quote_override = true`); the part's tier is never touched.

If the chosen part has no pricing tiers yet, the block shows a warning ("This part has no pricing tiers yet. Open the part detail page to add them."). Tiers are authored on the part — the quote form is purely a selector with optional one-off overrides.

**Order matters:** the visual order of part blocks (and the order of tier checkboxes within each block) drives the `sequence` field on the resulting `quote_line_items`, which in turn drives PDF row order.

▸ **Terms**

- Lead time (days, optional)
- Expiration date (defaults to today + 10 days)

**Actions:**

- Create quote / Save changes → returns to detail page
- Cancel → returns to the previous page

**Validation guards:**

- At least one part block is required.
- Every part block must have a part selected and at least one tier checked.
- Lead time, if entered, must be 0 – 3,650 days.

### 3. Quote Detail View

**Route:** `/dashboard/{companyId}/quotes/{id}`

**Header:**

- Quote number (large)
- Status pill (Active / Expired)
- Created date, created by, expires-in, lead time

**Content cards:**

- **Converted-to-Jobs banner** — only when `converted_at` is set. Lists every linked job by number with click-through links.
- **Customer card** — name + click-through to the customer record.
- **Line items table** — Part, Description, Order qty, Unit price, Total (one row per `quote_line_item`, one line item per part). A **Total** row summing every line item is rendered at the bottom of the table.
- **Pricing tiers (reference)** — beneath the line items table, one row per part with > 1 master tier shows the part's full price-break list as chips, with the matched tier highlighted. Suppressed when a line uses a custom price override.

**Actions (based on status):**

| Current State | Available Actions |
|---|---|
| Active, not converted | Edit (metadata), Convert to Jobs, Delete |
| Active, converted | Delete only (line items are frozen) |
| Expired | Convert with warning, Delete |

**Print PDF** lives in the top-right page toolbar and is available in every status. See [Printing Quotes](#printing-quotes) below.

### 4. Convert to Jobs Modal

**Trigger:** "Convert to Jobs" button on the detail page (active or expired quote).

**Prerequisite:** Every part on the quote must have a routing. If any does not, conversion is blocked with a link to fix the routing on that part.

**Modal Content:**

The modal lists one section per distinct `part_id` on the quote. Each section is a radio group of that part's line items — one radio per available tier:

```
Holder
  ◯ Qty 1 · $187.00 / unit = $187.00
  ◯ Qty 2 · $112.00 / unit = $224.00
  ◉ Qty 4 · $94.00  / unit = $376.00

Clamp
  ◉ Qty 5 · $62.00  / unit = $310.00     (auto-selected — only one tier)
```

If a part has only one line item on the quote, that radio is pre-selected — the user just confirms.

A single **Lead time** input applies to all jobs created in this conversion (defaults to the quote's lead time, editable).

**Actions:**

- Create Jobs → calls `convertQuoteToJob(quote_id, { selections: [{ line_item_id }, …], leadTimeDays })` → creates one job per selection, copies the routing into each via `create_job_operations_from_routing`, sets `quote.converted_at`, and redirects to the first created job's detail page.
- Cancel → closes the modal without changes.

The submit button stays disabled until **every** part on the quote has a tier selected.

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

- [ ] "+ New Customer" button visible next to customer dropdown
- [ ] Quick Create Customer modal opens with required fields
- [ ] New customer auto-selected after creation
- [ ] "+ New Part" button visible inside a part block
- [ ] Quick Create Part modal asks for name + description only
- [ ] New part auto-selected in the part block after creation
- [ ] Block warns "no pricing tiers yet" until the user adds tiers on the part detail page
- [ ] Validation errors display inline in modals
- [ ] Success toast shown after creation

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

Markup % is the source of truth on a part tier. Typing a unit price in the part Pricing card back-calculates and stores the markup; routing changes still propagate to every tier's unit price.

**On the quote (createQuote):**

For each `(part, selected_tier)` the user checked in the form, insert one `quote_line_items` row:

```
quote_line_items.{quantity, unit_price, markup_percent, base_cost_per_unit}
                = source_tier.{quantity, unit_price, markup_percent, base_cost_per_unit}
quote_line_items.total_price       = quantity × unit_price
quote_line_items.source_tier_id    = source_tier.id   (soft reference)
quote_line_items.is_quote_override = false
```

If the salesperson typed a one-off price in the form's "✏ Adjust price" editor, the matching `quote_line_items` row instead carries the typed values (and any back-calculated markup) plus `is_quote_override = true`. The part tier itself is never modified.

Cost snapshots (`quote_operations`, `quote_materials`) are written once per **distinct part** in the quote, so a quote with three tiers of the same Holder still only stores one Holder cost snapshot.

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

When the user creates a quote selecting all three tiers, three `quote_line_items` are snapshotted with these values; subsequent edits to the part's tiers do not mutate the quote.

---

## Status Transition Rules

| From | To | Trigger |
|---|---|---|
| (new) | Active | `createQuote` |
| Active | Expired | Background sweep when `expiration_date` passes (idempotent on every list/detail load) |
| Active or Expired | (converted, status unchanged) | `convertQuoteToJob` sets `converted_at`; status stays where it is |

**Editing rule:** the metadata (customer, lead time, expiration) is editable while `status === 'active'` and `converted_at IS NULL`. Line items are never editable — they're snapshots.

---

## Convert to Jobs Function

`convertQuoteToJob(quote_id, { selections: [{ line_item_id }, …], leadTimeDays })`:

1. Refuse if `converted_at` is already set.
2. Validate selections: exactly one `line_item_id` per distinct `part_id` on the quote.
3. Resolve lead time (override > quote default > null) and compute due date.
4. For each selected line item:
   - Insert a `jobs` row carrying `quote_id`, `customer_id`, `part_id`, `source_quote_line_item_id = line_item.id`, `due_date`, `lead_time_days`, `status = 'not_started'`.
   - Call the `create_job_operations_from_routing(job_id, routing_id)` RPC to clone the part's routing into `job_operations`.
5. Set `quote.converted_at` (status unchanged).
6. Return `{ quote, jobs: [{ id, job_number, line_item_id, part_id, quantity }, …] }`.

A multi-part quote with three parts becomes three jobs. Each job's `quantity_ordered` matches the quantity of the line item the user picked, and the per-job lead time is the same value across the batch (single input on the modal).

---

## API Architecture

**All Operations → Direct Supabase Calls**

The Quotes module uses direct Supabase calls from the frontend (via `utils/quotesAccess.ts`) for all operations:

- CRUD on quote headers
- Snapshotting selected `part_pricing_tiers` into `quote_line_items` and per-part cost snapshots into `quote_operations` / `quote_materials`
- Lazy expiration sweep (`sweepExpiredQuotes`) called as a fire-and-forget side effect on list/detail loads
- Convert to Jobs (orchestrated in TypeScript; calls the `create_job_operations_from_routing` RPC for each created job)

This follows the same pattern as Customers, Parts, and Operations:

- Avoids Vercel serverless cold starts
- Leverages Supabase RLS for security
- Simpler, faster for all operations

**No FastAPI endpoints needed** — there are no AI-powered features in the Quotes module.

---

## Acceptance Criteria

### Core Functionality

- [ ] Can view paginated list of quotes

- [ ] Can search quotes by number

- [ ] Can filter by status (active / expired)

- [ ] Can filter by customer

- [ ] Can create a quote with one or more parts; each part contributes one or more snapshotted tiers

- [ ] Form blocks submission until every part block has a part selected and at least one tier checked

- [ ] Quote header is editable (customer, lead time, expiration). Line items are editable via the [Edit policy](#edit-policy-line-item-reconcile-frozen-pricing-drift) below — reconciled on save, prices frozen by default

- [ ] List page Total column shows the line-item total when there is exactly one line item, otherwise `—`

- [ ] List page Jobs column shows links to every job spawned from the quote

- [ ] Cost breakdown view groups operations + materials + tier prices per distinct part on the quote

- [ ] `override` chip shown on tiers whose unit price was locked manually

- [ ] Quote number auto-generates (Q-0001 format)

- [ ] Setup-only operations (run = 0, setup > 0) appear in the cost breakdown with `run_cost = 0` and a non-zero setup cost (regression test for #224)

### Convert to Jobs

- [ ] Modal lists one section per distinct part on the quote, with a radio per tier

- [ ] When a part has only one tier on the quote, that radio is pre-selected

- [ ] Convert button stays disabled until every part has a tier selected

- [ ] Single lead-time input applies to all created jobs

- [ ] N selected tiers (across distinct parts) produce N jobs, each with `source_quote_line_item_id` set

- [ ] Quote sets `converted_at` (status unchanged); detail page shows the linked jobs banner

### Per-quote price overrides

- [ ] Each selected tier row exposes an "✏ Adjust price" button on the quote form
- [ ] Expanding the editor shows Unit price + Markup % inputs pre-filled from the part tier
- [ ] Bidirectional editing: typing a price back-calculates markup, typing a markup recomputes price
- [ ] When the typed price diverges from the tier's standing price, the row chip changes to "adjusted for this quote"
- [ ] The resulting `quote_line_items` row carries `is_quote_override = true` and the typed values
- [ ] The cost-breakdown view renders a green "✏ adjusted for this quote" chip on overridden line items
- [ ] The part's tier is unchanged

### Edit policy (line-item reconcile, frozen pricing, drift)

This section is the authoritative spec for editing an existing quote. It supersedes any older "line items are read-only" language elsewhere in this doc. Implementation tracked in [#324](https://github.com/debola31/Jigged/issues/324). Every behavior carries an `edit → save → reload → assert` verification clause; the reload step is the binding mechanism — see [docs/testing/Testing-gaps.md](../testing/Testing-gaps.md) for why.

**Pricing basis snapshot (the data shape this all depends on)**

- [ ] On create and on add-line, a `quote_line_items` row stores the **pricing basis** (the relevant tier breaks, the markup %, and the rates) that produced its `unit_price` — *verified by `__tests__/utils/quotesAccess.test.ts > 'createQuote snapshots pricing basis'` AND the basis column visible in `supabase/schema.staging.sql` after the schema migration ships*.
- [ ] The pricing basis is stored as a structured snapshot, not only the resolved `unit_price` — *verified by the migration adding a `pricing_basis_snapshot jsonb` (or similarly-named) column to `quote_line_items`*.

**Existing-quote handling (Option C — locked)**

Rows that existed before the basis-snapshot migration are flagged `basis_unknown = true`. The edit UI renders a small "basis unknown" chip on those lines; drift detection on those rows falls back to comparing the resolved `unit_price` to the current tier price — a degraded signal, but visibly degraded.

Option A (backfill the basis column from current tiers at the original quantity) is **explicitly dropped**. It would fabricate a pricing history that never existed — the Contour data loaded from Tangle has no basis and would get a false-history snapshot written into it, and the system would then report "no drift" on quotes that genuinely drifted. That violates the [no-silent-fallbacks engineering principle in CLAUDE.md](../../CLAUDE.md#no-silent-runtime-fallbacks-for-data-at-rest-issues). Option B (basis-unknown with no chip) is the silent-degradation variant of C and is also rejected.

- [ ] Pre-snapshot rows are marked `basis_unknown = true` and render a "basis unknown" chip in the edit form — *verified by `__tests__/components/quotes/QuoteForm.test.tsx > 'basis-unknown chip renders on pre-snapshot lines'`*.
- [ ] On a `basis_unknown` line, drift detection compares the resolved `unit_price` to the current tier price (degraded signal) — *verified by `__tests__/utils/quotesAccess.test.ts > 'basis-unknown line uses resolved-vs-current drift comparison'`*.

**Reconcile on save**

- [ ] Opening an existing quote, adding a part, saving, reloading the page shows the new line persisted — *verified by `e2e/quote-edit.spec.ts > 'add part persists across reload'`*.
- [ ] Opening an existing quote, removing a part, saving, reloading shows the line gone — *verified by `e2e/quote-edit.spec.ts > 'remove part persists across reload'`*.
- [ ] Opening an existing quote, editing a line's quantity, saving, reloading shows the new quantity and a `unit_price` computed against the line's SNAPSHOTTED basis curve (not current tiers) — *verified by `e2e/quote-edit.spec.ts > 'quantity change persists and honors snapshotted basis'`*.
- [ ] `updateQuote()` reconciles `quote_line_items` (insert new, update edited, delete removed), mirroring `createQuote()`'s pattern — *verified by `__tests__/utils/quotesAccess.test.ts > 'updateQuote reconciles line items on edit'`*.

**Frozen-by-default pricing**

- [ ] Editing only header fields (customer, lead time, expiration) and saving leaves every line's `unit_price` exactly as it was, and reloading confirms this — *verified by `e2e/quote-edit.spec.ts > 'header-only edit leaves every unit_price unchanged after reload'` AND `__tests__/utils/quotesAccess.test.ts > 'header-only edit leaves all unit prices unchanged'`*.
- [ ] Quantity changes recompute via `resolveTier()` against the snapshotted basis — *verified by `__tests__/utils/quotePricingResolver.test.ts > 'resolves against arbitrary tier set'` AND `__tests__/utils/quotesAccess.test.ts > 'quantity change recomputes against snapshotted basis, not current tiers'`*.
- [ ] Lines with `is_quote_override = true` are never repriced under any circumstance (header edit, qty change, drift control, anything) — *verified by `__tests__/utils/quotesAccess.test.ts > 'override line stays frozen even on quantity change'` AND `e2e/quote-edit.spec.ts > 'override line stays frozen across edit and reload'`*.

**Drift detection and flag UI**

Drift = the current tier table differs from the line's snapshotted basis. Quantity-curve movement when the user changes a quantity is NOT drift; it's expected behavior computed against the snapshot.

- [ ] A detection helper returns the set of line IDs whose current tier price differs from the snapshotted basis — *verified by `__tests__/utils/quotesAccess.test.ts > 'detectDrift returns flagged line IDs'`*.
- [ ] On the edit form, drifted lines render a chip showing snapshotted price next to current price — *verified by `__tests__/components/quotes/QuoteForm.test.tsx > 'renders drift chip on flagged lines'`*.
- [ ] The form renders a per-line "Update to current price" control on each drifted line AND an "Update all flagged" bulk control above the lines list — *verified by `__tests__/components/quotes/QuoteForm.test.tsx > 'renders per-line and update-all drift controls'`*.
- [ ] Clicking the per-line control queues that line for repricing on save; the actual reprice happens at save time — *verified by `__tests__/components/quotes/QuoteForm.test.tsx > 'per-line update marks line for reprice'`*.
- [ ] The drift flag is NON-BLOCKING on untouched lines: a user can save a quote with drifted lines and never click any drift control — *verified by `e2e/quote-edit.spec.ts > 'untouched drifted line does not require user action to save'`*.
- [ ] **An untouched drifted line keeps its original price after reload** — *verified by `e2e/quote-edit.spec.ts > 'untouched drifted line does not reprice on save'`*.
- [ ] Drifted lines reprice only on explicit user choice (per-line control or update-all) — *verified by `e2e/quote-edit.spec.ts > 'drifted line repriced only via explicit control'`*.
- [ ] `is_quote_override = true` lines are NEVER flagged as drifted, even if their tier has moved — *verified by `__tests__/utils/quotesAccess.test.ts > 'override lines never appear in drift set'` AND `__tests__/components/quotes/QuoteForm.test.tsx > 'override line never renders drift chip'`*.

**Forced keep-or-update on actively-edited drifted lines (conditional)**

The forced-choice path — block save on a line the user is actively editing where the price is ambiguous (drifted), until they explicitly pick keep-the-snapshot or update-to-current — is **gated on the [Issue #325](https://github.com/debola31/Jigged/issues/325) (drift-frequency conversation with the primary quoter) outcome**. If drift turns out to be rare, this clause is dropped and the non-blocking chip is sufficient.

Choose ONE of the two bullets below based on the Issue #325 decision:

- [ ] (if forced-choice ships) Attempting to save while editing a drifted line without choosing keep-or-update blocks save with a form error — *verified by `__tests__/components/quotes/QuoteForm.test.tsx > 'edited drifted line blocks save until keep-or-update chosen'`*.
- [ ] (if forced-choice is dropped) Editing a drifted line and saving without making a drift choice uses the non-blocking chip behavior — the line keeps its snapshotted price unless the per-line control was clicked — *verified by `__tests__/components/quotes/QuoteForm.test.tsx > 'edit-time drift uses non-blocking chip only'`*.

**Verification rule for the whole section**

Every editable behavior above has at least one `edit → save → reload → assert persists` clause. The reload step is non-negotiable — it's what closes the gap between optimistic UI updates and DB writes. The E2E spec [`e2e/quote-edit.spec.ts`](../../e2e/quote-edit.spec.ts) (authored in [#331](https://github.com/debola31/Jigged/issues/331)) is the catch-all.

---

## Printing Quotes

Quote detail pages include a **Print PDF** button that generates a customer-facing PDF locally in the browser (no server round-trip).

**What the PDF contains:**

- Company logo (if uploaded in Settings → Company Branding) and company name in the header
- Large "QUOTE" heading with the quote number, date, and status
- **Bill To** block — customer name, contact person, address, phone, and email (pulled from the customer record; missing fields are skipped cleanly)
- Line-item table — one row per `quote_line_item` ordered by `sequence`. Columns: Part, Description, Qty, Unit Price, Total.
- **Conditional grand total**:
  - Exactly one line item → bottom-line Total renders.
  - More than one line item → grand total is **omitted** and replaced with the italic note "Select a quantity per part to confirm total." This is the multi-tier flow: the customer hasn't yet picked a quantity, so a single bottom-line price would be misleading.
- Acceptance / signature block + page footer

**Intentionally excluded** (kept off the customer's view):

- Routing / operations / run times
- Labor and material cost snapshots
- Markup percentage and base cost

**Filename:** `Quote-{quote_number}.pdf`

**Branding:** Upload your logo at `/dashboard/{companyId}/settings` (admin-only, Company Branding card). PNG, JPG, or WebP up to 2 MB. SVGs are accepted for storage but currently fall back to a text-only header in the PDF — use a raster format for logos that should appear. If no logo is uploaded, the PDF renders with the company name only.

**Immutability:** Line items are frozen at creation, so the printed PDF is a faithful record of the price the customer was quoted. Re-printing the same quote tomorrow produces the same PDF.

---

## Inline Entity Creation

While creating a quote, users can create new entities without leaving the form:

- **"+ New Customer"** opens a modal that creates the customer and auto-selects it.
- **"+ New Part"** (within a part block) opens a modal that creates the part and auto-selects it in that block. Tier authoring still happens on the part detail page — a freshly-created part has no tiers, so the form will warn until the user opens the part page and adds at least one tier.

---

## Search and Filter

**Search:** Full-text search on quote number (toolbar input)

**Filters:**

- Status dropdown: All / Active / Expired
- Customer dropdown: All / specific customer

**Sorting:** Click any column header to sort.

---

## Validation Rules

**Customer:** required

**Parts:** at least one part block; each block must have a part selected and at least one tier checked

**Lead time (days):** integer, 0 – 3,650 (optional)

**Expiration date:** ISO date (defaults to created + 10 days)

**Tier-level fields** (`quantity`, `markup_percent`, `unit_price`) are validated on the part page when the tier is authored, not on the quote form.

---

