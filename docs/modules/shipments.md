# Shipments Module

## Overview

Shipments capture what physically left the shop, when, to whom, against which job, and in what quantity. They generate packing slips, drive job auto-close, and decouple **fulfillment status** (what the customer sees) from **production status** (what the shop is working on). Each shipment (and therefore each packing slip) belongs to exactly **one job**.

**Priority:** Built and shipped as a **core feature (always on)**. There is no per-tenant gate — the shipments feature flag was removed once it went general; `lib/featureFlags.ts` documents this and its `KNOWN_FEATURES` registry no longer contains a `shipments` key (the only opt-in flag left is `inventory_locations`).

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
| `shipping_address_id` | uuid? | FK → `customer_addresses` (`ON DELETE SET NULL`). The chosen shipping address; snapshotted into `ship_to_address` at insert. |
| `one_time_address` | jsonb? | Reserved for Phase 3 ad-hoc shipping; unused today (plain nullable jsonb, always NULL in Phase 1). No XOR constraint — the ship-to snapshot is the source of truth for the rendered address, so the earlier `shipments_one_address_source` XOR was dropped (migration `20260623021524`). |
| `packing_slip_number` | text | Unique per company. App-wide rule `PS-{jobBase}-{n}` (jobBase = `job_number` minus its alpha prefix, e.g. `J-0141` → `0141`; `n` starts at 1). Derived inline by the RPC under the per-job advisory lock — no per-company configurable format/counter. |
| `ship_date` | date | Defaults to `current_date` |
| `shipping_method` | enum-via-CHECK | `customer_pickup | personal_delivery | shipment | dropship | restock` (constraint `shipments_shipping_method_check`). Replaces the retired `shipping_arrangement`. |
| `carrier` | text? | A plain **label only — there is no carrier (FedEx/UPS/USPS) API integration**; nothing is rated, tracked, or labeled. Only set when `shipping_method='shipment'`. The form offers a UPS / FedEx / USPS / Other dropdown (`CARRIER_OPTIONS`); "Other" stores the typed free-text name here. No DB CHECK. |
| `created_by` | uuid? | FK → `auth.users`, `ON DELETE SET NULL` |
| `customer_name`, `bill_to_address`, `ship_to_address` | text?, jsonb?, jsonb? | Document-snapshot block frozen at insert by the `snapshot_shipment_party` trigger (`bill_to_address` = the customer's `default_billing` address; `ship_to_address` = the chosen shipping address). The packing-slip PDF renders these frozen snapshots, not the live address rows. |
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

`VOLATILE SECURITY DEFINER`. Derives the single job behind the line items (raises if zero or **more than one** distinct job — one slip = one job), takes a `pg_advisory_xact_lock` on that job, mints the packing-slip number `PS-{jobBase}-{n}` inline (`n = count of existing shipments for the job + 1`, collision-free under the lock), inserts the shipment + line items, snapshots `fulfillment_status` pre/post, writes the audit row when applicable, and **returns the new shipment's `id`** (a uuid). `createShipment` in the access layer then reads the minted `packing_slip_number` back in a second query so callers get `{shipmentId, packingSlipNumber}`.

Parameters mirror `CreateShipmentPayload` in `types/shipment.ts` (`p_company_id`, `p_customer_id`, `p_shipping_address_id`, `p_one_time_address`, `p_ship_date`, `p_carrier`, `p_shipping_method`, `p_line_items`); `job_id` is **not** a parameter — it's derived. The signature also carries a trailing `p_notes text DEFAULT NULL`, but it is **dead** — there is no `shipments.notes` column and the INSERT never uses it.

---

## Pages / surfaces

There is **no standalone `/dashboard/{companyId}/shipments` list page and no `/shipments/new` wizard** — both (and the sidebar entry) were removed once a packing slip became one-job (commit `c233b50`). Every shipment surface now lives on the **job detail page**: the `ShipmentsMenu` toolbar dropdown (view existing) and the `CreateShipmentModal` dialog (create). The residual `Header.tsx` "Shipments" / "New Shipment" title mappings are dead route matches with no page behind them.

### Job detail — `ShipmentsMenu`

A toolbar dropdown on the job detail page (mirrors `InvoicesMenu`), rendered whenever the job has at least one part. It loads the job's non-voided shipments via `getShipmentsForJob(jobId)` (newest first by `ship_date` then `created_at`) and rolls the inner-joined line items up to one entry per slip. The button reads `Shipments (n)`; each menu item shows the `packing_slip_number` (a red `VOIDED` tag when voided) + ship date and opens `PackingSlipPreviewDialog` on click. When `canShip`, a divider + **Create shipment** item invokes the page's `onCreate`, which opens `CreateShipmentModal`. A `refreshKey` prop re-pulls the list after a new shipment is created. Voiding is **not** on this menu — it lives inside the packing-slip preview (see below), so the destructive action is only reachable once the slip is on screen.

### Job detail — `CreateShipmentModal`

The single entry point for shipment creation now that a slip belongs to one job. A thin `Dialog` wrapper around `ShipmentForm` running in **`job` mode** (`source: {kind: 'job', jobId}`). On success it fires `onCreated`; the job detail page then auto-opens `PackingSlipPreviewDialog` for the new slip.

`ShipmentForm` (`components/shipments/ShipmentForm.tsx`) in job mode:

- Loads the job + its customer (addresses only — there are no per-customer shipping defaults) and the per-part shipped summary via `getJobPartShipmentSummaries(jobId)`.
- Renders a per-part table (Ordered / Already Shipped / Remaining / Ship Now), each row pre-filled with the full remaining qty and an inline consequence caption ("Completes this line" / "N will remain owed" / "Over-ships by N") computed by `lineShipConsequence`. It warns (soft) when `qty > qty_remaining` and blocks submit when every qty is zero.
- Shipment-level fields: `ship_date` (defaults to today), `shipping_address_id` (customer addresses; the ATTN preview reads the selected address's `attention_to`), **`shipping_method`** (required dropdown from `SHIPPING_METHOD_OPTIONS`), and **`carrier`** (a UPS/FedEx/USPS/Other dropdown from `CARRIER_OPTIONS`, shown only when `shipping_method='shipment'`; "Other" reveals a free-text carrier field whose typed value is stored in `shipments.carrier`). The carrier is a **label only** — selecting it does nothing beyond recording the string; there is no carrier API, so no rates, tracking, or labels.
- Submit calls `createShipment(companyId, payload)` → the `create_shipment_with_line_items` RPC (derives the job, mints the PS number). There is **no `notes` field** on the form or in `CreateShipmentPayload`.

**Job mode is the only reachable path.** `CreateShipmentModal` only ever passes `job` mode, so that is the entire shipped creation flow. `ShipmentForm` still carries a dormant `source: {kind: 'customer', customerId}` branch (a cross-job open-lines picker fed by `getOpenJobPartsForCustomer`), but **no surface routes to it** and it is not a carrier integration — just an alternate, unreachable creation UI. It is **dead code slated for excision — Planned (see #550)**; treat it as not part of the module. The dormant branch and `getOpenJobPartsForCustomer` are excluded from this doc's behavior.

---

## Access Layer

`utils/shipmentsAccess.ts`:

| Function | Purpose |
|---|---|
| `createShipment(companyId, payload)` | Validates non-empty line items, calls the RPC, returns `{shipmentId, packingSlipNumber}` |
| `getShipmentById(shipmentId)` | Hydrated `ShipmentWithRelations` (customer, addresses, nested line_items with job + part); resolves `created_by_member` |
| `getShipmentsForJob(jobId)` | Non-voided shipments filtered via `line_items.job_part.job_id`; newest-first; batch-resolves `created_by_member` |
| `listShipmentsForCompany(companyId, filters?)` | Flat list with optional customer/date/voided filters. No current caller — kept for reporting/future surfaces. |
| `countShipmentsForJob(jobId)` | Counts **all** rows (voided included) via the direct `shipments.job_id` column; used as `deleteJob`'s pre-delete FK guard |
| `getJobPartShipmentSummaries(jobId)` | `{job_part_id, qty_ordered, qty_shipped, qty_remaining (clamped ≥0), last_ship_date}` |
| `getJobShipmentSummary(jobId)` | Job-level rollup: ordered/shipped/remaining, last ship date, latest packing slip #, count |
| `getOpenJobPartsForCustomer(companyId, customerId, filter?)` | Feeds only `ShipmentForm`'s dormant customer-mode branch — no live caller; slated for removal with that branch (Planned, see #550) |
| `getJobLastShipDate(jobId)` | Wrapper over the `job_last_ship_date(uuid)` SQL helper (RPC) |
| `resolveAttentionLine(shipment)` | ATTN: line comes from the frozen `ship_to_address` snapshot's `attention_to` (shared by form preview + PDF so they can't drift) |
| `voidShipment(shipmentId)` | **Implemented.** Auth-guards, then stamps `voided_at`/`voided_by` (idempotent via `.is('voided_at', null)`); the void trigger reverses the fulfillment cascade. Invoked from the packing-slip preview's Void button. |

---

## Feature flag (removed — now core)

Shipments used to be gated by a per-tenant `settings.features.shipments` flag while it rolled out. It is now a **core feature enabled for every tenant**, and that flag has been removed from `lib/featureFlags.ts` (no `isShipmentsEnabled` helper, no `shipments` key in `KNOWN_FEATURES`, no sidebar/UI gate). The DB columns and triggers always shipped to every tenant unconditionally — harmless when no shipments exist — which is what let the flag be retired without a migration.

---

## Acceptance Criteria

Each bullet is a Given/When/Then scenario carrying a verification clause — a pointer to the test that proves it, a manual procedure, or an explicit automation-pending tag. Every editable entity has at least one edit -> save -> reload -> persists bullet. Doc-vs-code disagreements this audit surfaced are recorded in the divergence report on issue #347.

**Surface & access (no standalone page)**

- [ ] **Given** the app, **when** a user looks for a top-level shipments list route, **then** none exists — the only surfaces are `ShipmentsMenu` + `CreateShipmentModal` on the job detail page — *manual: no `app/dashboard/[companyId]/shipments/` directory (removed in commit `c233b50`); `getShipmentsForJob` is the only shipment read wired into a page (`components/jobs/ShipmentsMenu.tsx`)*.
- [ ] **Given** a job with at least one part, **when** the job detail page renders, **then** a `Shipments (n)` dropdown lists that job's non-voided slips newest-first and opens the packing slip on click — *automation-pending (`getShipmentsForJob`, `ShipmentsMenu`)*.
- [ ] **Given** shipments went general, **when** any tenant loads a job, **then** the feature is on with no per-company flag check — *manual: `lib/featureFlags.ts` `KNOWN_FEATURES` contains only `inventory_locations` + `ai_insights` (no `shipments` key, no `isShipmentsEnabled` helper); the registry itself is exercised by `__tests__/lib/featureFlags.test.ts > 'featureFlags: inventory_locations' > 'is registered in KNOWN_FEATURES (so /admin/companies renders a toggle)'`*.

**Create (job mode is the only wired path)**

- [ ] **Given** the Create Shipment dialog on a job, **when** the user sets per-part Ship-Now quantities and a shipping method and submits, **then** `createShipment` mints a `PS-{jobBase}-{n}` slip for that one job and the line items persist — *write path verified by `api/tests/integration/test_shipment_void_permutations.py > 'TestExplicitEdgeCases' > 'test_ship_10_void'` (the `_ship` helper drives the RPC and asserts the resulting fulfillment); reload-persistence E2E automation-pending (#367)*.
- [ ] **Given** back-to-back shipments on one job, **when** each is created, **then** every packing-slip number is distinct (advisory-lock sequence) — *verified by `api/tests/integration/test_shipment_void_permutations.py > 'TestConcurrencyAndUniqueness' > 'test_distinct_packing_slip_numbers_for_back_to_back_ships'`*.
- [ ] **Given** a create payload with no line items, **when** `createShipment` runs, **then** it throws before hitting the RPC (a zero-line slip is meaningless) — *verified by `api/tests/integration/test_shipment_void_permutations.py > 'TestConcurrencyAndUniqueness' > 'test_empty_line_items_is_caught_by_application_layer'` (documents the app-layer block; the raw INSERT is a harmless trigger no-op)*.
- [ ] **Given** the Ship-Now qty inputs, **when** a value is empty/zero, exactly the remaining, short, or over the remaining, **then** the row caption reads Not shipping / Completes this line / N will remain owed / Over-ships by N — *verified by `__tests__/components/shipments/shipmentFormHelpers.test.ts > 'lineShipConsequence' > 'returns none for empty, zero, negative, or non-numeric input'` AND `> 'lineShipConsequence' > 'returns over with the excess when shipping more than remaining'`*.
- [ ] **Given** a projected slip across a job's parts, **when** the chosen quantities close out every part (counting prior shipments), **then** the projected job status is `fully_shipped` — *verified by `__tests__/components/shipments/shipmentFormHelpers.test.ts > 'projectSlip' > 'projects fully_shipped when this slip completes every part'` AND `> 'projectSlip' > 'counts prior shipments toward part completion (cross-slip)'`*.

**Edit — Void (edit -> save -> reload -> persists)**

- [ ] **Given** an existing shipment, **when** a signed-in user voids it from the packing-slip preview, **then** `voided_at`/`voided_by` are stamped (idempotent — re-void is a no-op) and the menu re-pull no longer counts it toward fulfillment — *write path verified by `__tests__/utils/shipmentsAccess.test.ts > 'voidShipment' > 'stamps voided_at/voided_by on the row, guarded against re-void'`; reload-persistence E2E automation-pending (#367)*.
- [ ] **Given** a job shipped to `fully_shipped`, **when** the shipment is voided, **then** the job/part fulfillment reverts (e.g. ship 10 → `fully_shipped`, void → `unshipped`) with no new audit row for the reverse transition — *verified by `api/tests/integration/test_shipment_void_permutations.py > 'TestExplicitEdgeCases' > 'test_ship_10_void'` AND `> 'TestExplicitEdgeCases' > 'test_ship_5_ship_5_void_first'`*.
- [ ] **Given** a void with no user session, **when** `voidShipment` runs, **then** it throws and writes nothing — *verified by `__tests__/utils/shipmentsAccess.test.ts > 'voidShipment' > 'throws when no user is signed in (never writes)'`*.
- [ ] **Given** the `compute_job_part_fulfillment_status` function and the stored column, **when** ship/void steps replay, **then** they agree after every step — *verified by `api/tests/integration/test_shipment_void_permutations.py > 'TestExplicitEdgeCases' > 'test_compute_function_agrees_with_column_after_each_step'`*.

**Fulfillment derivation & downstream (dual/triple status)**

- [ ] **Given** an existing `job_part`, **when** its ordered `quantity` is raised above the shipped total (editable-order-quantity feature), **then** its `fulfillment_status` recomputes (a part `fully_shipped` at 10 flips to `partially_shipped` at 15) — *behavior verified by `__tests__/utils/jobsAccess.test.ts > 'updateJobPartQuantity' > 'allows INCREASING quantity even after the part is invoiced (the 10 -> 15 case)'`; the `recompute_job_part_fulfillment_from_qty` trigger is exercised live by `api/tests/integration/test_shipment_void_permutations.py` (permutation harness)*.
- [ ] **Given** an existing `job_part`, **when** a user tries to reduce its quantity below what is already shipped, **then** the update is blocked — *verified by `__tests__/utils/jobsAccess.test.ts > 'updateJobPartQuantity' > 'blocks reducing below the already-shipped quantity'`*.
- [ ] **Given** a partially-shipped part, **when** its production is cancelled, **then** it stays `partially_shipped` (cancellation is independent of fulfillment) — *verified by `api/tests/integration/test_shipment_void_permutations.py > 'TestCancellationFulfillmentIndependence' > 'test_partial_ship_then_cancel_keeps_partially_shipped'`*.
- [ ] **Given** a job crossing forward into `fully_shipped`, **when** the closing shipment commits, **then** exactly one `job_fulfillment_audit` row records it, keyed to the triggering shipment — *verified by `api/tests/integration/test_shipment_void_permutations.py > 'TestExplicitEdgeCases' > 'test_audit_causal_link_second_ship_closes'` AND `> 'TestExplicitEdgeCases' > 'test_audit_on_void_and_reship_two_rows'`*.
- [ ] **Given** any generated ship/void sequence up to length 4, **when** replayed against the DB, **then** column, job status, audit count, and `job_last_ship_date` all match the oracle — *verified by `api/tests/integration/test_shipment_void_permutations.py > 'test_all_short_permutations_agree_with_oracle'`*.

**Delete guard (job referencing shipments)**

- [ ] **Given** a job with no shipments or invoices, **when** it is deleted, **then** the delete succeeds scoped to `company_id` — *verified by `__tests__/utils/jobsAccess.test.ts > 'deleteJob' > 'deletes a job with no shipments or invoice, scoped to company_id (any status)'`*.
- [ ] **Given** a job that has shipment records, **when** deletion is attempted, **then** it is rejected and nothing is deleted (the `countShipmentsForJob` guard, counting voided rows too) — *verified by `__tests__/utils/jobsAccess.test.ts > 'deleteJob' > 'rejects when the job has shipment records and never deletes'` AND `__tests__/utils/shipmentsAccess.test.ts > 'countShipmentsForJob' > 'counts all shipment rows for a job via the direct job_id column'`*.

**Customer-consistency (DB triggers)**

- [ ] **Given** a shipment for customer A, **when** a line item is inserted whose `job_part` resolves to another customer, **then** the DB trigger raises — *verified by `api/tests/integration/test_shipment_customer_consistency.py > 'test_line_item_trigger_rejects_cross_customer_insert'` AND `> 'test_line_item_trigger_rejects_cross_customer_update'`*.
- [ ] **Given** an existing shipment, **when** an UPDATE tries to change `customer_id`, **then** it is rejected and the row is unchanged, while updating other fields (carrier, shipping_method) still succeeds — *verified by `api/tests/integration/test_shipment_customer_consistency.py > 'test_shipment_customer_id_immutable_trigger_rejects_change'` AND `> 'test_shipment_immutability_trigger_allows_other_field_updates'`*.

**Multi-tenant isolation (RLS)**

- [ ] **Given** user A, **when** they select / insert / update / delete a shipment in company B, **then** RLS returns empty (or blocks the insert) — *verified by `api/tests/database/test_rls_policies.py > 'TestShipmentsRLS' > 'test_select_cross_tenant_returns_empty'` AND `> 'TestShipmentsRLS' > 'test_insert_into_other_company_is_blocked'` AND `> 'TestShipmentsRLS' > 'test_update_cross_tenant_returns_empty'` AND `> 'TestShipmentsRLS' > 'test_delete_cross_tenant_returns_empty'`*.

**Packing slip (document snapshot)**

- [ ] **Given** a shipment, **when** its packing slip renders, **then** the Bill To / Ship To blocks come from the frozen `bill_to_address`/`ship_to_address` snapshots (not live address rows) and the ATTN line from `resolveAttentionLine` — *automation-pending (`snapshot_shipment_party` trigger, `resolveAttentionLine`, `utils/packingSlipPdf.ts`)*.

---

## See also

- [Jobs](jobs.md) — for production_status and the job detail integration.
- [Customers](customers.md) — addresses live on `customer_addresses` and feed the `shipping_address_id` picker.
