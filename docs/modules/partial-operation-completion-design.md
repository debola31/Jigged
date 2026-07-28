# Design: Partial Quantity Completion on Operations

## Context

Jigged already lets a shop ship a subset of a job's quantity and invoice a subset,
but **operations can only be completed whole**. A real case from our design partner:
order quantity 12, material for 5, 2 came out wrong, 3 completed. The operator's only
way to record "3 done, 9 to go" was a free-text note (`notes`): *"3 are complete
need 9 more."* That fact lives in prose instead of data — nothing rolls it up, nothing
shows it to the admin, and the next run has to re-read the note.

This design makes **operation-level quantity progress first-class**, consistent with
how partial shipments and partial invoices already work. It introduces the first
quantity concept onto `job_operations` and defines how it rolls up, what it does (and
deliberately does **not**) touch, and how it renders — reusing the existing append-only
event + trigger-derived-status pattern the codebase already uses twice.

### What exists today (established by code exploration)

- Hierarchy: `jobs` → `job_parts` → `job_operations`. Order quantity lives on
  [`job_parts.quantity`](supabase/schema.prod.sql) (`numeric`, `CHECK > 0`). Operations
  belong to a **job_part**.
- [`job_operations`](supabase/schema.prod.sql#L782) has `status ∈ {pending, in_progress,
  completed}` (CHECK-constrained), `completed_at`, `completed_by` — **no quantity, no
  started_at, no actual-time/cost columns** (those were deliberately removed).
- **The house partial pattern**, used identically by shipments and invoices:
  - Append-only child event table carrying a per-event `quantity`
    ([`shipment_line_items`](supabase/schema.prod.sql#L703),
    [`quickbooks_invoice_line_items`](supabase/migrations/20260702011324_multi_invoice_per_job.sql)).
    Events are never mutated or hard-deleted.
  - A denormalized tri-state status enum on the parent (`fulfillment_status`,
    `invoicing_status`), maintained **entirely by a DB trigger family** with
    `pg_trigger_depth() > 2` recursion guards. A single SQL `compute_*` function is the
    documented source of truth.
  - `remaining = ordered − SUM(non-voided events)`, clamped `≥ 0` (`Math.max(0, …)`),
    computed in SQL (for the cached column) and again in the access layer (for the UI
    prefill) — the codebase accepts these two agreeing-by-construction sites.
  - Corrections are **void + recreate**, never edit-in-place. `voided_at`/`voided_by`
    columns are present and filtered everywhere from day one (invoices shipped them
    before the void UI existed).
  - Over-completion: **shipments warn but never block** (only hard floor
    `quantity > 0`); invoices hard-block over-*ordered* at the DB. We follow **shipments**.
  - UI prefills full-remaining but **labels each input's consequence** so a default can't
    silently over/under-complete ([`shipmentMath.ts`](components/shipments/shipmentMath.ts)
    `lineShipConsequence` → `none | full | partial{leftover} | over{excess}`, rendered by
    `ConsequenceCaption`).
- **Operations are money-decoupled today.** `production_status` (from operations) is
  independent of `fulfillment_status` (from shipments) and `invoicing_status` (from
  invoices). Completing an op touches no cost — costing is estimate-only from
  `routing_operations` at quote time.
- Progress is **count-of-operations** in three places, none quantity-weighted:
  [`operatorAccess.buildOperatorJobs`](utils/operatorAccess.ts), the operator op-action
  page, and [`OperationsPanel`](components/jobs/OperationsPanel.tsx).
- op→job_part rollup is **app code**
  ([`recomputeJobPartStatus`](utils/jobsAccess.ts#L1206) / inline in
  `operatorAccess.completeOperation`); job_part→job is a **DB trigger**
  (`compute_job_production_status`).
- **No scrap is modeled anywhere.** `job_notes.note_type = 'event'` is a reserved,
  unused hook for auto-logged feed entries.

### Decisions taken with the user (2026-07-20)

1. **Good-only in v1; scrap deferred.** v1 records good quantity only. The schema is
   left forward-compatible so scrap is a purely additive column + one input later.
2. **Over-completion: warn, never block.** Matches over-shipment. Only DB floor is
   `quantity_good > 0`. Corrections are void + re-enter, never edit-in-place.
3. **Fully decoupled from money paths.** Operation progress never gates shippable or
   invoiceable quantity in v1. Stated as an explicit design decision; no silent fallback.

---

## Data model

**Recommendation: append-only completion events, NOT a mutable `completed_quantity`
column on the operation.**

A mutable counter cannot answer "who completed how many, when" and cannot distinguish
`3 + 3 + 3` (three shifts) from one entry of `9` — it destroys the audit trail the prompt
requires and has no clean correction story. The event model gives auditability,
corrections-via-void, and derived rollups for free, and is the pattern the codebase
already runs twice. The one honest tension: shipments/invoices are *documents* (each event
is a numbered business record) while an operation completion is a shop-floor tap — but the
auditability requirement alone forces per-event rows regardless, so the tension does not
change the answer.

### New table `public.job_operation_completions`

Created via `supabase migration new job_operation_completions` (CLI-timestamped), grants +
RLS + policies bundled in the same migration (Data-API-grants rule):

| column | type | notes |
|---|---|---|
| `id` | uuid PK | |
| `company_id` | uuid NOT NULL | member-scoped RLS, matches sibling tables |
| `job_operation_id` | uuid NOT NULL FK → `job_operations(id)` ON DELETE CASCADE | the op being completed |
| `job_part_id` | uuid NOT NULL FK → `job_parts(id)` ON DELETE CASCADE | denormalized-from-operation for rollup-query convenience + parity with `shipment_line_items` |
| `quantity_good` | numeric NOT NULL | `CHECK (quantity_good > 0)` — the **only** hard qty floor |
| `completed_by` | uuid FK → `auth.users(id)` | who (parity with `job_operations.completed_by`) |
| `completed_at` | timestamptz NOT NULL DEFAULT now() | when |
| `note` | text | optional free-text (non-blank if present), for the "reason" affordance |
| `voided_at` | timestamptz | correction path; filtered everywhere from day one |
| `voided_by` | uuid FK → `auth.users(id)` | |

- **No `quantity_scrap` in v1** (deferred). Adding it later is one additive column +
  one input; nothing about the v1 rollup or trigger needs it.
- **No over-completion cap** (following shipments, not invoices) — extra good parts are
  legitimate and no money is involved. The only DB constraint is `quantity_good > 0`.
- Grants: `SELECT, INSERT, UPDATE` to `authenticated` (UPDATE is needed for the void
  stamp), `SELECT` to `anon` only if operator reads run logged-out (they don't — drop
  it), full to `service_role`.

### The operation "target" and derived status

The per-op target quantity is `job_parts.quantity` — **every operation on a part must
produce the full part quantity of good pieces.** We keep the existing 3-value
`job_operations.status` enum and make it **trigger-derived** from events + target:

```
qty_good(op) = COALESCE(SUM(quantity_good) WHERE voided_at IS NULL, 0)
status = 'pending'      when qty_good == 0
         'in_progress'  when 0 < qty_good < target
         'completed'    when qty_good >= target        -- >= so over-completion still completes
```

Keeping the same enum is the key simplification: every downstream rollup
(`deriveStatusFromOps`, `recomputeJobPartStatus`, `compute_job_production_status`) reads
`op.status` and **keeps working unchanged** — the op just flips to `completed` at a
quantity threshold instead of a manual mark.

### New SQL + trigger (mirrors the fulfillment/invoicing families)

- `compute_job_operation_status(p_job_operation_id)` `STABLE` — the documented single
  source of truth returning the enum above. Reads `job_parts.quantity` for the target.
- `recompute_job_operation_status_from_completion()` trigger — fires on INSERT / UPDATE
  (void) of a `job_operation_completions` row; recomputes and persists
  `job_operations.status`, `completed_at` (set when crossing threshold, cleared when it
  drops below), `completed_by` (the completing user of the crossing event). Guard with
  `pg_trigger_depth()`.
- A completion event's INSERT/void → op.status change → the **existing**
  op→part→job rollup takes over (`recomputeJobPartStatus` in app code on the write path;
  the job_part→job DB trigger unchanged). We do **not** rebuild the part/job rollups.

Also add a trigger on `job_parts.quantity` change → recompute all its operations' status
(raising the order re-opens a `completed` op whose good < new target), exactly as the
fulfillment/invoicing families already re-open on quantity edits.

### Access layer: `utils/operationCompletionsAccess.ts` (new, typed)

Mirrors `shipmentsAccess.ts`. Use `getTypedSupabase()`.

- `createOperationCompletion({ jobOperationId, jobPartId, quantityGood, note? })` — direct
  Supabase INSERT (this is simple CRUD, not a privileged/multi-step op, so **no FastAPI
  endpoint** per the architecture rule). Stamps `completed_by` from `auth.getUser()`.
- `voidOperationCompletion(completionId)` — stamps `voided_at`/`voided_by`, idempotent via
  `.is('voided_at', null)` (the void trigger recomputes op.status). Mirrors `voidShipment`.
- `getOperationCompletionSummaries(jobPartId)` — the N+1-safe rollup: pull the part's
  operations + target, sum non-voided completions per op, return
  `{ job_operation_id, target, qty_good, qty_remaining: Math.max(0, target − qty_good) }`.
  Mirrors `getJobPartShipmentSummaries`.
- `getOperationCompletionEvents(jobOperationId)` — the per-op audit list (who / when /
  how-many / voided) for the admin history panel.

### Pure math helper: `components/operations/operationMath.ts` (new, React-free, unit-tested)

Mirrors `shipmentMath.ts`:

```
operationCompletionConsequence(input, remaining) ->
  'none'                       // input <= 0
  | { kind:'full' }            // input === remaining  -> "Completes this operation"
  | { kind:'partial', leftover } // input < remaining  -> "N will remain"
  | { kind:'over', excess }    // input > remaining     -> "Over by N" (warn, allowed)
```

---

## Status semantics & the next station

- **In progress vs complete** as defined above: an op with `0 < good < target` is
  `in_progress`; `good >= target` is `completed`.
- **What the next station sees:** unchanged. `get_ready_operations_for_station` surfaces a
  downstream op only when no earlier-sequence op is incomplete
  (`prev.status <> 'completed'`). A partially-done upstream op has status `in_progress`
  (not `completed`), so **downstream stays gated exactly as today.** Partial completion
  does not release downstream on the completed subset.
- **Flow splitting is explicitly OUT of v1.** Letting station 2 start on the 3 finished
  pieces while station 1 still owes 9 means tracking a sub-lot of WIP quantity moving
  independently between operations — a substantially larger feature (sub-lot identity,
  per-op WIP in/out quantities, split/merge). **Recommendation: defer to a later phase.**
  v1 keeps the current all-or-nothing gate on downstream visibility; the completed subset
  is *visible as a quantity* but does not advance the routing.

---

## Rollups & money paths — what changes, what deliberately doesn't

| Rollup / path | Assumes whole-op today? | v1 change |
|---|---|---|
| `deriveStatusFromOps` / `recomputeJobPartStatus` (app) | reads `op.status` | **No logic change** — op.status is now qty-derived but same enum |
| `compute_job_production_status` (DB trigger, job_part→job) | reads job_part status | **No change** |
| Count-of-ops progress in 3 UIs | yes (`completed/total`) | Keep count headline; **add** per-op qty annotation (see UI). Count semantics unchanged — no silent redefinition |
| Shippable qty (`fulfillment_status`, shipment events) | independent of ops | **No change — explicit decision: op progress never affects shippable qty** |
| Invoiceable qty (`invoicing_status`) | independent of ops | **No change — explicit decision: op progress never affects invoiceable qty** |
| Costing | estimate-only from routing | **No change** (partial data could later feed yield costing; v1 records data only) |

**Explicit money decoupling (no silent fallback).** Recording "3 good" does **not** make 3
pieces shippable or invoiceable. Shippable quantity continues to come *only* from shipment
events; invoiceable from ordered quantity (shipped as soft default). We do not synthesize
shipment/invoice eligibility from operation progress, and we do not add a "can't ship more
than produced good" gate in v1 (shipments deliberately don't hard-gate on production
today). The data to build that gate now exists; wiring it is a named deferred item.

---

## Scrap

**v1 records good quantity only; scrap is deferred** (user decision). The motivating
incident's "2 came out wrong" will not be structurally captured in v1 — the operator can
still note it free-text in the existing `notes` feed. The schema is deliberately
forward-compatible: adding scrap later is one additive `quantity_scrap numeric DEFAULT 0
CHECK (>= 0)` column plus one optional input, with **no** change to the v1 rollup
(`remaining = target − good`; scrap would remain display/audit-only, never reducing
remaining, never touching costing/material until a separate yield-costing phase).

---

## UI

1. **Operator completion flow**
   ([`.../operations/[jobOperationId]/page.tsx`](app/operator/[companyId]/jobs/[jobId]/parts/[jobPartId]/operations/[jobOperationId]/page.tsx)):
   the single `MARK COMPLETE` becomes a quantity entry. Number field **defaults to
   remaining good** (`target − good so far`, mirroring the shipment prefill), with a live
   consequence caption from `operationCompletionConsequence` ("Completes this operation" /
   "N will remain" / red "Over by N"). Keep shop-floor speed with a one-tap **"Complete all
   remaining"** button for the common full case. `Undo` becomes "void last completion"
   (or a short voidable event list).
2. **Operator job card**
   ([`.../jobs/page.tsx`](app/operator/[companyId]/jobs/page.tsx)): keep "X of Y
   operations" + bar; for the in-progress op add a "3 of 12 good" sub-label. Extend
   `buildOperatorJobs` to surface current-op good/target.
3. **Admin job page**
   ([`OperationsPanel`](components/jobs/OperationsPanel.tsx) /
   [`OperationCard`](components/jobs/OperationCard.tsx)): each op row shows
   "3 / 12 good · 9 remaining". Admin can complete a quantity (mirror of operator) and, in
   the already-existing expand panel, sees the **completion event history** (who / when /
   how-many / voided) with a per-event void action. Headline `completedCount / total` bar
   stays.
4. **Printed traveler** ([`jobTravelerPdf.ts`](utils/jobTravelerPdf.ts) `head`/`body`
   ~line 213): add a per-operation **target qty** and a blank **"Good made"** write-in
   column, since paper remains the offline capture fallback. Small, additive change.
5. **Part progress display generalization:** keep the count-of-ops percentage as the
   headline everywhere (no semantic change), and annotate each op with its good/target.
   We deliberately do **not** switch the headline to a quantity-weighted percentage in v1 —
   that would silently redefine a number three surfaces already show.

---

## Migration (zero data loss, reversible)

Additive, in one CLI-generated migration:

1. `CREATE TABLE public.job_operation_completions` + grants + RLS + policies.
2. `compute_job_operation_status` fn + the recompute trigger + the `job_parts.quantity`
   re-open trigger.
3. **Backfill:** for every `job_operations` row with `status = 'completed'`, insert **one**
   completion event: `quantity_good = job_parts.quantity`, `completed_by =
   job_operations.completed_by`, `completed_at = job_operations.completed_at`. Pending ops
   get no event.
4. **Verify at rest:** after backfill, `compute_job_operation_status` returns the same
   enum for every row (`completed` op with good = target → `completed`; `pending` →
   `pending`). Per the no-silent-fallback rule, every existing row satisfies the new
   invariant when the migration finishes — the read path has one clean shape.
   - Edge case: an op with `status = 'in_progress'` and no completions cannot have its
     quantity inferred and would derive to `pending`. In practice op-level `in_progress`
     is unused (ops go straight `pending → completed`; `in_progress` is only ever set on
     the job_part). The migration asserts this cardinality is ~0 and logs any rows found;
     `pending` is an acceptable resolution for an operator-abandoned op.
5. **Reversibility:** the down-migration drops the table + triggers + function. Because we
   **keep** `job_operations.status` / `completed_at` / `completed_by` as real columns
   (the trigger maintains them; it does not replace them), reverting leaves those columns
   holding valid last-computed values — no data is lost and manual completion still works.
6. Regenerate [`types/database.ts`](types/database.ts) (`pnpm gen:db-types`); CI diff-check
   enforces it.

---

## Phasing

**v1 (smallest shippable):**
- `job_operation_completions` table (good-only, `voided_at` from day one) + grants/RLS +
  backfill + reversible down-migration.
- `compute_job_operation_status` + recompute triggers (event insert/void, quantity-change
  re-open).
- `operationCompletionsAccess.ts` (create / void / summaries / event list), typed.
- `operationMath.ts` pure helper + consequence.
- Operator quantity entry (default remaining, "complete all remaining" shortcut, void).
- Admin `OperationCard` qty display + event history + per-event void.
- Progress surfaces annotated with per-op good/target.
- Traveler: target + blank "Good made" column.
- Explicit non-goals wired in: no money coupling, no downstream release, no scrap effect.

**Deferred (each stated):**
- **Scrap capture** (additive column + input; display/audit-only).
- **Flow splitting / sub-lot downstream release** on the completed subset.
- **Production→shippable gate** ("can't ship more than produced good") — data now exists.
- **Scrap → material consumption / yield costing** and **actual labor/time capture.**
- **Auto-logged `note_type='event'` feed entries** for completions in the activity feed.

---

## Acceptance criteria (spec-first, test-implementable)

Written to be turned directly into Vitest (`operationMath`, access layer) and
migration/trigger tests. Given/When/Then.

**Math (`operationMath.ts`)**
- AC1 remaining default: target 12, good 0 → prefill 12. good 3 → prefill 9. good 12 → 0.
- AC2 consequence — full: input == remaining → `{kind:'full'}` ("Completes this operation").
- AC3 consequence — partial: input 3, remaining 9 → `{kind:'partial', leftover:6}`.
- AC4 consequence — none: input ≤ 0 → `'none'`.
- AC5 **over-completion boundary:** target 12, good 3 (remaining 9), input 30 →
  `{kind:'over', excess:21}`; the caption is a warning and **submit remains enabled**.

**Access layer / triggers**
- AC6 create partial: op on a 12-qty part, insert good=3 → op.status `in_progress`;
  `getOperationCompletionSummaries` → `qty_good 3, qty_remaining 9`.
- AC7 accumulate to complete: after AC6 insert good=9 → op.status `completed`, remaining 0;
  the existing part rollup flips the part to `completed` when it's the only op.
- AC8 **over-completion allowed:** target 12, insert good=30 → succeeds (only
  `quantity_good > 0` enforced), op.status `completed`, `qty_remaining` clamped to `0`
  (never negative).
- AC9 **correction flow (30 instead of 3):** insert good=30, then
  `voidOperationCompletion(id)` → the event is `voided_at`-stamped (not deleted),
  excluded from the sum; op.status recomputes to `pending`; re-insert good=3 →
  `in_progress`, remaining 9. No event row is ever mutated in place.
- AC10 void is idempotent: voiding an already-voided completion is a no-op (no re-stamp).
- AC11 quantity re-open: op with good=12 on a 12-qty part is `completed`; raising
  `job_parts.quantity` to 20 recomputes the op to `in_progress` (good 12 < 20), remaining 8.
- AC12 **money decoupling:** inserting/voiding completions never changes the part's or
  job's `fulfillment_status` or `invoicing_status`, and never changes shippable/invoiceable
  quantities returned by `getJobPartShipmentSummaries` / the billable-parts path.
- AC13 **downstream gate unchanged:** with a partially-completed upstream op
  (`in_progress`), `get_ready_operations_for_station` does **not** surface the gated
  downstream op (it appears only when the upstream op reaches `completed`).

**Migration**
- AC14 backfill: a pre-existing `completed` op on a 12-qty part yields exactly one
  completion event with `quantity_good = 12`, `completed_by`/`completed_at` copied; its
  derived status stays `completed`.
- AC15 no regression: a pre-existing `pending` op yields zero events and derives to
  `pending`; a fresh `db reset` + backfill leaves every op's derived status equal to its
  pre-migration status (except documented empty in-progress edge case).

---

## Verification (end to end)

- `pnpm exec vitest run __tests__/.../operationMath.test.ts` and the access-layer test.
- `supabase db reset` (replays migration + backfill on fresh local DB), skim for trigger
  errors; the PR's Supabase preview branch is the authoritative gate.
- `pnpm exec tsc --noEmit` after regenerating `types/database.ts`.
- Manual: on the seed's Vanguard job, complete an operation for a partial qty as operator,
  confirm "3 of 12 good · 9 remaining" on the operator card, the admin `OperationCard`
  history, and that shippable/invoiceable numbers are unchanged (money decoupling).
- One operator E2E extension (partial-complete → assert remaining shown) added to
  `e2e/global-setup.ts`'s data shape rather than runtime-skipping.
