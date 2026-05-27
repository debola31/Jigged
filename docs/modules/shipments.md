# Shipments Module

## Overview

Shipments capture what physically left the shop, when, to whom, against which job(s), and in what quantity. They generate packing slips, drive job auto-close, and decouple **fulfillment status** (what the customer sees) from **production status** (what the shop is working on).

**Priority:** Built; in production behind a per-tenant feature flag (`settings.features.shipments`). See [`lib/featureFlags.ts`](../../lib/featureFlags.ts).

**Dependencies:** [Jobs](jobs.md), [Customers](customers.md). Updates `jobs.fulfillment_status` via DB triggers.

The product reasoning behind this module is preserved in [PRD-shipments-2.md](PRD-shipments-2.md) (Cagan/Fadell-framed discovery doc). This file describes the implementation.

---

## Data Model

### `shipments` table

One row per packing slip.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid | PK |
| `company_id` | uuid | FK |
| `customer_id` | uuid | FK |
| `shipping_address_id` | uuid? | FK → `customer_addresses` (XOR with `one_time_address`) |
| `one_time_address` | jsonb? | Phase 3 (XOR via `shipments_one_address_source` constraint) |
| `packing_slip_number` | text | Unique per company; formatted via `format_packing_slip_number` and a row-locked counter on `companies.packing_slip_next_seq` |
| `ship_date` | date | Defaults to `current_date` |
| `carrier` | text? | |
| `tracking_number` | text? | |
| `shipping_arrangement` | enum-via-CHECK | `prepaid_and_add | prepaid | collect | third_party_account | customer_pickup | customer_arranged_freight | other` |
| `shipping_arrangement_other` | text? | Required when `shipping_arrangement='other'` (CHECK constraint `shipments_arrangement_other_text`) |
| `weight_lbs`, `package_count`, `package_type` | various | |
| `notes`, `coc_text` | text? | |
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

Three trigger chains keep `fulfillment_status` consistent:

1. `recompute_job_part_fulfillment_from_line` — AFTER INS/UPD/DEL on `shipment_line_items`, recomputes `job_parts.fulfillment_status`.
2. `recompute_job_part_fulfillment_from_void` — AFTER UPD `voided_at` on `shipments`, cascades void to dependent line items.
3. `sync_job_fulfillment_status_from_parts` — AFTER INS/UPD `fulfillment_status` / DEL on `job_parts`, recomputes `jobs.fulfillment_status`.

The derivation functions are:

- `compute_job_part_fulfillment_status(uuid)` STABLE → `unshipped | partially_shipped | fully_shipped`, comparing `SUM(non-voided line item quantities)` vs `job_parts.quantity`.
- `compute_job_fulfillment_status(uuid)` STABLE → aggregates child statuses (does **not** exclude cancelled parts per PRD §7.1).

A job auto-closes (fulfillment_status → `fully_shipped`) when `SUM(shipped) ≥ SUM(ordered)` for all non-cancelled job_parts.

---

## RPC: `create_shipment_with_line_items`

`VOLATILE SECURITY DEFINER`. Inserts a shipment and its line items in a single transaction with sorted `pg_advisory_xact_lock` per affected job (deadlock-free), snapshots `fulfillment_status` pre/post, writes the audit row when applicable, and returns `{shipmentId, packingSlipNumber}`.

Parameters mirror `CreateShipmentPayload` in `types/shipment.ts`.

---

## Pages

### List — `/dashboard/{companyId}/shipments`

Feature-gated by `isShipmentsEnabled(company)`. AG Grid with columns:

- **Packing Slip #** (blue, bold)
- **Ship Date** (formatted "MMM D, YYYY")
- **Customer**
- **Jobs** (chip list — a shipment can span multiple jobs)
- **Carrier**, **Tracking**
- **Lines** (line-item count)
- **Created By** (member name, resolved via batched `getMember` calls)

Search runs across `packing_slip_number`, `customer_name`, `tracking_number`, `job_numbers`, `carrier` (debounced 300ms). Row click opens `PackingSlipPreviewDialog` (PDF preview).

The list is hydrated via `listShipmentsForCompanyWithJobs(companyId)` — two round trips: PostgREST with a nested join through `shipment_line_items → job_parts → jobs`, then batch-resolve `created_by` member IDs.

### Create Shipment — `/dashboard/{companyId}/shipments/new`

Two-step wizard:

1. **Customer picker** (`SearchableSelect`). Pre-selectable via `?customer=` query param.
2. **`ShipmentForm`** in customer mode (`source: {kind: 'customer', customerId}`).

`ShipmentForm` is also reused from the job detail page (`source: {kind: 'job', jobId}`) for single-job creation.

The form:

- Loads customer context (default carrier, default shipping arrangement, default COC text, addresses).
- Loads open lines via `getOpenJobPartsForCustomer(companyId, customerId, {excludeFullyShipped: true, excludeCancelled: true})`.
- Renders a checkbox table of open lines with a per-line **qty** input (warns when `qty > qty_remaining`, blocks submit when all qtys are zero).
- Customer mode shows a "Ready to Ship" filter chip (`production_status != 'cancelled'` AND `fulfillment_status != 'fully_shipped'`) and a search input over part name / job number / customer PO.
- Shipment-level fields: `ship_date` (today), `shipping_address_id` (customer addresses), `carrier`, `tracking_number`, `shipping_arrangement` (dropdown; `shipping_arrangement_other` shown when `other`), `weight_lbs`, `package_count`, `package_type`, `notes`, `coc_text`.
- Submit calls `createShipment(companyId, payload)` which routes through `create_shipment_with_line_items`.
- Post-create the form opens `PackingSlipPreviewDialog` showing the PDF, then navigates back to `/shipments`.

### Job detail — `ShipmentHistoryCard`

Embedded on the job detail page. Lists shipments for the job (`getShipmentsForJob(jobId)`), newest first by `ship_date` then `created_at`. Rolls up the inner-joined line items so each shipment appears once. Columns: Packing Slip #, Ship Date, Carrier, Tracking, Created By, Qty, Actions (View / Print). A `refreshKey` prop triggers refetch after a new shipment is created; `initialPreviewShipmentId` auto-opens the preview dialog on first mount (post-create flow).

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
- [PRD-shipments-2.md](PRD-shipments-2.md) — original product-discovery PRD.
