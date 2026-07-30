# Operator View Module

## Overview

The Operator View is a mobile-first interface for shop-floor operators, used on their own
phones. Operators sign in, tap the station they're working at from a list, see the work
ready at that station, open a step, and record progress with a single **Mark Complete**.

> This spec covers the **data model and screens**. For the end-to-end operator journeys
> and the paperless-preferred model, see [operator-paperless-flow.md](../operator-paperless-flow.md).

**Route:** `/operator/{companyId}` (dedicated mobile interface)

> **Supersedes** an earlier draft that described `operation_type` stations, a routing **DAG**
> with parallel branches, `operator_sessions` time tracking, and PIN/badge login. The shipped
> module uses **work centers**, **linear** routings, **complete-only** capture (no
> sessions/timers), and **email/password** login. Don't trust older revisions.

---

## Authentication

- **Email/password via Supabase Auth.** Operators authenticate the same way as office staff
  but land on the operator interface. Role = `operator` in `user_company_access`.
- Operators use **their own phones**; the Supabase session persists, so sign-in is
  effectively one-time per device. Shared-kiosk PIN/badge is intentionally **not** used.
- `getPostLoginRoute()` routes `operator`-role users to `/operator/{companyId}`, others to
  `/dashboard/{companyId}`.

## Stations (work centers)

- A "station" is a row in **`work_centers`**; each `job_operations` row carries `work_center_id`.
- The operator picks a station from a tappable list (`components/operator/StationSelector.tsx`,
  fed by `getStationOperationTypes` → internal work centers) — there is **no permanent
  operator↔station assignment**. Selection persists in `localStorage`
  (`jigged_operator_station`, via `components/operator/OperatorStationContext.tsx`), so it
  survives a browser restart or a backgrounded-tab eviction, and can be changed any time from
  the header station dropdown. Logout clears it (`clearStoredStation`).
- **There is no station QR.** Per-work-center QR placards (a download on each work-center
  detail page plus a bulk **Print Placards** action, encoding
  `…/operator/{companyId}/login?station={workCenterId}`) were removed in July 2026 — they were
  never posted on a shop floor, and in-app selection plus the dashboard jobs list's **Shop
  floor view** button reach the same place. The login page no longer reads a `?station=` param.

## Data model

**Operators** — `user_company_access` with `role='operator'` (the legacy `operators` table is deprecated).

**Operations** — `job_operations`: one row per routing step on a `job_part`.
- `sequence`, `operation_name`, `instructions`, `work_center_id`.
- `status`: **`pending` → `completed`** (single tap) for internal steps. `completed_at` /
  `completed_by` record who and when.
- **Outside (external-vendor) steps** — a step routed to a work center with `kind='external'`
  is performed by a vendor (e.g. coating), so it uses a **send/receive** lifecycle instead of
  Mark Complete: `pending → (Mark Sent Out) sent → (Mark Received) completed`. `sent` is an
  **optional waypoint** — Mark Received also completes directly from `pending` (the common
  after-the-fact case), back-filling the send stamp. `sent_at` / `sent_by` record the send;
  received reuses `completed_at` / `completed_by` (received == completed). An external step can
  **never** be completed through the internal Mark Complete path. See
  [jobs.md](jobs.md#outside-external-vendor-operations) and [prd.md](../prd.md) §4.3.
- `estimated_setup_minutes`, `estimated_run_minutes_per_unit` — estimates only, used for costing/quoting.
- **No actual-time columns and no `operator_sessions` table** — both were removed. There is no
  start/stop, no timer, no shift/clock-in. See [prd.md](../prd.md) §4.3 (Complete-Only).

**Notes** — `notes` (+ `note_media`). Renamed from `job_notes` / `job_note_media` in
[`20260728040701`](../../supabase/migrations/20260728040701_notes_subjects_and_view_logging.sql).
Not to be confused with **`part_comments`** (renamed from `part_notes` in the same
migration) — that is the office-side part activity feed carrying manual comments
alongside system-generated pricing/stock events, and it is a different domain
entirely. Operators never see it; it has no view logging, no subjects, no media.

A note carries a **subject** (`subject_kind`), which is what it is *about* — not
where it was captured:

| `subject_kind` | Required | Optional refinement |
|---|---|---|
| `job` | `job_id` | `job_part_id`, then `job_operation_id` |
| **`part`** | **`part_id`** | **`routing_operation_id`** — the routing step |
| `work_center` | `work_center_id` | — |

Enforced by the `notes_subject_valid` CHECK, plus a `notes_validate_subject`
trigger that Postgres CHECKs cannot express: every subject FK must belong to the
note's own `company_id`, and `routing_operation_id` must belong to `part_id`.

**Why `part` matters.** Before this, `job_notes.job_id` was NOT NULL, so every
note in the system died with its job and "what we learned running this part" had
to be *reconstructed at read time* by walking prior completed jobs. A note
anchored to `(part_id, routing_operation_id)` has no job in it at all, so the next
person running that part reads the same row the last person wrote.

`captured_job_id` / `captured_job_operation_id` are **provenance, not subject** —
where a durable note was written, so it still appears in that job's feed. Both are
`ON DELETE SET NULL`: the knowledge outlives its origin.

Which subject the composer writes is never an operator decision — if the current
`job_operation` has a `routing_operation_id`, `addJobNote` writes a `part` subject
with provenance; otherwise (an ad-hoc step with no routing link) a `job` subject.
So **new operator captures are durable by default.**

## The read-back loop (attribution)

A note that goes into a void is not worth writing. `note_views` closes the loop:
reads are logged, counted, and reflected back **to the author only**.

**What is logged.** `useNoteDwell` observes note *bodies* (never a header, never a
count badge) and logs a view after **2 seconds visible**, gated on
`document.visibilityState === 'visible'` — an IntersectionObserver reports
intersecting in a backgrounded tab, and a count that exceeds reality is worse than
no count. Dwell completions are batched into one `log_note_views(ids, jobId)` RPC
per screenful, fire-and-forget, Sentry on failure and never a user-visible error.

**Dedupe:** `UNIQUE NULLS NOT DISTINCT (note_id, viewer_id, job_id)` — one row per
person per note per job, forever. Re-reading the same note on the same job is one
row. `NULLS NOT DISTINCT` is load-bearing: `job_id` is nullable, and the SQL
default would treat every NULL as unequal, so repeat Playbook reads would insert
unbounded rows.

Two counters on `notes`, maintained only by the `note_views_bump_counts` trigger
and **monotonic** (`GREATEST`, no decrement):

- `viewer_count` — distinct **people**. Saturates near shop size; that is its meaning.
- `usage_count` — distinct **jobs**. Uncapped, and the signal that separates a
  load-bearing note from one read once out of curiosity. It ranks the Playbook.

**Never logged:** the author's own reads, or anyone with
`user_company_access.excluded_from_metrics` / in `system_admins`. Both are enforced
in `log_note_views` itself, because the browser has no INSERT grant to opt out of.

### Privacy — the rules that must not be relaxed

`note_views` has **no client-readable path at all**. Not a narrow policy — none.
Any row-returning SELECT policy is probeable into a per-viewer oracle via
`HEAD ?note_id=eq.X&viewer_id=eq.Y` with `Prefer: count=exact`, and RLS is powerless
against a count computed over exactly the rows it admitted. So:

- No grant to `anon`, `authenticated`, or `jigged_ai_readonly` — **ever**. A
  RESTRICTIVE deny-all policy names all three, so a future permissive policy still
  ANDs to false.
- **No function touching `note_views` may accept a viewer parameter.** The three
  that touch it: `log_note_views` (returns `void` — a duplicate must be
  indistinguishable from a first view), `note_viewers(note_id)` (authors only, one
  row per person, ordered by name, **no timestamps**). `my_note_digest()` used to
  be the third — as `my_note_view_digest`, before it also began reporting helpful
  marks — but no longer touches the table at all: it reads `notes.viewer_count`
  and counts `note_reactions`, so it is `SECURITY INVOKER`. **It takes no
  arguments, permanently**: a caller-supplied time window would be a bisection
  oracle for when a note was read.
- **`authenticated` has no UPDATE on `notes` at all** — notes are append-only today,
  so the whole privilege is revoked. Otherwise setting `viewer_count = 0` and
  returning later to read the delta is a one-bit read oracle per note. If note
  editing is ever added it needs a permissive policy **and** a column-scoped grant
  that excludes `viewer_count`, `usage_count`, `company_id`, `author_id` and every
  subject column.
- `user_company_access` UPDATE/INSERT **are** column-scoped, to
  `(name, role, email, pin_hash)`. Without that, an admin flags everyone-but-one
  with `excluded_from_metrics`, watches whose reads still count, and has a full
  deanonymization — or deletes and re-inserts a membership to the same end.
- Counters are **monotonic** so deleting a member and differencing the counts
  cannot reconstruct what they read.
- Never add `note_views` to `supabase_realtime`, `ALLOWED_TABLES`, or
  `SENSITIVE_TABLES`' opposite. Never add a constraint requiring a `note_views` row
  before a reaction — that turns the reaction endpoint into a "has X viewed N" oracle.

**There is no owner-facing report of who read what.** The rule is one sentence with
no role branch: *you see who viewed your own notes; nobody sees who viewed anyone
else's.* `note_viewers()` deliberately has no admin exclusion — roles move up and
down in a small shop, and an operator promoted to lead must not silently lose the
feedback loop on notes they already wrote.

**Residual, stated rather than hidden:** an admin can read `viewer_count` (by
design), poll it, and correlate an increment with who was on shift. That is inherent
to publishing any count. The design denies every amplifier — no per-job breakdown,
no timestamps in the named list, no read timeline, no realtime stream. Jigged staff
with prod access can read the table as `postgres`; the promise is "your boss cannot
see this", not "nobody can".

### What comes back to the author

- **Login banner** (`NoteUsageBanner`, on the jobs list) — **"2 people found your
  notes helpful · 3 new views."** `my_note_digest()` returns *running totals* of
  both across the caller's own notes: views (the sum of `viewer_count`, exactly
  the figure My work shows, so the two can never disagree) and helpful marks.
  **Helpful leads when present** — a view is someone needing to look something
  up; a helpful is a colleague choosing to say it was worth reading. Only the
  signals that actually moved are mentioned. `helpful` is **not** monotonic (a
  mark can be taken back), so its delta is clamped at zero. The component stores the
  total it last acknowledged in `localStorage` and renders the **difference**, so
  it appears only when something has genuinely happened and goes quiet once seen —
  no nag on the many jobs-list visits in a shift. Both the ✕ and a tap-through
  bank the total. Renders `null` at zero.

  **First run on a device announces nothing.** The mark lives in `localStorage`,
  so it follows the *device*, not the person — a shop tablet, a replacement
  phone, a second browser or cleared site data all start empty. Defaulting to
  zero would render the whole history as new ("312 new views" after a year), and
  the banner's only asset is that its number is true. Instead the current total
  is adopted silently, so the *next* view is announced correctly. The cost is one
  missed announcement: views that accrued while that device was away are never
  banner-announced. Information delayed, not lost — the full picture is on My
  work, one tap down. A mangled stored value is treated as **absent** for the
  same reason (zero would announce everything).

  Two earlier designs are recorded here because both are tempting and both are
  wrong. A **weekly window** (the first version) let the count climb all week
  while dismissal was all-or-nothing, so dismissing at "1 person" on Monday
  silently swallowed Friday's "6" — the nag and the reward were the same object.
  A **"last opened" timestamp** would have to travel back as a query window, and a
  caller-supplied window is a bisection oracle: narrow it repeatedly and you
  recover *when* a note was read, which combined with `note_viewers()` naming the
  reader reconstructs "Kurtis had to look this up on Tuesday". A count is a number
  the server already told us, so subtracting on the client leaks nothing.
- **My work** (`/operator/{companyId}/my-work`) — notes / photos / views, then each
  note with its view count, the job it was written on beside the date, and on tap
  the named viewers plus an **Open J-NNNN** link back to the source.

**The word is "views", never "uses".** All that is recorded is that someone opened
a note and stayed on it. Whether they acted on it is not measured, and claiming it
makes every number a small lie the author can personally disprove by asking.

### The Playbook (previous notes)

`PartNotesSheet`, opened from the op card's **Playbook · N**. Everything the shop
has learned about running this part, ranked so the useful thing is first.

**Ordering** lives in `part_playbook_notes`: usefulness-first with a recency
guard.

1. Anything from the **last 14 days**, newest-first
2. Then `usage_count` — distinct jobs it was consulted on, the strongest signal
   we have because it records someone reaching for the note *while doing the
   work*, not an opinion offered afterwards
3. Then helpful marks, then recency

Newest-first alone buried the load-bearing note on any part with several. Pure
usefulness would bury a correction written this morning below an old note with a
long history, which on a shop floor is the dangerous direction — the original
plan handled that with a `confirmed` reaction and visual decay of stale entries,
and both were dropped, so the 14-day guard carries it alone. The window is a
judgement, not a finding; revisit it with real data.

**Why this is a sheet and not a page.** Operators already carry an annotated
paper print, and paper wins on two things we cannot match: it is always at the
machine, and its annotations are *spatially indexed* — a margin note points AT a
feature, which a text list cannot reproduce. What digital adds is narrower and
real: the knowledge survives the sheet being lost or superseded by a revision, it
exists in more than one place (one annotated print sits at one machine), and it
carries attribution and reception. All three land one tap from the step. A
browsable `/parts/{partId}/playbook` route was planned and **deliberately not
built**: it would have asked an operator to go *looking* for knowledge while off
a job, which is exactly when they will not. If a part ever needs a destination of
its own, that is the moment to add one — not before.

**Corrections are not built either.** `corrects_note_id` exists in the schema
with no writer anywhere, so a corrections section would be a display for
something nothing can create.

### Reactions (`helpful`)

The **voluntary** half of the loop, and the deliberate opposite of view logging.
A view is involuntary and private — a record that someone needed to look
something up — which is why `note_views` has no client read path at any level. A
reaction is a claim someone chose to make, so it is public inside the shop,
carries the reactor's name, and is removable only by the person who made it
(admins deliberately **cannot** delete someone else's: a boss who can curate the
public record of what the shop found useful is worse than a stale reaction).

Rendered by `NoteReactions` on three surfaces: the job feed, the previous-notes
sheet (where prior knowledge is actually read, so the most important one), and
**My work read-only** — RLS forbids reacting to your own note, so there
endorsements are *reception*, the same category as the view count beside them.

- **There is no thumbs down, and this is not a deferral.** `kind` is
  CHECK-limited to `('helpful','confirmed')`, so there is no schema slot for a
  negative. An inaccurate note is corrected (`corrects_note_id`) or superseded,
  never publicly judged — nobody on a fifteen-person floor writes a second note
  after being downvoted by a colleague they see every morning.
- **`confirmed` has no UI.** It stays in the CHECK; nothing writes or renders it,
  and the helpful count filters it out so a stray row cannot inflate anything.
- **The control is hidden on your own notes.** The INSERT policy refuses
  self-reaction, so rendering it there makes every tap a guaranteed `42501` that
  reads as a broken button. This is why `part_playbook_notes` returns `author_id`
  as well as `author_name` — matching on a display name breaks on two Daves.
- **Optimistic with rollback.** On shop wifi a thumbs-up that waits for a round
  trip before moving reads as broken. A failure rolls the button back and goes to
  Sentry; there is no toast, because an operator mid-job does not need a dialog
  about a thumbs-up.
- **Count and names derive from the same array**, so they can never disagree —
  which is why no denormalized reaction counter exists. That array must carry
  `reactor_id`: without it a reader cannot be found in it, so the thumbs-up
  renders un-pressed on a note they have already marked and a second tap just
  re-inserts a duplicate. `part_playbook_notes` shipped without it and the bug
  looked exactly like "likes are not persisting" — they were.
- **No `operator_events` kind for reactions, deliberately.** `note_reactions`
  already records who reacted, to what, and when; a parallel funnel event would
  duplicate it and drift.

**What this must never become: a per-person total.** Reactions are safe because
they attach to a *note*. "Diego has 47 thumbs-ups" is a leaderboard and "Priya
gave 3" is a participation score — both are the operator-comparative metrics this
module refuses. Nothing sums them by person, including My work, which shows
endorsements received *on a note*.

### Capture is part of completing (B4)

Finishing a step and writing down what you learned are **one act, one button, one
commit**. The completion block carries the quantity field, an optional "Anything
worth noting for next time?" with photo attach, and `RECORD COMPLETION` submits
all of it.

It used to be three separate things: record the completion, then a prompt
offering to add a photo, then a *separate* Post. The middle of that had no
durability — attaching a photo showed a thumbnail, the flow read as finished, and
a back tap discarded it silently. There was no `beforeunload` guard and no draft
persistence, so the only real fix was to stop having two commits. **The
post-completion offer is deleted, not relocated.**

**Submit order is load-bearing and deliberately NOT atomic:**

1. `createOperationCompletion` — lands first, durably
2. `addJobNote`, if there is text or a photo
3. `addJobNoteMedia` per photo

A transaction would be *worse*: it would roll back real finished work because an
image failed to upload on shop wifi. So if the note fails the completion stands,
and the note error surfaces on its own next to the text the operator still has.
Asserted by `OperationActionPage.test.tsx > 'writes the note only AFTER the
completion has landed'` and `'keeps the completion when the note fails'`.

**Capture is always optional.** Completion works with the field empty.

**Where the feed keeps its own composer.** Three of the four branches of the
operation page have no completion block, so capture cannot live only there:

| Branch | Capture |
|---|---|
| Internal, incomplete | **In the completion block**, one button |
| Internal, **complete** | Feed composer — otherwise a photo could never be added after finishing, which is how photos actually arrive (taken on the phone's camera, attached later) |
| **Outside** step (send/receive) | Feed composer — `operator-paperless-flow.md` calls *"sent to coater 7/9, expected back 7/16"* the highest-value note in the system |
| No station selected | Neither: the page is only a station picker |

`JobFeed`'s `standaloneCapture` prop is that switch, and it is false on the normal
path so there is never more than one composer on screen. This is a deliberate
deviation from the plan's *"the note cannot be saved without completing"*, forced
by the render branches rather than by preference.

**The primary button says what it will do, and that closes a hole.** With a
quantity it reads `RECORD COMPLETION` and submits the completion then the note.
With **nothing finished but something typed** it reads `SAVE NOTE` and writes the
note alone.

That path is not a convenience. `qty > 0` is enforced, so an operator who
finished zero pieces — *"machine down"*, *"waiting on material"*, *"tool chipped,
swapping it"* — otherwise had two options and both were bad: stay silent and lose
exactly the knowledge this workstream exists to capture, or **type a false
quantity** to get the note saved. Corrupting the number that feeds costing and
scheduling to satisfy a UI constraint is far worse than an extra code path. One
field, one button, no second composer.

### Density on the step screen

This screen's failure mode is crowding, and the primary action is what gets
pushed off the bottom. ISA-101 frames it as a Level 1 action display, not a
Level 3 detail display: *"what does the operator need to know right now"*.

- **The job card is one line** — `J-0007 · PROD-ACTUATOR-200` — and **the whole
  card is the tap target**, with a decorative chevron as the affordance. A
  separate chevron button would be a second control for one action, and nesting
  it would be invalid markup. The expanded section sits **outside** that button
  because it contains a real link (`View all steps for J-0007`), which is where
  the traveler link moved to when the job number stopped being one.
- **Expanded state is sticky** across steps via `sessionStorage`. Whether it
  should persist across days as a remembered preference is undecided.
- **Always visible, never behind the expander:** the part description, the
  per-operation instructions, and **part progress** — "where am I on this part"
  is the question a step screen exists to answer.
- **`Parts finished` shares a row with Files and Playbook**, leading it, matched
  to their 48px height. It leads because it is the input for the primary action
  while those are reference; they keep their counts, which is what actually
  advertises them.
- **Capture is one row** — single-line field that grows, camera as an adjacent
  icon. The dictation tip is a **caption, never an icon button**: nothing can
  invoke the OS keyboard's dictation from a web page, so a mic icon beside a real
  camera button is a false affordance.

**The action is NOT pinned, by decision.** A fixed bar guaranteed reachability
but overlaid the content beneath it. The protection is density instead, which is
a weaker guarantee — measured at 440×956, collapsed the button clears the nav
(bottom 495 vs 521); **expanded it does not** (629) and needs a scroll. Since the
expander is sticky, an operator who expands once keeps it that way. **Measure
before adding anything above that button** — that is exactly how it broke the
first time.

### Description vs instructions: no dimming, ever

Two lines can carry the engineer's intent, and the app cannot tell which:
`parts.description` and `job_operations.instructions`. Per-operation text is
optional and frequently blank, so shops often put the instruction in the part
description instead.

So **neither is de-emphasised**, and the distinction is a dimmed **label**
(`Instructions:`, the same word the admin sees when writing the field) rather than
weight or a tinted box. What is dimmed is chrome, never content — the label shares
the content's font size, so **colour is the only difference between them**. A
smaller label beside larger text read as two unrelated lines rather than a label
and its value, and the colon carries the demarcation a size change was doing
badly.

An earlier revision dimmed the description to make the instruction "the brighter
one". That was wrong twice over: it asserted "reference, not instruction" exactly
when that was false, and ISA-101 requires every emphasis to carry a defined
meaning — de-emphasis used as a **guess** carries none, and NN/G's hierarchy work
is explicit that muted text draws less attention. Emphasis stays reserved for
states that genuinely mean "look here now": the over-quantity error and the
station-mismatch warning.

**The seed matters here.** `supabase/seed.sql` used to fill every routing step's
`instructions` with `'<WorkCenter> operation'`. That made the box appear on every
step of every demo, which teaches an operator the box is noise so they skip it on
the day it says "torque to 40, not 45". Four steps now carry real shop
instructions and the rest are NULL, so a usability session tells us about the
design rather than about our test data.

One implementation, two hosts: [`useNoteCapture`](../../hooks/useNoteCapture.ts)
owns the draft, the photo pipeline (including the iOS unreadable-`File`
mitigation) and the funnel events; [`NoteCaptureFields`](../../components/operator/NoteCaptureFields.tsx)
renders them and deliberately owns **no** submit button, because the surface it
sits in decides what "save" means.

### Triangularity (B5)

The asymmetry that makes writing something down worth the extra taps:

| | Effort | What comes back |
|---|---|---|
| Completion alone | one tap | **Nothing.** The step turns green |
| Completion + a note | ~4 more taps | A Playbook entry with their name, a view count that grows, named readers, a login-banner line |

**Do not equalise it.** If completing were rewarded on its own, the note would be
pure cost and nobody would write one. So "nothing comes back from a bare
completion" is a feature with a test —
`e2e/operator-completion.spec.ts > 'a bare completion adds no note and no My work
row'` — which also scans My work for `completed`, `streak`, `average` and `pace`,
because a contribution screen is exactly where a completion count wants to appear.

### Surveillance guardrail (non-negotiable)

No operator-facing surface may reflect an operator's pace or standing back at them.
Concretely, **My work must never grow** a completion count, streak, average, or
anything comparable against another person — it is exactly where a leaderboard wants
to grow, and a test asserts the absence. No points, badges, or leaderboards anywhere.
There is no settings toggle for this.

Actual time is **structurally unrepresentable** — `operator_sessions` and
`job_operations.actual_*` were dropped ([`20260621132129`](../../supabase/migrations/20260621132129_drop_operator_time_tracking.sql)) —
so "actual vs quoted" cannot be built without a migration. The quoted
`estimated_setup_minutes` / `estimated_run_minutes_per_unit` shown on the traveler
and operation page stay: they are the engineer's routing estimate (an input to the
job), the printed traveler carries the identical figures, and there is no actual to
compare against. **Capturing actual time and showing it to the operator is the
trigger that reverses that decision.**

`operator_events` (funnel instrumentation: `app_opened`, `op_card_opened`,
`prior_notes_opened`, `composer_focused`, `note_saved`, …) is **service-role only**
and carries no note ids of what the actor read. A per-operator event log readable by
the shop's own admin would reconstruct exactly the reading behaviour the above exists
to protect.

## Routing & readiness

- Routings are a **linear sequence** of operations — no DAG, no parallel branches.
- An operation is **ready** when all lower-`sequence` operations on the **same part** are
  completed. Out-of-order work is **warned, not blocked** (`predecessors_incomplete`).
- Completing the last incomplete operation on a part completes the part; the job's
  `production_status` is derived (`not_started` / `in_progress` / `completed`). There is no
  separate operation-level "in progress" concept beyond the operation row's status — the one
  exception is an outside step's `sent` (at-vendor) state, which counts as *not completed*, so
  it holds the part at `in_progress` and blocks downstream internal steps until the parts are
  received.

---

## Screens & routes

| Screen | Route | Purpose |
|---|---|---|
| Login | `/operator/{companyId}/login` | Email/password; captures `?job=&part=`, `?job=&part=&operation=`, or `?location=` from a scanned QR and routes accordingly. A bare sign-in lands on the station job list. |
| Station job list (dispatch) | `/operator/{companyId}/jobs` | Work ready/in-progress at the selected station — one row per (job, part), sorted by due date. An **All Stations** lens shows the whole plant grouped by station. |
| Job parts hub | `/operator/{companyId}/jobs/{jobId}` | For multi-part jobs, lists the job's parts with progress; single-part jobs redirect straight to the traveler. |
| Part traveler | `…/jobs/{jobId}/parts/{jobPartId}` | All steps for one part (read-only), with a back-link to the parts hub on multi-part jobs. |
| Operation action | `…/parts/{jobPartId}/operations/{jobOperationId}` | Internal step: **Mark Complete** / **Undo**. Outside step: an "Outside process" banner (+ vendor) and **Mark Sent Out** / **Mark Received** (station-mismatch guard suppressed — outside steps have no operator station). Both: notes + photos, "last time we ran this part" guidance. |
| My work | `/operator/{companyId}/my-work` | The author's own contribution and its reception: notes / photos / views, each note's view count, the job it was written on, and on tap the named viewers + a link back to that job. Bottom-nav tab; also the login banner's tap-through. **No completion count, streak or average — see the guardrail above.** |
| Inventory (optional) | `/operator/{companyId}/inventory[/locations/{id}]` | Feature-gated bin browse + add/remove/adjust stock. |
| Profile | `/operator/{companyId}/profile` | Operator name, email, company name, **Logout**, and **Give Feedback**. (The current station lives in the header selector, not on this page.) |

## QR codes

There are two: the traveler QR and the inventory-location label. **There is no station QR** —
see [Stations](#stations-work-centers).

- **Traveler QR** (`utils/jobTravelerPdf.ts`): **exactly one per traveler sheet**, in the header
  beside the Job #, captioned "Scan to open this traveler". It opens that part's traveler page,
  where the operator taps the step they're working. An **optional accelerator** for shops
  mid-transition — not required under the paperless-preferred model.
  *A previous revision printed a QR on every operation row; operators couldn't tell which code
  they were pointing their phone at, so the sheet is back to one unambiguous target. The
  `?job=&part=&operation=` deep link still resolves for sheets printed under that revision.*
- **Inventory location label** (`utils/locationLabelPdf.ts`, `components/inventory/locations/LocationQRModal.tsx`):
  printed on a bin/cabinet, encodes `?location={id}` and opens that bin's view. Feature-gated
  with the rest of inventory locations — see [Inventory](inventory.md).
- The printed traveler's other shop-floor conventions: **outside (external-vendor) steps are
  flagged with a heavy black outline + bold text (border only, no fill)** — unmistakable and
  grayscale-safe, but essentially no extra toner (earlier gray/solid fills drew a shop-owner ink
  complaint). The merged **Notes** column carries the "OUTSIDE — ship to {vendor}" cue for
  outside steps (and the setup/cycle estimates for internal steps), and the **Done** column is a
  blank write-in for a count or tick.

## Admin

- **Operator creation** is a **magic-link invite** sent from the admin team page
  (`/dashboard/{companyId}/team`, Operators tab, via
  `/dashboard/{companyId}/team/members/new` with `role='operator'`). The invite is issued by the
  **`team-invites` Edge Function** (`supabase/functions/team-invites/index.ts`), which needs the
  service-role key; on acceptance it creates the `user_company_access` row with `role='operator'`.
  There is **no** operator-provisioning FastAPI endpoint in the shipped path.
- Operator management (list / rename / remove) uses the Supabase client directly against
  `user_company_access` with RLS (`listOperators` / `updateOperator` / `deleteOperator` in
  `utils/operatorAccess.ts`) — no backend involved.
- The legacy `POST /api/operators` backend (`api/routes/operators_routes.py`) is **dead code**:
  it targets a non-existent `operators` table, has no caller, and would fail at runtime. Its
  deletion is tracked in **#550**.

---

## Acceptance Criteria

Each bullet is a Given/When/Then scenario carrying a verification clause — a pointer to the test that proves it, a manual procedure, or an explicit automation-pending tag. Every editable entity has at least one edit -> save -> reload -> persists bullet. Doc-vs-code disagreements this audit surfaced are recorded in the divergence report on issue #342.

**Authentication & routing**

- [ ] **Given** a signed-in operator with no station yet, **when** they tap one in the station selector, **then** it is written to `localStorage` (`jigged_operator_station`), they land on that station's job list, and it is still selected after a browser restart — while logout clears it — *verified by `__tests__/components/operator/OperatorStationContext.test.tsx > 'OperatorStationProvider' > 'setStation persists (survives a reload); clearStoredStation wipes it on logout'` and `'hydrates the stored station on mount and finishes initializing'`; login E2E automation-pending (`OperatorLoginPage`)*.
- [ ] **Given** a signed-in user with `role='operator'`, **when** `getPostLoginRoute` runs, **then** they are routed to `/operator/{companyId}` (office roles go to `/dashboard/{companyId}`) — *automation-pending (`getPostLoginRoute` in `utils/companyAccess.ts`)*.
- [ ] **Given** the traveler QR (`?job=&part=`) — the one code printed on a job traveler — **when** the operator signs in, **then** they land on that part's traveler page and pick the step themselves; a `?job=&part=&operation=` QR (older travelers still on the floor) jumps straight to that step's action view, a `?location=` QR opens that bin, and a bare scan falls back to the station jobs list — *automation-pending (`OperatorLoginPage.postLoginPath`); the traveler's single-QR contract is verified by `__tests__/utils/jobTravelerPdf.test.ts > 'generateJobTravelerPdf — single traveler QR'`*.

**Station selection (work centers)**

- [ ] **Given** the station picker, **when** it lists selectable stations, **then** only **internal** work centers appear (external/vendor centers are excluded) — *verified by `__tests__/utils/workCentersAccess.test.ts > 'getWorkCentersByKind' > 'filters by kind in addition to company'`; the operator picker's `kind='internal'` filter is `getStationOperationTypes` — reload-persistence E2E automation-pending (#367)*.
- [ ] **Given** a selected station, **when** the operator taps the header station name and picks another, **then** the selection updates in `sessionStorage` and the jobs list re-scopes — *automation-pending (`OperatorStationContext.setStation`)*.

**Station job list (dispatch)**

- [ ] **Given** the "My Station" lens with a station selected, **when** the list loads, **then** it shows one row per (job, part) whose station operation is ready or in-progress, via the `get_ready_operations_for_station` RPC — *readiness RPC verified by `api/tests/database/test_operator_ready_ops_rpc.py > 'test_get_ready_operations_for_station_plans_against_real_columns'`; row-shape assembly (`getOperatorJobs` / `buildOperatorJobs`) reload E2E automation-pending (#367)*.
- [ ] **Given** the readiness RPC returns an error, **when** the list loads, **then** the failure surfaces in an Alert (it is NOT swallowed into an empty "No jobs" list — the May 2026 `jobs.status` regression) — *verified by `__tests__/utils/operatorAccess.test.ts > 'getAllStationsOperatorJobs' > 'throws (surfaces the error) when the readiness RPC fails, instead of returning []'`*.
- [ ] **Given** the "All Stations" lens, **when** it loads, **then** the whole-plant ready/in-progress work is fetched once per station in parallel and grouped by station — *verified by `__tests__/utils/operatorAccess.test.ts > 'getAllStationsOperatorJobs' > 'queries readiness once per station (parallel) and returns [] when nothing is ready'`*.

**Part traveler & readiness**

- [ ] **Given** a job_part, **when** the traveler loads, **then** it lists every operation in `sequence` order (read-only) with per-step status, and a completed step stays tappable so it can be reopened to undo — *automation-pending (`getJobPartTraveler`)*.
- [ ] **Given** an operation whose lower-`sequence` predecessors on the same part aren't complete, **when** the operation page loads, **then** `predecessors_incomplete` is flagged and a warning shows, but completion is still allowed (warned, not blocked) — *automation-pending (`getOperatorOperationDetail` / `isJobOperationReady`)*.

**Complete an operation (the one editable state change)**

- [ ] **Given** a pending operation, **when** the operator taps **Mark Complete**, **then** `job_operations.status` becomes `completed` with `completed_at`/`completed_by` set, and the page reloads into the completed state showing **Undo** — *write path verified by (`completeOperation`); reload-persistence E2E automation-pending (#367)*.
- [ ] **Given** an operation completed by mistake, **when** the operator taps **Undo**, **then** it returns to `pending`, `completed_at`/`completed_by` clear, and the part status is recomputed (`in_progress` if any sibling op is still done, else `not_started`) — *write path verified by (`revertOperationCompletion`); reload-persistence E2E automation-pending (#367)*.
- [ ] **Given** completing the last remaining operation on a part, **when** the write finishes, **then** the part moves to `completed` and the `job_parts` trigger cascades the derived `production_status` to the job — *automation-pending (`completeOperation`)*.
- [ ] **Given** a not-started part, **when** any earlier-than-final operation is completed, **then** the part moves to `in_progress` — there is no explicit "Start" — *automation-pending (`completeOperation`)*.
- [ ] **Given** the operator's selected station differs from the operation's `work_center_id`, **when** the operation page loads, **then** Mark Complete is replaced by a mismatch guard ("switch & complete" / back to traveler) rather than completing silently — *automation-pending (`OperatorOperationActionPage` station guard)*.

**Job feed (notes + media)**

- [ ] **Given** the operation page and a step WITH a `routing_operation_id`, **when** the operator saves a note, **then** it is written as a **durable `part` subject** (`part_id` + `routing_operation_id`) with the job recorded only as provenance — so the next run of that part surfaces it with no prior-job traversal — *verified by `__tests__/utils/operatorAccess.test.ts > 'addJobNote'*.
- [ ] **Given** an ad-hoc step with NO routing link, **when** the operator saves a note, **then** it falls back to a `job` subject (a genuine subject difference, not a silent fallback) — *verified by `__tests__/utils/operatorAccess.test.ts > 'addJobNote'*.
- [ ] **Given** the operation page, **when** the operator adds a note (optionally media-only) with a step tag, **then** it inserts into `notes` with the trimmed body, `job_part_id`, and `job_operation_id`, then reloads into the feed with a readable "Op N · Name" label — *edit->save->reload verified by `__tests__/utils/operatorAccess.test.ts > 'addJobNote' > 'inserts the step tag + trimmed body and returns the mapped note'` AND `__tests__/utils/operatorAccess.test.ts > 'getJobNotes' > 'maps author, step-tag label, and media; rolls up the whole job by job_id'`*.
- [ ] **Given** a blank-text note, **when** it is saved, **then** `body` is stored as null so a media-only note is valid — *verified by `__tests__/utils/operatorAccess.test.ts > 'addJobNote' > 'stores a null body for a media-only (blank text) note'`*.
- [ ] **Given** the job feed, **when** it loads, **then** job-subject notes AND durable part-subject notes captured on this job roll up together (newest first), via `or=(job_id.eq.X,captured_job_id.eq.X)` — *verified by `__tests__/utils/operatorAccess.test.ts > 'getJobNotes' > 'maps author, step-tag label, and media; rolls up the whole job by job_id'`*.

**"Last time we ran this part" guidance**

- [ ] **Given** a part with a prior completed run, **when** the traveler/operation page loads guidance, **then** it shows the newest completed prior run (excluding the current job) with that run's notes — *verified by `__tests__/utils/operatorPreviousRun.test.ts > 'getPreviousRunForPart' > 'returns the newest completed prior run, excluding the current job'`*.
- [ ] **Given** a specific operation, **when** guidance is scoped to that step, **then** the prior run's notes are filtered to the same step across runs (by `routing_operation_id`, falling back to `operation_name`) — *verified by `__tests__/utils/operatorPreviousRun.test.ts > 'getPreviousRunForPart' > 'filters notes to the same step across runs via routing_operation_id'`*.

**Read-back loop (attribution)**

- [ ] **Given** a note body scrolled past in under 2 seconds, **when** it leaves the viewport, **then** no view is logged — *verified by `__tests__/hooks/useNoteDwell.test.tsx`*.
- [ ] **Given** a note visible for 2+ seconds while the tab is **hidden**, **when** the timer would fire, **then** no view is logged — the count must never exceed reality — *verified by `__tests__/hooks/useNoteDwell.test.tsx`*.
- [ ] **Given** five notes dwelled within the debounce window, **when** they flush, **then** it is **one** `log_note_views` call — a read N+1 must not become a write N+1 — *verified by `__tests__/hooks/useNoteDwell.test.tsx`*.
- [ ] **Given** an author reading their own note, **when** the view is logged, **then** no row is written and `viewer_count` does not move — enforced in `log_note_views`, not the client — *verified by `api/tests/integration/test_note_views_rls.py`*.
- [ ] **Given** any non-author, **when** they SELECT `note_views`, embed it, or probe it with `Prefer: count=exact`, **then** they get `42501` / no count — *verified by `api/tests/integration/test_note_views_rls.py`*.
- [ ] **Given** an author, **when** they open one of their own notes in My work, **then** `note_viewers()` returns one row per person with a representative job number and **no timestamp**, ordered by name — *verified by `api/tests/integration/test_note_views_rls.py`*.
- [ ] **Given** a member is deleted, **when** their view rows cascade, **then** neither counter moves — monotonic, so delete-and-difference cannot reconstruct what they read — *verified by `api/tests/integration/test_note_views_rls.py`*.
- [ ] **Given** nothing new since the operator last looked, **when** the jobs list renders, **then** the banner renders nothing — no nag on the many jobs-list visits in a shift — *verified by `__tests__/components/operator/NoteUsageBanner.test.tsx`*.
- [ ] **Given** a running total of 9 of which 6 were already acknowledged, **when** the banner renders, **then** it says **3** new views, not 9 — *verified by `__tests__/components/operator/NoteUsageBanner.test.tsx`*.
- [ ] **Given** the digest RPC, **when** it is called with any argument at all, **then** it fails — the function is permanently argument-free so no time window can be probed — *verified by `api/tests/integration/test_note_views_rls.py > test_digest_takes_no_time_window`*.
- [ ] **Given** a new reader, **when** the digest is called again, **then** the running total has climbed — it is a total, not a window, which is what makes a client-side subtraction correct — *verified by `api/tests/integration/test_note_views_rls.py > test_digest_is_a_running_total_not_a_window`*.
- [ ] **Given** a non-zero banner, **when** the operator taps it, **then** it navigates to My work AND banks the whole total; **when** they tap its close button, **then** it dismisses **without** navigating — *verified by `__tests__/components/operator/NoteUsageBanner.test.tsx`*.
- [ ] **Given** My work, **when** it renders with any data, **then** no completion count, streak, average, pace or rank appears anywhere on the page — *verified by `__tests__/app/operator/MyWorkPage.test.tsx > 'shows no completion count, streak, average or pace'`*.
- [ ] **Given** a note whose job has been deleted, **when** My work renders it, **then** the note survives and only the job link is absent — *verified by `__tests__/app/operator/MyWorkPage.test.tsx`*.

**Playbook ordering**

- [ ] **Given** two notes both older than the recency window, **when** the Playbook loads, **then** the one consulted on more jobs comes first even if it is the older — *verified by `api/tests/integration/test_note_views_rls.py > test_playbook_ranks_the_load_bearing_note_first`*.
- [ ] **Given** a note written today with zero usage and a veteran with several jobs, **when** the Playbook loads, **then** the fresh note is above it — a correction must never be buried — *verified by `api/tests/integration/test_note_views_rls.py > test_a_fresh_note_is_never_buried_by_a_veteran`*.
- [ ] **Given** two equally-used notes, **when** one carries a helpful mark, **then** it ranks first — *verified by `api/tests/integration/test_note_views_rls.py > test_helpful_breaks_a_usage_tie`*.

**Reactions**

- [ ] **Given** a colleague's note, **when** the operator taps Helpful, **then** the count moves immediately and the write follows — an optimistic toggle, because a thumbs-up that waits for shop wifi reads as broken — *verified by `__tests__/components/operator/NoteReactions.test.tsx`*.
- [ ] **Given** a failed write, **when** it rejects, **then** the button rolls back rather than leaving a lie on screen, with no toast — *verified by `__tests__/components/operator/NoteReactions.test.tsx`*.
- [ ] **Given** nothing finished and something typed, **when** the operator taps the primary button, **then** the note is saved with NO completion invented to carry it — *verified by `__tests__/app/operator/OperationActionPage.test.tsx > 'saves a note alone when nothing was finished'` and `e2e/operator-completion.spec.ts`*.
- [ ] **Given** an empty quantity and an empty note, **then** the button is disabled — the zero-quantity completion floor is unchanged — *verified by `__tests__/app/operator/OperationActionPage.test.tsx > 'cannot record zero'`*.
- [ ] **Given** the step screen, **when** it loads, **then** the job card is collapsed and expands IN PLACE without navigating — *verified by `__tests__/app/operator/OperationActionPage.test.tsx > 'collapses the job details by default, and opens them in place'`*.
- [ ] **Given** the operator's OWN note, **when** it renders, **then** no control is offered — RLS forbids self-reaction, so the tap would be a guaranteed `42501` — *verified by `__tests__/components/operator/NoteReactions.test.tsx`*.
- [ ] **Given** a `confirmed` row, **when** the card renders, **then** it is excluded from the helpful count and its reactor is not named — *verified by `__tests__/components/operator/NoteReactions.test.tsx`*.
- [ ] **Given** any note, **when** looking for a negative option, **then** none exists on screen or in the schema — *verified by `__tests__/components/operator/NoteReactions.test.tsx`*.
- [ ] **Given** a duplicate insert (two taps racing, or a second device), **when** the unique constraint fires, **then** it is treated as success — the end state is what the caller asked for — *verified by `__tests__/utils/operatorAccess.test.ts`*.
- [ ] **Given** an un-react, **when** it is issued, **then** it is scoped to the caller's own row — *verified by `__tests__/utils/operatorAccess.test.ts`*.

**Inventory (feature-gated by `inventory_locations`)**

- [ ] **Given** a company without the `inventory_locations` flag, **when** the operator shell renders, **then** the Inventory bottom-nav tab is hidden — *automation-pending (`OperatorShell`, `features.inventory_locations`)*.
- [ ] **Given** the warehouse home, **when** it loads, **then** only top-level (root) locations are listed and tapping one drills into its bin view — *verified by `__tests__/components/operator/OperatorWarehouseHome.test.tsx > 'OperatorWarehouseHomePage' > 'lists only top-level locations and drills into the bin view'`*.
- [ ] **Given** a bin with stock, **when** the operator **Removes** more than is on hand, **then** the depletion is graceful (clamped to zero, flagged as a discrepancy) and stamped with the operator id — *edit->save->reload verified by `__tests__/components/operator/OperatorBinView.test.tsx > 'OperatorBinViewPage' > 'Remove depletes gracefully and stamps the operator'`*.
- [ ] **Given** a bin removal, **when** the operator tags it to an active job, **then** `depleteStockAtLocation` is called with that `jobId` (tag optional — a removal with no job is untagged) — *verified by `__tests__/components/operator/OperatorLocationActionModal.test.tsx > 'OperatorLocationActionModal — deplete job tag' > 'lists active jobs with their parts and tags the removal with the chosen job'`*.
- [ ] **Given** a bin, **when** the operator taps **Stock a part**, **then** only tracked parts not already in that bin are offered and the chosen part is added at this location — *verified by `__tests__/components/operator/OperatorReceivePartModal.test.tsx > 'OperatorReceivePartModal' > 'offers only tracked parts not already in the bin'`*.

**Admin: operators**

- [ ] **Given** the team page Operators tab, **when** an admin invites an operator (`/dashboard/{companyId}/team/members/new` with `role='operator'`), **then** a magic-link invitation is sent via the `team-invites` Edge Function and, on acceptance, a `user_company_access` row with `role='operator'` is created — *automation-pending (`team-invites` Edge Function; `InviteTeamMemberPage`)*.
- [ ] **Given** an existing operator, **when** an admin edits the operator's name and saves, **then** reloading shows the new name — *write path verified by (`updateOperator` in `utils/operatorAccess.ts`, `user_company_access`); reload-persistence E2E automation-pending (#367)*.
- [ ] **Given** the app, **when** looking for a manual operator-create route inside the operator interface, **then** none exists — operator accounts are provisioned from the admin team page only — *manual: no create route under app/operator/[companyId]/*.

---

## Out of scope (deliberate)

Single-tap completion keeps the operator's burden minimal. Intentionally **not** part of this
module: start/stop, time tracking, shift/clock-in, downtime reasons, general operation-level WIP
status, and permanent operator↔station assignment. (The one deliberate operation-level state is
an outside step's `sent`/at-vendor waypoint — it exists because the part is physically invisible
while it's out, not to track in-shop WIP.) Scrap/defect capture is in discovery (see
[operator-paperless-flow.md](../operator-paperless-flow.md) §5.4).
