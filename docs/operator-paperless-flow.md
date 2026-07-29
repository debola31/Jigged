# Operator Paperless Flow — Proposal & Journey Spec

> **Status:** Draft proposal · **Date:** 2026-06-29 · **Branch:** `feature/operator-paperless-proposal`
>
> **Update (2026-07-29):** the **station-QR placard was removed** — generator, bulk-print
> action, and the `?station=` deep-link all deleted. It shipped but was never posted on a
> floor, so it stopped being the lever this doc treats it as; operators reach their station
> by signing in and tapping it (J1), or via **Shop floor view** on the dashboard jobs list.
> §1, §2, §3, §4 (J1/J2), and §6 are amended below. Everything about the *queue* path — the
> actual paperless loop — is unchanged.
>
> **Purpose.** Define the *preferred* operator experience as **paperless**, spec the
> operator user journeys end-to-end, and record the product decisions that bound them.
> This doc is meant to (a) become the operator-journey source of truth and (b) drive a
> set of corrections to the stale parts of [`docs/prd.md`](prd.md) and
> [`docs/modules/operator-view.md`](modules/operator-view.md) (see
> [§9 Stale-doc reconciliation](#9-stale-doc-reconciliation)).
>
> It **builds on** the existing, current [`prd.md` §4.3 "Shop-Floor Data Capture Model
> (Complete-Only)"](prd.md) — that section is canon and is not re-litigated here.

---

## 1. TL;DR

The paperless path operators "can't reach" **already exists and is wired end-to-end**:
sign in → tap the station you're standing at → see the live list of jobs ready at that
station → tap one → **Mark Complete**. No printed traveler is required anywhere in that loop.

The problem is **not a missing capability — it's that the path was never deployed.**
The only QR codes in the building are on printed travelers — operators scan paper because
it's the only QR there is. (A station-QR placard feature also existed, but it was never
posted on a floor either, and was removed in July 2026; station entry is tap-select.) The
work, therefore, is:

1. **Make the queue the default** — land the operator on their station's queue, make
   "change station" obvious, and demote the printed traveler to an optional transition
   aid. ([§6](#6-making-paperless-the-preferred-model))
2. **Spec the journeys we haven't nailed** — the **whole-plant view** ([§7](#7-whole-plant-view-proposed))
   and **multi-part jobs** ([§8](#8-multi-part-job-navigation-proposed)) — so we can decide
   *from the journeys* whether/how to build them (rather than guessing).
3. **Run discovery on scrap / defect / quality flagging** ([§5.4](#54-scrap--defect--quality-flagging-discovery))
   — nothing exists today and it isn't yet thought through.

The one genuinely missing *capability* is the whole-plant ("sign into the plant") view;
everything else is adoption polish and spec hygiene.

---

## 2. Goal & non-goals

### Goal
Make the **preferred, default operator workflow paperless**: an operator on their own
phone signs in, taps the station they're standing at, and pulls work from a live,
station-scoped queue — confirming each step with a single tap. Printed travelers remain
available as a *fallback* during transition, not as the primary mechanism.

### Explicit non-goals (deliberate, decided)
These are intentional simplicity choices. They are **not** gaps to "fix" — the operator
UX is deliberately minimal so a busy operator on the floor does as little as possible.

| Non-goal | Rationale |
|---|---|
| **No start / pause / resume** — only a single **Mark Complete** | Start/stop on the floor is unreliable; one finish trigger is all an operator must do. (See `prd.md` §4.3.) |
| **No per-operation time tracking** | Same; costing/quoting use *estimated* times only. `operator_sessions` and `job_operations.actual_*` were already removed. |
| **No operation-level WIP/"in progress" status** | An internal operation is **pending → completed**. "Work in progress" is meaningful only at the **job/part** level (derived from partial completion via `production_status`), not per operation. *Exception:* an **outside (external-vendor) step** carries a `sent` (at-vendor) waypoint — `pending → (Mark Sent Out) sent → (Mark Received) completed` — because the part is physically out of the shop and invisible while it's away (see §5.2). |
| **No permanent operator↔station assignment** | Operators roam; station is chosen per session (scan or tap), persisted in `sessionStorage` only. |
| **No shift management / clock-in** | Out of scope; sign-in time is whatever Supabase Auth records, nothing more. |
| **No downtime / stoppage reasons** | Follows directly from complete-only — there is no "paused" state to attribute. |
| **No real-time push (WebSockets) for now** | Manual refresh is simpler and likely sufficient. Revisit only if we *validate* that live updates are needed. ([§5.3](#53-freshness-manual-refresh)) |

### In scope for this proposal
Paperless-preferred journeys, the whole-plant view spec, multi-part job navigation,
scrap/defect discovery framing, and the stale-doc fix list.

---

## 3. Current reality (what's actually built)

> Verified against the code on `main` as of 2026-06-29. This corrects the widespread
> assumption that operators have "no way in" without a printed traveler.

### Authentication & access
- Operators sign in with **email/password** via Supabase Auth (same auth as office
  staff), role `operator` in `user_company_access`. — `app/operator/[companyId]/login/page.tsx`,
  `utils/operatorAccess.ts` (`getCurrentOperator`).
- Operators on **their own phones** (decided) → the session persists via Supabase refresh
  tokens, so login is effectively one-time per device. Per-person login gives clean
  `completed_by` attribution.

### Station = work center
- "Station" maps to a row in **`work_centers`** (not `operation_type` — that terminology
  is stale in older docs). Each `job_operations` row carries `work_center_id`.
- **Station entry is tap-select:** `components/operator/StationSelector.tsx` lists the
  internal work centers as tappable buttons; the choice is kept in `localStorage`
  (`jigged_operator_station`) via `components/operator/OperatorStationContext.tsx`, so it
  survives a browser restart, and the header dropdown switches it any time.
- **Station QR placards were removed (July 2026).** A per-work-center placard generator and
  a bulk **Print Placards** action existed, encoding
  `…/operator/{companyId}/login?station={workCenterId}` — but placards were **never posted**
  on a floor, so the feature never influenced behaviour. Deleted rather than left as dead
  weight; tap-select plus **Shop floor view** on the dashboard jobs list cover the same entry.

### The dispatch list (station-scoped job queue)
- `app/operator/[companyId]/jobs/page.tsx` shows one row per **(job, job_part)** with a
  *ready or in-progress* operation at the selected station, via RPC
  `get_ready_operations_for_station` (`utils/operatorAccess.ts` → `getOperatorJobs`).
- Readiness = all lower-`sequence` operations on the **same part** are complete; out-of-order
  work is warned, not blocked.
- A row links to `…/jobs/{job_id}/parts/{job_part_id}` and deep-links straight to the ready
  `…/operations/{operation_id}` when known (`jobs/page.tsx:87`).
- **The My Station lens returns an empty list when no station is selected** (`getOperatorJobs`
  short-circuits). The whole-plant **"All Stations"** lens (shipped — see §7) is the mode that
  covers "no single station," e.g. a roaming operator or lead.

### Action & capture
- Operation action page: **Mark Complete** + **Undo**, append-only **notes + photo/video**
  feed (`notes` / `note_media`), and "last time we ran this part" guidance.
  — `app/operator/[companyId]/jobs/[jobId]/parts/[jobPartId]/operations/[jobOperationId]/page.tsx`,
  `components/operator/JobFeed.tsx`, `components/operator/PreviousRunCard.tsx`.
- **Per-operation QR** on the printed traveler (`utils/jobTravelerPdf.ts`) deep-links to a
  step's action page — the current dominant habit.

### What's missing / weak (the real list)
- **No whole-plant view** ([§7](#7-whole-plant-view-proposed)).
- **No job-level hub** — there is no `app/operator/[companyId]/jobs/[jobId]/page.tsx`;
  navigation drops the operator onto a single **part**. Multi-part jobs have no
  "see/switch parts" surface ([§8](#8-multi-part-job-navigation-proposed)).
- **Paperless isn't the default** — the only QR in the building is the printed traveler, and
  nothing steers a shop toward the queue path ([§6](#6-making-paperless-the-preferred-model)).
- **No scrap/defect/quality capture** ([§5.4](#54-scrap--defect--quality-flagging-discovery)).

---

## 4. Target operator journeys

The spine is the MES-standard **dispatch-list pull model** (operator stands at a station,
sees what's ready, pulls the next job). We already have it per-station; the journeys below
make it the *default* and fill the two gaps (whole-plant, multi-part).

### J1 — Station entry by tap-select (preferred, paperless)
1. Operator walks to e.g. *CNC Lathe #2* and opens the operator view on their phone — a
   bookmark, or **Shop floor view** from the dashboard jobs list.
2. If already authenticated → straight in (the session persists per device). If not → log in
   once with email/password.
3. They **tap *CNC Lathe #2* from the station list** (`StationSelector`). The choice is stored
   on the device, so on every later visit they land straight on the queue; the header dropdown
   switches stations any time.
4. Dispatch list shows everything ready at *CNC Lathe #2*, sorted by due date.
5. Tap a job/part → operation action → **Mark Complete** (+ optional note/photo) → back to the list.

*Status:* **built.** *Change needed:* make the queue the obvious home
([§6](#6-making-paperless-the-preferred-model)).

*Note:* an earlier revision of this doc split station entry into J1 (scan a posted station-QR
placard) and J2 (tap-select as the no-placard fallback). The placard was removed in July 2026
— it was never posted on a floor — so tap-select **is** the entry path, and the old J2 is
folded in here. J2 is retired; the numbering gap is deliberate so J3–J6 keep their names.

### J3 — Work the queue → action a step
From the dispatch list, tap a (job, part) row → land on the ready operation (or the part
traveler if no single ready step) → **Mark Complete** / **Undo**, add notes/photos, view
"last time we ran this." On complete, return to the queue.

*Status:* **built.** *Open:* confirm post-complete returns the operator to the *same lens*
they came from (station queue vs whole-plant — [§7](#7-whole-plant-view-proposed)).

### J4 — Whole-plant ("sign into the plant") — **proposed**
Operator (or roaming lead) chooses **"All stations"** instead of one station, and sees every
ready/in-progress job across the floor, grouped by station, sorted by due date. Used when
your station is idle, when you float between machines, or to answer "where is job #123?".
See [§7](#7-whole-plant-view-proposed) for the full spec and open questions.

*Status:* **not built** — decide from this journey.

### J5 — Multi-part job — **proposed**
A job with several parts currently scatters into separate dispatch rows (one per ready
(job, part)) and there's no way, once on one part, to see or jump to sibling parts. Spec a
lightweight **job → parts** overview. See [§8](#8-multi-part-job-navigation-proposed).

*Status:* **partial** (parts appear as separate queue rows; no hub).

### J6 — Printed traveler — **fallback only**
The per-operation traveler QR still deep-links to a step (scan-to-complete). It remains
available for shops mid-transition, intermittent connectivity, or operators who prefer paper —
but it is **no longer the primary path**. During rollout, run paper + digital in parallel,
then retire paper as the default once the queue path sticks.

---

## 5. Design decisions & principles

### 5.1 Authentication
**Decided:** email/password on operators' **personal phones**. PIN-pad / badge-tap /
passwordless (the shared-kiosk pattern) is **explicitly deferred** — it only pays off when a
single device is shared at a station, which isn't our model. *Consequence:* `prd.md` FR-5's
"enter PIN or scan personal QR badge" language is **stale** ([§9](#9-stale-doc-reconciliation)).

### 5.2 Status model (no operation-level WIP)
An **internal** operation is **pending → completed** (single tap; `completed_by`/`completed_at`
recorded). "In progress" is a **job/part** concept only, derived from partial completion and
surfaced as `production_status`. We do **not** need a separate operation-level "in progress"
state for in-shop work.

**Outside (external-vendor) steps are the one exception.** A step at a work center with
`kind='external'` (e.g. coating) is done off-site, so it uses a send/receive waypoint:
`pending → (Mark Sent Out) sent → (Mark Received) completed`. `sent` is optional (Mark Received
also completes from `pending`); received == completed. This exists precisely because the part
is invisible while it's out — the highest-value note in the system is "sent to coater 7/9,
expected back 7/16." An outside step can never be completed via the internal path and is never
auto-skipped. See [jobs.md](modules/jobs.md#outside-external-vendor-operations).

*Resolved:* `job_operations.status = 'in_progress'` stays a legal value (the enum is now
`pending | in_progress | completed | sent`); the complete-only flow never sets `in_progress`
itself, but `deriveStatusFromOps` still maps a mix that includes a `sent` op to part-level
`in_progress`.

### 5.3 Freshness: manual refresh
**Decided:** manual refresh via **browser reload / pull-to-refresh**; **no WebSockets / live
push** for now. (The in-app refresh button on the dispatch list was removed to declutter the
operator UI — reloading the page is equivalent and one less control to explain.) It's simpler and
probably sufficient. Revisit only if we validate a concrete need (e.g. two operators colliding on
the same step often enough to matter).

### 5.4 Scrap / defect / quality flagging — **discovery needed**
Nothing exists today, and we haven't designed it. This needs real discovery before building.
Framing the option space, pressure-tested against our complete-only, low-friction ethos:

**Option A — Lightweight "Flag issue" (recommended starting hypothesis).**
Reuse the existing notes + photo feed: add a **Flag issue** action on the operation page that
posts a `job_note` of a distinct *kind* (e.g. `quality_issue` / `scrap`), optionally with a
photo and an optional scrap quantity. Near-zero new model; surfaces in the job feed and can roll
up to office/QC. Keeps the operator's burden to one tap + optional detail.

**Option B — Scrap quantity at completion.**
When marking complete, optionally capture *good qty vs scrap qty*. Gives real scrap numbers for
costing/inventory, but adds a field to the single-tap action — tension with the complete-only
ethos. Make it optional and skippable.

**Option C — Defect reason codes.**
A configurable list of defect/disposition codes (rework / scrap / use-as-is). Heavier, MES-grade.
**Caution:** this is exactly the "named-pattern entity" shape we've been burned by — pressure-test
for anemic data and copy-from-X redundancy before committing. Likely premature.

**Open discovery questions (must answer before building):**
- Do we need scrap *quantity* (for costing/inventory) or just a *flag* (for visibility)? 
- Does scrapping a unit affect inventory (consume material? scrap doesn't return stock)?
- Who reviews flagged issues, and where (office job view? a QC queue)? Note `prd.md` FR-19 +
  Flow 2 describe a Pass/Fail QC workflow that **was never built** — decide whether to revive,
  reshape, or drop it as part of this.
- Does a flag block downstream steps, or is it informational?
- How does this relate to the existing inventory over-consumption "discrepancy" flag?

---

## 6. Making paperless the preferred model

The capability is there but **was never made the default** — the only QR on the floor is the
printed traveler, and nothing steers a shop to the queue. These changes make the queue path
*win* over paper.

> **Amended (2026-07-29).** The original keystone here was *"bulk placard deployment"* — add a
> print-all action so a shop could post the whole floor in one pass. That action was built,
> and placards still never went up. The placard feature has since been removed, so the
> keystone is now **getting operators onto the queue by default**, below. The lesson kept:
> the bottleneck was adoption, not the absence of a print button.

- **Dispatch list = the operator home (the keystone).** After login, land the operator on *the
  queue* — their last station (persisted in `localStorage`, so a returning operator skips the
  picker entirely) or, first time only, the station picker — never a dead end. Make "change
  station" obvious in the header.
- **Demote the printed traveler.** Reframe the traveler QR as an explicit *fallback* (J6), not
  the default. Consider a setting/onboarding step: "We've gone paperless — operators pick their
  station in the app" vs "keep printing travelers."
- **Onboarding nudge.** A short shop-setup checklist: (1) create work centers, (2) invite
  operators, (3) each operator signs in once on their phone and picks their station (it sticks
  per device). Surfaces the path that already exists.
- **Parallel run, then retire paper.** Per the transition research, run paper + digital together
  for a few weeks; once the queue path sticks, stop printing travelers by default.

---

## 7. Whole-plant view ("All Stations") — shipped

**Why:** the one clear missing capability and your explicit "sign into the plant" ask. Serves the
roaming operator (station idle → find work elsewhere), the working lead (floor-wide status), and
the "where is job #123?" lookup — without walking the floor (the Andon/visibility pattern).

**Shipped shape:**
- A lens toggle on the operator jobs page: **My Station** (default) ↔ **All Stations**
  (`app/operator/[companyId]/jobs/page.tsx`). The toggle is **hidden on the station-picker
  screen** — it only appears once a station is selected and there's a list to scope.
- "All Stations" lists every ready/in-progress (job, part, operation) across the company,
  **grouped by station**, reusing the dispatch row card.
- Implementation: rather than a filter-less variant RPC, `getAllStationsOperatorJobs`
  (`utils/operatorAccess.ts`) fans out the **same** per-station `get_ready_operations_for_station`
  RPC once per station in parallel and tags each row with its station — one source of truth for
  "ready," no duplicated readiness logic.

**How the open questions resolved:**
- **Read-only or act?** Operators can act. Tapping a row at a *different* station routes through
  the operation page's station-switch guard (`prd.md` §4.3), so the station-guard intent holds.
- **Default lens:** always My Station.
- **Complement or replace?** Complements — both lenses coexist; per-station stays the default.
- **Distinct from the office list?** Yes — it's the lighter operator dispatch card, not the
  `/dashboard` office jobs table.

---

## 8. Multi-part job navigation (proposed)

**Problem:** there is no `jobs/[jobId]` hub. Dispatch rows and traveler/operation links all land
on a **single part**. A job with multiple parts shows up as multiple separate queue rows, and once
an operator is on one part there's no way to see or move to sibling parts.

**Proposed:** a lightweight **job → parts overview** (`app/operator/[companyId]/jobs/[jobId]/page.tsx`)
showing the job header + each part with its progress (X/Y operations) and a tap-through to that
part's traveler. Reachable from the part traveler ("← all parts in this job") and as the landing
page when a job-level (rather than part-level) entry point is used.

**Open questions:**
- Is a parts hub needed for *operators*, or only when multiple parts are ready at the *same*
  station (in which case separate dispatch rows may already suffice)?
- Does scanning ever land at the *job* level, or always part/operation level? (Travelers are
  per-part, so today it's always part-level.)
- Sibling-part visibility: show all parts, or only parts with work ready at the current station?

---

## 9. Stale-doc reconciliation

`prd.md` §4.3 (complete-only) is **current and canonical** — keep it. The following are stale and
should be corrected (proposed, for approval):

| Location | Stale content | Correction |
|---|---|---|
| `prd.md` FR-5 (L124) | "operator enters their **PIN or scans their personal QR badge**" | Email/password on personal phones; no PIN/badge ([§5.1](#51-authentication)). |
| `prd.md` FR-6 (L125) | WO entry, start-time, time-tracking, permanent station | Already superseded by §4.3 — mark it explicitly stale or delete. |
| `prd.md` Flow 1 (L151) | "Operator scans **operation type QR**, enters job number"; step 6 blank | Dispatch list (or the traveler QR) → open the step → Mark Complete; remove "enter job number"; fill/remove the empty step. |
| `prd.md` Flow 4 (L199-211) | "**Operator Shift Start**", operation-type QR, PIN/badge, time tracking begins | Reframe as "Station sign-in" (J1); no shift, no PIN/badge, no timer. |
| `prd.md` FR-11 (L130) | templates with "series or **parallel** flows" | **Linear routings only** — no DAG/parallel. |
| `prd.md` FR-12 (L131) | time-per-station, time streaks | Already noted in §4.3 — gamification (if any) is on completion counts/on-time, not duration. |
| `prd.md` FR-19 + Flow 2 | Pass/Fail QC workflow + rework routing | **Not built.** Fold into the scrap/defect discovery ([§5.4](#54-scrap--defect--quality-flagging-discovery)) — revive, reshape, or drop. |
| `prd.md` L525-566 | Jan-2026 audit tail: "Routings Module ❌ — placeholder only", "Dashboard ❌", "Evaluated 2026-01-02" | **Outdated.** Routings (linear, inline on part page) and dashboard are built. Remove the stale audit block. |
| `docs/modules/operator-view.md` | `operation_type` stations, routing **DAG** + parallel branches, `operator_sessions` time-tracking, email-only login screens | Rewrite to: `work_centers`, **linear** routings, complete-only (no sessions), and the journeys in this doc. |
| Terminology (PRD-wide) | "**work order**" / "operation type" | App + domain language is "**job**" / "work center". Align the PRD. |

---

## 10. Open questions / next steps

1. **Approve the journeys** (J1, J3–J6 — J2 was folded into J1) and the paperless-preferred framing ([§6](#6-making-paperless-the-preferred-model)).
2. **Whole-plant view:** decide read-only vs actionable, and complement vs replace ([§7](#7-whole-plant-view-proposed)) → then build (additive RPC + lens toggle).
3. **Multi-part:** confirm operators actually need a parts hub vs separate queue rows ([§8](#8-multi-part-job-navigation-proposed)).
4. **Scrap/defect:** run discovery on the [§5.4](#54-scrap--defect--quality-flagging-discovery) questions before any build; decide the fate of FR-19/Flow 2.
5. **Doc hygiene:** on approval, apply the [§9](#9-stale-doc-reconciliation) corrections to `prd.md` and rewrite `operator-view.md`.
6. **Optional verification:** run the app and walk J1 (tap-select a station → dispatch → Mark Complete) to confirm the built path behaves as described before building on it.
