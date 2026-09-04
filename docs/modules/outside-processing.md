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
| **No purchase orders** | The slip is the outside-work document, and it works with no accounting system connected — which the [purchase-order plan](jobs.md) could not. |

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
`shipped_at`, `due_back_on`, `carrier`, `notes`, `created_by`, `voided_at`/`voided_by`, timestamps.

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
`quantity_good`, `quantity_scrapped`, `received_at`, `received_by`, `note`, `voided_at`/`voided_by`,
timestamps. Append-only: corrections are a void plus a new row, which is why `authenticated` holds
an UPDATE grant on `voided_at`/`voided_by` **and no other column**.

- Each quantity is `>= 0`, **not `> 0`**, with `good + scrapped > 0`. A vendor that ruined the whole
  lot returns `(good 0, scrapped 50)` — which `job_op_completions_quantity_positive` makes
  unrepresentable, and which is one of the reasons receipts are not that table.
- One **composite FK** `(outside_shipment_id, company_id, job_operation_id, job_part_id)` makes a
  receipt whose denormalized ids disagree with its shipment *unrepresentable*, rather than a rule
  three future queries have to remember.

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

Three supporting reasons: the all-scrap case above; *"a receipt must reference a shipment"* is a
`NOT NULL` here and would have been a trigger there; and the client-side guards in
`createOperationCompletion` and `completeJobOperation` stay unconditionally true instead of gaining
an *"unless `capture_source='vendor_receipt'`"* clause that a plain PostgREST insert could sidestep.

---

## Status derivation

`compute_job_operation_status` — rebuilt from its newest definition
([20260823163931](../../supabase/migrations/20260823163931_split_vendor_services_from_work_centers.sql):316),
in-house arm byte-identical:

```
v_sent = SUM(live outside_shipments.quantity)
v_good = SUM(live receipts.quantity_good)
v_back = SUM(live receipts.quantity_good + quantity_scrapped)

v_good >= job_parts.quantity  -> 'completed'    ← tested FIRST, deliberately
v_sent - v_back > 0           -> 'sent'         ← pieces are physically at the vendor
v_good > 0                    -> 'in_progress'
                              -> 'pending'
```

**Completed is tested first and the order is load-bearing.** Send 120 for a 100-piece order, get 100
good back and 20 never returned: the op is done, and testing outstanding first would hold it at
`sent` over 20 pieces nobody is waiting for.

**The three cases that decide whether this is right:**

| | |
|---|---|
| 100 out, 98 good + 2 **scrapped** | Outstanding 0, so nothing is at the plater; `98 < 100`, so → **`in_progress`**. Exactly what an in-house op says at 98 good of 100. Resolutions that already exist: re-run and send a second shipment, drop `job_parts.quantity` to 98 (the part-quantity trigger derives `completed`), or cancel the part. **There is no close-out flag** — a second mechanism for a fact the quantities carry would eventually disagree with them. |
| 100 out, 98 good, **0 scrapped** | Outstanding 2 → stays **`sent`**. As far as the shop knows, 2 pieces are on someone's rack. Booking them as scrapped is a decision a person takes. |
| A part-quantity edit | **The 2026-08-23 hazard is closed by construction, not by a guard.** The exemption existed because `recompute_job_ops_status_from_part_qty()` runs the status function over every op on the part and a `sent` op reset to `pending`. The outside arm reads shipments and receipts; a quantity edit writes neither. `sent_at` survives for the same reason — it is a mirror, not the record. |

---

## The write surface, and why it is shaped this way

**The browser has exactly one door.** `outside_shipments` grants `authenticated` **SELECT and
nothing else**: a send must mint `OSP-{jobBase}-{n}` under an advisory lock and freeze the vendor
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

**Slip numbers: `OSP-{jobBase}-{n}`**, byte-parallel with the customer slip's `PS-{jobBase}-{n}`.
*Outside processing* is what the trade calls this — Epicor, JobBOSS and E2 all ship a module by that
name — so it needs no legend. Rejected: **`OP-`** collides with `OP 10 / OP 20` on the traveler this
same slip rides with, a real misread on paper by the person least able to check; **`SO-`** reads as
*sales order*; **`OS-`** is one round letter from `PS-`. The counter runs over **all** rows
including voided ones — the plater is holding a paper `OSP-0141-2`, and reissuing that number is how
two shipments become one in a phone call. A distinct advisory-lock namespace from
`create_shipment_with_line_items`, so a slow outside send never blocks the customer shipping desk.

---

## Surfaces

**Send and receive live ONLY on the operation** — the office card and the operator step screen.
Everything else is read-and-reprint. That is deliberate: a cross-job outside-work *action* tab was
deleted in Aug 2026 because a second place to act on the same row is a liability
([jobs.md](jobs.md#outside-external-vendor-operations)), and that argument still holds.

| Surface | What it does |
|---|---|
| **Office op card** ([`OperationCard`](../../components/jobs/OperationCard.tsx)) | `Send to {vendor}` (outlined/warning — the sanctioned exception named in `interactionStandardsCheck.ts`) and `Receive {n}` (contained/**primary**, never green). **Gated on quantities, not status**: an op with 50 out and 50 in the shop offers BOTH, which is what makes send-50-now-50-later reachable. Expanding shows **slip history**. |
| **Send / receive dialogs** | Prefilled to state their own outcome. Over-send **warns, never blocks**. Due back is **empty by default** — no lead-time data exists, and an invented promise on a printed document is worse than a blank line. |
| **Operator step screen** | One tap survives and gains a fact: the button reads `SEND 50 TO PROFINISH`, the same move the page already makes with `RECORD n FINISHED`. Scrap is **progressively disclosed** — two prefilled numeric fields side by side on a one-handed phone is the shape that gets fat-fingered. |
| **Slip preview** | Reprint, download, print — and **Void, which lives here and nowhere else**, so the destructive action is only reachable once the document is on screen. |
| **`/dashboard/{companyId}/outside-work`** | The cross-job register. Slips, not operations. **No send, no receive, no undo.** |

### Surveillance guardrail

Every number on the operator screen is derived from **one `job_operation_id`** — it describes the
job in front of them, which [the rule](operator-view.md#surveillance-guardrail-non-negotiable)
permits. What is refused, and written into the file so the next reader knows it was considered: no
tally of slips a person has sent or received, nothing on `/my-work`, and no window ("this week")
that would turn a count into a rate.

---

## The document

[`utils/outsideShipmentPdf.ts`](../../utils/outsideShipmentPdf.ts), a sibling of the customer
packing slip sharing its header primitive, grid table and footer. Two differences:

- **It carries a SHIP FROM block.** The customer knows who we are; a plater's dock is holding parts
  from a dozen shops and has to know whose these are and where they go back.
- **The title is 20pt, not 26.** `SHOP_LOGO_MAX_W` lets the header's left block reach x≈230, and
  `OUTSIDE PROCESSING` at 26pt bold starts near x≈292 — 62pt of air between them.

**Two defects were found by rendering a real PDF, and neither is visible to the test suite** (it
mocks jsPDF wholesale, so it cannot observe overflow or wrap width):

1. A vendor's name here is its **legal** name and those are long. At 11pt bold, *"PerformCoat of
   Michigan Limited Liability Company"* measures 270pt against a 258pt column — it ran past the
   right margin and off the page. The address blocks now wrap, measuring each line **in the font it
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
| DB / RLS / triggers | [`test_outside_processing.py`](../../api/tests/integration/test_outside_processing.py) | The derivation walk, the 98-of-100 case, scrap vs never-returned, **the void cascade reaching the JOB** (the trigger-depth trap), slip-number reuse, the guard trigger, the composite FK, cross-tenant |
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
