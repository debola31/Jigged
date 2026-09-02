# Operator View Module

**Route:** `/operator/{companyId}` — a mobile-first interface used by shop-floor operators on
their own phones.

> **Merged and condensed 2026-08-02 for [#634](https://github.com/debola31/Jigged/issues/634):
> three files of 14,558 words became this one of ~10,160 (−30%).**
> `docs/operator-paperless-flow.md` (3,390) was folded in and deleted — it duplicated this doc's
> current-state sections and contradicted *itself* on what had shipped. So was
> `docs/modules/partial-operation-completion-design.md` (2,923), a design doc whose subject
> shipped in July 2026, which had **zero inbound links**, and whose central claim about the status
> enum had since become false.
>
> **Every claim below was re-verified against the code on `main` @ `4eb4acf`.** That pass found
> this doc wrong about its own centre — capture is a *quantity*, not a single tap, see
> [Recording a completion](#recording-a-completion) — and found five shipped surfaces it had never
> mentioned at all. So roughly **1,900 words here are net-new true content**, and the reduction on
> the material the three files actually shared is nearer **−32%**. Length that buys previously
> undocumented behaviour is not the length #634 is about.
>
> What was cut: the build log, superseded reasoning left standing beside its replacement, prose
> restating what the code does, and screens tables an `ls` could rebuild. What was kept
> deliberately: every measured number, every **withdrawn argument** — one line each, because
> recording that a reason was *wrong* is what stops the next person rebuilding on it — every
> citation, and every named gap.
>
> If you are tempted to add length here, add it as a table row.

---

## Overview

An operator signs in on their own phone, taps the work centre they are standing at, sees what is
ready there, opens a step, and **records how many good pieces they finished**. Optionally they
write down what they learned, which the next person running that part will read.

The spine is the **MES-standard dispatch-list pull model** — the operator stands at a station, sees
what is ready, and pulls the next job — rather than work being pushed or assigned to them. That is
why there is no operator↔station assignment and no scheduler in this module.

The paperless path is the *preferred* path and has been wired end-to-end for a year. **The problem
was never a missing capability — it was that the path was never deployed.** The only QR codes in
the building were on printed travelers, so operators scanned paper because it was the only QR
there was. What remains is adoption, not construction — see
[Paperless is the preferred model](#paperless-is-the-preferred-model).

---

## Who does what, and where

> **Written 2026-08-02**, replacing a screens-and-routes table that had drifted on five of its
> nine rows. Verified against the code, row by row. Routes are relative to `/operator/{companyId}`.

The app is five bottom-nav tabs — **Jobs · Inventory · Scan · Maintenance · Me**. **No tab is
feature-gated**: `inventory_locations` and `machine_maintenance` were retired 2026-08-24 and both
surfaces are core for every tenant. Maintenance is gated on **a selected station alone** — a
station *is* a machine, so before one is picked there is nothing for the tab to be about — giving
the bar exactly two shapes: four tabs before a station, five after. Five is the Material Design
ceiling of 3–5, which is why Scan took the old Profile tab's slot rather than being added beside
it. **Keep Scan third**: dead centre at five slots, within half a slot of centre at four.

**Withdrawn:** "most shops see three" — wrong from the day `inventory_locations` went default-on,
and doubly so now; the bar's shape depends on the station, not on the tenant.

| I want to… | Where | How |
|---|---|---|
| Start work at the machine I'm standing at | `jobs` | Tap the work centre in the station picker. Remembered on the device, so every later visit lands straight on the queue. |
| See what's ready here | `jobs` | One row per (job, part) with an operation ready or in progress at this station, sorted by due date. |
| Find work when my station is idle | `jobs` → **All Stations** | The whole plant, grouped by station. Tapping a row at another station works — the mismatch only warns. |
| Check something I already finished | `jobs` → **Show completed** | Completed work at the current lens, so a step can be reopened and undone. |
| Work a step | `jobs` → row → step | Land on the ready operation, or the part's step list when no single step is ready. |
| **Record what I finished** | step → `Parts finished` | A quantity, then `RECORD COMPLETION`. Partial is normal. |
| Write down what I learned | step → the same block | One optional field + camera, submitted by the same button. |
| Read what the shop learned about this part | step → **Playbook · N** | Every note ever written about this part, useful-first. |
| Fix a wrong number | step → `Undo all (N)` | Voids this operator's entries; the status recomputes. Never an edit. |
| Send a part to a vendor / take it back | outside step | **Mark Sent Out** → **Mark Received**. No quantity, no station guard. |
| See all the parts on a multi-part job | `jobs/{jobId}` | Parts with progress. Single-part jobs redirect straight to the traveler — **which is now every new job**, since quote conversion creates one job per part. The hub still serves grandfathered multi-part jobs. |
| Go to a shelf, or open a traveler | `scan` | One scanner reads location labels *and* job travelers; a code from another company is refused by name. |
| Log something about this machine | `maintenance` | The machine logbook for the current station. |
| See who read my notes | `me` | Notes / photos / times viewed, then each note with its view count and readers. |

**Not built on this surface:** scrap or defect capture ([discovery](#scrap-and-defect-capture-discovery)),
any offline mode, real-time push ([manual refresh](#freshness-manual-refresh)), and any view of an
operator's own pace or standing ([guardrail](#surveillance-guardrail-non-negotiable)).

**Journeys that were once proposed here, and where they landed:**

| Journey | Status |
|---|---|
| Station entry by tap-select | **Built**, and it is the only entry path — see [Stations](#stations-work-centers). |
| Whole-plant "sign into the plant" view | **Built** as the All Stations lens — the **Andon / visibility pattern**: answer "where is job #123?" and "my station is idle, what else is ready?" without walking the floor. It was the one genuinely missing capability; it is not missing any more, and three sections of the old journey doc never caught up. |
| Multi-part job navigation | **Built** as the parts hub, with a back-link from the traveler on multi-part jobs only. Reachable only via grandfathered data now — no new job has more than one part. |
| Printed traveler as the primary path | **Demoted, deliberately.** It remains a fallback for shops mid-transition or spotty connectivity. |
| Scrap / defect flagging | **Not built, and not designed.** [Discovery first](#scrap-and-defect-capture-discovery). |
| Exploring real-looking data before doing real work | **Built** — the shop's **demo company**, same name as the office, entered from the "Me" tab and left from a bar carried on every screen. Operators enter but never create: the RPC is admin-only, so the entry renders nothing until an admin sets one up. Demo activity is excluded from `operator_events` at the write, so it cannot inflate the funnel. [demo-mode.md](demo-mode.md) |

---

## Authentication

- **Email/password via Supabase Auth**, the same as office staff; role = `operator` in
  `user_company_access`. `homePathForRole()` (`utils/companyAccess.ts`) is the single rule —
  `operator` → `/operator/{companyId}`, everyone else → `/dashboard/{companyId}` — shared by all
  four places that send someone home (post-login, `/launch`, the company selector, invite
  acceptance) so they cannot drift apart. Three of them used to hardcode `/dashboard` and lean on
  the `AuthGuard` bounce to correct it, which worked but cost a round trip and a visible flash on
  a new user's first screen.
- Operators use **their own phones**, so the Supabase session persists and sign-in is effectively
  one-time per device. Per-person login also gives clean `completed_by` attribution.
- **PIN-pad / badge-tap is deliberately deferred, not missing.** It only pays off when one device
  is shared at a station, which is not our model. `prd.md` FR-5 has been corrected to match.

## Stations (work centers)

- A "station" is a row in **`work_centers`** — see [work-centers.md](work-centers.md) for the
  definition and for the `operation_types` terminology it replaced. Each `job_operations` row
  carries `work_center_id`.
- The operator picks one from a tappable list (`components/operator/StationSelector.tsx`, fed by
  `getStationOperationTypes`). **There is no permanent operator↔station assignment** — operators
  roam. The picker shows internal work centres only, and **excludes archived ones**: without that
  filter it offers a machine nobody can be standing at, and selecting one is unrecoverable from
  the floor.
- **The AppBar's centre slot names the company while no station is chosen**, yielding to the
  station name once one is (`components/operator/OperatorCompanyLabel.tsx`, added 2026-08-08).
  That slot used to be empty before a station was picked, and the picker hides the bottom nav
  too — so the one screen where you commit to a working context identified **nothing**, while the
  operator login page one step earlier does show the company name and then loses it. A person who
  works two shops, or who has just stepped into the demo company, had nothing to check
  against. The name comes from
  [`OperatorCompanyContext`](../../components/operator/OperatorCompanyContext.tsx), resolved once
  for the whole operator tree off the company row the shell already fetches, so it costs no
  request; inside a demo company it is the **real** shop's name, matching the office.
  - **One place, not two.** The picker card deliberately does not repeat it. An interim version
    showed it in both and rendered the same words twice within ~100px on that screen. The header
    wins the single slot because the card is absent on the other screens reachable without a
    station (Me, Inventory), and because it is already where the operator looks for "where am I"
    once a station exists. `StationSelector` does not even import the company context, so
    re-adding the line throws rather than silently duplicating.
  - **A label, never a control.** The header's prohibition on a second tap target (Fitts's law;
    touch resolves to the nearest control) covers promoting inert text into a button. Switching
    company stays in the "Me" tab.
- Selection persists in **`localStorage`** (`jigged_operator_station`, via
  `components/operator/OperatorStationContext.tsx`) — *not* `sessionStorage`, so it survives a
  browser restart or a backgrounded-tab eviction. The header dropdown changes it any time; logout
  clears it (`clearStoredStation`).
- **An operator picks their station in the app, and there is nothing to scan to do it.** Tap-select
  plus **Shop floor view** on the dashboard jobs list reach everything the station needs to be.
  **Withdrawn:** an earlier plan treated printing something for every machine as the keystone of
  adoption. It was built, nothing was ever posted on a floor, and the bottleneck turned out to be
  adoption rather than the absence of a print button — which is the lesson worth carrying, not the
  artifact. The two printed things Jigged has are the **job traveler** and the **location label**,
  both covered by [QR codes and scanning](#qr-codes-and-scanning).

---

## Data model

**Operators** — `user_company_access` with `role='operator'`. The legacy `operators` table is gone.

**Operations** — `job_operations`, one row per routing step on a `job_part`: `sequence`,
`operation_name`, `instructions`, `work_center_id`, `status`, `completed_at` / `completed_by`,
`sent_at` / `sent_by`, and `estimated_setup_minutes` / `estimated_run_minutes_per_unit`
(**estimates only**, used for costing and quoting).

**Withdrawn 2026-08-16:** *"No actual-time columns … there is no start/stop, no timer."* True from
[`20260621132129`](../../supabase/migrations/20260621132129_drop_operator_time_tracking.sql) until
[`20260816203641`](../../supabase/migrations/20260816203641_job_operation_intervals.sql), which
adds recorded time back in a different shape. `operator_sessions` and `job_operations.actual_*`
stay dropped and are not coming back — the new table is not that table (see
[Recording time](#recording-time)). There is still **no shift and no clock-in**: this measures time
on an operation, never attendance, and the two must not be conflated.

**Completions** — `job_operation_completions`
([`20260721023953`](../../supabase/migrations/20260721023953_job_operation_completions.sql)):
`company_id`, `job_operation_id`, `job_part_id`, `quantity_good`, `completed_by`, `completed_at`,
optional `note`, `voided_at` / `voided_by`, `created_at` / `updated_at`. Two CHECKs:
`quantity_good > 0` — **the only hard quantity floor in the system** — and a non-blank `note`.

**Outside (external-vendor) steps** use a send/receive lifecycle rather than a quantity:
`pending → (Mark Sent Out) sent → (Mark Received) completed`. `sent` is an **optional waypoint** —
Mark Received also completes directly from `pending`, the common after-the-fact case, back-filling
the send stamp. An external step can **never** be completed through the internal path and is never
auto-skipped. Full lifecycle, surfaces and invariants:
[jobs.md](jobs.md#outside-external-vendor-operations).

**Notes** — `notes` (+ `note_media`), renamed from `job_notes` / `job_note_media` in
[`20260728040701`](../../supabase/migrations/20260728040701_notes_subjects_and_view_logging.sql).
Not to be confused with **`part_comments`** (renamed from `part_notes` in the same migration) —
the office-side part activity feed carrying manual comments alongside system-generated
pricing/stock events. It is **a different domain entirely**: operators never see it, and it has no
view logging, no subjects, no media.

A note carries a **subject** (`subject_kind`) — what it is *about*, not where it was captured:

| `subject_kind` | Required | Optional refinement |
|---|---|---|
| `job` | `job_id` | `job_part_id`, then `job_operation_id` |
| **`part`** | **`part_id`** | **`routing_operation_id`** — the routing step |
| `work_center` | `work_center_id` | — |

Enforced by the `notes_subject_valid` CHECK plus a `notes_validate_subject` trigger doing what a
Postgres CHECK cannot: every subject FK must belong to the note's own `company_id`, and
`routing_operation_id` must belong to `part_id`.

**Why `part` matters.** Before this, `job_notes.job_id` was NOT NULL, so every note in the system
died with its job and "what we learned running this part" had to be *reconstructed at read time*
by walking prior completed jobs. A note anchored to `(part_id, routing_operation_id)` has no job
in it at all, so the next person running that part reads the row the last person wrote.

`captured_job_id` / `captured_job_operation_id` are **provenance, not subject** — where a durable
note was written, so it still appears in that job's feed. Both are `ON DELETE SET NULL`: the
knowledge outlives its origin.

Which subject the composer writes is never an operator decision. If the current `job_operation`
has a `routing_operation_id`, `addJobNote` writes a `part` subject with provenance; otherwise (an
ad-hoc step with no routing link) a `job` subject. **New operator captures are durable by default.**

### Status model

`job_operations.status` is `pending | in_progress | completed | sent`, and for internal steps it is
**derived from recorded quantity by a trigger, never set by hand**
(`compute_job_operation_status`):

```
qty_good = SUM(quantity_good) WHERE voided_at IS NULL
pending      qty_good = 0
in_progress  0 < qty_good < job_parts.quantity
completed    qty_good >= job_parts.quantity     -- >= so over-completion still completes
```

**Outside steps are exempt**: when the work centre is `kind='external'` the function returns the
**stored** status untouched, because those ops are driven by send/receive. Without that branch a
part-quantity edit would recompute a `sent` op back to `pending` and lose the send stamp.

Raising `job_parts.quantity` **re-opens** a completed op whose good total no longer reaches the
new target — the same behaviour the fulfillment and invoicing families already have.

**Corrected 2026-08-02.** This doc previously said an operation was `pending → completed` by a
single tap and that there was "no operation-level in-progress concept". Both are false. What
survives is the narrower and still-true claim: **there is no manual start or pause — WIP is
derived from quantity, never asserted by a human.** At the job/part level, `production_status` is
derived as before, and a `sent` op counts as *not completed*, so it holds its part at
`in_progress` and blocks downstream internal steps until the parts are received.

---

## Recording a completion

The operator types how many good pieces they finished into `Parts finished` and taps
`RECORD COMPLETION`. Each entry is one append-only `job_operation_completions` row — who, when,
how many — and the operation's status recomputes from the running total.

**Partial is the normal case.** The motivating incident: order quantity 12, material for 5, 2 came
out wrong, 3 completed. The only way to record "3 done, 9 to go" was a free-text note — *"3 are
complete need 9 more"* — so the fact lived in prose, nothing rolled it up, and the next run had to
re-read the note.

**Decisions taken 2026-07-20, and what each rejected:**

| Decision | Why, and what lost |
|---|---|
| **Append-only events, not a mutable `completed_quantity` column** | **Withdrawn:** a counter cannot distinguish `3+3+3` across three shifts from one entry of `9`, and has no correction story. Events give auditability and corrections for free. |
| **Corrections are void, never edit** | `Undo all (N)` stamps `voided_at`/`voided_by`; the trigger recomputes. This is the house partial pattern's **third** use, after `shipment_line_items` and `quickbooks_invoice_line_items` — both shipped `voided_at` from day one, and this one does too. |
| **Over-completion warns, never blocks** | Follows **shipments**, not invoices. Extra good parts are legitimate and no money is involved; the only DB floor is `quantity_good > 0`. |
| **Good-only in v1; scrap deferred** | Adding scrap later is one additive column plus one input, with no change to the rollup. See [discovery](#scrap-and-defect-capture-discovery). |
| **Fully decoupled from money** | Recording "3 good" does **not** make 3 pieces shippable or invoiceable — `fulfillment_status` and `invoicing_status` are untouched. This is an explicit decision, not an omission: the data for a "can't ship more than produced" gate now exists, and wiring it is a **named deferred item**. |
| **Flow splitting is out** | Letting station 2 start on the 3 finished pieces means sub-lot identity, per-op WIP in/out, and split/merge. Downstream stays gated until `completed`; the finished subset is *visible as a quantity* but does not advance the routing. |

**The station mismatch warns; it does not block.** If the step's work centre differs from the
operator's selected station a warning shows **and the action still works**, because completion
keys off the operation id, not the station. *(An earlier revision of this doc, and `prd.md` §4.3,
described a guide offering a one-tap "switch & complete". No such control was ever built.)*

**Backfill.** Every pre-existing `completed` op got exactly one event at
`quantity_good = job_parts.quantity`, so every row satisfied the new invariant when the migration
finished. The part rollup runs *inside* the trigger function, which is why the shipped guard is
`pg_trigger_depth() > 4` rather than the `> 2` the sibling families use.

---

## Recording time

`job_operation_intervals`
([`20260816203641`](../../supabase/migrations/20260816203641_job_operation_intervals.sql)) — a span
of recorded time on one operation. Added 2026-08-16, reversing
[`20260621132129`](../../supabase/migrations/20260621132129_drop_operator_time_tracking.sql) under
the condition that migration's successor had written down in advance.

**It is not `operator_sessions` under a new name**, and the differences are the reason this one can
work where that one did not:

| Decision | Why, and what it rejects |
|---|---|
| **Chained on the WORK CENTRE, one open interval per machine** | Cost is charged at `work_centers.labor_rate` through `job_operations.work_center_id`, so this measures **machine time, not operator attention**. Keyed on the operator instead, a machinist tending three spindles would have Mill-2 silently closed the moment they tapped into Lathe-1 — a *fabricated* stop, and the modal shape of a precision shop. Two partial unique indexes make an overlap unrepresentable. |
| **No Stop on the happy path** | You stop by starting the next thing, by recording the completion, or by `Done for the day` / `Left it running`. The forgotten stop is the dominant failure mode in every product surveyed, and this surface has the weakest possible recovery channel — see below. |
| **Never auto-closed** | An open interval stays open, loud on the office list, and excluded from every rollup until a human says when it ended. Fabricating an end is a silent runtime fallback for a data-at-rest problem. |
| **Raw and adjusted are separate columns; `effective_*` is generated** | E2/Shoptech's shipped model — `Actual Clock In/Out` beside `Adjusted Clock In/Out`, only Adjusted editable. `started_at`/`ended_at` are not in the browser's UPDATE grant, so the raw pair is immutable by construction rather than by convention. Generating `effective_*` gives every reader one shape and no `COALESCE` to forget. |
| **Writes are RPC-only** | The chain close crosses row ownership: the **shift handoff** — B starts on the machine A forgot to close — is routine, and under an own-rows UPDATE policy B is blocked by the unique index and denied by RLS, with no way forward. `start_operation_interval` crosses ownership by design; `close_operation_interval` asserts it, because an explicit close carries adjusted times and an unchecked id would let any member rewrite anyone's hours. |
| **`capture_source` ships with the operator path** | `operator | sensor | system`. An interval left open overnight is exactly where a sensor interval will later contradict a labour one, and without a common shape there is nothing to express the disagreement *in*. |
| **No setup/run phase control** | An 18-vendor sweep found nobody shipping a SETUP/RUN toggle inside a running timer: it is a UI mode that fails *silently* into the office's numbers. The split is solvable office-side from what this table already produces — `T = setup + q × cycle` across runs of the same part-operation, with the existing estimates as priors — at zero operator taps. **Deferred, not rejected.** |

**Starting is mandatory, and the primary button is what enforces it.** One button changes meaning
— `START THIS STEP` when idle, `RECORD <n> FINISHED` when running. Having both on screen at once
was the original mistake: it let a step be completed without ever being timed, which made the timer
optional in practice and left the data half-collected. The label **interpolates the quantity** into
the verb rather than reading `COMPLETE`, because partial completion is the normal case and a bare
"Complete" would misstate it.

**`Complete without timing` is the deliberate escape hatch**, quiet but always present when there
is a quantity to record. A hard block is the one shape that reliably corrupts this screen — it
already carries an incident where a constraint that could not be satisfied led operators to type a
false quantity to get past it. It records **no interval**, never a backdated one: a remembered
start is a recall estimate, recall bias grows with the magnitude estimated, and an invented duration
would corrupt exactly the data this feature exists to collect. An honest absence beats a plausible
fabrication, and it is the same state an office-side completion already produces. `operation
completed untimed` measures how often it is used — a rising rate means starting is too hard to
reach, which is our problem and not the operator's.

**The job feed is the record; the clock is only the readout.** Starting appends a *"Started Final
Inspection · 11:06 PM"* entry and finishing appends a separate *"Finished … · 12:47 AM · 1h 41m"*
above it — **two rows, never one that rewrites itself**, because a log entry that changes after the
fact reads as the surface losing track. Each row carries **Adjust**, editing the end its own number
came from, so a correction happens where the wrong figure is rather than in a dialog asking about
both. Corrections write immediately (see the constraint note below); nothing is held in page state.

**Withdrawn 2026-08-17, unshipped: a confirm sheet before recording.** It was built and removed the
same day. The reasoning that made it *safe* still stands — what B4 deleted was a **post**-completion
offer, and a pre-completion sheet writes nothing until confirmed, so it never reintroduced that bug
— but safe is not the same as warranted. It put a third surface (strip, clock, sheet) in front of
one fact, and once the feed carries the record there is nothing for a sheet to add. Completion is
one tap again, with the inline composer riding along exactly as B4 requires.

**Withdrawn 2026-08-17: the running-timer strip in the shell.** A bar above the job card duplicated
what the step screen's own clock and feed already say. **The cost is real and was accepted
knowingly:** with no notification channel either (see below), *nothing outside the step screen
indicates a timer is running*, so a forgotten stop is caught by the office Still-running list the
next morning rather than by the operator in the moment — which makes that correction a recall
estimate. An E2E assertion checks the strip has not crept back.

**Withdrawn 2026-08-18: `Stop without finishing`, and the `done_for_day` / `left_running` reasons
behind it.** Built and removed. They asked the operator to classify a stop — a second decision on
top of the one that matters — and an interval left open already says "nobody closed this" on the
office Still-running list without anyone having to name why. `close_reason` is now only `completed`
or `switched`, and `close_operation_interval` has no reason parameter at all.

**So an interval closes exactly two ways: you record what you finished, or the chain closes it when
the next start takes the work centre.** An operator who walks away leaves it running and corrects
the times from the feed afterwards, which is the same correction path every other mistake uses. The
accepted cost is that a deliberate lights-out run and a forgotten stop now look identical until
someone says otherwise.

### `Cancel activity` — the third end, added 2026-08-26

An interval still closes exactly two ways. It is now **discarded** a third:
[`cancel_operation_interval`](../../supabase/migrations/20260826105251_operator_can_cancel_a_running_activity.sql)
stamps `voided_at` / `voided_by` and leaves `ended_at` and `close_reason` NULL.

**The dead end it closes.** An operator who started a step and produced nothing could not stop the
clock at all. `close_operation_interval` refuses a non-owner, so the office could not; the owner's
only close path runs through `createOperationCompletion`, floored at `quantity_good > 0`;
`Complete without timing` is hidden while a timer runs; and `Adjust` is absent from a running row.
The only remaining move was to type a quantity you had not made and then undo it.

**That workaround was not hypothetical — it was already in use, in two places.** The E2E suite's
`stopTimer()` helper did it deliberately and said so in a comment; and of the three intervals that
had ever existed in production, two were seconds-long runs on J-0013 EDM created with a completion
and immediately voided, by hand, because there was no other way. Both are gone now: the helper
drives this control instead.

**Why it voids rather than closes, and the argument NOT to make.** It is tempting to say we do not
know when the work stopped, so closing at `now()` would fabricate an end. Do not — this schema
fabricates that end routinely: `start_operation_interval` closes whatever holds the chain slot at
`now()` on every chained start, and it did exactly that to J-0118 / OP 30 EDM, which is now a
408-minute `switched` interval feeding that operation's actual-vs-estimate. The real reason is
simpler: **this is Undo for a timer.** Voiding a completion already voids the intervals it closed;
this is the same act one step earlier, so it voids too.

**Why it is not a revert of the 2026-08-18 withdrawal.** That removed a control that asked the
operator to *classify* a stop and that *closed* the interval, preserving the measured span under a
label. This takes no reason and discards — a different act, and the opposite direction on data
preservation. The withdrawal's objection, "a second decision on top of the one that matters", does
not apply where there is no second decision.

**What it costs and what it frees.** Both partial unique indexes carry `voided_at IS NULL`, so a
discard releases the work centre's chain slot immediately — the machine is available to the next
start without an end time ever being asserted. Every reader already filters `voided_at IS NULL`, so
the row contributes to no total and **both** its `Started` and `Finished` feed rows disappear. It
introduces one genuinely new row state, `voided_at IS NOT NULL AND ended_at IS NULL`: until now
every voided interval was also closed.

It is confirmed by a dialog rather than an Undo snackbar — this is the "immediately-persisted, no
restore" row of [interaction-standards.md](../interaction-standards.md)'s scaled-friction table, and
the audience floor rules the snackbar out. The confirm copy says the step itself is unaffected,
because "Activity" also names a dashboard section and the notes feed.

**A `Finished` row says how many parts it produced**, resolved through
`job_operation_intervals.completion_id` rather than stored, so it can never disagree with the
completion itself. A row that says a step stopped but not what came off it withholds the half an
operator scrolls back to check.

**Undo retracts the time with the count — decided 2026-08-18.** Voiding a completion voids the
intervals it closed, through a trigger on `job_operation_completions` rather than client code: it is
atomic with the void, and `revertOperationCompletion` is called from both the operator undo and the
office one, so neither caller has to know and a third cannot forget. Scoped by `completion_id`, so
`switched` intervals — real work no completion ever claimed — survive.

**The cost is accepted, not overlooked: real measured minutes are discarded because a COUNT was
wrong.** An operator who types 10 instead of 12 loses the timing of work they genuinely did, and
re-recording produces a fresh, shorter interval that understates it. The alternative — keeping the
time and dropping the quantity — was rejected because a `Finished` row surviving its own completion
claims production that was retracted, and once the row carries a quantity that is not clutter but a
false statement.

**The feed shows YOUR time entries and EVERYONE'S notes**, and the asymmetry is deliberate. A
job-scoped feed naming when each person started would be a per-person time view available shop-wide.
There is no admin path to that view either: `get_operator_time_detail` was removed, so **no role**
can resolve recorded time to a named person. The feed's self-only scope is now the only per-person
view of time in the product. RLS enforces it.

**`Complete without timing` appends a Finished row too, marked `not timed`.** It records no
interval — a remembered start is a recall estimate, and inventing one would corrupt the data this
feature exists to collect — but it is still work that happened, so it belongs in the log. It is
rendered from the completion rather than an interval, with a check glyph instead of a clock (a clock
on a row holding no duration would be the one part of this UI claiming something untrue), no
duration, and no `Adjust` (there are no times behind it to correct). **Withdrawn:** *the escape
hatch leaves no feed entry* — that was not a decision, it was a gap: the step flipped to complete
with nothing saying so, so the operator who took the honest path got less acknowledgement than the
one who timed it.

Completions in the feed are the reader's **own**, with no actor name, exactly like the interval rows
beside them — a job-scoped list of what each named person finished and when would be the per-person
production log the guardrail refuses. A completion an interval already claims is shown once, as the
timed row; the feed drops the duplicate by matching `completion_id`.

**With one addition, made 2026-08-28: every completion the OFFICE recorded is shown to everyone.**
The own-rows rule is about *people*, and an office completion has no person in it — so including it
exposes nobody's pace, and **excluding it was a bug**. The office marked a step done and the floor's
own record of that step stayed silent, so the operator standing at the machine had no way to learn
their step had been closed out from under them. Those rows read `recorded in the office` where an
operator's untimed row reads `not timed`: both are untimed, but "you finished this and forgot the
clock" and "the office closed this step out" are different facts, and rendering the second as the
first tells an operator they did something they did not do.

The split is [`job_operation_completions.capture_source`](../../supabase/migrations/20260828124806_office_completion_is_untimed_and_in_the_feed.sql)
— the **surface**, never the actor's role. An admin standing at a machine records through the
operator surface and their row is operator capture; classifying by role would publish it shop-wide.
`NULL` means "recorded before that migration, surface unknown" — an honest no-data state rather than
a default, and those rows stay own-only, so nothing at rest changed meaning.

**Times can only be adjusted once the interval is closed** — `job_op_intervals_adjust_only_when_
closed`, and `Adjust` is absent from a running row rather than merely disabled. A running interval
has no finish to check a new start against, so a correction made mid-run can be contradicted by the
finish that follows, and the contradiction only becomes representable at close — after the UI has
already said it saved. Recording the completion is what makes both ends known, which is what
`AdjustTimesDialog` validates against each other.

Ordering is enforced on the **effective** pair (`job_op_intervals_effective_ordered`), not the
adjusted one. Checking only the adjusted pair short-circuits when just the start is corrected: on a
closed 9:00–10:00 interval, an adjusted start of 11:00 was accepted and produced a −1h duration that
[`get_operation_actuals`](../../supabase/migrations/20260816203641_job_operation_intervals.sql) would
have summed into a negative actual.

**Withdrawn:** *an adjusted START is allowed on a running interval; only the END is guarded* —
wrong because it assumed the only risk was claiming a finish that never happened. The real risk is
an unvalidatable start, and *"I actually started twenty minutes before I tapped"* being knowable
immediately does not make it checkable immediately.

**No dictate button, and no speech API — decided 2026-08-17.** `webkitSpeechRecognition` **fails in
an installed PWA**, and even in plain Safari it needs Siri enabled and carries documented throttling
and interim-result bugs in WebKit. Both mobile keyboards already ship a microphone, so a plain
multiline field gives dictation on every phone with no permission prompt and no bundle.
[`NoteCaptureFields`](../../components/operator/NoteCaptureFields.tsx) already promotes it —
`MicHint` draws the iOS dictation glyph and says *"tap the ⌇ on your keyboard to talk instead of
type"*, capped at five shows and dismissible.

**The cap is per hook instance, which constrains where the composer may be mounted.** The confirm
sheet renders the step screen's *existing* `useNoteCapture` object rather than creating its own —
otherwise one visit would count two shows and retire the tip in half the time. A future surface
that wants a composer should pass the caller's capture in, not call the hook again.

**Why there is no "you left a timer running" notification.** iOS Web Push requires the site to be a
Home Screen *web app*, and [`app/manifest.ts`](../../app/manifest.ts) sets `display: 'browser'`
deliberately: standalone gives the icon a cookie jar separate from Safari, and since the Camera app
opens the default browser, every scanned traveler QR would then land in a different session and
start demanding a password. There is also no service worker at all. Even fully built the blended
reach is ~48%, and the errors correlate the wrong way — the operator disciplined enough to install
a PWA is the same one who remembers to close their interval. **The correction prompt arrives at the
operator's next tap instead**, which is on-shift, phone in hand, and has a delivery receipt.

**The office keeps the detection half.** `get_open_intervals` backs a Still-running list, which is
also the *only* route to an interval whose owner has gone home — `close_operation_interval` and
`cancel_operation_interval` both refuse a non-owner by design, so without that list the row would be
unreachable.

**And, since 2026-08-28, the correction half.** That "only route" claim was aspirational for twelve
days: the list rendered rows and no control, so the route led to a read. J-0001 is what it cost —
an interval opened at 06:49, visible from the office, closable by nobody.
[`void_open_intervals_for_operation`](../../supabase/migrations/20260828124806_office_completion_is_untimed_and_in_the_feed.sql)
is the missing half, and the card's **Stop** is its caller. It **discards rather than closes**:
`voided_at` is stamped and `ended_at` left NULL, because nobody at that desk knows when the work
stopped and a stamped end would be counted as a measurement. It is admin-gated rather than
owner-gated — the narrow exception to the ownership assertion every other write path here enforces —
and it takes an *operation* and returns a *count*, so the office can stop a timer without ever
learning whose it was. The same call runs when the office completes a step somebody was timing; see
[jobs.md](jobs.md#job-operations-on-the-admin-side).

**Costing is untouched.** Quoting and job cost still read `estimated_setup_minutes` /
`estimated_run_minutes_per_unit` and the snapshot rates. Actuals are reported *beside* the
estimate, never substituted into `true_cost_per_unit` — changing what a job costs is a separate and
louder decision than measuring what it took.

---

## The read-back loop (attribution)

A note that goes into a void is not worth writing. `note_views` closes the loop: reads are logged,
counted, and reflected back **to the author only**.

**What is logged.** `useNoteDwell` observes note *bodies* — never a header, never a count badge —
and logs a view after **2 seconds visible**, gated on `document.visibilityState === 'visible'`,
because an IntersectionObserver reports intersecting in a backgrounded tab and a count that
exceeds reality is worse than no count. Dwell completions batch into one `log_note_views(ids,
jobId)` RPC per screenful, fire-and-forget, Sentry on failure, never a user-visible error.

**Dedupe:** `UNIQUE NULLS NOT DISTINCT (note_id, viewer_id, job_id)` — one row per person per note
per job, forever. `NULLS NOT DISTINCT` is load-bearing: `job_id` is nullable, and the SQL default
treats every NULL as unequal, so repeat Playbook reads would insert unbounded rows.

Two counters on `notes`, maintained only by the `note_views_bump_counts` trigger and **monotonic**
(`GREATEST`, no decrement):

- `viewer_count` — distinct **people**. Saturates near shop size; that is its meaning.
- `usage_count` — distinct **jobs**. Uncapped, and the signal separating a load-bearing note from
  one read once out of curiosity. It ranks the Playbook.

**Never logged:** the author's own reads, or anyone with
`user_company_access.excluded_from_metrics` / in `system_admins`. Both are enforced inside
`log_note_views`, because the browser has no INSERT grant to opt out of.

### Privacy — the rules that must not be relaxed

`note_views` has **no client-readable path at all**. Not a narrow policy — none. Any row-returning
SELECT policy is probeable into a per-viewer oracle via `HEAD ?note_id=eq.X&viewer_id=eq.Y` with
`Prefer: count=exact`, and RLS is powerless against a count computed over exactly the rows it
admitted. So:

- **No grant to `anon`, `authenticated`, or `jigged_ai_readonly` — ever.** A RESTRICTIVE deny-all
  policy names all three, so a future permissive policy still ANDs to false.
- **No function touching `note_views` may accept a viewer parameter.** Two do: `log_note_views`
  (returns `void` — a duplicate must be indistinguishable from a first view) and
  `note_viewers(note_id)` (authors only, one row per person, ordered by name, **no timestamps**).
  `my_note_digest()` used to be a third; it now reads `notes.viewer_count` and counts
  `note_reactions` instead, so it is `SECURITY INVOKER`. **It takes no arguments, permanently** —
  a caller-supplied time window would be a bisection oracle for when a note was read.
- **`authenticated` has UPDATE on exactly one column of `notes`: `body`.** Notes were append-only
  until #628; editing was added on terms this section set in advance — a permissive author-only
  policy **and** a column-scoped grant. The grant *names* the editable column rather than
  *excluding* a list, the stronger form: a column added next year is non-updatable by default
  rather than relying on someone remembering to extend a denylist. `viewer_count` and
  `usage_count` stay unwritable by any browser role, so setting `viewer_count = 0` and returning
  later to read the delta is impossible.
  - **An edit never resets a note's reach**, and that was the live design question. A reset is
    superficially fairer — "7 people read this" after a rewrite refers to 7 people who read
    different words — but it is the exact oracle this section denies: an author edits at 9:00,
    glances at 9:15, and any increment says somebody read it in those fifteen minutes, with
    `note_viewers()` supplying the name and defeating its no-timestamps rule. It would also not
    have worked mechanically, since `note_views_bump_counts()` recounts rather than increments, so
    the next read restores the true total. The honesty cost is carried by `edited_at` and a
    "· edited" marker instead.
  - `edited_at` is **stamped by a `BEFORE UPDATE` trigger and granted to nobody** — the marker is
    a claim made to other readers, so the one party with a motive to suppress it must not be able
    to write it. The same trigger refuses any browser UPDATE touching a column other than `body`
    (a backstop against a future blanket `GRANT`, not against a bad policy), and skips non-browser
    roles by `current_user`, because `note_views_bump_counts()` legitimately writes the counters as
    the table owner — **without that skip every note read would 500.**
  - `note_counter_write_leaks()` asserts the whole property in CI, so a future
    `GRANT ALL ON public.notes` fails the build rather than silently re-opening it.
- `user_company_access` UPDATE/INSERT **are** column-scoped, to `(name, role, email, pin_hash)`.
  Without that, an admin flags everyone-but-one with `excluded_from_metrics`, watches whose reads
  still count, and has a full deanonymization — or deletes and re-inserts a membership to the same
  end.
- Counters are **monotonic** so deleting a member and differencing the counts cannot reconstruct
  what they read.
- Never add `note_views` to `supabase_realtime`, and never call `apply_ai_read_access` on it —
  it is named in the surveillance block of `tenant_tables_missing_ai_decision()`'s exempt list
  for this reason. Never add a constraint
  requiring a `note_views` row before a reaction — that turns the reaction endpoint into a
  "has X viewed N" oracle.

**There is no owner-facing report of who read what.** One sentence, no role branch: *you see who
viewed your own notes; nobody sees who viewed anyone else's.* `note_viewers()` deliberately has no
admin exclusion — roles move up and down in a small shop, and an operator promoted to lead must
not silently lose the feedback loop on notes they already wrote.

**Residual, stated rather than hidden:** an admin can read `viewer_count` (by design), poll it, and
correlate an increment with who was on shift. That is inherent to publishing any count. The design
denies every amplifier — no per-job breakdown, no timestamps in the named list, no read timeline,
no realtime stream. Jigged staff with prod access can read the table as `postgres`; the promise is
"your boss cannot see this", not "nobody can".

**Second residual, added with #628:** exposing Delete hands an author a crude version of the reset
that editing refuses — delete, repost, and the copy starts at `viewer_count` 0. That path is not
new (RLS always permitted an author to delete their own note; only the UI was missing) and stays
acceptable because it is **loud** where an edit-triggered reset would have been silent: the note
visibly disappears and comes back, loses its reactions and photos, and jumps to the top of the
feed. Anyone using it as a polling oracle does so in full view of everyone reading the same feed.
**The distinction worth preserving is silence, not irreversibility.**

### What comes back to the author

**Login banner** (`NoteUsageBanner`, on the jobs list) — *"2 people found your notes helpful · 3
new views."* `my_note_digest()` returns **running totals** across the caller's own notes: views
(the sum of `viewer_count`, exactly the figure My work shows, so the two can never disagree) and
helpful marks. **Helpful leads when present** — a view is someone needing to look something up; a
helpful is a colleague choosing to say it was worth reading. Only signals that moved are
mentioned; `helpful` is **not** monotonic (a mark can be taken back), so its delta is clamped at
zero. The component banks the last acknowledged total in `localStorage` and renders the
**difference**, so it appears only when something happened and goes quiet once seen — no nag on
the many jobs-list visits in a shift. Both the ✕ and a tap-through bank the total; `null` at zero.

**First run on a device announces nothing.** The mark follows the *device*, not the person, so a
replacement phone or cleared site data starts empty; defaulting to zero would render the whole
history as new ("312 new views" after a year), and the banner's only asset is that its number is
true. The current total is adopted silently and the *next* view announced correctly — one missed
announcement, with the full picture one tap down on My work. A mangled stored value is treated as
**absent** for the same reason.

**Two earlier designs are recorded because both are tempting and both are wrong.** A **weekly
window** let the count climb all week while dismissal was all-or-nothing, so dismissing at "1
person" on Monday silently swallowed Friday's "6" — the nag and the reward were the same object. A
**"last opened" timestamp** would travel back as a query window, and a caller-supplied window is a
bisection oracle: narrow it repeatedly and you recover *when* a note was read, which with
`note_viewers()` naming the reader reconstructs "Kurtis had to look this up on Tuesday". A count is
a number the server already told us, so subtracting on the client leaks nothing.

**New since you last looked** (My work, above everything) — the NAMED half of the loop. *"Diego
Alvarez found your note helpful"*, quoting the note as a **blockquote** rather than setting it in
bold: bold read as the block's own headline, so the one thing the surface exists to say — that
somebody valued something *you* wrote — was the thing it did not say. Reactors are grouped by note,
so three people marking one note is ONE item naming three, never three items and never a per-person
total. Names are acceptable here and not on the banner because this is the surface an operator opens
about themselves; the banner is glanceable over a shoulder. Renders nothing at zero.

**Dismissal destroys nothing.** **Got it** (no timer, never cleared by scrolling past) advances
`user_company_access.reactions_seen_at` through `mark_reactions_seen()`; every reaction stays on its
note below, permanently, because the prompt and the record are different objects. The cursor is
**server-side**, unlike the banner's `localStorage` mark, because what a new device would lose here
is a name rather than a number — and `note_reactions` is already company-readable, so a "seen
through T" cursor discloses nothing a member could not already query. It is forwarded to PostgREST
as the **raw string**: Postgres keeps `timestamptz` to the microsecond and JS `Date` only to the
millisecond, and since the cursor is set to the newest reaction actually shown, truncating it makes
that reaction compare strictly greater and return as "new" for ever.

Eligibility is capped at **8 weeks** so a long absence is not met with stale news; the DISPLAY has
no expiry. Derived from live `note_reactions` rows rather than stored messages, so a retracted mark
simply stops appearing and no "still valid?" rule is needed. **The cursor is one-way by design**
(`mark_reactions_seen` never moves it backwards, so two devices cannot un-see each other's
dismissal) — which means a shared demo database is spent once someone taps Got it, and
`supabase/seed.sql` therefore sets the cursor deliberately rather than leaving it NULL.

**My work** (`/operator/{companyId}/my-work`, the **Me** tab) — a summary headed *"Your notes so
far"*, then the operator's notes ten at a time behind **Show more**, each row the note itself with
one quiet metadata line: view count, one reference, date. Tapping the view count names the viewers;
the overflow carries **Open J-NNNN**, Edit and Delete. Identity, Log out and Give feedback sit at
the top (`/operator/{companyId}/profile` is now a redirect here).

**Switch company** joins them there, and only for an operator who actually belongs to more than one
shop — for everyone else `OperatorCompanySwitcher` renders nothing. It exists because the company
switcher lives in the office sidebar and this surface has no sidebar, so a two-shop operator had no
route to their second company at all; logging out did not help, since login follows
`last_company_id` straight back. It sits **beside Give feedback, not in the identity row**: Log out
has to remain the only tap target in that row, and making the company name already shown there
tappable is exactly the tidy-up that would break it.

Two details are load-bearing. **The heading predicates the notes, not the operator** — a view is
not something they added, but the notes *were* viewed, so every figure under it is a true
predicate; and *"so far"* stays unbounded, because a window would turn a tally into a rate, and a
rate is pace. **The reference is the job number for a job or part note and the work centre for a
maintenance entry** — a `notes` row has exactly one subject under the CHECK, so they are mutually
exclusive; `part_name` appears only as a fallback once a durable part note's capturing job has
been deleted.

**The word is "views", never "uses".** All that is recorded is that someone opened a note and
stayed on it. Whether they acted on it is not measured, and claiming it makes every number a small
lie the author can personally disprove by asking.

### The Playbook (previous notes)

`PartNotesSheet`, opened from the op card's **Playbook · N**. Everything the shop has learned about
running this part, ranked so the useful thing is first. Ordering lives in `part_playbook_notes` —
usefulness-first with a recency guard:

1. Anything from the **last 14 days**, newest first
2. Then `usage_count` — distinct jobs it was consulted on, the strongest signal we have because it
   records someone reaching for the note *while doing the work*, not an opinion offered afterwards
3. Then helpful marks, then recency

Newest-first alone buried the load-bearing note on any part with several. Pure usefulness would
bury a correction written this morning below an old note with a long history, which on a shop
floor is the dangerous direction. The original plan handled that with a `confirmed` reaction and
visual decay of stale entries; **both were dropped, so the 14-day guard carries it alone.** The
window is a judgement, not a finding — revisit it with real data.

**Why this is a sheet and not a page.** Operators already carry an annotated paper print, and paper
wins on two things we cannot match: it is always at the machine, and its annotations are
*spatially indexed* — a margin note points AT a feature, which a text list cannot reproduce. What
digital adds is narrower and real: the knowledge survives the sheet being lost or superseded, it
exists in more than one place (one annotated print sits at one machine), and it carries attribution
and reception — all three one tap from the step. A browsable `/parts/{partId}/playbook` route was
planned and **deliberately not built**: it would ask an operator to go *looking* for knowledge
while off a job, which is exactly when they will not. If a part ever needs a destination of its
own, that is the moment to add one.

**Corrections are not built either.** `corrects_note_id` exists in the schema with no writer
anywhere, so a corrections section would display something nothing can create.

### Reactions (`helpful`)

The **voluntary** half of the loop, and the deliberate opposite of view logging. A view is
involuntary and private — a record that someone needed to look something up — which is why
`note_views` has no client read path at any level. A reaction is a claim someone chose to make, so
it is public inside the shop, carries the reactor's name, and is removable only by the person who
made it. Admins deliberately **cannot** delete someone else's: a boss who can curate the public
record of what the shop found useful is worse than a stale reaction.

`NoteReactions` renders on three surfaces — the job feed, the Playbook sheet (where prior
knowledge is actually read, so the most important one), and **My work read-only**, since RLS
forbids reacting to your own note and there endorsements are *reception*, the same category as the
view count beside them. It also appears on maintenance entries.

- **There is no thumbs down, and this is not a deferral.** `kind` is CHECK-limited to
  `('helpful','confirmed')`, so there is **no schema slot** for a negative. An inaccurate note is
  corrected or superseded, never publicly judged — nobody on a fifteen-person floor writes a
  second note after being downvoted by a colleague they see every morning.
- **`confirmed` has no UI.** It stays in the CHECK; nothing writes or renders it, and the helpful
  count filters it out so a stray row cannot inflate anything.
- **The control is hidden on your own notes.** The INSERT policy refuses self-reaction, so
  rendering it makes every tap a guaranteed `42501` that reads as a broken button. This is why
  `part_playbook_notes` returns `author_id` as well as `author_name` — matching on a display name
  breaks on two Daves.
- **Optimistic with rollback.** On shop wifi a thumbs-up that waits for a round trip reads as
  broken. A failure rolls the button back and goes to Sentry; no toast, because an operator
  mid-job does not need a dialog about a thumbs-up.
- **Count and names derive from the same array**, so they can never disagree — which is why no
  denormalized counter exists. That array must carry `reactor_id`: without it a reader cannot find
  themselves in it, so the thumbs-up renders un-pressed on a note they already marked and a second
  tap re-inserts a duplicate. `part_playbook_notes` shipped without it and **the bug looked
  exactly like "likes are not persisting" — they were.**
- **No `operator_events` kind for reactions, deliberately.** `note_reactions` already records who
  reacted, to what, and when; a parallel funnel event would duplicate it and drift.

**What this must never become: a per-person total.** Reactions are safe because they attach to a
*note*. "Diego has 47 thumbs-ups" is a leaderboard and "Priya gave 3" is a participation score —
both are the operator-comparative metrics this module refuses. Nothing sums them by person,
including My work, which shows endorsements received *on a note*.

### Surveillance guardrail (non-negotiable)

No operator-facing surface may reflect an operator's pace or standing back at them. Concretely,
**My work must never grow** a completion count, streak, average, or anything comparable against
another person — it is exactly where a leaderboard wants to grow, and a test asserts the absence.
No points, badges, or leaderboards anywhere. There is no settings toggle for this.

**The rule, in the form that survives the arrival of recorded time:**

> A number on an operator's screen may describe the job in front of them. It may never accumulate
> across jobs to describe the person. **"It's private" is not an exemption — the mechanism is
> attention to output, not observation.**

That last clause is load-bearing and is not a hunch. Etkin 2016 (*J. Consumer Research*) Exp. 1 ran
a private, self-only, goal-free, comparison-free counter, with participants told pay did not depend
on speed: output rose ~26% (p = .010) while blind-rated quality **fell** — creativity 3.02→2.58
(p = .014), care 2.83→2.54 (p = .035). On a shop floor that decrement is scrap, skipped inspection
and rushed setups. Stress, anxiety, difficulty, distraction, interruption and evaluation
apprehension were all ruled out as explanations, which is why "but nobody else sees it" does not
rescue a tally. It is also a **one-way door**: removing the counter left people doing *less* than
controls (p = .034). And **operator demand is not evidence of safety** — 88% of Etkin's
participants wanted the count and predicted it would make the task more enjoyable (t = 6.06,
p < .001); it made it less.

*(Do not cite the Hawthorne effect for any of this. Levitt & List recovered the original
illumination data and the canonical descriptions are fiction. Etkin isolates the count rather than
the observation, which is the claim actually needed here.)*

**Withdrawn 2026-08-16:** *"Actual time is structurally unrepresentable … capturing actual time and
showing it to the operator is the trigger that reverses that decision."* The trigger fired, and
[`20260816203641`](../../supabase/migrations/20260816203641_job_operation_intervals.sql) is the
reversal. What the operator now sees is bounded by the rule above, and the bound is enforced in the
schema rather than in review:

| Operator sees | Operator never sees |
|---|---|
| The interval running **right now**, as a large monospace clock | A total across jobs, a weekly figure, an average, a rate |
| Their own start and finish entries in the job feed, each correctable | Anyone else's start or finish, on any surface |
| That the **office** completed a step on this job, unnamed and untimed | Who in the office did it, or what any other operator finished |
| A journal of their own recorded intervals, each naming its job and step | A row count, an entry total, or any scalar over that journal |
| Their own raw times beside their own corrections | Anyone else's times, or their own compared to the estimate |

**The estimate is hidden from the step screen while an interval is running.** Alone it is the
engineer's input to the job and the printed traveler carries the same figure. Beside a live counter
it is a target, and a number about your own output next to a standard is the adjacent comparison
that turns informational feedback into controlling feedback — the same Deci/Koestner/Ryan
distinction that separates +0.66 from −0.44. This is the load-bearing half of the guardrail, and it
is the half that must not move.

**Withdrawn 2026-08-17: "the elapsed counter is secondary and monochrome; a start time is a fact,
a hero counter is closer to Etkin's manipulation."** Wrong because it over-applied the evidence.
Etkin's harmful counter was a tally of **output accumulating across a task**; a stopwatch on the
operation in front of you accumulates nothing and — with the estimate gone — sits beside no
standard. The clock is now a large centred monospace figure, matching what this app shipped before
[`541ca291`](https://github.com/debola31/Jigged/commit/541ca291) removed it. It also earns the size
operationally, which the first version undervalued: **an unmissable clock is the best defence
against the forgotten start and the forgotten stop**, which is the failure mode the whole model
fights. What did not change: no estimate beside it, no total across jobs, no average.

**Aggregate-by-default is enforced by RLS, not convention — and as of 2026-08-25 there is no
exception left to be default *from*.** `job_operation_intervals` has **no admin-readable path**: a
row-returning SELECT policy exposing `operator_id` would *be* a per-person report, because PostgREST
supplies the grouping for free. Admins read `get_operation_actuals` / `get_open_intervals`, which
return no operator identity at all.

`get_operator_time_detail` used to be the one path that named a person: admin-gated, reason-coded,
writing an `operator_time_access_log` row **before** it returned anything. It is **gone**, together
with that log table and the admin dialog that opened it
([`20260825170421`](../../supabase/migrations/20260825170421_drop_per_person_time_reporting.sql)).
The narrow-logged-door argument — that an owner who cannot get the number by any route will ask for
a permissive view of the table, and that request is harder to refuse than to pre-empt — did not
survive contact with use. The door was built; the demand it was meant to pre-empt never arrived; and
between shipping on 2026-08-16 and being removed, production recorded **zero** rows in that log —
and zero intervals for it to report on. Nothing in the repo ever read the log either, so the
deterrent was a sentence of dialog copy rather than a trail anyone could review.

**No path in this product resolves recorded time to a named person.** `operator_id` remains on the
table, but as *structure* rather than reporting — it is the RLS key for the operator's own rows, the
ownership assertion in `close_operation_interval`, and the ad-hoc chain key. A future per-person
reader does not belong on the `function_execute_leaks()` allowlist, and does not belong at all.
Where the office needs a denominator, the dimension is the **work centre**: `work_center_id` is
already the chain key on every interval, and `get_open_intervals` already reports by machine.

`operator_events` (funnel instrumentation: `app_opened`, `op_card_opened`, `prior_notes_opened`,
`composer_focused`, `note_saved`, `note_saved_with_photo`, `photo_attached`, `video_attached`,
`station_selected`, `completion_recorded`) is **service-role only** and carries no note ids of what the actor read. A
per-operator event log readable by the shop's own admin would reconstruct exactly the reading
behaviour the above exists to protect. The PostHog `operator_operation_completed` capture carries
no operator identity for the same reason.

---

## The step screen

Four decisions govern this screen; all four were arrived at against a real failure.

### Capture is part of completing (B4)

Finishing a step and writing down what you learned are **one act, one button, one commit**. The
completion block carries the quantity field, an optional *"Anything worth noting for next time?"*
with a camera and a video recorder, and `RECORD COMPLETION` submits all of it.

It used to be three separate things: record the completion, then a prompt offering to add a photo,
then a *separate* Post. The middle had no durability — attaching a photo showed a thumbnail, the
flow read as finished, and a back tap discarded it silently. There was no `beforeunload` guard and
no draft persistence, so the only real fix was to stop having two commits. **The post-completion
offer is deleted, not relocated.**

**Submit order is load-bearing and deliberately NOT atomic:** `createOperationCompletion` lands
first and durably, then the note. A transaction across the two would be *worse* — it would roll back
real finished work because an image failed to upload on shop wifi. So if the note fails the
completion stands, and the note error surfaces on its own next to the text the operator still has.

### Attached material is shot in Jigged (2026-09-02)

**Both controls go to a live camera.** The photo input carries `capture="environment"`, so a tap
opens the rear camera rather than the OS sheet; video is recorded by
[`VideoRecorderDialog`](../../components/operator/VideoRecorderDialog.tsx) inside the app. There is
no camera roll and no file picker on this surface any more. Several items per note come from
tapping again — HTML Media Capture is one shot per invocation, so `multiple` was dropped with the
sheet.

**This reverses a decision, and the evidence it reverses still stands.** The sheet was deliberately
left open because the observed failure was setup photos stranded in the camera roll, and the audit
that followed found the phone-camera-then-attach flow was how photos actually arrived. Neither
finding has been contradicted. What changed is what the photo is *for*: a note's media is read back
later as a record of what this job looked like, and material picked from a roll cannot say when or
where it was taken. The cost is real and was accepted — an operator who shoots at the machine and
files the note later must now open Jigged at the machine.

**The signal to watch is `composer_focused` against `note_saved`.** That pair is documented below as
reading "capture friction". If this change hurts, it will look exactly like that and mean something
else, so read a widening gap as this first.

**`MovementPhotoField` deliberately did NOT follow.** Movement evidence is a receipt for a
transaction happening now, and the likeliest photo is the one already taken of the shelf. Same
attribute, opposite answer, because it is a different question.

### Video: two minutes, recorded in the app

**Why an in-app recorder rather than `capture` on a video input.** HTML Media Capture takes no
duration argument and no bitrate argument. iOS runs to its own ten-minute default, and two minutes
of phone-native 1080p is 100–400 MB — over the bucket's inherited 50 MB ceiling and hopeless on
shop cellular. A two-minute rule imposed that way could only reject a clip *after* it was shot.
`MediaRecorder` stops itself, and encodes at 720p / 1.5 Mbit/s so a full-length clip is ~23 MB.
A byte budget stops the recording early if a handset ignores the bitrate hint, because an oversized
clip otherwise fails at the *end* of a multi-minute upload.

**Audio is recorded, and noise suppression is off.** A chattering tool or a bearing starting to go is
diagnosed by sound, and suppression is tuned to remove exactly the steady machine noise that is the
content here.

**MP4 is preferred over WebM, and that is a compatibility requirement rather than a taste.** These
clips are read back by the office on a desktop, and Safari cannot play VP8 WebM at all — an
Android-recorded WebM would be a permanently unplayable file for the person it was recorded for.
The probe order is pinned by a test for that reason.

**Duration is measured, never read off the file.** A fresh `MediaRecorder` blob reports its own
duration as `Infinity` or `0`, because the container is written without knowing the length in
advance. That is what `note_media.duration_seconds` is for.

**Every clip gets a poster, and `thumbnail_path` finally has a writer.** Without one the galleries
fall back to `storage_path`, so painting a 72px thumbnail would pull the whole clip down a cellular
link — and an `<img>` cannot decode it anyway. The poster is a ~40 KB JPEG grabbed from the live
preview shortly after recording starts, not at stop, because by stop the phone is usually already
coming down. **Every read surface also handles a poster-less clip** with a play-badge tile rather
than falling back, since that fallback is the expensive case.

**The countdown is inside the guardrail.** It describes the recording in front of the operator and
resets every time. Nothing accumulates, and nothing on this screen counts clips.

**Within the note, photos upload BEFORE the note row is written** — `uploadJobNoteMediaFile` for
every photo, then `addJobNote`, then `insertNoteMedia` per photo. Corrected 2026-08-04 from
[#624](https://github.com/debola31/Jigged/issues/624); it used to be the other way round. Uploading
is the slow, failure-prone half, so a phone on dropping wifi stalled with the note *already
committed*: backing out left a note claiming to be saved without the photo it was taken for, and
nothing said so. Inverted, a failed or timed-out upload leaves **nothing** behind — which is why
this needs no partial-save state and no second kind of error message. The draft and the photos are
still in the composer, and tapping save again is a clean retry rather than a second note. It is the
rule [`OperatorLocationActionModal`](../../components/operator/OperatorLocationActionModal.tsx)
already states: *upload before the write, never after.* It was reachable here only because the
storage path keys on the job or the machine and never on the note.

The cost moves rather than vanishing: photos that land before a later step fails are orphans, swept
best-effort by `discardNoteMediaUploads` and otherwise invisible. A `insertNoteMedia` failure *after*
the note lands can still leave a text-only note, but that is a fast local write rather than a
transfer, so it is a far smaller exposure than the one it replaced.

**Capture is always optional.** Completion works with the field empty.

**Where the feed keeps its own composer.** Three of the four branches have no completion block, so
capture cannot live only there:

| Branch | Capture |
|---|---|
| Internal, incomplete | **In the completion block**, one button |
| Internal, **complete** | Feed composer — otherwise a photo could never be added after finishing, which is how photos actually arrive (taken on the camera, attached later) |
| **Outside** step (send/receive) | Feed composer — *"sent to coater 7/9, expected back 7/16"* is the highest-value note in the system, precisely because the part is invisible while it is away |
| No station selected | Neither: the page is only a station picker |

`JobFeed`'s `standaloneCapture` prop is that switch, false on the normal path so there is never
more than one composer on screen. This is a **deliberate deviation** from the plan's *"the note
cannot be saved without completing"*, forced by the render branches rather than by preference.

**The primary button says what it will do, and that closes a hole.** With a quantity it reads
`RECORD COMPLETION`; with **nothing finished but something typed** it reads `SAVE NOTE` and writes
the note alone. That path is not a convenience. `qty > 0` is enforced, so an operator who finished
zero pieces — *"machine down"*, *"waiting on material"*, *"tool chipped, swapping it"* — otherwise
had two bad options: stay silent and lose exactly the knowledge this workstream exists to capture,
or **type a false quantity** to get the note saved. Corrupting the number that feeds costing and
scheduling to satisfy a UI constraint is far worse than an extra code path.

### Density

This screen's failure mode is crowding, and the primary action is what gets pushed off the bottom.
ISA-101 frames it as a **Level 1 action display**, not a Level 3 detail display: *what does the
operator need to know right now*.

- **The job card is one line** — `J-0007 · PROD-ACTUATOR-200` — and **the whole card is the tap
  target**, with a decorative chevron as the affordance. A separate chevron button would be a
  second control for one action, and nesting it would be invalid markup. The expanded section sits
  **outside** that button because it contains a real link (`View all steps for J-0007`), which is
  where the traveler link moved when the job number stopped being one.
- **Expanded state is sticky** across steps via `sessionStorage`. Whether it should persist across
  days as a remembered preference is undecided.
- **Always visible, never behind the expander:** the part description, the per-operation
  instructions, and **part progress** — "where am I on this part" is the question a step screen
  exists to answer.
- **`Parts finished` shares a row with Files and Playbook**, leading it, matched to their **48px**
  height. It leads because it is the input for the primary action while those are reference; they
  keep their counts, which is what actually advertises them.
- **Capture is one row** — a single-line field that grows, camera as an adjacent icon. The
  dictation tip is a **caption, never an icon button**: nothing can invoke the OS keyboard's
  dictation from a web page, so a mic icon beside a real camera button is a false affordance.

**The action is NOT pinned, by decision.** A fixed bar guaranteed reachability but overlaid the
content beneath it. The protection is density instead, which is a weaker guarantee — measured at
**440×956**, collapsed the button clears the nav (**bottom 495 vs 521**); **expanded it does not
(629)** and needs a scroll. Since the expander is sticky, an operator who expands once keeps it
that way. **Measure before adding anything above that button** — that is exactly how it broke the
first time.

### Description vs instructions: no dimming, ever

Two lines can carry the engineer's intent and the app cannot tell which: `parts.description` and
`job_operations.instructions`. Per-operation text is optional and frequently blank, so shops often
put the instruction in the part description instead.

So **neither is de-emphasised**, and the distinction is a dimmed **label** (`Instructions:`, the
same word the admin sees when writing the field) rather than weight or a tinted box. What is dimmed
is chrome, never content — the label shares the content's font size, so **colour is the only
difference between them**. A smaller label beside larger text read as two unrelated lines rather
than a label and its value, and the colon carries the demarcation a size change was doing badly.

**Withdrawn:** an earlier revision dimmed the description to make the instruction "the brighter
one". Wrong twice over — it asserted "reference, not instruction" exactly when that was false, and
ISA-101 requires every emphasis to carry a defined meaning, so **de-emphasis used as a guess
carries none**; NN/g's hierarchy work is explicit that muted text draws less attention. Emphasis
stays reserved for states that genuinely mean "look here now": the over-quantity error and the
station-mismatch warning.

**The seed matters here.** `supabase/seed.sql` used to fill every routing step's `instructions`
with `'<WorkCenter> operation'`. That made the box appear on every step of every demo, teaching an
operator the box is noise **so they skip it on the day it says "torque to 40, not 45"**. Four steps
now carry real shop instructions and the rest are NULL, so a usability session tells us about the
design rather than about our test data.

One implementation, two hosts: [`useNoteCapture`](../../hooks/useNoteCapture.ts) owns the draft,
the photo pipeline and the funnel events; [`NoteCaptureFields`](../../components/operator/NoteCaptureFields.tsx)
renders them and deliberately owns **no** submit button, because the surface it sits in decides
what "save" means. The photo pipeline copies bytes into a stable `File` **immediately**, because a
camera-origin `File` on iOS can become unreadable by compress-and-upload time and yield a
zero-byte blob; unreadable picks are **reported per file**, never dropped silently.

The write side now holds the same line. Both slow steps are **bounded**, because an unbounded one
reads as a working app rather than a broken one and the operator waits, gives up, and loses the
photo: compression carries a real `AbortSignal` (30 s, CPU-bound so it only fires when something is
wrong), and the upload carries a size-aware deadline in
[`storageHelpers`](../../utils/storageHelpers.ts) — roughly 46 s for a compressed photo, minutes for
a 100 MB part model, since one choke point serves both. Supabase Storage exposes no cancel or
progress hook for uploads, so that deadline abandons the request rather than stopping it; if photo
uploads ever fail often enough to matter, the escalation is TUS resumable uploads, not a longer wait.

### Triangularity (B5)

The asymmetry that makes writing something down worth the extra taps:

| | Effort | What comes back |
|---|---|---|
| Completion alone | one entry | **Nothing.** The step turns green |
| Completion + a note | ~4 more taps | A Playbook entry with their name, a view count that grows, named readers, a login-banner line |

**Do not equalise it.** If completing were rewarded on its own, the note would be pure cost and
nobody would write one. So "nothing comes back from a bare completion" is a feature with a test —
which also scans My work for `completed`, `streak`, `average` and `pace`, because a contribution
screen is exactly where a completion count wants to appear.

---

## Routing & readiness

Routings are a **linear sequence** — no DAG, no parallel branches; see
[routings.md](routings.md) for why. An operation is **ready** when all lower-`sequence` operations
on the same part are completed, and out-of-order work is **warned, not blocked**
(`predecessors_incomplete`). The readiness rule and its two RPCs are owned by
[jobs.md](jobs.md#current-operation-column).

**The My Station lens returns an empty list when no station is selected** (`getOperatorJobs`
short-circuits) — which is exactly what the All Stations lens exists to cover. All Stations fans
out the **same** per-station `get_ready_operations_for_station` RPC once per station in parallel
and tags each row with its station, rather than adding a filter-less variant: one source of truth
for "ready", no duplicated readiness logic. The lens toggle is hidden on the station-picker screen,
since there is no list to scope yet.

**If the readiness RPC errors, the failure surfaces in an Alert** — it is never swallowed into an
empty "No jobs" list. That is the shape of the May 2026 `jobs.status` regression.

### A step with a timer open is on the list, whatever the sequence says

Added [`20260826010648`](../../supabase/migrations/20260826010648_station_dispatch_includes_running_steps.sql)
after a production sighting: J-0118 / OP 30 EDM had an interval open since 3:01 PM, showed on the
office [Still-running card](#recording-time), and appeared **on no operator surface at all** — not
My Station at EDM, not Completed, not All Stations. The step the floor was actually running was the
one step the floor could not see.

**Two correct rules composed into a wrong answer.** `job_operations.status` derives from *recorded
quantity*, so a step somebody started but has produced nothing on is `pending` — correctly. And the
dispatch RPC admitted a `pending` step only when it was sequence-ready — also correctly, that being
what a dispatch list is. But **starting does not require sequence-readiness** (that is the
`predecessors_incomplete` warning above, deliberately non-blocking), so the write path admits a case
the read path then hid. J-0118's OP 10 and OP 20 were both pending, so EDM was neither ready nor
"in progress", and fell through every branch.

So there are now **three** ways onto the list, and an open interval is the third: *sequence-ready*,
*has quantity recorded*, or *somebody is on it right now*. The row is marked `Running`.

**This is also the only route to an abandoned interval.** `close_operation_interval` refuses a
non-owner, so the office cannot clear one — what can is `start_operation_interval`, which closes
whatever holds that work centre's chain slot as `switched` (the shift handoff). That recovery runs
through the station list, which was the one place the forgotten interval did not appear.

**The mark carries no person, and that is enforced in SQL rather than in the card.** The dispatch
RPC is `SECURITY INVOKER`, and `job_op_intervals_select_own` scopes the interval table to the
caller's own rows — so the fact is fetched through
`get_running_operation_ids_for_station`, a `SECURITY DEFINER` helper that returns **operation ids
and nothing else**: no `operator_id`, no `started_at`, no elapsed figure, no count. "OP 30 at EDM is
running" is a fact about a machine, the same class of disclosure as the office card, and the only
form of it that stays clear of the [guardrail](#surveillance-guardrail-non-negotiable). A `since
<time>` on this list would additionally revive the copy of the deleted header strip, which an E2E
assertion still watches for.

**Two holes are left open on purpose**, both named in the migration: an interval on a job that was
later **cancelled**, and one on a step an **office-side completion** marked `completed` (which
closes no interval). Both still show on the office Still-running card; neither has been observed.

## QR codes and scanning

There are **two** codes, and nothing else in Jigged is scannable — parts carry no barcode at all
(see [Stations](#stations-work-centers)).

```
Traveler   HTTPS://WWW.JIGGED.APP/T/{company32}{jobPart32}     77 chars → QR version 4 @ EC-M
Location   HTTPS://WWW.JIGGED.APP/L/{company32}{location32}    77 chars → QR version 6 @ EC-H
```

**Redesigned August 2026, because the old codes did not scan.** A Contour operator spent 30+
seconds failing to read a traveler off *fresh* paper. The scheme it replaced was a login deep link
carrying two full UUIDs — 157 characters, QR **version 8**, 0.37 mm per module inside a 56pt square.
`jobTravelerPdf`'s own `QR_SIZE` comment had predicted this and prescribed the fix: shorten the
payload, do not enlarge the code. The location label was worse and unmeasured, at **version 10**.

Three things buy the new versions, and all three are load-bearing:

1. **Every character is in the QR alphanumeric charset**, which packs 2 characters into 11 bits
   where byte mode spends 8 bits each. That is why the URL is uppercase. A lowercase character does
   not break anything visibly — it just quietly costs a version.
2. **UUIDs are RFC 4648 base32**, 26 characters instead of 36.
3. **The traveler carries `job_part_id` only.** A third UUID would be version 5. This is why the
   traveler page moved to `/operator/{co}/parts/{jobPartId}` — `getJobPartTraveler` never needed the
   job id, so the `/jobs/{jobId}` segment was decoration the printed code was paying for.

The result is **0.60 mm per module** on the traveler and **1.00 mm** on the label — 61% and 79%
larger than what failed. [`__tests__/utils/qrVersionCeiling.test.ts`](../../__tests__/utils/qrVersionCeiling.test.ts)
holds the ceiling, asserting charset, version and printed mm-per-module, so the next payload change
fails in CI rather than on a shop floor. **When it fails, shorten the payload — do not raise the
numbers.**

- **The company id stays in the payload**, which is what the obvious shortening (`/t/{jobPartId}`)
  would have dropped. It is what lets `foreignCompanyRejection` refuse another shop's code **by
  name, offline, before any navigation**. Base32 buys the version *and* keeps it.
- **QRs are drawn as vector modules** ([`lib/qrVector.ts`](../../lib/qrVector.ts)), not embedded
  PNGs — the old 320px bitmap was ~239 dpi on a 34 mm label. Same ink, no resolution. The matrix
  carries no margin, so the **quiet zone is the layout's job**; both callers assert they leave 4
  modules.
- **One mapping, one place.** `parseJiggedScan` → `scanDestination` serves both the in-app scanner
  and the camera-app path: `/T/{code}` decodes and hands the destination to the operator login as a
  validated `?next=`. The login page used to re-derive it from `?job=&part=&operation=&location=` —
  a second hand-maintained copy, with a comment admitting nothing checked that the two agreed.
  `safeNextPath` re-validates on arrival, because a query parameter is attacker-controlled even
  when we wrote it.
- **Traveler QR** (`utils/jobTravelerPdf.ts`): **exactly one per traveler sheet**, in the header
  beside the Job #, opening that part's step list where the operator taps the step they are
  working. It carries **no caption** — a QR already reads as "scan me", and the old line cost a row
  of paper. An **optional accelerator** for shops mid-transition, not required.
  **Withdrawn:** a previous revision printed a QR on every operation row; operators couldn't tell
  which code they were pointing the phone at.
- **Inventory location label** (`utils/locationLabelPdf.ts`,
  `components/inventory/locations/LocationQRModal.tsx`): **Avery 5163 adhesive stock**, ten to a
  Letter page, so a shop peels and sticks instead of cutting. Reached from the Storage board, and
  **ungated** — the label printer never had a flag check of its own, and the surface it hangs off
  is core for every tenant since `inventory_locations` was retired 2026-08-24 — see
  [inventory.md](inventory.md).
- **No backward compatibility, deliberately.** Nobody had printed a code that anyone kept, so the
  old payload shapes, the `operation=` deep link and their parser branches were deleted outright
  rather than carried. Anything printed before this ships is dead format — reprint it.
- The printed traveler's other shop-floor conventions: **outside steps are flagged with a heavy
  black outline + bold text (border only, no fill)** — unmistakable and grayscale-safe, but
  essentially no extra toner. **Withdrawn:** earlier gray and solid fills drew a shop-owner ink
  complaint. The merged **Notes** column carries "OUTSIDE — ship to {vendor}" for outside steps and
  the setup/cycle estimates for internal ones, and the **Done** column is a blank write-in.

---

## Decisions that bound this module

### Explicit non-goals (deliberate, decided)

These are simplicity choices, **not** gaps to fix. A busy operator on the floor should do as little
as possible.

| Non-goal | Rationale |
|---|---|
| **No pause / resume** | **Amended 2026-08-16.** Start came back ([Recording time](#recording-time)); pause and resume did not, and will not. A paused state is one more thing to remember to undo, and the chain already expresses "I stopped doing this" as "I started doing something else". |
| ~~**No per-operation time tracking**~~ | **Withdrawn 2026-08-16** — wrong because it read the 2026-06 evidence as "actual time cannot be captured" when what the evidence said was "a start/stop lifecycle the operator must maintain cannot be captured". The chain does not ask them to maintain one. **Costing and quoting still use estimated times only**; actuals are reported beside them and never substituted. |
| **No manually-set WIP status** | WIP is **derived from recorded quantity**, never asserted by a human — see [Status model](#status-model). *Exception:* an **outside step** carries a `sent` waypoint, because the part is physically out of the shop and invisible while it is away — that exists for visibility, not to track in-shop WIP. |
| **No permanent operator↔station assignment** | Operators roam; the station is chosen per device and changed from the header any time. |
| **No shift management / clock-in** | Out of scope. Sign-in time is whatever Supabase Auth records, nothing more. |
| **No downtime / stoppage reasons** | Follows from having no paused state to attribute one to. |
| **No real-time push** | See below. |

### Freshness: manual refresh

**Decided:** browser reload / pull-to-refresh; **no WebSockets or live push**. The in-app refresh
button on the dispatch list was removed to declutter — reloading is equivalent and one less control
to explain. Revisit only on a validated need, e.g. two operators colliding on the same step often
enough to matter.

### Scrap and defect capture (discovery)

**Nothing exists today and nothing has been designed.** `job_operation_completions` is deliberately
good-only. This needs real discovery before any build; the option space, pressure-tested against
the complete-only, low-friction ethos:

| Option | Shape | Assessment |
|---|---|---|
| **A — Lightweight "Flag issue"** | Reuse the notes + photo feed: a **Flag issue** action posting a note of a distinct kind (`quality_issue` / `scrap`), optional photo, optional scrap quantity. | **Recommended starting hypothesis.** Near-zero new model, surfaces in the job feed, rolls up to office/QC, one tap plus optional detail. |
| **B — Scrap quantity at completion** | Capture good qty vs scrap qty together. | Gives real numbers for costing and inventory, but adds a field to the primary action. Make it optional and skippable. |
| **C — Defect reason codes** | A configurable list (rework / scrap / use-as-is). | Heavier, MES-grade. **Caution:** this is exactly the "named-pattern entity" shape we have been burned by — pressure-test for anemic data and copy-from-X redundancy before committing. Likely premature. |

**Open questions, all unanswered — answer before building:**

1. Do we need scrap *quantity* (for costing/inventory) or just a *flag* (for visibility)?
2. Does scrapping a unit affect inventory — consume material, and does scrap return stock?
3. Who reviews flagged issues, and where — the office job view, or a QC queue? `prd.md` FR-19 and
   Flow 2 describe a Pass/Fail QC workflow that **was never built**; decide here whether to revive,
   reshape, or drop it.
4. Does a flag block downstream steps, or is it informational?
5. How does it relate to the existing inventory over-consumption `has_discrepancy` flag
   ([inventory.md](inventory.md))?

### Paperless is the preferred model

The capability has been there for a year; it was never made the default. These make the queue path
win over paper:

- **The dispatch list is the operator home.** After login, land on *the queue* — the last station
  from `localStorage`, so a returning operator skips the picker entirely, or the picker itself the
  first time. Never a dead end; "change station" is in the header.
- **Demote the printed traveler** to an explicit fallback. Consider a setup choice: "we've gone
  paperless — operators pick their station in the app" versus "keep printing travelers".
- **Onboarding nudge** — a short checklist: create work centres, invite operators, each operator
  signs in once on their phone and picks their station. It surfaces a path that already exists.
- **Parallel run, then retire paper.** Run paper and digital together for a few weeks; once the
  queue path sticks, stop printing travelers by default.

**Withdrawn:** the original keystone here was printing something for every machine so a shop could
post the whole floor in one pass. It was built and nothing ever went up. **The bottleneck was
adoption, not the absence of a print button.**

---

## Admin

- **Operator creation is a magic-link invite** from the admin team page
  (`/dashboard/{companyId}/team` → Operators → `team/members/new` with `role='operator'`), issued by
  the **`team-invites` Edge Function** (`supabase/functions/team-invites/index.ts`), which needs the
  service-role key. On acceptance it creates the `user_company_access` row. There is **no**
  operator-provisioning FastAPI endpoint in the shipped path.
- **Operator management is not part of this module.** It is the generic team-member surface
  operating on `user_company_access` under RLS. *(This doc previously named `listOperators` /
  `updateOperator` / `deleteOperator` in `utils/operatorAccess.ts`; none of those functions exist.)*
- **`api/routes/operators_routes.py` is worse than dead code — it is mounted.** `api/index.py`
  registers it, so `POST /api/operators` is a **live route that would 500**, because it targets an
  `operators` table that no longer exists. Nothing in the frontend calls it. Its deletion was
  tracked in **#550, which is closed as completed while the file is still on disk** — read that
  issue as superseded, not as done.

---

## Acceptance Criteria

Convention (Given/When/Then + a checkable verification clause) is stated once in
[modules/README.md](README.md#the-acceptance-criteria-convention). Every path below was confirmed to exist on
2026-08-02.

**Authentication & station selection**

- [ ] **Given** a signed-in operator with no station, **when** they tap one in the picker, **then** it is written to `localStorage` (`jigged_operator_station`), they land on that station's job list, it survives a browser restart, and logout clears it — *verified by `__tests__/components/operator/OperatorStationContext.test.tsx` > `OperatorStationProvider` (5 `it`s)*.
- [ ] **Given** the station picker, **when** it lists stations, **then** only **internal**, **non-archived** work centres appear — *verified by `__tests__/utils/workCentersAccess.test.ts` > `getWorkCentersByKind`; the operator picker's filters are `getStationOperationTypes`*.
- [ ] **Given** a signed-in user with `role='operator'`, **when** any of the four "send them home" entry points runs, **then** they go to `/operator/{companyId}` and office roles to `/dashboard/{companyId}` — and an **unknown or absent** role resolves to the office, never the shop floor — *verified by `__tests__/utils/homePathForRole.test.ts` > `homePathForRole` (3 `it`s); the `getPostLoginRoute` wrapper that calls it is automation-pending (#367)*.

**Dispatch list**

- [ ] **Given** the My Station lens with a station selected, **when** the list loads, **then** it shows one row per (job, part) whose station operation is ready, in progress, or has a timer still open, via `get_ready_operations_for_station` — *verified by `api/tests/database/test_operator_ready_ops_rpc.py` (1 test, planned against the real columns) and `api/tests/integration/test_station_dispatch_open_intervals.py` (6 tests, incl. the negative control that an idle out-of-sequence step stays hidden); row assembly reload E2E automation-pending (#367)*.
- [ ] **Given** a running timer on a step, **when** the operator taps `Cancel activity` and confirms, **then** the interval is voided (`ended_at` left NULL), no completion is written, the work centre's chain slot frees immediately, and both feed rows disappear — *verified by `api/tests/integration/test_cancel_operation_interval.py` (8 tests) and the running-state describe in `__tests__/app/operator/OperationActionPage.test.tsx`*.
- [ ] **Given** a running timer belonging to somebody else, **when** a different member calls `cancel_operation_interval`, **then** it is refused — *verified by `test_a_non_owner_is_refused`*.
- [ ] **Given** a step at this station with an interval another member left open, **when** the list loads, **then** the row appears marked `Running`, sorted above idle ready work, and carries no operator identity, start time or elapsed figure — *verified by `api/tests/integration/test_station_dispatch_open_intervals.py`, which asserts as the OTHER member and re-checks that the interval row itself stays unreadable*.
- [ ] **Given** the readiness RPC returns an error, **when** the list loads, **then** the failure surfaces in an Alert and is NOT swallowed into an empty "No jobs" list — *verified by `__tests__/utils/operatorAccess.test.ts` > `getAllStationsOperatorJobs`*.
- [ ] **Given** the All Stations lens, **when** it loads, **then** whole-plant work is fetched once per station in parallel and grouped by station — *verified by `__tests__/utils/operatorAccess.test.ts` > `getAllStationsOperatorJobs`*.
- [ ] **Given** no station selected, **when** the My Station lens loads, **then** it returns an empty list rather than the whole plant — *verified by `__tests__/utils/operatorAccess.test.ts` > `getCompletedOperatorJobs`; the ready-lens equivalent is automation-pending (`getOperatorJobs`)*.
- [ ] **Given** the **Show completed** toggle, **when** it is on, **then** completed work at the current lens is listed and both controls persist in the URL (`?scope=`, `?completed=1`) — *automation-pending (`getCompletedOperatorJobs` / `getAllStationsCompletedOperatorJobs`)*.

**Recording a completion**

- [ ] **Given** a step on a 12-quantity part with nothing recorded, **when** the operator enters 3 and taps `RECORD COMPLETION`, **then** one `job_operation_completions` row is written, the op derives `in_progress`, and 9 remain — *verified by `__tests__/utils/operationCompletionsAccess.test.ts` (9 `it`s) and `__tests__/components/operations/operationMath.test.ts` (7 `it`s)*.
- [ ] **Given** entries totalling the order quantity, **when** the last lands, **then** the op derives `completed` and the part rollup cascades the job's `production_status` — *verified by `__tests__/utils/operationCompletionsAccess.test.ts`*.
- [ ] **Given** an entry above the remaining quantity, **when** it is submitted, **then** it is **warned but allowed** (the only floor is `quantity_good > 0`) and remaining clamps to zero — *verified by `__tests__/components/operations/operationMath.test.ts`*.
- [ ] **Given** a wrong entry, **when** the operator taps `Undo all (N)`, **then** the events are `voided_at`-stamped rather than deleted, excluded from the sum, and the status recomputes — *verified by `__tests__/utils/operationCompletionsAccess.test.ts`*.
- [ ] **Given** an **outside** step, **when** `compute_job_operation_status` runs, **then** its stored status is returned untouched so a quantity edit cannot reset a `sent` op — *verified by `__tests__/schema/externalOperationMigration.test.ts`*.
- [ ] **Given** an empty quantity and an empty note, **then** the button is disabled; **given** nothing finished but something typed, **then** it reads `SAVE NOTE` and saves the note with **no completion invented to carry it** — *verified by `__tests__/app/operator/OperationActionPage.test.tsx` (21 `it`s) and `e2e/operator-completion.spec.ts` (5 tests)*.
- [ ] **Given** a completion and a note submitted together, **when** they are written, **then** the completion lands **first and durably**, and a failing note leaves the completion standing — *verified by `__tests__/app/operator/OperationActionPage.test.tsx`*.
- [ ] **Given** the operator's station differs from the operation's `work_center_id`, **when** the page loads, **then** a mismatch **warning** shows and the step can still be recorded — *verified by `__tests__/app/operator/OperationActionPage.test.tsx`*.
- [ ] **Given** the step screen, **when** it loads, **then** the job card is collapsed and expands IN PLACE without navigating — *verified by `__tests__/app/operator/OperationActionPage.test.tsx`*.

**Outside steps**

- [ ] **Given** an outside step, **when** the page loads, **then** it offers **Mark Sent Out** / **Mark Received** rather than a quantity, suppresses the station guard, and shows the feed composer — *verified by `__tests__/utils/operatorAccess.test.ts` > `markOperationSent`, `markOperationReceived`, `external operation lifecycle` and `revertOperationCompletion (external branches)`*.
- [ ] **Given** a `sent` op, **when** its part's status is derived, **then** it counts as not completed, holding the part at `in_progress` and gating downstream internal steps — *verified by `__tests__/schema/externalOperationMigration.test.ts`*.

**Traveler & scanning**

- [ ] **Given** a job traveler, **when** it is generated, **then** it carries **exactly one** QR, in the header, pointing at the part traveler with no `operation=` param, and no per-operation Scan column — *verified by `__tests__/utils/jobTravelerPdf.test.ts` (8 `it`s)*.
- [ ] **Given** any supported code, **when** it is scanned in the Scan tab, **then** it parses to a destination — location label, job traveler, or older `?job=&part=&operation=` sheet — and a code from another company is **refused by name** — *verified by `__tests__/lib/jiggedScan.test.ts` (35 `it`s)*.
- [ ] **Given** a scanned code at the login page, **when** the operator signs in, **then** they land on that part's traveler, that step, or that bin, and a bare sign-in falls back to the jobs list — *automation-pending (`OperatorLoginPage.postLoginPath`)*.

**Part traveler & readiness**

- [ ] **Given** a job_part, **when** the traveler loads, **then** it lists every operation in `sequence` order with per-step status, and a completed step stays tappable so it can be reopened — *automation-pending (`getJobPartTraveler`)*.
- [ ] **Given** an operation whose predecessors aren't complete, **when** the page loads, **then** `predecessors_incomplete` is flagged and a warning shows, but recording is still allowed — *automation-pending (`getOperatorOperationDetail` / `isJobOperationReady`)*.
- [ ] **Given** a multi-part job, **when** the hub loads, **then** it lists each part with progress; **given** a single-part job, **then** it redirects straight to the traveler — *automation-pending (`getJobPartsOverview`)*. **The multi-part half can no longer be produced through the UI** — quote conversion creates one job per part — so automating it needs a fixture that inserts a second `job_parts` row directly. Keep the criterion: it protects grandfathered jobs at the pilot shop that carry live shipments and invoices.

**Notes: subject, capture, edit and delete**

- [ ] **Given** a step WITH a `routing_operation_id`, **when** a note is saved, **then** it is written as a **durable `part` subject** with the job recorded only as provenance; **given** an ad-hoc step with no routing link, **then** it falls back to a `job` subject — a genuine subject difference, not a silent fallback — *verified by `__tests__/utils/operatorNoteSubject.test.ts` (6 `it`s) and `__tests__/utils/operatorAccess.test.ts` > `addJobNote`*.
- [ ] **Given** a blank-text note with a photo, **when** it is saved, **then** `body` is stored as null so a media-only note is valid — *verified by `__tests__/utils/operatorAccess.test.ts` > `addJobNote`*.
- [ ] **Given** a clip, **when** the note is saved, **then** the clip uploads before its poster and both before the note row, a failure sweeps **both** objects, and `compressPhoto` is never called on a video — *verified by `__tests__/hooks/useNoteCapture.test.tsx` > `useNoteCapture — video`*.
- [ ] **Given** a recording, **when** it reaches two minutes, **then** it stops itself, hands back exactly one clip however many things asked it to stop, and releases every camera track — *verified by `__tests__/components/operator/VideoRecorderDialog.test.tsx`*.
- [ ] **Given** a browser that cannot record, **when** the composer renders, **then** no video control appears at all and photos still work — *verified by `__tests__/lib/videoCapture.test.ts` and `__tests__/components/operator/JobFeed.test.tsx` > `JobFeed — capture-only media`*.
- [ ] **Given** a note with a photo, **when** it is saved, **then** every photo reaches storage **before** the note row is written; **given** an upload that fails or times out, **then** no note is created at all, the draft and photos stay in the composer so saving again is a retry rather than a second note, and the photos that did land are swept — *verified by `__tests__/hooks/useNoteCapture.test.tsx` and `__tests__/components/operator/JobFeed.test.tsx`*.
- [ ] **Given** a stalled upload, **when** its size-aware deadline expires, **then** it fails rather than hanging on "Saving…" forever — *verified by `__tests__/utils/storageHelpers.test.ts` > `uploadFileToStorage deadline`*.
- [ ] **Given** the job feed, **when** it loads, **then** job-subject notes AND durable part-subject notes captured on this job roll up together, newest first — *verified by `__tests__/utils/operatorAccess.test.ts` > `getJobNotes`*.
- [ ] **Given** an author editing their own note, **when** it saves, **then** only `body` changes, `edited_at` is stamped by the trigger, a "· edited" marker renders, and **the view count does not reset** — *verified by `__tests__/components/notes/NoteEditDialog.test.tsx` (12 `it`s), `__tests__/components/operator/JobFeed.test.tsx` (17 `it`s) and `__tests__/utils/operatorAccess.test.ts` > `updateNoteBody`*.
- [ ] **Given** an author deleting their own note, **when** it is removed, **then** it disappears from the feed, the Playbook and My work — *verified by `__tests__/components/operator/JobFeed.test.tsx` and `__tests__/app/operator/MyWorkPage.test.tsx` (31 `it`s)*.

**Previous notes (the Playbook)**

- [ ] **Given** a part with prior notes, **when** the step screen loads, **then** the count renders as **Playbook · N** and opening it lists them — *verified by `__tests__/utils/operatorPartPreviousNotes.test.ts` (7 `it`s), `__tests__/components/operator/PartReferenceRow.test.tsx` (4 `it`s) and `__tests__/components/operator/PartNotesSheet.test.tsx` (6 `it`s)*.
- [ ] **Given** two notes both older than the recency window, **when** the Playbook loads, **then** the one consulted on more jobs comes first even if it is older; **given** a note written today with zero usage, **then** it still ranks above a veteran — a correction must never be buried; **given** two equally-used notes, **then** a helpful mark breaks the tie — *verified by `api/tests/integration/test_note_views_rls.py` (70 tests)*.

**Read-back loop (attribution)**

- [ ] **Given** a note body scrolled past in under 2 seconds, or visible 2+ seconds while the tab is **hidden**, **then** no view is logged — the count must never exceed reality; **given** five notes dwelled in one window, **then** it is **one** `log_note_views` call, because a read N+1 must not become a write N+1 — *verified by `__tests__/hooks/useNoteDwell.test.tsx` (8 `it`s)*.
- [ ] **Given** an author reading their own note, **then** no row is written and `viewer_count` does not move — enforced in `log_note_views`, not the client — *verified by `api/tests/integration/test_note_views_rls.py`*.
- [ ] **Given** any non-author, **when** they SELECT `note_views`, embed it, or probe it with `Prefer: count=exact`, **then** they get `42501` / no count — *verified by `api/tests/integration/test_note_views_rls.py`*.
- [ ] **Given** an author, **when** they open one of their own notes, **then** `note_viewers()` returns one row per person with a representative job number and **no timestamp**, ordered by name — *verified by `api/tests/integration/test_note_views_rls.py`*.
- [ ] **Given** a member is deleted, **when** their view rows cascade, **then** neither counter moves — monotonic, so delete-and-difference cannot reconstruct what they read — *verified by `api/tests/integration/test_note_views_rls.py`*.
- [ ] **Given** the digest RPC called with **any** argument, **then** it fails — permanently argument-free, so no time window can be probed; **given** a new reader, **then** the running total has climbed, because it is a total and not a window — *verified by `api/tests/integration/test_note_views_rls.py`*.
- [ ] **Given** a browser role attempting to write `viewer_count`, `usage_count` or `edited_at`, **then** it is refused — asserted in CI by `note_counter_write_leaks()` — *verified by `api/tests/integration/test_note_views_rls.py`*.
- [ ] **Given** nothing new since the operator last looked, **then** the banner renders nothing; **given** a running total of 9 of which 6 were acknowledged, **then** it says **3**, not 9; **given** a tap, **then** it navigates to My work AND banks the total, while the close button dismisses without navigating — *verified by `__tests__/components/operator/NoteUsageBanner.test.tsx` (16 `it`s)*.
- [ ] **Given** My work with any data, **then** no completion count, streak, average, pace or rank appears anywhere; **given** an operator with more than ten notes, **then** ten load and the totals still count every note they have written — *verified by `__tests__/app/operator/MyWorkPage.test.tsx` and `e2e/operator-completion.spec.ts`*.
- [ ] **Given** a note whose job has been deleted, **then** the note survives, the Open-job item leaves the overflow menu, and the reference falls back to the part; **given** a maintenance entry, **then** the row names the **work centre** where a job note names its job — *verified by `__tests__/app/operator/MyWorkPage.test.tsx`*.
- [ ] **Given** My work, **when** the operator taps a note's body, **then** nothing happens — the view count opens the readers and the overflow opens the actions, so no tap is ambiguous between reading and deleting — *verified by `__tests__/app/operator/MyWorkPage.test.tsx`; rationale in [interaction-standards.md](../interaction-standards.md)*.
- [ ] **Given** the whole loop end to end, **when** one operator writes a note and another reads it, **then** the count and the named reader reach the author — *verified by `e2e/operator-notes-loop.spec.ts` (2 tests)*.

**New since you last looked** (#661)

- [ ] **Given** helpful marks the author has not seen, **then** they appear grouped by NOTE with the reactors named — three people on one note is one item naming three — and never as a per-person total; **given** nothing new, **then** the block renders nothing — *verified by `__tests__/components/operator/NewHelpfulBlock.test.tsx` and `__tests__/utils/operatorAccess.test.ts > getNewHelpful`*.
- [ ] **Given** the quoted text, **then** it is a `blockquote` and the line reads "found **your note** helpful" — bold with no framing read as the block's own headline, so the surface failed to say the one thing it exists for — *verified by `__tests__/components/operator/NewHelpfulBlock.test.tsx`*.
- [ ] **Given** **Got it**, **then** the cursor advances to the newest instant actually on screen (not `now()`), so a reaction landing mid-render is still shown next time; **given** a failed dismiss, **then** the block stays put rather than losing the news — *verified by `NewHelpfulBlock.test.tsx`*.
- [ ] **Given** a cursor stored at microsecond precision, **when** the block reloads, **then** the newest reaction does **not** return — the cursor goes to PostgREST as the raw string, because a round-trip through JS `Date` truncates to milliseconds and makes that reaction compare strictly greater for ever — *verified by `__tests__/utils/operatorAccess.test.ts` > `getNewHelpful`*.
- [ ] **Given** an operator whose notes nobody has opened, **when** the summary renders, **then** the zero stays in place and a forward-looking line appears instead of a standing "0 views" — *verified by `__tests__/app/operator/MyWorkPage.test.tsx`*.

**Playbook ordering**

- [ ] **Given** two notes both older than the recency window, **when** the Playbook loads, **then** the one consulted on more jobs comes first even if it is the older — *verified by `api/tests/integration/test_note_views_rls.py > test_playbook_ranks_the_load_bearing_note_first`*.
- [ ] **Given** a note written today with zero usage and a veteran with several jobs, **when** the Playbook loads, **then** the fresh note is above it — a correction must never be buried — *verified by `api/tests/integration/test_note_views_rls.py > test_a_fresh_note_is_never_buried_by_a_veteran`*.
- [ ] **Given** two equally-used notes, **when** one carries a helpful mark, **then** it ranks first — *verified by `api/tests/integration/test_note_views_rls.py > test_helpful_breaks_a_usage_tie`*.

**Reactions**

- [ ] **Given** a colleague's note, **when** the operator taps Helpful, **then** the count moves immediately and the write follows; **given** a failed write, **then** the button rolls back with no toast — *verified by `__tests__/components/operator/NoteReactions.test.tsx` (12 `it`s)*.
- [ ] **Given** the operator's OWN note, **then** no control is offered — RLS forbids self-reaction, so the tap would be a guaranteed `42501`; **given** a `confirmed` row, **then** it is excluded from the count and its reactor is not named; **given** any note, **then** no negative option exists on screen or in the schema — *verified by `__tests__/components/operator/NoteReactions.test.tsx`*.
- [ ] **Given** a duplicate insert (two taps racing, or a second device), **then** it is treated as success; **given** an un-react, **then** it is scoped to the caller's own row — *verified by `__tests__/utils/operatorAccess.test.ts`*.

**Inventory**

- [ ] **Given** the Inventory tab, **when** it loads, **then** it is **item-first** — a part lookup plus a shop-wide activity feed, not a location board — *verified by `__tests__/components/operator/OperatorWarehouseHome.test.tsx` > `OperatorWarehouseHomePage — item-first Inventory tab` and `__tests__/components/operator/OperatorPartLookup.test.tsx`*.
- [ ] **Given** a bin with stock, **when** the operator **Removes** more than is on hand, **then** the depletion is graceful — clamped to zero, flagged as a discrepancy — and stamped with the operator id — *verified by `__tests__/components/operator/OperatorBinView.test.tsx`*.
- [ ] **Given** a bin removal, **when** the operator tags it to an active job, **then** `depleteStockAtLocation` is called with that `jobId`; the tag is optional — *verified by `__tests__/components/operator/OperatorLocationActionModal.test.tsx`*.
- [ ] **Given** a bin, **when** the operator taps **Stock a part**, **then** only tracked parts not already in that bin are offered — *verified by `__tests__/components/operator/OperatorReceivePartModal.test.tsx`*.

**Maintenance**

- [ ] **Given** no station selected, **then** the Maintenance tab is hidden — a station *is* a machine, so there is deliberately no machine picker — *automation-pending (`app/operator/[companyId]/layout.tsx`)*; the logbook itself is covered by [machine-maintenance.md](machine-maintenance.md) and `e2e/machine-maintenance.spec.ts`.

**Admin: operators**

- [ ] **Given** the team page Operators tab, **when** an admin invites an operator, **then** a magic-link invitation is sent via the `team-invites` Edge Function and, on acceptance, a `user_company_access` row with `role='operator'` is created — *automation-pending (`team-invites` Edge Function; `InviteTeamMemberPage`)*.
- [ ] **Given** the app, **when** looking for a manual operator-create route inside the operator interface, **then** none exists — *manual: no create route under `app/operator/[companyId]/`*.

---

## Gaps, and what is still wrong elsewhere

**Unbuilt, named:** scrap and defect capture (above); a production→shippable gate, whose data now
exists; scrap-driven material consumption and yield costing; auto-logged completion entries in the
activity feed; and any offline mode.

**Code the docs surfaced, tracked nowhere:** `api/routes/operators_routes.py` is mounted and would
500 (above). `#550`, which tracked its deletion, is **closed without the deletion having landed** —
read it as superseded, the same way [inventory.md](inventory.md) records its own #550 residue.

**`prd.md` was corrected in the same pass** (2026-08-02): §4.3's three false claims (single-tap
capture, one QR per operation row, a blocking station guard), FR-6, FR-12's withdrawn gamification,
Flow 1's blank step and linear lifecycle, Flow 2 and FR-19 marked never-built, §6's three dropped
entities, and the work-order / operation-type terminology. If you find a fourth §4.3 claim that
does not match the code, fix it there — this doc defers to §4.3 rather than restating it.
