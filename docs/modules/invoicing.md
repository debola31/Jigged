# Invoicing

How Jigged bills a job. Invoicing is delegated to **QuickBooks** — which owns the invoice
document and its numbering — while Jigged owns the invoice **record** and the **per-part
quantities** each invoice billed.

A company connects **either QuickBooks Online or QuickBooks Desktop**, never both (a database
invariant, not just a route check). Everything on this page is true of both: the billing model,
the ordered cap, the price lock and the idempotency claim are one shared implementation. What
differs about Desktop — no deep link, no idempotency key, tax codes, the `needs_verification`
state — is [quickbooks-desktop.md](quickbooks-desktop.md). See also
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
- **Additive, except for correcting the record:** invoices are only ever *created* — a
  quantity increase is billed by a new invoice, never a revision — and reducing a
  *job part* below what is already invoiced stays blocked. What Jigged RECORDED an
  invoice as billing is separately correctable; see
  [§Correcting a recorded quantity](#correcting-a-recorded-quantity). Voids and credit
  memos still happen in QuickBooks.
  **Withdrawn:** *"corrections … happen directly in QuickBooks"* — wrong because the
  only in-QuickBooks correction that reaches Jigged is a void, which zeroes the whole
  invoice rather than one quantity, and never for Desktop.

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
  A `BEFORE INSERT OR UPDATE OF quantity, job_part_id, invoice_link_id` trigger hard-blocks
  over-invoicing (Σ created non-void qty ≤ ordered) — it covers a *corrected* line, not
  just a new one, and excludes the row's own invoice from the sum so a reduction always
  passes. **Withdrawn:** *"a `BEFORE INSERT` trigger"* — it never was INSERT-only
  ([`20260702011324`](../../supabase/migrations/20260702011324_multi_invoice_per_job.sql)).
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
- **The job's activity rail** carries an `Invoice created` row per invoice — same
  `getQuickBooksInvoiceLinksForJob` read, so it inherits the `status = 'created'` filter and a push
  that never landed can never reach the feed. It shows the number, Jigged's line total and the
  QuickBooks link — and deliberately **no payment chip**: see [§Payment status](#payment-status-quickbooks-online-mirror)
  for why a mirror with no paid-at cannot honestly be a row in a chronological feed.
- **Edit job**: quantity stays editable (upward) even after invoicing, down to
  `max(shipped, invoiced)`; a part's unit price is disabled once it has invoiced qty.

## Payment status (QuickBooks Online mirror)

**As-built 2026-09-03**, schema in
[`20260903203624`](../../supabase/migrations/20260903203624_qbo_invoice_payment_mirror.sql), logic in
`api/services/quickbooks.py`. A **read-only mirror of what QuickBooks Online last said** about each
invoice Jigged created, shown as a chip per row in the job page's Invoices menu. It answers one
question per invoice and feeds nothing else: no payment record, no aging bucket, no statement, no
dunning, and `customers.credit_status` is still typed by a human
([customers.md](customers.md#credit-hold)). **Online only** — a Desktop read is a Web Connector
round trip to a PC that may be off ([quickbooks-desktop.md](quickbooks-desktop.md)).

Seven columns on `quickbooks_invoice_links`, all NULL until a read succeeds:

| Column | What it holds |
|---|---|
| `qb_status` | `paid` / `partial` / `open` / `voided` / `missing`. NULL means **never checked**, and a DB CHECK ties it to `qb_status_checked_at` so no row can claim a status nobody can date |
| `qb_total_amt` | `Invoice.TotalAmt` — **tax-inclusive**, so it may legitimately exceed Jigged's line total |
| `qb_balance` | `Invoice.Balance`: what is still owed. 0 is paid |
| `qb_due_date` | `Invoice.DueDate` as QuickBooks computed it from the terms. NULL means QBO reported none, and such an invoice never renders overdue |
| `qb_txn_date` | `Invoice.TxnDate` — for Online this is the authoritative invoice date, not `transaction_date` (which is what the browser sent at push time) |
| `qb_status_checked_at` | When Intuit last **answered**. Stamped only on a definitive answer |
| `qb_stale_at` | When a webhook last said this invoice changed |

### The status rule

Evaluated top-down, stored, and **clock-free** — the same order in the backend and in the chip:

| Condition | `qb_status` |
|---|---|
| The id was absent from a successful query **and** absent again from a per-id confirm query | `missing` |
| `total_amt == 0` while Jigged's line total is > 0 | `voided` |
| `balance <= 0` | `paid` |
| `0 < balance < total_amt` | `partial` |
| otherwise | `open` |

**`jigged_total` (Σ `quickbooks_invoice_line_items.total_price`) is used for the void test and
nothing else.** QuickBooks totals are tax-inclusive and Jigged's are not, so comparing the two to
decide partial vs open would report a fully-paid taxable invoice as partly paid forever. Partial is
decided against QuickBooks' own total, never against ours.

**The $0 edge is deliberately read as a void.** A voided QBO invoice keeps its number and reports
`TotalAmt` 0; so does an invoice a bookkeeper discounted to nothing. Both mean "this invoice is no
longer money owed", the quantity should reopen either way, and Intuit exposes nothing that
distinguishes them.

**Overdue is not stored.** It depends on today, so it is derived at render from `qb_due_date` — a
stored `overdue` would be a claim that goes wrong overnight with nobody writing to the row.

**Deleted takes two successful observations.** A QBO query that omits an id proves nothing on its
own — batching, paging and minor-version behaviour can all drop one — so an absent id is re-asked
for by id, and only a second successful miss writes `missing`. It is not terminal: every later
refresh queries it again, and an invoice that comes back clears it.

### A failed read is never written down

`qb_status_checked_at` moves only on a definitive answer. An Intuit outage, an expired refresh
token, a timeout — none of them touch the row, and the menu keeps showing the last answer **with
the date it was given**. The route says so out loud (409 `qbo_unreachable`, *"Showing what it last
said"*) rather than rendering an unchecked invoice as open or unpaid: **"couldn't check" is never
"nothing was paid"**, which is the same rule the PO-field discovery follows
([customers.md](customers.md#quickbooks)).

**The monotonic guard.** `apply_qbo_invoice_mirror` ignores a row whose `qb_status_checked_at` is
already newer than the pass being applied. Two people opening the same job, or a menu open racing
the launch backfill, otherwise let the slower Intuit response land last and flip a paid invoice back
to open. Same shape as `apply_stripe_subscription`'s guard on event time.

**The realm rule.** The write matches on `company_id` **and** `realm_id`, and the route counts what
it left alone as `skipped_other_realm`. A shop that disconnects and connects a different QuickBooks
company keeps its old invoices exactly as they last read: an Intuit invoice id is only meaningful
inside the realm that issued it, and re-querying it against a new realm would attach another
company's numbers to Jigged's invoice.

**A reconnect never changes which QuickBooks company this is.** The authorize screen grants access
for whichever Intuit account is signed into that browser, and Intuit offers a brand-new trial company
to a signer who has none — so an admin reconnecting an expired connection while signed in as
themselves can land on a different company file without being asked a single question. Found live on
2026-09-05, reconnecting Contour Tool & Machine after Intuit revoked their grant.

`persist_connection` overwrites `realm_id` unconditionally and nothing checked it, so that used to
succeed and the card just said "Connected" — while every invoice link and customer mapping stayed
bound to the old realm, payment status reported them as belonging to a previous company, and new
pushes went to the empty one. The callback now compares the realm Intuit returns against the stored
one and refuses outright, redirecting to `?qb=realm_mismatch`; the grant it declined to store is
revoked rather than left live.

**The refusal is unconditional, and the first draft of it was not.** That draft allowed the switch
when no invoice or customer row was bound to the old realm, on the theory that there was nothing to
strand. There is: `default_item_id`, `default_income_account_id`, `po_custom_field_id` and
`po_custom_field_name` live on the connection row, name objects *inside the old company file*, and
`persist_connection` clears none of them. A "harmless" swap therefore leaves the new company
pointing at another company's item and income account, and the next push files a **wrong invoice**
rather than merely failing to read one. One rule with no exception is also the only version a shop
owner can predict, since the exception turned on state they cannot see.

**Switching companies on purpose still works: Disconnect, then connect.** That path deletes the
connection row, which is exactly what makes it safe — every stale realm-specific setting goes with
it — and `revoke_token` never raises, so it cannot get stuck. The one comparison that is skipped is
a stored row from the *other* Intuit environment: a sandbox row while running production is stale by
definition, not a company to protect, so it never blocks a fresh connection.

### A void in QuickBooks reopens the quantity

`voided` or `missing` sets `voided_at`, which fires the existing
`trigger_recompute_jp_invoicing_on_link`: the parts stop counting as invoiced, "Left to invoice"
reopens, and no further code is involved. Clearing it again — the invoice came back — re-locks them.

**The mirror only ever touches rows where `voided_by IS NULL`.** `voided_at` now has two possible
writers (this, and the deferred in-app void below) and `voided_by` is what tells them apart, so a
human void can never be undone by a QuickBooks read.

### Freshness: the webhook is a signal, not a payload

**Intuit webhooks say only *that* something changed.** The handler verifies the signature, stamps
staleness markers in Postgres, returns 200, and makes **zero Intuit calls** — resolving a Payment
event to the invoices it touched would need a read inside the handler, and a webhook that can call
out is a webhook that times out. Payment and CreditMemo events name only the payment or memo, so
they stamp the connection-wide `quickbooks_connections.qb_invoices_stale_since`; an Invoice event
stamps that invoice's own `qb_stale_at`.

**Opening the Invoices menu is what reads balances back** — one call to our own backend per open,
and the *backend* decides whether Intuit is asked at all. It is asked when a link has never been
checked, or its `qb_stale_at` is newer than its `qb_status_checked_at`, or the company marker is,
or the last check is older than ten minutes. Otherwise the stored rows are returned with
`checked: false` and Intuit never hears from us.

**There is no "Check payment status" button, and that is the requirement**, not an omission: a
button asks the user to know something they cannot know (whether the number in front of them is
current). The ten-minute floor and the webhook markers exist so that opening the menu is enough.
Reads are batched (`INVOICE_QUERY_CHUNK = 100` ids per query, `maxresults` 1000), so a job's whole
menu is normally one Intuit call.

A one-time backfill made every existing job current at launch; after that these two paths are the
only things that write the mirror. **There is no scheduler and no poll** — see the deferred list.

## Correcting a recorded quantity

**As-built 2026-10-01**, schema in
[`20261001025551`](../../supabase/migrations/20261001025551_correct_recorded_invoice_quantities.sql).
Jigged's note of what an invoice billed is editable; the QuickBooks document is not, and
never is. Lowering a recorded quantity reopens the un-billed remainder through the
existing line-item triggers, and the ordinary push then bills it.

**The bug that forced it.** Before partial invoicing, billing half a job meant pushing the
whole invoice from Jigged and editing it down in QuickBooks. §7b of
[`20260702011324`](../../supabase/migrations/20260702011324_multi_invoice_per_job.sql)
backfilled every legacy `created` invoice as having billed each part's **full current
quantity**, on the stated assumption that `job_parts.quantity == the invoiced qty`. For a
hand-edited invoice that is false, so `qty_invoiceable` is 0 forever. Found live on J-0018:
12 ordered, 3 shipped and invoiced, backfilled as 12 — and the recorded line total was
$2,274.48 against a mirrored QuickBooks total of $585.12.

**Why not a backfill.** CLAUDE.md requires a data-at-rest problem to be fixed at rest, and
this is its named exception: only the shop knows what its QuickBooks document billed.
`qb_total_amt` cannot settle it either, being tax-inclusive and so not comparable with
Jigged's line total (§Payment status). So the dialog links to the invoice and the shop
reads the quantity off it. One company was affected platform-wide, which is also why
there is no detector.

| Rule | Why |
|---|---|
| Office roles only (`admin`, `user`), never `operator` | Invoicing is already member-level, so admin-only would rebuild the support escalation this removes. The dashboard has no operator redirect, so the UI gate is real — and the RPC refuses an operator regardless |
| Billing gate asserted **by hand** in the function | `SECURITY DEFINER` walks past the restrictive `billing_gate_*` policies. Both invoice tables left `tenant_tables_missing_write_gate()`'s exempt list in the same migration, so from here a definer function writing either one without consulting `company_can_write` fails CI — neither guard could see this before |
| `total_price` recomputed server-side | It is Jigged's revenue figure and the price is locked once invoiced; a caller that supplied it could make the amount disagree with its own quantity |
| A line corrected to 0 is **deleted** | `qb_ili_quantity_positive` forbids a zero line, and a line that billed nothing is not a line |
| An invoice may not be corrected to record **nothing** | Σ line total 0 breaks the mirror's void test, which reads "QuickBooks says 0 while Jigged says > 0" — a genuinely voided invoice would start reading as **paid**. Voiding is that operation, and it belongs in QuickBooks |
| `corrected_at` / `corrected_by` stamped, and shown in the Invoices menu | A line total that quietly disagrees with the invoice Jigged pushed is the same silent discrepancy this feature exists to undo |

**The browser still cannot write either invoice table.** The same migration revoked the
`INSERT`/`UPDATE`/`DELETE` that `quickbooks_invoice_line_items` had carried for
`authenticated` since 2026-07-02 — it predates
[`20260716025048`](../../supabase/migrations/20260716025048_align_data_api_default_privileges.sql),
which is explicitly not retroactive, so the table had been one RLS policy away from being
browser-writable with no CI check watching. Its parent was closed on day one; it now
matches.

## Editing gates (`utils/jobsAccess.ts`)

- `updateJobPartQuantity` — floor is `max(qty_shipped, qty_invoiced)`; increases always
  allowed.
- `updateJobPartPrice` — blocked per-part once `qty_invoiced > 0` (untouched parts on a
  partially-invoiced job stay repriceable).
- `deleteJob` — **archives** the job (soft-delete via `deleted_at`); it never blocks. The
  former "records-of-value" guards (blocking when the job had a created invoice or a
  shipment) were **removed** — archiving preserves the row, so the invoice/shipment history
  stays intact and every retained reference keeps resolving. `cancelJob` (the `cancelled`
  production status) is a separate shop-floor outcome, not a deletion. See
  [Architecture §16 — Deletion & Archiving Policy](../architecture.md#16-deletion--archiving-policy).

## Not built (deferred)

In-app void / credit-memo of a created invoice (do it in QBO). Jigged's invoiced-qty
reflects invoices *issued from Jigged*.
**Withdrawn 2026-10-01:** this used to list *correction* of a created invoice here too.
Correcting what Jigged RECORDED an invoice as billing now ships — see
[§Correcting a recorded quantity](#correcting-a-recorded-quantity). Voiding does not:
`voided_by` is still written by nothing.

**Corrected 2026-09-03:** this used to add *"a credit issued directly in QBO does not sync back"*,
which is now wrong for half of what it covered. A **void or delete** in QuickBooks Online does come
back — the mirror sets `voided_at` and the quantity reopens (above). A **credit memo** still does
not: it is a separate QuickBooks transaction that leaves the invoice standing with a balance of its
own, so Jigged keeps counting the original invoice's quantity as billed.

Also deferred, each a piece of the AR subledger this product refuses
([customers.md](customers.md#explicitly-not-built)):

- **A paid date.** QBO reports a balance, not when it reached zero; the date would have to come from
  Payment objects, which is the subledger.
- **Aging buckets, statements, dunning.** QuickBooks ships three statement formats and automated
  reminders — two engines means the AP clerk gets two past-due emails.
- **Any scheduler or background poll** refreshing the mirror without someone opening the menu. The
  webhook and the menu open are the only writers by design; a cron would call Intuit for jobs nobody
  is looking at.
