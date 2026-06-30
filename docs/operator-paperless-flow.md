# Operator Paperless Flow — Proposal & Journey Spec

> **Status:** Draft proposal · **Date:** 2026-06-29 · **Branch:** `feature/operator-paperless-proposal`
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
sign in → select a station (by scanning a posted station-QR placard *or* tapping it from
a list) → see the live list of jobs ready at that station → tap one → **Mark Complete**.
No printed traveler is required anywhere in that loop.

The problem is **not a missing capability — it's that the path was never deployed.**
The station-QR placards exist as a *feature*, but they have **not been posted on the floor**,
so the only QR codes in the building are the per-operation ones on printed travelers —
operators scan paper because it's the only QR there is. The work, therefore, is:

1. **Deploy the station-placard flow, then make paperless the default** — placards aren't
   posted yet, so step one is getting them onto the floor (bulk-print so it's one action);
   then land the operator on the queue and demote the printed traveler to an optional
   transition aid. ([§6](#6-making-paperless-the-preferred-model))
2. **Spec the journeys we haven't nailed** — the **whole-plant view** ([§7](#7-whole-plant-view-proposed))
   and **multi-part jobs** ([§8](#8-multi-part-job-navigation-proposed)) — so we can decide
   *from the journeys* whether/how to build them (rather than guessing).
3. **Run discovery on scrap / defect / quality flagging** ([§5.4](#54-scrap--defect--quality-flagging-discovery))
   — nothing exists today and it isn't yet thought through.

The one genuinely missing *capability* is the whole-plant ("sign into the plant") view;
everything else is deployment, adoption polish, and spec hygiene.

---

## 2. Goal & non-goals

### Goal
Make the **preferred, default operator workflow paperless**: an operator on their own
phone signs in, identifies their station (QR scan or tap-select), and pulls work from a
live, station-scoped queue — confirming each step with a single tap. Printed travelers
remain available as a *fallback* during transition, not as the primary mechanism.

### Explicit non-goals (deliberate, decided)
These are intentional simplicity choices. They are **not** gaps to "fix" — the operator
UX is deliberately minimal so a busy operator on the floor does as little as possible.

| Non-goal | Rationale |
|---|---|
| **No start / pause / resume** — only a single **Mark Complete** | Start/stop on the floor is unreliable; one finish trigger is all an operator must do. (See `prd.md` §4.3.) |
| **No per-operation time tracking** | Same; costing/quoting use *estimated* times only. `operator_sessions` and `job_operations.actual_*` were already removed. |
| **No operation-level WIP/"in progress" status** | An operation is **pending → completed**. "Work in progress" is meaningful only at the **job/part** level (derived from partial completion via `production_status`), not per operation. |
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
- **Station QR placards already exist:** each work center's detail page renders a
  downloadable A4 placard — `components/operations/StationQRCode.tsx`, used at
  `app/dashboard/[companyId]/work-centers/[workCenterId]/page.tsx`. The QR encodes
  `…/operator/{companyId}/login?station={workCenterId}`. Print once, post at the machine.
  **Not yet deployed:** the *generator* exists, but placards have **not been posted** on the
  floor — getting them up is the actual near-term unlock ([§6](#6-making-paperless-the-preferred-model)).
- **Manual selection** also works with no QR: `components/operator/StationSelector.tsx`
  lists work centers as tappable buttons; selection is kept in `sessionStorage`
  (`jigged_operator_station`) via `components/operator/OperatorStationContext.tsx`.

### The dispatch list (station-scoped job queue)
- `app/operator/[companyId]/jobs/page.tsx` shows one row per **(job, job_part)** with a
  *ready or in-progress* operation at the selected station, via RPC
  `get_ready_operations_for_station` (`utils/operatorAccess.ts` → `getOperatorJobs`).
- Readiness = all lower-`sequence` operations on the **same part** are complete; out-of-order
  work is warned, not blocked.
- A row links to `…/jobs/{job_id}/parts/{job_part_id}` and deep-links straight to the ready
  `…/operations/{operation_id}` when known (`jobs/page.tsx:87`).
- **Returns an empty list when no station is selected** (`getOperatorJobs` short-circuits) —
  i.e. there is **no "all stations / whole plant" mode** today.

### Action & capture
- Operation action page: **Mark Complete** + **Undo**, append-only **notes + photo/video**
  feed (`job_notes` / `job_note_media`), and "last time we ran this part" guidance.
  — `app/operator/[companyId]/jobs/[jobId]/parts/[jobPartId]/operations/[jobOperationId]/page.tsx`,
  `components/operator/JobFeed.tsx`, `components/operator/PreviousRunCard.tsx`.
- **Per-operation QR** on the printed traveler (`utils/jobTravelerPdf.ts`) deep-links to a
  step's action page — the current dominant habit.

### What's missing / weak (the real list)
- **No whole-plant view** ([§7](#7-whole-plant-view-proposed)).
- **No job-level hub** — there is no `app/operator/[companyId]/jobs/[jobId]/page.tsx`;
  navigation drops the operator onto a single **part**. Multi-part jobs have no
  "see/switch parts" surface ([§8](#8-multi-part-job-navigation-proposed)).
- **Paperless isn't deployed** — the station-placard *generator* exists but placards have
  **not been posted on the floor**, so the only QR in the building is the printed traveler;
  nothing steers a shop to deploy the placard flow ([§6](#6-making-paperless-the-preferred-model)).
- **No scrap/defect/quality capture** ([§5.4](#54-scrap--defect--quality-flagging-discovery)).

---

## 4. Target operator journeys

The spine is the MES-standard **dispatch-list pull model** (operator stands at a station,
sees what's ready, pulls the next job). We already have it per-station; the journeys below
make it the *default* and fill the two gaps (whole-plant, multi-part).

### J1 — Station entry by QR placard (preferred, paperless)
1. Operator walks to e.g. *CNC Lathe #2*, scans the **posted station placard** with their phone.
2. Lands on operator login with `?station={workCenterId}`. If already authenticated → station
   set, straight to the dispatch list. If not → log in once, then dispatch list.
3. Dispatch list shows everything ready at *CNC Lathe #2*, sorted by due date.
4. Tap a job/part → operation action → **Mark Complete** (+ optional note/photo) → back to the list.

*Status:* **built.** *Change needed:* make the placard easy to deploy and the queue the
obvious home ([§6](#6-making-paperless-the-preferred-model)).

### J2 — Station entry by tap-select (no placard / lost / new machine)
Same as J1, but the operator opens the app, logs in, and **taps their station from the
list** (`StationSelector`). Ensures the paperless path never *depends* on a placard being present.

*Status:* **built.**

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
An operation is **pending → completed** (single tap; `completed_by`/`completed_at` recorded).
"In progress" is a **job/part** concept only, derived from partial completion and surfaced as
`production_status`. We do **not** need a separate operation-level "in progress" state.
*Open item:* confirm whether `job_operations.status = 'in_progress'` is used anywhere
meaningfully or is vestigial under complete-only; if vestigial, simplify to pending/completed.

### 5.3 Freshness: manual refresh
**Decided:** manual refresh (the dispatch list already has a refresh control); **no
WebSockets / live push** for now. It's simpler and probably sufficient. Revisit only if we
validate a concrete need (e.g. two operators colliding on the same step often enough to matter).

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

The capability is there but **was never deployed** — placards aren't posted, so the only QR on
the floor is the printed traveler. Deployment is the single biggest lever; these changes get the
placard flow onto the floor and make the queue path *win* over paper.

- **Bulk placard deployment (the keystone).** Placards aren't posted today, and they're
  downloaded one-per-work-center from each detail page — tedious across a whole floor. Add a
  **"Print all station placards"** action (one PDF, one page per work center) so a shop can
  print, laminate, and post the entire floor in one pass. This is the most direct unlock.
- **Dispatch list = the operator home.** After login (without a deep-link), land the operator on
  *the queue* — either their last station (from `sessionStorage`) or a station picker — not a
  dead end. Make "change station" obvious in the header.
- **Demote the printed traveler.** Reframe per-operation traveler QR as an explicit *fallback*
  (J6), not the default. Consider a setting/onboarding step: "We've gone paperless — post these
  station placards" vs "keep printing travelers."
- **Onboarding nudge.** A short shop-setup checklist: (1) create work centers, (2) print &
  post station placards, (3) operators bookmark/scan once. Surfaces the path that already exists.
- **Parallel run, then retire paper.** Per the transition research, run paper + digital together
  for a few weeks; once the queue path sticks, stop printing travelers by default.

---

## 7. Whole-plant view (proposed)

**Why:** the one clear missing capability and your explicit "sign into the plant" ask. Serves the
roaming operator (station idle → find work elsewhere), the working lead (floor-wide status), and
the "where is job #123?" lookup — without walking the floor (the Andon/visibility pattern).

**Proposed shape:**
- A lens toggle on the operator jobs page: **My Station** (default) ↔ **All stations**.
- "All stations" lists every ready/in-progress (job, part, operation) across the company,
  **grouped by station**, sorted by due date (urgent first). Reuse the dispatch row UI.
- Implementation seam: a variant of `get_ready_operations_for_station` that omits the
  `work_center_id` filter (or a sibling RPC) returning all ready operations company-wide; the
  jobs page already short-circuits to empty without a station, so this is an additive mode.

**Open questions (answer from the journey before building):**
- Is it **read-only visibility**, or can an operator **act** (Mark Complete) directly from it?
  (Acting from it weakens the station-guard intent — `prd.md` §4.3 — so maybe tapping a row at a
  *different* station still routes through the station-switch guard.)
- Default lens: always My Station, or remember the operator's last choice?
- Does it **complement** station mode (recommended) or could it **replace** per-station entirely?
- Owner/office already have job lists in `/dashboard` — is the operator whole-plant view distinct
  from (lighter than) the office jobs list, or should it reuse it?

**Recommendation:** complement, don't replace. Default to My Station; offer All-stations as a
toggle aimed at "find work / floor visibility," routing any *action* through the existing
station-switch guard.

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
| `prd.md` Flow 1 (L151) | "Operator scans **operation type QR**, enters job number"; step 6 blank | Work-center QR + dispatch-list/scan-to-complete; remove "enter job number"; fill/remove the empty step. |
| `prd.md` Flow 4 (L199-211) | "**Operator Shift Start**", operation-type QR, PIN/badge, time tracking begins | Reframe as "Station sign-in" (J1/J2); no shift, no PIN/badge, no timer. |
| `prd.md` FR-11 (L130) | templates with "series or **parallel** flows" | **Linear routings only** — no DAG/parallel. |
| `prd.md` FR-12 (L131) | time-per-station, time streaks | Already noted in §4.3 — gamification (if any) is on completion counts/on-time, not duration. |
| `prd.md` FR-19 + Flow 2 | Pass/Fail QC workflow + rework routing | **Not built.** Fold into the scrap/defect discovery ([§5.4](#54-scrap--defect--quality-flagging-discovery)) — revive, reshape, or drop. |
| `prd.md` L525-566 | Jan-2026 audit tail: "Routings Module ❌ — placeholder only", "Dashboard ❌", "Evaluated 2026-01-02" | **Outdated.** Routings (linear, inline on part page) and dashboard are built. Remove the stale audit block. |
| `docs/modules/operator-view.md` | `operation_type` stations, routing **DAG** + parallel branches, `operator_sessions` time-tracking, email-only login screens | Rewrite to: `work_centers`, **linear** routings, complete-only (no sessions), and the journeys in this doc. |
| Terminology (PRD-wide) | "**work order**" / "operation type" | App + domain language is "**job**" / "work center". Align the PRD. |

---

## 10. Open questions / next steps

1. **Approve the journeys** (J1–J6) and the paperless-preferred framing ([§6](#6-making-paperless-the-preferred-model)).
2. **Whole-plant view:** decide read-only vs actionable, and complement vs replace ([§7](#7-whole-plant-view-proposed)) → then build (additive RPC + lens toggle).
3. **Multi-part:** confirm operators actually need a parts hub vs separate queue rows ([§8](#8-multi-part-job-navigation-proposed)).
4. **Scrap/defect:** run discovery on the [§5.4](#54-scrap--defect--quality-flagging-discovery) questions before any build; decide the fate of FR-19/Flow 2.
5. **Doc hygiene:** on approval, apply the [§9](#9-stale-doc-reconciliation) corrections to `prd.md` and rewrite `operator-view.md`.
6. **Optional verification:** run the app and walk J1 (station-scan → dispatch → Mark Complete) to confirm the built path behaves as described before building on it.
