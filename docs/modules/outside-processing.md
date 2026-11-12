# Outside Processing — Shipping & Receiving

When a routing hits an outside operation — anodize, heat treat, plating — parts physically leave
the building. This module is the record of that: **what went out, on what paper, and what came
back.** Built 2026-09-03. Depends on [Vendor Services](vendor-services.md) and [Jobs](jobs.md).

> **What this replaced.** Until 2026-09-03 the whole lifecycle was four columns on
> `job_operations` — `sent_at`/`sent_by`, `completed_at`/`completed_by` — flipped by a **Mark Sent
> Out** / **Mark Received** pair. A state flag, not a record. It could not say how many pieces went,
> where they went, when they were due back, or that anything had happened at all after an Undo,
> which cleared the stamp with no tombstone.

---

## The four decisions

| | |
|---|---|
| **Grain** | One shipment = ONE `job_operations` row + a quantity. An operation may have many — send 50 now, 50 next week. |
| **Shipping is the send** | There is no state-only write left. `job_operations.status`/`sent_at`/`sent_by` are derived, and a hand-written one is **refused by a trigger**. |
| **Quantities drive status** | Exactly as in-house completions do. This deliberately reversed the outside-op exemption in `compute_job_operation_status`. |
| **The slip moves the parts; a PO only orders them** | The slip and its receipts are the only record of what went out and came back, and they work with no accounting system connected. Since 2026-11 a vendor PO may price and order the step — a native, Jigged-numbered document, its QuickBooks push optional — and the slip links to its line ([below](#the-vendor-po-line-a-slip-ships-against--2026-11)). |

**Withdrawn 2026-11:** *"No purchase orders — the slip is the outside-work document, and it works
with no accounting system connected, which the purchase-order plan could not"* — wrong on its own
ground once the PO is Jigged's document, which needs no accounting system either
([purchasing.md](purchasing.md#why-it-exists)). Only that ground fell: the slip is still the one
record of movement, and nothing on a PO writes a slip or a receipt.

**Why now rather than later.** Contour had **37 outside operations, every one `pending`, none ever
sent**, while completing 36 in-house ones. Of those 37 exactly **one** was unblocked by its
predecessors — so the path was untravelled rather than rejected, and there was no real send history
to migrate. That is the cheapest moment a lifecycle ever gets reshaped.

---

## Data model

### `outside_shipments` — one send

`id`, `company_id`, `job_id`, `job_part_id`, `job_operation_id` (all NOT NULL — `job_id` is not
convenience, the per-job slip counter reads it under an advisory lock), `vendor_id`
(**ON DELETE RESTRICT**, like `vendor_services.vendor_id`), `vendor_address_id` /
`vendor_contact_id` (SET NULL), the Document-Snapshot-Standard freeze `vendor_name`,
`service_name`, `ship_to_address` jsonb, `ship_to_contact` jsonb, then `slip_number`, `quantity`,
`shipped_at`, `due_back_on`, `carrier`, `notes`, `created_by`, `voided_at`/`voided_by`,
`closed_at`/`closed_by` (the short-close, 2026-09-06), `vendor_purchase_order_line_id`
([below](#the-vendor-po-line-a-slip-ships-against--2026-11)), timestamps.

- **`shipped_at` is timestamptz; `due_back_on` is a date.** The first is an event the `/activity`
  feed sorts on and `job_operations.sent_at` mirrors exactly; the second is a *promise*, the same
  asymmetry `jobs.due_date` has beside `jobs.created_at`.
- **No `deleted_at`.** A shipment is **voided**, never archived — the `shipments` posture, for the
  same reason: it is a document the vendor is holding, so a correction is a void plus a new slip.
- **There is deliberately no `CHECK (due_back_on >= shipped_at::date)`.** `timestamptz::date` is
  STABLE, not IMMUTABLE, so Postgres refuses that constraint with an error that reads like a typo.
  `create_outside_shipment` validates it instead.
- `UNIQUE (company_id, slip_number)` turns a minting bug into a `23505` rather than two slips the
  vendor cannot tell apart. `UNIQUE (id, company_id, job_operation_id, job_part_id)` exists only as
  the target of the receipts' composite FK.

### `outside_shipment_receipts` — what came back

`id`, `company_id`, `outside_shipment_id` **NOT NULL**, `job_operation_id`, `job_part_id`,
`quantity_good`, `received_at`, `received_by`, `note`, `voided_at`/`voided_by`, timestamps.
Append-only: corrections are a void plus a new row, which is why `authenticated` holds an UPDATE
grant on `voided_at`/`voided_by` **and no other column**.

- **Good-only, `quantity_good > 0`**, like its in-house sibling. A short return is settled by
  **short-closing the slip** (`outside_shipments.closed_at`, *"that is everything we are getting"*)
  — Sage's short-close, Oracle's quantity-cancelled — which retires what is outstanding without
  counting toward good. ⚠ *Until [`20260906005725`](../../supabase/migrations/20260906005725_short_close_outside_shipment.sql)
  a receipt also carried `quantity_scrapped`, each `>= 0` with `good + scrapped > 0`, so a vendor that
  ruined the lot returned `(good 0, scrapped 50)`; that case is now a close with no receipt at all.*
- One **composite FK** `(outside_shipment_id, company_id, job_operation_id, job_part_id)` makes a
  receipt whose denormalized ids disagree with its shipment *unrepresentable*, rather than a rule
  three future queries have to remember.

### The vendor PO line a slip ships against — 2026-11

`outside_shipments.vendor_purchase_order_line_id` (SET NULL) names the *outside service* line of a
[vendor PO](purchasing.md#outside-processing-one-source-of-truth-for-received) the slip ships
against. The PO is an optional commercial layer; **the line's sent, at-vendor and received figures
are read off its linked slips**, and an outside receipt cannot be represented on the PO at all.

| Rule | How |
|---|---|
| One open outside line per (operation, vendor) | Enforced by the PO writers, re-checked on reopen |
| A slip links itself | `create_outside_shipment` links the single eligible line — draft or sent, not closed, not archived, same operation and vendor. **It takes no PO argument and no office check**: operators send, and the link happens anyway |
| A line links its slips | Inserting an outside line links that step's existing live, unlinked slips for the vendor |
| A person can correct it | `set_outside_shipment_vendor_purchase_order_line`, office-only relink or unlink |
| A link goes | When the PO is archived or the line removed |
| A wrong link is unrepresentable | A BEFORE trigger refuses a line of another company, kind, operation or vendor — 23514, the service role included |
| **Linking changes no status** | The column is in no status trigger's `UPDATE OF` list, so it fires nothing in the cascade and cannot reach [the trap below](#the-write-surface-and-why-it-is-shaped-this-way) |

**Closing the slip short and closing the PO line are independent**; the receive dialog's unticked
*"Also close PO-1042 line 2 — nothing more expected"* is the one place they meet. The PO side — the
send dialog's *"Ships against PO-1042 line 2"*, `PO: …` on the slip, the drawer's PO number — is
listed in [purchasing.md](purchasing.md#screens).

### Why receipts are not `job_operation_completions` rows

That reuse was tempting — the quantity→status path would have worked almost unchanged. **It is
blocked by the AI exemption.** `job_operation_completions` is on the permanent exempt list in
`tenant_tables_missing_ai_decision()`
([20260826103645](../../supabase/migrations/20260826103645_ai_readable_means_grant_and_policy.sql))
under *"Per-operator pace and attention data. Excluded on the surveillance guardrail."* Outside
processing is exactly what an owner asks the chat — *what is out at PerformCoat, how long does
Thermal One take, which vendor returns short* — and under that reuse those numbers would sit behind
a door that has to stay shut, with no column-list escape (the objection is to `completed_by` on
*internal* rows). Here the two tables are **readable, column-scoped**, with the actor columns
withheld: no business question needs the name of the person who signed for a box.

Two supporting reasons — a third, the all-scrap receipt, went with `quantity_scrapped` on
2026-09-06: *"a receipt must reference a shipment"* is a `NOT NULL` here and would have been a
trigger there; and the client-side guards in
`createOperationCompletion` and `completeJobOperation` stay unconditionally true instead of gaining
an *"unless `capture_source='vendor_receipt'`"* clause that a plain PostgREST insert could sidestep.

---

## Status derivation

`compute_job_operation_status` — rebuilt from its newest definition
([20260823163931](../../supabase/migrations/20260823163931_split_vendor_services_from_work_centers.sql):316),
in-house arm byte-identical:

```
v_good        = SUM(live receipts.quantity_good)
v_outstanding = SUM over live slips: 0 if the slip is closed, else max(0, its quantity − its live good)

v_good >= job_parts.quantity  -> 'completed'    ← tested FIRST, deliberately
v_outstanding > 0             -> 'sent'         ← pieces are physically at the vendor
v_good > 0                    -> 'in_progress'
                              -> 'pending'
```

⚠ *Rebuilt 2026-09-06 ([`20260906005725`](../../supabase/migrations/20260906005725_short_close_outside_shipment.sql)):
outstanding is counted **per slip**, because a short-closed slip owes nothing however much came back
on it — which a company-wide `v_sent − v_back`, with `v_back = good + scrapped`, could not express.*

**Completed is tested first and the order is load-bearing.** Send 120 for a 100-piece order, get 100
good back and 20 never returned: the op is done, and testing outstanding first would hold it at
`sent` over 20 pieces nobody is waiting for.

**The three cases that decide whether this is right:**

| | |
|---|---|
| 100 out, 98 good, slip **closed short** | Outstanding 0, so nothing is at the plater; `98 < 100`, so → **`in_progress`**. Exactly what an in-house op says at 98 good of 100. Resolutions that already exist: re-run and send a second shipment, drop `job_parts.quantity` to 98 (the part-quantity trigger derives `completed`), or cancel the part. **Withdrawn:** *"there is no close-out flag — a second mechanism for a fact the quantities carry would eventually disagree with them"* — wrong because the close (2026-09-06) **replaced** the scrap quantity rather than joining it, so there is still one mechanism. |
| 100 out, 98 good, slip **left open** | Outstanding 2 → stays **`sent`**. As far as the shop knows, 2 pieces are on someone's rack. Closing the slip short is a decision a person takes. |
| A part-quantity edit | **The 2026-08-23 hazard is closed by construction, not by a guard.** The exemption existed because `recompute_job_ops_status_from_part_qty()` runs the status function over every op on the part and a `sent` op reset to `pending`. The outside arm reads shipments and receipts; a quantity edit writes neither. `sent_at` survives for the same reason — it is a mirror, not the record. |

### "How many still have to go out" is not `ordered − sent`

`qty_to_send` is **`ordered − good − at_vendor`**, and the difference matters the first time a
vendor comes back short. Send 12, get 10 good and close the slip: `ordered − sent` says **0** while the
job is still two parts short, so the shop is offered a dead button and no way to act. The pieces the
vendor ruined have to be re-run and sent again, so they reappear in what is left to send.

*Found by driving the app, not by a test — the arithmetic was self-consistent and every unit test
passed. What gave it away was a disabled `SEND 0 TO PROFINISH ANODIZING` on a job that was
visibly two parts light.*

---

## The write surface, and why it is shaped this way

**The browser has exactly one door.** `outside_shipments` grants `authenticated` **SELECT and
nothing else**: a send must mint `VPS-{jobBase}-{n}` under an advisory lock and freeze the vendor
address block, neither of which a PostgREST insert can do. Receiving IS simple CRUD — an insert plus
a trigger — so it goes straight through the client, the same shape `createOperationCompletion` uses.

| Function | Why it is what it is |
|---|---|
| `create_outside_shipment(...)` RPC | `company_id` is **derived from the operation, never a parameter**, so a caller cannot name a tenant it does not own. Calls `company_can_write` **by hand** — SECURITY DEFINER bypasses RLS *and* the restrictive gate with it, and the literal string is what `definer_writers_missing_write_gate()` matches on. |
| `void_outside_shipment(uuid)` RPC | Two **top-level** statements, receipts first. See the trap below. |
| `job_operations_outside_state_is_derived` trigger | Turns "one writer of the sent state" from a convention into an invariant. Discriminates on `current_user`, not `pg_trigger_depth()` — which is why the recompute became `SECURITY DEFINER`. |

> ### The trigger-depth trap
>
> **The void cascade cannot be a trigger on `outside_shipments`.** Trace it: shipment void → cascade
> trigger at depth 1 → its `UPDATE outside_shipment_receipts` fires the receipt trigger at depth 2 →
> that trigger's `UPDATE job_parts` fires the job sync at depth **3**, where
> `sync_job_production_status_from_parts()` bails at `> 2`
> ([baseline.sql](../../supabase/migrations/20260527151536_baseline.sql):1932). **The job status
> freezes, silently, with nothing in the logs** — and the op and part still look right, which is
> what makes it hard to find. `pg_trigger_depth()` counts *trigger* nesting, not function nesting,
> so two statements inside a plpgsql body each fire at depth 1 and the rollup lands at 2. A
> `BEFORE UPDATE OF voided_at` refusal trigger backs it up so a wrong-ordered repair script raises.

**Slip numbers: `VPS-{jobBase}-{n}`** — Vendor Packing Slip — byte-parallel with the customer slip's
`PS-{jobBase}-{n}`.

**Both documents print the title "PACKING SLIP"**, because that is what each one is to the person
opening the box; a plater's receiving clerk has no idea what "outside processing" means from where
they stand. That puts the whole burden of saying *which* document this is on the **number**, so it
names who it is for. Rejected: **`PSV-`** and **`SPS-`** share `PS-`'s opening sound, which is the
one thing the number now has to avoid; **`OP-`** collides with `OP 10 / OP 20` on the traveler this
slip rides in the box with — a real misread on paper by the person least able to check;
**`OPS-`** reads as *operations*; **`SO-`** reads as *sales order*. The counter runs over **all** rows
including voided ones — the plater is holding a paper `VPS-0141-2`, and reissuing that number is how
two shipments become one in a phone call. A distinct advisory-lock namespace from
`create_shipment_with_line_items`, so a slow outside send never blocks the customer shipping desk.

### Editing an applied migration is a no-op where it already ran

`20260903203741` was edited in place to mint `VPS-` instead of `OSP-`. That works
on a database seeing it for the first time and does **nothing** everywhere it had
already run: the version sits in `supabase_migrations.schema_migrations`, the file
is never replayed, and the old function body survives.

It was caught on this PR's own Supabase preview branch, which had applied the
original and went on minting `OSP-0057-1` from a tree that said `VPS-` in ten
places. Production had not applied it, so nothing shipped wrong — but the next
environment to be a version ahead would have been prod, and the symptom is a
document that disagrees with its own source.

The fix is [`20260905183520`](../../supabase/migrations/20260905183520_vendor_packing_slip_prefix.sql),
which `CREATE OR REPLACE`s the function (keeping its ACL and comment) and asserts
afterwards that the installed body actually mints `VPS-`. **Once a migration has
been applied anywhere, change it with a new migration.**

Slips issued as `OSP-` are **not renumbered**. A slip number is printed on a
document that left the building; rewriting one is the same failure as reissuing a
voided number to a different box.

### `getSession()`, never `getUser()`, in a write path

`receiveOutsideShipment` and `voidOutsideReceipt` read the acting user from
`supabase.auth.getSession()` — a local read. `getUser()` makes a network round trip to
`/auth/v1/user`, and `supabase-js` serialises auth calls behind a `navigator.locks` acquisition
that gates **every other request on the page**. A slow or failed one does not just cost a hop: the
writes queued behind it stall.

*That is not theoretical. Written with `getUser()`, the receipt insert hung indefinitely in the E2E
run — no error surfaced anywhere, and the next `page.reload()` aborted the request, so the row
simply never appeared.* The same trap is documented from the other direction in the `memberFlights`
docblock in [`utils/operatorAccess.ts`](../../utils/operatorAccess.ts). The customer-side
`voidShipment` still uses `getUser()`; it was not touched here.

---

## Surfaces

**Receive is on the operation AND in the drawer; send and undo are only on the operation.** The
asymmetry is the point. The Aug 2026 tab was deleted for carrying all three across every job — a
duplicate of what the operation card already did. Receiving is the one that is *not* a duplicate:
when a truck arrives from the plater with three boxes for three jobs, the dock does that in one
place, and an operation card structurally cannot serve it because it only ever knows one operation.
Sending and undoing have no batch shape — you send one step's parts while looking at that step — so
they stay put, and this does not become the tab again. **Both receive paths call the same access
function**, which is what stops the two surfaces drifting. Everything else is read-and-reprint. That is deliberate: a cross-job outside-work *action* tab was
deleted in Aug 2026 because a second place to act on the same row is a liability
([jobs.md](jobs.md#outside-external-vendor-operations)), and that argument still holds.

**There is no sidebar entry and no standalone page.** A strip on the Jobs page is the door and a
drawer is the room, which is one entry point rather than two.

*Rejected: adding **“At vendor” to the Jobs status filter.*** It reads as the cheapest option and is
not: `getJobLifecycleStage` is a total function of exactly two columns returning one **mutually
exclusive** stage per job, and "at vendor" is neither — it is derived from operations, and a job at a
vendor is *also* `in_progress`. Dropping it into that multi-select breaks the filter's invariant,
where selecting everything means showing everything, and leaves "at vendor + in progress" ambiguous
between AND and OR.

| Surface | What it does |
|---|---|
| **Office op card** ([`OperationCard`](../../components/jobs/OperationCard.tsx)) | `Send to {vendor}` (outlined/warning — the sanctioned exception named in `interactionStandardsCheck.ts`) and `Receive {n}` (contained/**primary**, never green). **Gated on quantities, not status**: an op with 50 out and 50 in the shop offers BOTH, which is what makes send-50-now-50-later reachable. **Slip history is not on the card** — it lives on the job's [activity rail](jobs.md#job-detail--dashboardcompanyidjobsid) as `sent` / `received` / `short_closed` rows, each carrying its `VPS-` number. |
| **Send / receive dialogs** | Prefilled to state their own outcome. Over-send **warns, never blocks**. Due back is **empty by default** — no lead-time data exists, and an invented promise on a printed document is worse than a blank line — **unless the step ships against a vendor PO line**, whose need-by date prefills it: a date the shop chose for exactly this work (2026-11, [purchasing.md](purchasing.md#outside-processing-one-source-of-truth-for-received)). |
| **Operator step screen** | One tap survives and gains a fact: the button reads `SEND 50 TO PROFINISH`, the same move the page already makes with `RECORD n FINISHED`. A short return is closed with one tick, offered only when fewer come back than are out. ⚠ *This was a progressively disclosed scrap field until scrap left the receipt, 2026-09-06.* |
| **Slip preview** | Reprint, download, print — and **Void, which lives here and nowhere else**, so the destructive action is only reachable once the document is on screen. |
| **Jobs-page strip** ([`OutsideWorkStrip`](../../components/jobs/OutsideWorkStrip.tsx)) | Renders **only while something is at a vendor** — so on the days nothing is out, most days for a shop with three outside steps, the Jobs page is exactly what it was. Costs no query: every number comes from the outside queue the page already loads for its At-vendor chip. |
| **Outside-work drawer** ([`OutsideWorkDrawer`](../../components/jobs/OutsideWorkDrawer.tsx)) | Opened by the strip. Grouped **by vendor**, oldest first, because "what has PerformCoat got?" is how the question is actually asked. Each row is the job number as **one link** — deep-linking to `?op=` on the job — plus **Receive**. Loaded on open, not with the page. |

### Surveillance guardrail

Every number on the operator screen is derived from **one `job_operation_id`** — it describes the
job in front of them, which [the rule](operator-view.md#surveillance-guardrail-non-negotiable)
permits. What is refused, and written into the file so the next reader knows it was considered: no
tally of slips a person has sent or received, nothing on `/my-work`, and no window ("this week")
that would turn a count into a rate.

---

## The document

[`utils/outsideShipmentPdf.ts`](../../utils/outsideShipmentPdf.ts), a sibling of the customer
packing slip sharing its header primitive, grid table and footer.

**Both documents are titled `PACKING SLIP`, and that follows the industry rather than inventing.**
Every ERP in this space treats the outbound-to-vendor document as a packing slip and differentiates
it by **naming the counterparty on the screen and the document**, never by decorating the number:
Epicor Kinetic ships *Subcontractor Shipment Entry* alongside *Customer Shipment Entry* and calls the
output a **Subcontract Packing Slip**; Infor SyteLine/CSI calls the same direction a **Vendor Packing
Slip**. We use *vendor* because that is what the rest of the product calls that party — `vendors`,
`vendor_services`, the Vendors page — and introducing "subcontractor" as a second noun for one entity
would be a worse invention than the one it avoided.

- **One address block: SHIP TO.** `drawShopHeaderBlock` already prints the shop's name, address and
  phone as the letterhead. A SHIP FROM block underneath repeated all three, in the same order, six
  lines lower — *the letterhead **is** the ship-from*, which is how packing slips worked long before
  any of this was software.
- **The title is 22pt, not the customer slip's 26**, sized to sit with the meta line under it rather
  than tower over it.
- **No signature block.** A packing slip is a *contents list*; proof of delivery is a separate signed
  receipt or the bill of lading, and the freight literature is blunt that treating a packing slip as
  proof of delivery is "a frequent and costly mistake". It was also useless in practice — the signed
  copy stays on the plater's desk, we print one PDF, and nothing here captures it. The receipt this
  system actually keeps is the `outside_shipment_receipts` row written when the parts come back.
  *(The customer packing slip carried a `RECEIVED BY` block and inherited the same objection. It was
  removed at the same time — on that document the failure is worse, because it invites a **customer**
  to treat a signed copy as something it legally is not. See [shipments.md](shipments.md).)*

**Two defects were found by rendering a real PDF, and neither is visible to the test suite** (it
mocks jsPDF wholesale, so it cannot observe overflow or wrap width):

1. A vendor's name here is its **legal** name and those are long. At 11pt bold, *"PerformCoat of
   Michigan Limited Liability Company"* measures 270pt, and against the half-width column the block
   sat in before SHIP FROM was removed it ran past the right margin and off the page. The block
   wraps, measuring each line **in the font it
   is drawn in** (line 0 is bold), or the heading wraps against body metrics and still overruns.
   *The customer packing slip has the same latent bug and was not touched.*
2. `buildAddressBlockLines` only emits `(No address on file)` when it has **nothing**, and here it
   always has the vendor name — so a vendor with no address printed as a lone name that reads like
   a truncation. The slip says it plainly instead.

The instructions block sets the body font **before** measuring, because the details block above
leaves the document in bold 11 and `splitTextToSize` wraps against whatever is current;
[`quotePdf.ts`](../../utils/quotePdf.ts) carries the same comment for the same bug.

---

## Test coverage

| Layer | File | What it pins |
|---|---|---|
| DB / RLS / triggers | [`test_outside_processing.py`](../../api/tests/integration/test_outside_processing.py) | The derivation walk, the 98-of-100 case, closed short vs never returned, **the void cascade reaching the JOB** (the trigger-depth trap), slip-number reuse, the guard trigger, the composite FK, cross-tenant |
| The closed hazard | [`test_vendor_services_split_hazards.py`](../../api/tests/integration/test_vendor_services_split_hazards.py) | A part-quantity edit cannot reach the send — now via a real shipment |
| Access | [`outsideShipmentsAccess.test.ts`](../../__tests__/utils/outsideShipmentsAccess.test.ts) | Ledger arithmetic and its 2dp re-rounding, point-in-time backlog, instant-not-text ordering, the refusal to guess a ship-to |
| Document | [`outsideShipmentPdf.test.ts`](../../__tests__/utils/outsideShipmentPdf.test.ts) | Ordering, argument values and font state — the three things that survive a mocked jsPDF |
| Card | [`OperationCard.test.tsx`](../../__tests__/components/jobs/OperationCard.test.tsx) | A part-sent op offers **both** Send and Receive; Receive stays a filled *primary* button |

**Known gap, stated rather than implied:** no test proves the slip does not overflow. The suite
cannot see it. The check is a real render — long service name, long vendor name, a ~500-character
instruction block, and a vendor with no address — and it is a PR checklist item, not automation.

## See also

- [Jobs](jobs.md#outside-external-vendor-operations) — the operation lifecycle this derives.
- [Vendor Services](vendor-services.md) — what an outside operation targets.
- [Vendors](vendors.md) — `vendor_addresses`, whose `is_default` flag this module is the first
  consumer of.
- [Shipments](shipments.md) — the customer-facing sibling, and the source of the shared PDF library.
