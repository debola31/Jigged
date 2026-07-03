# Invoicing

How Jigged bills a job. Invoicing is delegated to **QuickBooks Online (QBO)** — QBO
owns the invoice document and numbering — while Jigged owns the invoice **record** and
the **per-part quantities** each invoice billed. See also
[quickbooks integration](../../CLAUDE.md) provenance, [jobs](jobs.md), and
[shipments](shipments.md).

## Model: many invoices per job, billed by quantity

A job has **many** invoices (progressive billing), independent of shipments — a job might
have 3 invoices + 3 shipments, 1 invoice covering 3 shipments, or 2 + 3, in any
combination. When creating an invoice the user picks a **per-part quantity to bill**.

- **Ordered-cap (not ship-cap):** you can bill up to the **ordered** quantity that isn't
  yet invoiced (`invoiceable = qty_ordered − qty_invoiced`). Invoicing is **not** hard-gated
  on shipping — a packing slip is a document, not a delivery, and coupling billing to it
  created awkward states (voiding a slip yanking on invoiceable). The picker **defaults**
  each line to the shipped-but-unbilled qty and shows a soft "only N shipped so far" nudge
  when you bill beyond it, but you may bill ahead. The over-invoice DB trigger enforces the
  `≤ ordered` invariant at rest.
- **Price lock:** each invoice **snapshots** the part's `unit_price` at push time. Once
  *any* quantity of a part is invoiced, that part's price is locked (edit it via a
  QuickBooks credit/reissue). This keeps `job_parts.total_price` a faithful revenue figure.
- **Additive only (v1):** invoices are only ever created. Reducing a line below what's
  already invoiced is blocked; corrections/voids/credits happen directly in QuickBooks.
  (`quickbooks_invoice_links.voided_at` exists and is filtered everywhere, so a future
  in-app void/credit phase needs no schema change.)

### The 10 → 15 journey
Order 10 → ship & invoice 9 → customer bumps the order to 15 → ship & invoice the
remaining 6. The increase is billed by a **new** invoice, never by revising the first
(the industry norm). Raising `job_parts.quantity` reopens the part from `fully_invoiced`
to `partially_invoiced` via a trigger.

## Data

- `quickbooks_invoice_links` — one row per invoice (many per job). No longer
  `UNIQUE(job_id, realm_id)`; idempotency is keyed on a client-minted `qb_request_id`
  (`UNIQUE(realm_id, qb_request_id)`).
- `quickbooks_invoice_line_items` — `(invoice_link_id, job_part_id, quantity, unit_price,
  total_price)`; `UNIQUE(invoice_link_id, job_part_id)`. The Jigged-side source of truth
  for qty-invoiced. Written service-role by the push endpoint, atomic with the QBO call.
  A `BEFORE INSERT` trigger hard-blocks over-invoicing (Σ created non-void qty ≤ ordered).
- `invoicing_status` on `job_parts` + `jobs` — `uninvoiced | partially_invoiced |
  fully_invoiced`, maintained by triggers cloned from the `fulfillment_status` family
  (`compute_job_part_invoicing_status`, `sync_job_invoicing_status_from_parts`, recompute
  on line-item change, link status/void change, and job_part quantity change).

## Flow (all through the existing FastAPI push endpoint — QBO tokens are service-role only)

1. **Preflight** (`POST /api/quickbooks/{company}/jobs/{job}/preflight`) → customer
   resolution + per-part billing context (`load_billable_parts`: ordered / shipped /
   invoiced / invoiceable + price).
2. **Create invoice** (`POST …/{job}/invoice`, body `{customer, request_id, lines[]}`):
   validate the selection against the ordered-cap (`load_firm_invoice_lines`), claim the
   idempotency row by `qb_request_id`, POST to QBO (`?requestid=` dedups), then persist
   the link (`status='created'`) + line snapshots. A double-submit of the same draft
   reuses `request_id` → one invoice; a genuinely new invoice carries a new id.

## UI (job detail page)

- **Create invoice** toolbar action → a per-part quantity picker (defaults to
  shipped−invoiced, capped at ordered−invoiced, with a soft "N shipped so far" nudge when
  billing ahead) + the customer step. Mints a fresh `request_id` per open.
- **Job page layout:** the detail page is grouped into collapsible **Production** /
  **Fulfillment** (shipments + invoices) / **Attachments** sections (static, state-based
  default expansion — Fulfillment opens once there's shipment/invoice activity; no per-user
  memory). Shipping + invoicing live together under Fulfillment.
- **Invoices card** lists every created invoice (doc #, date, parts × qty, amount, "View in
  QuickBooks"). Replaces the old single "View invoice" button.
- **Edit job**: quantity stays editable (upward) even after invoicing, down to
  `max(shipped, invoiced)`; a part's unit price is disabled once it has invoiced qty.

## Editing gates (`utils/jobsAccess.ts`)

- `updateJobPartQuantity` — floor is `max(qty_shipped, qty_invoiced)`; increases always
  allowed.
- `updateJobPartPrice` — blocked per-part once `qty_invoiced > 0` (untouched parts on a
  partially-invoiced job stay repriceable).
- `deleteJob` — still blocked when any created invoice (or shipment) exists.

## Not built (deferred)

In-app void / credit-memo / correction of a created invoice (do it in QBO). Jigged's
invoiced-qty reflects invoices *issued from Jigged*; a credit issued directly in QBO does
not sync back.
