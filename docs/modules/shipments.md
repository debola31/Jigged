# Shipments Module

## Overview

Shipments capture what physically left the shop, when, to whom, against which job, and in what quantity. They generate packing slips, drive job auto-close, and decouple **fulfillment status** (what the customer sees) from **production status** (what the shop is working on). Each shipment (and therefore each packing slip) belongs to exactly **one job**.

**Priority:** Built; in production behind a per-tenant feature flag (`settings.features.shipments`). See [`lib/featureFlags.ts`](../../lib/featureFlags.ts).

**Dependencies:** [Jobs](jobs.md), [Customers](customers.md). Updates `jobs.fulfillment_status` via DB triggers.

This is the single source-of-truth doc for the module (implementation + the product reasoning that drove it). The earlier standalone discovery PRD was folded in and removed — its prior revisions live in git history.

---

## Data Model

### `shipments` table

One row per packing slip.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid | PK |
| `company_id` | uuid | FK |
| `customer_id` | uuid | FK |
| `job_id` | uuid | FK → `jobs`. The single job this slip belongs to; source of the packing-slip number. Enforced by the RPC (all line items resolve to this job). |
| `shipping_address_id` | uuid? | FK → `customer_addresses` (XOR with `one_time_address`) |
| `one_time_address` | jsonb? | Phase 3 (XOR via `shipments_one_address_source` constraint) |
| `packing_slip_number` | text | Unique per company. App-wide rule `PS-{jobBase}-{n}` (jobBase = `job_number` minus its alpha prefix, e.g. `J-0141` → `0141`; `n` starts at 1). Derived inline by the RPC under the per-job advisory lock — no per-company configurable format/counter. |
| `ship_date` | date | Defaults to `current_date` |
| `shipping_method` | enum-via-CHECK | `customer_pickup | personal_delivery | shipment | dropship | restock` (constraint `shipments_shipping_method_check`). Replaces the retired `shipping_arrangement`. |
| `carrier` | text? | Only set when `shipping_method='shipment'`. UI offers UPS / FedEx / USPS / Other (Other → the typed name is stored here). No DB CHECK. |
| `notes` | text? | |
| `created_by` | uuid? | FK → `auth.users`, `ON DELETE SET NULL` |
| `voided_at`, `voided_by` | timestamptz?, uuid? | Phase 3 (always NULL in Phase 1) |

Trigger `enforce_shipment_address_contact_customer` (BEFORE INS/UPD) verifies `shipping_address_id` belongs to `customer_id`.

### `shipment_line_items` table

One row per `(shipment, job_part)`.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid | PK |
| `shipment_id` | uuid | FK CASCADE |
| `job_part_id` | uuid | FK |
| `quantity` | numeric | `> 0` |

### `job_fulfillment_audit` table

Append-only causal record of forward transitions to `fully_shipped`. Written by `create_shipment_with_line_items` when a job's fulfillment status transitions forward.

---

## Fulfillment lifecycle (dual-status)

Jobs carry two independent status columns:

- **`production_status`**: `not_started | in_progress | completed | cancelled` — what the shop is doing.
- **`fulfillment_status`**: `unshipped | partially_shipped | fully_shipped` — what the customer has received. **Derived**, never written directly.

Four trigger chains keep `fulfillment_status` consistent:

1. `recompute_job_part_fulfillment_from_line` — AFTER INS/UPD/DEL on `shipment_line_items`, recomputes `job_parts.fulfillment_status`.
2. `recompute_job_part_fulfillment_from_void` — AFTER UPD `voided_at` on `shipments`, cascades void to dependent line items.
3. `recompute_job_part_fulfillment_from_qty` — AFTER UPD OF `quantity` on `job_parts` (the editable-order-quantity feature), recomputes that part's `fulfillment_status` from `compute_job_part_fulfillment_status`. Needed because editing the ordered quantity changes the shipped-vs-ordered comparison but fires none of the shipment-keyed triggers; e.g. a part `fully_shipped` at qty 10 flips to `partially_shipped` when raised to 15.
4. `sync_job_fulfillment_status_from_parts` — AFTER INS/UPD `fulfillment_status` / DEL on `job_parts`, recomputes `jobs.fulfillment_status`.

The derivation functions are:

- `compute_job_part_fulfillment_status(uuid)` STABLE → `unshipped | partially_shipped | fully_shipped`, comparing `SUM(non-voided line item quantities)` vs `job_parts.quantity`.
- `compute_job_fulfillment_status(uuid)` STABLE → aggregates child statuses (does **not** exclude cancelled parts per PRD §7.1).

A job auto-closes (fulfillment_status → `fully_shipped`) when `SUM(shipped) ≥ SUM(ordered)` for all non-cancelled job_parts.

`qty_remaining` (from `getJobPartShipmentSummaries`) is derived live as `job_parts.quantity − SUM(non-voided shipped)`, so it always reflects the **current** ordered quantity — including a post-conversion edit. Conversely, `updateJobPartQuantity` refuses to lower a part's quantity below `max(already-shipped, already-invoiced)`.

**Invoicing is decoupled from shipping.** Billing is capped at the **ordered** quantity, not shipped (a packing slip is a document, not a delivery); the invoice picker merely *defaults* to the shipped-but-unbilled qty and nudges when you bill beyond it. So voiding a shipment does **not** yank on what you can invoice. A **third** axis, `invoicing_status` (`uninvoiced | partially_invoiced | fully_invoiced`), mirrors this whole trigger family for invoices — so the "dual-status" model above is really three independent axes now. Full spec: [Invoicing](invoicing.md).

---

## RPC: `create_shipment_with_line_items`

`VOLATILE SECURITY DEFINER`. Derives the single job behind the line items (raises if zero or **more than one** distinct job — one slip = one job), takes a `pg_advisory_xact_lock` on that job, mints the packing-slip number `PS-{jobBase}-{n}` inline (`n = count of existing shipments for the job + 1`, collision-free under the lock), inserts the shipment + line items, snapshots `fulfillment_status` pre/post, writes the audit row when applicable, and returns `{shipmentId, packingSlipNumber}`.

Parameters mirror `CreateShipmentPayload` in `types/shipment.ts` (`p_carrier`, `p_shipping_method`, `p_notes`, …); `job_id` is **not** a parameter — it's derived.

---

## Pages

### List — `/dashboard/{companyId}/shipments`

Feature-gated by `isShipmentsEnabled(company)`. AG Grid with columns:

- **Packing Slip #** (blue, bold)
- **Ship Date** (formatted "MMM D, YYYY")
- **Customer**
- **Jobs** (chip list — one chip, since a slip is one job)
- **Method** (`SHIPPING_METHOD_LABELS`), **Carrier**
- **Lines** (line-item count)
- **Created By** (member name, resolved via batched `getMember` calls)

Search runs across `packing_slip_number`, `customer_name`, `job_numbers`, `carrier` (debounced 300ms). Row click opens `PackingSlipPreviewDialog` (PDF preview).

The list is hydrated via `listShipmentsForCompanyWithJobs(companyId)` — two round trips: PostgREST with a nested join through `shipment_line_items → job_parts → jobs`, then batch-resolve `created_by` member IDs.

### Create Shipment — `/dashboard/{companyId}/shipments/new`

Two-step wizard:

1. **Customer picker** (`SearchableSelect`). Pre-selectable via `?customer=` query param.
2. **`ShipmentForm`** in customer mode (`source: {kind: 'customer', customerId}`).

`ShipmentForm` is also reused from the job detail page (`source: {kind: 'job', jobId}`) for single-job creation.

The form:

- Loads customer context (addresses only — there are no per-customer shipping defaults anymore).
- Loads open lines via `getOpenJobPartsForCustomer(companyId, customerId, {excludeFullyShipped: true, excludeCancelled: true})`.
- Renders a checkbox table of open lines with a per-line **qty** input (warns when `qty > qty_remaining`, blocks submit when all qtys are zero).
- Customer mode shows a "Ready to Ship" filter chip (`production_status != 'cancelled'` AND `fulfillment_status != 'fully_shipped'`) and a search input over part name / job number / customer PO. **Single-job enforcement:** selecting a line locks the slip to that job — line groups for other jobs are disabled until the selection is cleared.
- Shipment-level fields: `ship_date` (today), `shipping_address_id` (customer addresses), **`shipping_method`** (required dropdown), and **`carrier`** (a UPS/FedEx/USPS/Other dropdown shown only when `shipping_method='shipment'`; "Other" reveals a free-text carrier field), `notes`.
- Submit calls `createShipment(companyId, payload)` which routes through `create_shipment_with_line_items` (which derives the job and mints the PS number).
- Post-create the form opens `PackingSlipPreviewDialog` showing the PDF, then navigates back to `/shipments`.

### Job detail — `ShipmentHistoryCard`

Embedded on the job detail page. Lists shipments for the job (`getShipmentsForJob(jobId)`), newest first by `ship_date` then `created_at`. Rolls up the inner-joined line items so each shipment appears once. Columns: Packing Slip #, Ship Date, Method, Carrier, Qty, Actions (View / Print). A `refreshKey` prop triggers refetch after a new shipment is created; `initialPreviewShipmentId` auto-opens the preview dialog on first mount (post-create flow).

---

## Access Layer

`utils/shipmentsAccess.ts`:

| Function | Purpose |
|---|---|
| `createShipment(companyId, payload)` | Validates non-empty line items, calls the RPC, returns `{shipmentId, packingSlipNumber}` |
| `getShipmentById(shipmentId)` | Hydrated `ShipmentWithRelations` (customer, addresses, nested line_items with job + part) |
| `getShipmentsForJob(jobId)` | Filtered via `line_items.job_part.job_id`; newest-first |
| `listShipmentsForCompany(companyId, filters?)` | Flat list |
| `listShipmentsForCompanyWithJobs(companyId, filters?)` | List page hydration: `job_numbers[]`, `line_item_count`, resolved `created_by_member` |
| `getJobPartShipmentSummaries(jobId)` | `{job_part_id, qty_ordered, qty_shipped, qty_remaining (clamped ≥0), last_ship_date}` |
| `getJobShipmentSummary(jobId)` | Job-level rollup: ordered/shipped/remaining, last ship date, latest packing slip #, count |
| `getOpenJobPartsForCustomer(companyId, customerId, filter?)` | Open-lines picker for `ShipmentForm` |
| `resolveAttentionLine(shipment)` | Phase 1: ATTN: line comes from `shipping_address.attention_to` only |
| `voidShipment(shipmentId)` | Phase 3 placeholder; currently throws |

---

## Feature flag

The shipments UI is gated by `isShipmentsEnabled(company)` (see [`lib/featureFlags.ts`](../../lib/featureFlags.ts)). The DB columns and triggers ship to every tenant unconditionally — they're harmless when no shipments exist, and isolating the gate to UI + access layer lets the migration land before rollout.

---

## See also

- [Jobs](jobs.md) — for production_status and the job detail integration.
- [Customers](customers.md) — addresses live on `customer_addresses` and feed the `shipping_address_id` picker.
