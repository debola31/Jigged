# Vendor Services Module

A **vendor service** is a process an outside vendor performs on your parts — anodize, heat treat,
wire EDM. It is owned by the vendor that performs it. **Built; Phase 1 shipped.**
Depends on [Vendors](vendors.md). Consumed by [Routings](routings.md) and [Jobs](jobs.md).

> **This replaces "external work centers."** Until 2026-08-23 an outsourced process was a
> `work_centers` row with `kind='external'` and a `vendor_id`. That is gone — the rows moved, and
> `work_centers.kind` / `work_centers.vendor_id` were **dropped**, not deprecated.

## Why this exists

The founder's objection was conceptual: a work centre is a place in *your* shop, and no shop owner
cares which cell inside the plater's building does the work. Production made the case concrete
(queried 2026-08-23, prod `mayuquvexmqjvwkfasxg`):

- **In 32 of 38 external rows the work-centre name WAS the vendor's own name**, character for
  character — `CLAS Carbide`, `Thermal One, Inc.`, `PerformCoat of Michigan LLC`. The six exceptions
  were demo/seed data. Users were not naming a process; they were naming the vendor, because the row
  existed only to point at one.
- **`PerformCoat of Michigan LLC` backed 201 routing steps carrying 18 distinct prices from $1.00 to
  $30.00** — anodize, black oxide and chem film collapsed into one row. Nothing in the schema forced
  that (the only unique constraint was `(company_id, name)`, so two rows could always share a
  `vendor_id`); the model simply offered nowhere to put a process name distinct from the supplier's.
- **`job_operations.operation_name` is a copy of the target's name**, so the traveler the shipper
  reads said `PerformCoat of Michigan LLC` where it should say `Anodize`.
- **861 of 966 outside routing steps (89.1%) carried no price at all**, and `get_priceable_part_ids`
  excludes any part with an unpriced outside op — so this was silently suppressing quotability.

## Data model

**`vendor_services`** — `id`, `company_id`, `vendor_id` (FK → `vendors`, `ON DELETE RESTRICT`),
`name`, `description`, `unit_price numeric(12,4)`, `created_at`, `updated_at`, `deleted_at`.

`UNIQUE (vendor_id, name)` — **scoped to the vendor, not the company**. Two vendors may both offer
"Anodize"; one vendor may not list it twice. This is the constraint that lets a service be named for
the process instead of the supplier.

> **Why `work_centers` kept `UNIQUE (company_id, name)` untouched.** The rejected alternative kept
> the rows in `work_centers` and hid the concept, which required weakening that constraint so two
> vendors could both offer "Anodize". That one change silently breaks four contracts that assume
> `(company_id, name)` is unique: the work-centres importer's `ON CONFLICT` (a `42P10` swallowed into
> a bare 500), `reviveArchivedWorkCenterByName`'s `.maybeSingle()` (`PGRST116` → revive throws),
> `checkWorkCenterNameExists`' company-wide `ilike`, and the routings importer's last-wins name
> lookup — which would route steps into the wrong row, silently, into cost-bearing data. Giving
> `vendor_services` its own constraint solves the name problem where it belongs.

### The polymorphic target

`routing_operations` and `job_operations` each carry **both** `work_center_id` and
`vendor_service_id`. A routing step targets exactly one:

```sql
CHECK (num_nonnulls(work_center_id, vendor_service_id) = 1)   -- routing_operations
CHECK (num_nonnulls(work_center_id, vendor_service_id) <= 1)  -- job_operations
```

`job_operations` allows neither, because its `work_center_id` FK is `ON DELETE SET NULL` and predates
this change.

**`vendor_service_id IS NOT NULL` is the "is this outside work?" test.** There is no `kind` column
left to consult. In TypeScript use `Boolean(vendor_service_id)`, not `!== null` — a `.select()` that
omits the column yields `undefined`, and `undefined !== null` is true, which once labelled every
in-house completion as "received from vendor".

### Price inheritance

`vendor_services.unit_price` **inherits**, exactly as `work_centers.labor_rate` already does:

| | In-house | Outside |
|---|---|---|
| Rate lives on | `work_centers.labor_rate` | `vendor_services.unit_price` |
| Per-step override | `routing_operations.labor_rate_override` | `routing_operations.external_unit_price` |
| Cost reads | `COALESCE(labor_rate_override, wc.labor_rate)` | `COALESCE(external_unit_price, vs.unit_price)` |
| Unpriceable when | both NULL | both NULL |

The editor pre-fills the field from the target and persists `null` when unchanged, so a step that
agrees with the vendor follows that vendor's price when it moves. **A plain copy would have been a
trap**: raise a station's rate and every quote moves; raise a service's price and nothing moves — two
adjacent fields with opposite semantics, on one screen, for a 50–60 year old user.

`create_job_part_operations_from_routing` snapshots the **effective** price, so a shipped job freezes
what was actually charged rather than a NULL that later reads as "never priced".

## The two hazards the split had to close

Both are silent-data-loss failures, and both come from leaving a function to infer "is this outside
work?" from a join that no longer resolves. Both were rewritten in the same transaction that made the
columns nullable, and both are covered by a hazard test.

1. **`compute_job_operation_status`** early-returns an outside op's stored status. Left joining
   `work_centers`, `v_kind` would come back NULL, the function would fall through to the
   completion-quantity path with `v_good = 0`, and **every sent/received op would reset to `pending`
   on the next part-quantity edit** — losing the send stamp. It runs from a trigger over every op on
   a part. Now branches on `vendor_service_id`, which is both the fix and simpler than what it
   replaced.
2. **`create_job_part_operations_from_routing`** INNER JOINed `work_centers`. The moment
   `routing_operations.work_center_id` became nullable, every outside step would be silently dropped
   at job creation: no error, no traveler step, `v_seq` renumbering the survivors, and the part
   reading complete when it was never sent out. Now two LEFT JOINs.

## Functions rebuilt by the split

Each from its **newest** definition — rebuilding from a creating migration silently reverts every fix
applied since.

| Function | Change |
|---|---|
| `compute_job_operation_status` | branches on `vendor_service_id`; no `work_centers` join |
| `create_job_part_operations_from_routing` | two LEFT JOINs; `operation_name` from the service; snapshots the effective price |
| `part_rollup_at_qty` | LEFT JOINs both targets; outside arm inherits |
| `get_priceable_part_ids` | three-way predicate keys off the target |
| `compute_part_cost_explain` | same predicate, **byte-parallel** with the above |
| `seed_demo_data` | routes `kind='external'` template entries into `vendor_services` |
| `reset_demo_company` | deletes `vendor_services` between `work_centers` and `vendors` |

`get_priceable_part_ids` and `compute_part_cost_explain` must move in lockstep — that parity is what
the 2026-08-19 incident was about, and
[`test_priceability_agreement.py`](../../api/tests/integration/test_priceability_agreement.py) is
the net.

**Unchanged and verified:** `get_ready_operations_for_station` keys on `jo.work_center_id`, so
outside ops (now NULL) never match — the same behaviour as the old internal-only station filter — and
its `prev.status <> 'completed'` predecessor rule still holds an outside step across the whole
job_part. `job_operation_intervals.work_center_id` is the *machine* chain key and stays internal-only
naturally; outside ops never get intervals.

## Access layer

[`utils/vendorServicesAccess.ts`](../../utils/vendorServicesAccess.ts) — the greppable landmark for
this entity. Archive is universal: `deleted_at` is stamped, never a SQL `DELETE`, never blocked by a
routing or job reference. Every list/picker/count filters `deleted_at IS NULL`; `getVendorService`
(by id) does not, so a routing holding an archived service keeps resolving.

- `getVendorServicesForVendor` / `getVendorServicesWithUsage` — the vendor detail page. Usage counts
  come from two small queries counted in the browser (PostgREST cannot `GROUP BY`), scoped to a
  handful of ids.
- `getVendorServicesForCompany` — the Vendors list's Services column. One small query grouped
  client-side, deliberately **not** an RPC: the per-row aggregate shape is what timed out on
  2026-08-19.
- `getVendorServicesForRouting` — the outside half of the routing picker, with the vendor name and
  `unit_price` pre-joined.
- `createVendorService` revives an archived namesake **belonging to the same vendor** on a `23505`;
  a live collision re-throws as a genuine duplicate.

## Known gaps

- **The importers still speak the old language.** The guided importer's Work Centers template carries
  `kind` / `vendor_name`, `lib/dataImportLinks.ts` auto-creates a vendor named after the work centre
  (which is what produced the 32-of-38 shape above), and `CreateMissingDialog` renders a literal
  "Outside shop" toggle. Until that lands, **the import wizard is the last place a user can create
  the concept this module removed.**
- **32 of 38 migrated services are named after their own vendor.** The migration moved names
  verbatim — inventing a process name would be fabricating data the shop never entered. Renaming them
  is a data-quality pass for the office.
- **No E2E spec**, inherited from [Vendors](vendors.md).

## See also

- [Vendors](vendors.md) — the parent entity.
- [Work Centers](work-centers.md) — in-house capacity, and what this is *not*.
- [Routings](routings.md) — how a step targets one or the other.
- [Jobs](jobs.md#outside-external-vendor-operations) — the send/receive lifecycle.
