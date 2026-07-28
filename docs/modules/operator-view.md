# Operator View Module

## Overview

The Operator View is a mobile-first interface for shop-floor operators, used on their own
phones. Operators sign in, select the station they're working at (by scanning a posted
station-QR placard or tapping it from a list), see the work ready at that station, open a
step, and record progress with a single **Mark Complete**.

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
- The operator selects a station **per session** — there is **no permanent operator↔station
  assignment**. Selection persists in `sessionStorage` (`jigged_operator_station`) and can be
  changed any time (scan a different placard, or pick from the header).
- **Station QR placards** are generated per work center (`components/operations/StationQRCode.tsx`)
  and bulk-printable from the work-centers list. The QR encodes
  `…/operator/{companyId}/login?station={workCenterId}`.

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

**Job feed** — `notes` (+ `note_media`): one append-only stream per job; a note may be
tagged to a step via `job_operation_id`. Captured on the operation page (text + photo/video).

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
| Login | `/operator/{companyId}/login` | Email/password; captures `?station=`, `?job=&part=&operation=`, or `?location=` from a scanned QR and routes accordingly. |
| Station job list (dispatch) | `/operator/{companyId}/jobs` | Work ready/in-progress at the selected station — one row per (job, part), sorted by due date. An **All Stations** lens shows the whole plant grouped by station. |
| Job parts hub | `/operator/{companyId}/jobs/{jobId}` | For multi-part jobs, lists the job's parts with progress; single-part jobs redirect straight to the traveler. |
| Part traveler | `…/jobs/{jobId}/parts/{jobPartId}` | All steps for one part (read-only), with a back-link to the parts hub on multi-part jobs. |
| Operation action | `…/parts/{jobPartId}/operations/{jobOperationId}` | Internal step: **Mark Complete** / **Undo**. Outside step: an "Outside process" banner (+ vendor) and **Mark Sent Out** / **Mark Received** (station-mismatch guard suppressed — outside steps have no operator station). Both: notes + photos, "last time we ran this part" guidance. |
| Inventory (optional) | `/operator/{companyId}/inventory[/locations/{id}]` | Feature-gated bin browse + add/remove/adjust stock. |
| Profile | `/operator/{companyId}/profile` | Operator name, email, company name, **Logout**, and **Give Feedback**. (The current station lives in the header selector, not on this page.) |

## QR codes

- **Station placard** (per work center): selects the station and opens its job list. Posted at
  the machine, printed once; bulk-print all from the work-centers list.
- **Traveler QR** (`utils/jobTravelerPdf.ts`): **exactly one per traveler sheet**, in the header
  beside the Job #, captioned "Scan to open this traveler". It opens that part's traveler page,
  where the operator taps the step they're working. An **optional accelerator** for shops
  mid-transition — not required under the paperless-preferred model.
  *A previous revision printed a QR on every operation row; operators couldn't tell which code
  they were pointing their phone at, so the sheet is back to one unambiguous target. The
  `?job=&part=&operation=` deep link still resolves for sheets printed under that revision.*
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

- [ ] **Given** an operator scans a station placard, **when** they open `…/login?station={workCenterId}` and sign in with email/password, **then** the station is written to `sessionStorage` (`jigged_operator_station`) and they land on that station's job list — *write path verified by `__tests__/components/operations/StationQRCode.test.tsx > 'StationQRCode' > 'renders the QR code with the operator-login URL'`; login/session-persist E2E automation-pending (`OperatorLoginPage`)*.
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

- [ ] **Given** the operation page, **when** the operator adds a note (optionally media-only) with a step tag, **then** it inserts into `notes` with the trimmed body, `job_part_id`, and `job_operation_id`, then reloads into the feed with a readable "Op N · Name" label — *edit->save->reload verified by `__tests__/utils/operatorAccess.test.ts > 'addJobNote' > 'inserts the step tag + trimmed body and returns the mapped note'` AND `__tests__/utils/operatorAccess.test.ts > 'getJobNotes' > 'maps author, step-tag label, and media; rolls up the whole job by job_id'`*.
- [ ] **Given** a blank-text note, **when** it is saved, **then** `body` is stored as null so a media-only note is valid — *verified by `__tests__/utils/operatorAccess.test.ts > 'addJobNote' > 'stores a null body for a media-only (blank text) note'`*.
- [ ] **Given** the job feed, **when** it loads, **then** both job-level and operation-scoped notes roll up together (newest first) because operation notes still carry `job_id` — *verified by `__tests__/utils/operatorAccess.test.ts > 'getJobNotes' > 'maps author, step-tag label, and media; rolls up the whole job by job_id'`*.

**"Last time we ran this part" guidance**

- [ ] **Given** a part with a prior completed run, **when** the traveler/operation page loads guidance, **then** it shows the newest completed prior run (excluding the current job) with that run's notes — *verified by `__tests__/utils/operatorPreviousRun.test.ts > 'getPreviousRunForPart' > 'returns the newest completed prior run, excluding the current job'`*.
- [ ] **Given** a specific operation, **when** guidance is scoped to that step, **then** the prior run's notes are filtered to the same step across runs (by `routing_operation_id`, falling back to `operation_name`) — *verified by `__tests__/utils/operatorPreviousRun.test.ts > 'getPreviousRunForPart' > 'filters notes to the same step across runs via routing_operation_id'`*.

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
