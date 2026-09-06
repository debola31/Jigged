# Shipments Module

> **Condensed 2026-08-03** for [#634](https://github.com/debola31/Jigged/issues/634): **3,046 → 2,256 words**
> (`wc -w`) — a 26% cut *while adding* the freight model the doc had omitted entirely. Cut: the acceptance-criteria block (39% of
> the doc — every bullet restated the test it cited); the "Feature flag (removed)" section, which repeated the
> Overview; UI prose a component open reproduces. Kept: the one-slip-one-job invariant, the
> dead-but-undroppable `p_notes` parameter, the dormant customer-mode branch, invoicing-is-decoupled, every gap.
>
> **Corrections against the code.** *(1) The data model omitted three shipped columns — `freight_terms`,
> `customer_carrier_account_id`, `freight_account_snapshot` — with their two CHECK constraints, and the access
> table omitted `resolveFreightLine`. Added; the reasoning is owned by [customers.md](customers.md).
> (2) The doc said the form loads the customer's "addresses only — there are no per-customer shipping
> defaults". False since Aug 2026: `customer_carrier_accounts` is exactly such a default. (3) The doc
> contradicted itself on the flag registry ("only `inventory_locations` left" vs "`inventory_locations` +
> `ai_insights`"). No count is restated here — [`lib/featureFlags.ts`](../../lib/featureFlags.ts) is the enforcement.
> (4) Three items were tagged "Planned — see #550"; **#550 is CLOSED** (the #332 audit's finished checklist),
> so they are now untracked gaps.)*

## Overview

Shipments capture what physically left the shop, when, to whom, against which job, and in what quantity. They
generate packing slips, drive job auto-close, and decouple **fulfillment status** (what the customer sees)
from **production status** (what the shop is working on). Each shipment — and therefore each packing slip —
belongs to exactly **one job**.

**Priority:** built, core, always on. The `shipments` flag was removed from `lib/featureFlags.ts` when it went
general; no migration was needed because the columns and triggers always shipped to every tenant
unconditionally, harmless when no shipments exist.

**Dependencies:** [Jobs](jobs.md), [Customers](customers.md). Updates `jobs.fulfillment_status` via DB
triggers. The standalone discovery PRD was folded in and removed; its revisions are in git history.

---

## Data Model

### `shipments` — one row per packing slip

| Column | Notes |
|---|---|
| `id`, `company_id`, `customer_id` | uuid |
| `job_id` | NOT NULL FK → `jobs`. The single job this slip belongs to and the source of its number; enforced by the RPC (all line items must resolve to one job). |
| `shipping_address_id` | FK → `customer_addresses` (`ON DELETE SET NULL`); snapshotted into `ship_to_address` at insert. |
| `one_time_address` | jsonb, reserved for Phase 3 ad-hoc shipping, always NULL today. No XOR constraint — the ship-to snapshot is the source of truth for the rendered address, so `shipments_one_address_source` was dropped (migration `20260623021524`). |
| `packing_slip_number` | Unique per company. App-wide rule `PS-{jobBase}-{n}` (jobBase = `job_number` minus its alpha prefix, `J-0141` → `0141`; `n` from 1), minted inline by the RPC under the per-job advisory lock. No per-company format or counter. |
| `ship_date` | date, defaults `current_date`. |
| `shipping_method` | `customer_pickup \| personal_delivery \| shipment \| dropship \| restock` (`shipments_shipping_method_check`). Replaced the retired `shipping_arrangement`. |
| `carrier` | A **label only — there is no carrier API**; nothing is rated, tracked or labeled. Set only when `shipping_method='shipment'`. UPS/FedEx/USPS/Other (`CARRIER_OPTIONS`); "Other" stores the typed name. No DB CHECK. |
| `freight_terms` | `prepaid \| collect \| third_party \| customer_arranged` (`shipments_freight_terms_check`). A second CHECK, `shipments_freight_terms_method_check`, permits non-NULL only when `shipping_method IN ('shipment','dropship')` — nobody bills freight on a pickup or a restock. |
| `customer_carrier_account_id` | FK → `customer_carrier_accounts` (`ON DELETE SET NULL`). Navigation only; the document renders the snapshot. |
| `freight_account_snapshot` | jsonb **redacted** freeze at ship time: `{carrier, bill_to_party, has_account, account_last4}`. Never the full account number — the slip leaves the building. `account_last4` is NULL at ≤ 4 chars, because showing 3 of 4 is not redaction. |
| `customer_name`, `bill_to_address`, `ship_to_address` | Document snapshot frozen at insert by `snapshot_shipment_party` (`bill_to_address` = the customer's `default_billing`). The PDF renders these, never the live address rows. |
| `heat_numbers_snapshot` | jsonb array, `NOT NULL DEFAULT '[]'`, frozen by the RPC at creation (2026-09-04): the DISTINCT `(heat_number, item_name)` pairs on the job's `inventory_transactions` depletions, as `[{heat_number, material_name}]` ordered by material then heat. The slip prints one `Material heat no(s).` line in SHIPMENT DETAILS **only when the array is non-empty** — most shops record no heats, and a blank line would read as a missing value on a dock. A heat corrected on the ledger afterwards never rewrites a slip a customer holds: void and reissue. Read through `parseHeatNumbersSnapshot` / `describeHeatNumbers` in `types/shipment.ts`. Why the heat lives on the movement and not on a lot: [inventory.md §5.6](inventory.md#56-lots--resolved-dont-build-them). |
| `created_by` | FK → `auth.users`, `ON DELETE SET NULL`. |
| `voided_at`, `voided_by` | |

Freight is a three-grain model (customer default → job → frozen shipment); the reasoning — why the job grain
is the point, why `prepaid_and_add` is excluded, how the account is kept off the AI surface — is owned by
**[customers.md](customers.md)** and not repeated here.

`enforce_shipment_address_contact_customer` (BEFORE INS/UPD OF `shipping_address_id`, `customer_id`,
`customer_carrier_account_id`) verifies both FKs belong to `customer_id`. **Its `UPDATE OF` list is narrower
than the jobs trigger's** — drop a column from it and an update touching only that column never fires the
guard, at exactly the grain where the money moves.

**`shipment_line_items`:** one row per `(shipment_id, job_part_id)`, `quantity numeric > 0`.
**`job_fulfillment_audit`:** append-only record of **forward** transitions to `fully_shipped`, written by the
RPC.

---

## Fulfillment lifecycle (dual-status)

Jobs carry two independent columns: **`production_status`** (`not_started | in_progress | completed |
cancelled`) and **`fulfillment_status`** (`unshipped | partially_shipped | fully_shipped`) — the latter
**derived, never written directly**.

| Trigger | Fires on | Recomputes |
|---|---|---|
| `recompute_job_part_fulfillment_from_line` | AFTER INS/UPD/DEL `shipment_line_items` | `job_parts.fulfillment_status` |
| `recompute_job_part_fulfillment_from_void` | AFTER UPD `shipments.voided_at` | cascades the void to dependent lines |
| `recompute_job_part_fulfillment_from_qty` | AFTER UPD OF `job_parts.quantity` | that part. Needed because editing the *ordered* qty changes the shipped-vs-ordered comparison but fires no shipment-keyed trigger — `fully_shipped` at 10 must flip to `partially_shipped` at 15. |
| `sync_job_fulfillment_status_from_parts` | AFTER INS/UPD `job_parts.fulfillment_status` / DEL | `jobs.fulfillment_status` |

`compute_job_part_fulfillment_status(uuid)` compares `SUM(non-voided line quantities)` vs
`job_parts.quantity`; `compute_job_fulfillment_status(uuid)` rolls the children up — `fully_shipped` only when
**every** `job_parts` row is, `partially_shipped` if any is partial-or-full, else `unshipped`. It **does not
exclude cancelled parts**, and there is no `SUM`: the rollup is over per-part *statuses*, counted across
**all** parts including cancelled ones, so a cancelled-and-unshipped part holds the whole job off
`fully_shipped`. *(⚠ This doc previously cited "PRD §7.1" for the cancelled-parts rule — **prd.md has never
had a §7.1**; its sections run 1, 1.1, 2, 2.1, 4.1–4.3, 5, 5.1, 6, 7, 8, 8.1, 9. The function body is the
enforcement, and `TestCancellationFulfillmentIndependence` is the test. The same passage then contradicted
itself one clause later with "across non-cancelled parts".)*
`qty_remaining` is derived live, so it always reflects the **current** ordered quantity including a
post-conversion edit; conversely `updateJobPartQuantity` refuses to lower a part below
`max(already-shipped, already-invoiced)`.

⚠ **Two different numbers share the name `qty_remaining`.** The job surfaces (jobs list, ship form,
`getJobPartShipmentSummaries`) answer *what is open on this job right now* — every non-voided slip
netted out. The **packing slip's Qty Remaining column** answers *what was still open as of that
shipment* — only the slips ordered at-or-before it, so opening slip #1 after slip #2 exists still
reads 10, not 0. Collapsing the two is the bug this column shipped with: it subtracted only the
slip's own quantity, so slip #2 of a 40-piece job printed "30 remaining" after 30 had already gone
out. `getShippedBeforeShipment` is the point-in-time half and is deliberately separate from
`getJobPartShipmentSummaries`, which structurally cannot answer it.

**Invoicing is decoupled from shipping.** Billing is capped at the **ordered** quantity, not the shipped one —
a packing slip is a document, not a delivery. The invoice picker only *defaults* to shipped-but-unbilled and
nudges past it, so voiding a shipment does not yank on what you can invoice. A third axis,
`invoicing_status`, mirrors this whole trigger family: "dual-status" is historical, there are three. See
[Invoicing](invoicing.md).

---

## RPC: `create_shipment_with_line_items`

`VOLATILE SECURITY DEFINER`. Derives the single job behind the line items (raises on zero **or more than
one**), takes `pg_advisory_xact_lock` on it, mints `PS-{jobBase}-{n}` inline (`n` = existing shipments + 1,
collision-free under the lock), freezes the job's material heat numbers into `heat_numbers_snapshot`
(2026-09-04 — `[]` when none was recorded), inserts shipment + lines, snapshots `fulfillment_status`
pre/post, writes the audit row when the job crosses forward, and returns the shipment **id**. Since
`20260904063844` its EXECUTE is granted by name to `authenticated` and `service_role` and revoked from
`PUBLIC`/`anon` — before that it was reachable only through PUBLIC's built-in default, which the 2026-08-01
recreation had silently left it on. `createShipment` reads the minted
number back in a second query so callers get `{shipmentId, packingSlipNumber}`. Parameters mirror
`CreateShipmentPayload` in `types/shipment.ts`; `job_id` is **not** one — it is derived.

Two traps, recorded in migration `20260801030048`, both of which apply cleanly and break production:

- **`p_notes text DEFAULT NULL` is dead** — no `shipments.notes` column, never used by the INSERT — and
  **cannot be dropped.** `shipmentsAccess.ts` supplies ten named arguments (`p_company_id`, `p_customer_id`,
  `p_shipping_address_id`, `p_one_time_address`, `p_ship_date`, `p_carrier`, `p_shipping_method`,
  `p_line_items`, `p_freight_terms`, `p_customer_carrier_account_id`) and omits `p_notes`; PostgREST resolves
  an RPC by the set of names supplied, so removing the default makes every shipment creation return
  `PGRST202`. All defaulted parameters stay trailing — `p_notes` is the first of three, ahead of the two
  freight ones. (Migration `20260801030048`'s own comment says "EIGHT named arguments"; that was the count
  before the same migration's frontend half added the two freight arguments. Count the call site, not the
  comment.)
- **`DROP FUNCTION IF EXISTS` against a wrong signature succeeds and does nothing**, leaving the old
  `SECURITY DEFINER` overload alive with its grants and letting PostgREST pick. The migration ends with a
  `DO $$` block asserting exactly one overload exists, turning a silent miss into a failed migration.

### Certificate of Conformance text — built, then dropped (2026-06-21)

The baseline schema carried a three-level CoC cascade — `shipments.coc_text` →
`customers.default_coc_text` → `companies.default_coc_text` — printed as a block on the packing slip.
Migration `20260621161856` dropped all three (with tracking number, weight, package count and type) as
*"fields the shop doesn't need at packing-slip time"*, and nothing survives in schema or UI. Recorded here
because it was re-discovered from the migration alone on 2026-09-03 while planning heat numbers, which are a
different thing (a fact about the material, on the movement — [inventory.md §5.6](inventory.md#56-lots--resolved-dont-build-them))
and deliberately do **not** bring CoC text back. If a customer ever asks for a conformance statement, it is a
fresh build on the snapshot pattern, not a revival.

---

## Pages / surfaces

There is **no `/dashboard/{companyId}/shipments` list page and no `/shipments/new` wizard** — both, and the
sidebar entry, went when a packing slip became one-job (commit `c233b50`). Everything lives on the **job
detail page**. The residual `components/layout/Header.tsx` "Shipments" / "New Shipment" title mappings are
dead route matches with no page behind them.

- **`components/jobs/ShipmentsMenu.tsx`** — toolbar dropdown (mirrors `InvoicesMenu`), rendered whenever the
  job has ≥1 part; reads `Shipments (n)` and opens `PackingSlipPreviewDialog`. **Voiding is deliberately not
  on this menu** — it lives inside the preview, so the destructive action is only reachable once the slip is
  on screen.
- **`components/shipments/CreateShipmentModal.tsx`** — thin `Dialog` around `ShipmentForm` in **`job` mode**;
  the job page auto-opens the preview for the new slip.
- **`components/shipments/ShipmentForm.tsx`** — per-part table (Ordered / Already Shipped / Remaining / Ship
  Now) pre-filled with the full remaining qty and captioned by `lineShipConsequence`. Over-shipping **warns,
  never blocks**; submit is blocked only when every qty is zero. No notes field.

**Freight in the form.** `resolveFreightLine` runs once at load, not at submit, so the shipper *sees* what
will happen and can override it instead of discovering it on the slip. The resolved account **seeds** the
carrier select (case-insensitive match, else "Other" with the name filled in) — a visible default, not a
forced value, because a shipment genuinely can move on a different carrier than the account it bills to.
`carrierAccountMismatch` returns a *message*, never a verdict, and is computed **outside** the validation memo
so freight can never reach `canSubmit`.

**Job mode is the only reachable path.** `ShipmentForm` still carries a `source: {kind: 'customer'}` branch (a
cross-job open-lines picker fed by `getOpenJobPartsForCustomer`) but **nothing routes to it**. Dead code
awaiting excision — **untracked gap** *(was "Planned — see #550"; #550 is closed)*. Its behaviour is excluded
from this doc.

---

## The printed slip

**No signature block, since 2026-09-05.** The slip carried `RECEIVED BY` with Signature / Print Name
/ Date. It went on the reasoning that kept one off the vendor slip
([outside-processing.md](outside-processing.md)): a packing slip is a **contents list**. The bill of
lading governs movement and ownership, proof of delivery is a separate signed receipt, and the
freight literature is blunt that treating a packing slip as proof of delivery is *"a frequent and
costly mistake"* — it is not a release document, and a signature line does not make it one.

On the customer document that is the worse failure, because it invites a **customer** to treat a
signed copy as something it legally is not. Nothing captured it either: the signed copy leaves with
whoever took delivery. What this system records is the shipment row and its line quantities, which is
what `fulfillment_status` is derived from. The page-break guard went with it — it existed only so the
block was never orphaned at the foot of a page. Asserted by
`__tests__/utils/packingSlipPdf.test.ts` › `what it deliberately omits`.

## Access Layer — `utils/shipmentsAccess.ts`

| Function | Purpose |
|---|---|
| `createShipment(companyId, payload)` | Validates non-empty lines, calls the RPC, returns `{shipmentId, packingSlipNumber}` |
| `getShipmentById(shipmentId)` | Hydrated `ShipmentWithRelations`; resolves `created_by_member` |
| `getShipmentsForJob(jobId)` | Non-voided, filtered via `line_items.job_part.job_id`, newest-first |
| `listShipmentsForCompany(companyId, filters?)` | Flat list, optional customer/date/voided filters. **No current caller** — kept for reporting |
| `countShipmentsForJob(jobId)` | Counts **all** rows incl. voided via the direct `shipments.job_id` column. No longer gates `deleteJob` ([architecture.md §16](../architecture.md)) |
| `getJobPartShipmentSummaries(jobId)` | `{job_part_id, qty_ordered, qty_shipped, qty_remaining (clamped ≥0), last_ship_date}` — sums **every** non-voided slip on the job |
| `getShippedBeforeShipment(shipment)` | `Map<job_part_id, qty>` for the slips ordered **before** this one — the packing slip's point-in-time backlog. One query on `shipments.job_id` (one slip = one job); voided siblings excluded in SQL; the tuple predicate is applied in TS because PostgREST has no compound `<` |
| `compareShipmentOrder(a, b)` | Total order over a job's slips: `ship_date` → `created_at` (parsed as an instant, not text) → `id` |
| `getJobShipmentSummary(jobId)` | Job rollup: ordered/shipped/remaining, last ship date, latest slip #, count |
| `getOpenJobPartsForCustomer(companyId, customerId, filter?)` | Feeds only the dormant customer-mode branch; same untracked-excision gap |
| `getJobLastShipDate(jobId)` | Wrapper over the `job_last_ship_date(uuid)` SQL helper |
| `resolveAttentionLine(shipment)` | ATTN line from the frozen `ship_to_address` snapshot — shared by form preview + PDF so they cannot drift |
| `resolveFreightLine(args)` | → `{terms, account, requiresChoice, source}`. **The job wins over the customer default:** a customer who normally ships collect can send one PO saying "this one prepaid", and re-deriving at pack time would quietly contradict it. Returns `requiresChoice: true` rather than guessing when the customer holds >1 live account and the job named none |
| `voidShipment(shipmentId)` | Auth-guards, stamps `voided_at`/`voided_by`, idempotent via `.is('voided_at', null)`; the void trigger reverses the cascade |

The printed freight line comes from `describeShipmentFreight` (`types/shipment.ts`), built from the frozen
snapshot, never the live account row.

---

## Verified behaviour

As-built, verified 2026-08-03. Each row names the file + `describe`/class that enforces it.

| Behaviour | Enforced by |
|---|---|
| Ship/void permutations to length 4 agree with an oracle on column, job status, audit count and `job_last_ship_date`; the compute function agrees with the stored column after every step; forward-only audit rows keyed to the triggering shipment | `api/tests/integration/test_shipment_void_permutations.py` — `TestExplicitEdgeCases`, `test_all_short_permutations_agree_with_oracle` |
| Back-to-back shipments mint distinct slip numbers; an empty line-item payload is blocked at the app layer (the raw INSERT is a harmless trigger no-op) | same file — `TestConcurrencyAndUniqueness` |
| A partially-shipped part stays `partially_shipped` when production is cancelled | same file — `TestCancellationFulfillmentIndependence` |
| Cross-customer line items and any `customer_id` change are rejected by trigger; other field updates still succeed | `api/tests/integration/test_shipment_customer_consistency.py` (4 module-level tests) |
| Cross-tenant select/insert/update/delete is empty or blocked | `api/tests/database/test_rls_policies.py` — `TestShipmentsRLS` |
| `voidShipment` stamps, is re-void-guarded, and throws without writing when there is no session | `__tests__/utils/shipmentsAccess.test.ts` — `voidShipment` |
| Row consequence captions; projected job status counting prior shipments cross-slip | `__tests__/components/shipments/shipmentFormHelpers.test.ts` — `lineShipConsequence`, `projectSlip` |
| Carrier/account mismatch produces a message, and none when they match or either is blank | same file — `carrierAccountMismatch` |
| Freight precedence (job over customer); refusing to guess at >1 account; printed freight comes only from the snapshot | `__tests__/utils/customerCarrierAccountsAccess.test.ts` — `resolveFreightLine — the job wins over the customer default`, `pickCarrierAccount — refuses to guess`, `describeShipmentFreight — everything printed comes from the snapshot` |
| Raising an ordered quantity above the shipped total recomputes fulfillment; reducing below shipped is blocked | `__tests__/utils/jobsAccess.test.ts` — `updateJobPartQuantity` |
| Deleting a job **archives** it and never blocks, even with shipments and an invoice — the records-of-value guards were removed | `__tests__/utils/jobsAccess.test.ts` — `deleteJob` |
| Slip quantities net out prior shipments, clamp over-shipment, survive `numeric(12,2)` fractions, and hand a voided slip's own quantity back to the backlog; the two conditional columns keep head / body / `columnStyles` aligned in all four permutations | `__tests__/utils/packingSlipPdf.test.ts` — `computePackingSlipQuantities`, `generatePackingSlipPdf — the quantity table` |
| Prior-shipment lookup skips itself, later slips and same-timestamp-greater-id siblings, and throws rather than reporting zero prior | `__tests__/utils/shipmentsAccess.test.ts` — `compareShipmentOrder`, `getShippedBeforeShipment` |
| The footer carries `Generated {date} with jigged.app` and no longer restates the company name | `__tests__/utils/packingSlipPdf.test.ts` — `generatePackingSlipPdf — document branding` |
| The shop header stacks logo → name → address, sized to the space the header already occupies so it never pushes content down, and drops the name when the logo already carries it | `__tests__/utils/shopHeaderBlock.test.ts` — `drawShopHeaderBlock` |

**Gaps, automation-pending ([#367](https://github.com/debola31/Jigged/issues/367)):** reload-persistence E2E
for create and void; `ShipmentsMenu` rendering; the packing-slip PDF rendering Bill To / Ship To / ATTN from
the frozen snapshots (`snapshot_shipment_party`, `resolveAttentionLine`) — the slip's **quantity table** is
now covered, the address blocks are not.

---

## See also

- [Jobs](jobs.md) — `production_status` and the job-detail integration.
- [Customers](customers.md) — addresses, `customer_carrier_accounts`, and the freight model this doc defers to.
- [Invoicing](invoicing.md) — the third status axis.
