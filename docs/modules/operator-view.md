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
- `status`: **`pending` → `completed`** (single tap). `completed_at` / `completed_by` record who and when.
- `estimated_setup_minutes`, `estimated_run_minutes_per_unit` — estimates only, used for costing/quoting.
- **No actual-time columns and no `operator_sessions` table** — both were removed. There is no
  start/stop, no timer, no shift/clock-in. See [prd.md](../prd.md) §4.3 (Complete-Only).

**Job feed** — `job_notes` (+ `job_note_media`): one append-only stream per job; a note may be
tagged to a step via `job_operation_id`. Captured on the operation page (text + photo/video).

## Routing & readiness

- Routings are a **linear sequence** of operations — no DAG, no parallel branches.
- An operation is **ready** when all lower-`sequence` operations on the **same part** are
  completed. Out-of-order work is **warned, not blocked** (`predecessors_incomplete`).
- Completing the last incomplete operation on a part completes the part; the job's
  `production_status` is derived (`not_started` / `in_progress` / `completed`). There is no
  separate operation-level "in progress" concept beyond the operation row's status.

---

## Screens & routes

| Screen | Route | Purpose |
|---|---|---|
| Login | `/operator/{companyId}/login` | Email/password; captures `?station=`, `?job=&part=&operation=`, or `?location=` from a scanned QR and routes accordingly. |
| Station job list (dispatch) | `/operator/{companyId}/jobs` | Work ready/in-progress at the selected station — one row per (job, part), sorted by due date. An **All Stations** lens shows the whole plant grouped by station. |
| Job parts hub | `/operator/{companyId}/jobs/{jobId}` | For multi-part jobs, lists the job's parts with progress; single-part jobs redirect straight to the traveler. |
| Part traveler | `…/jobs/{jobId}/parts/{jobPartId}` | All steps for one part (read-only), with a back-link to the parts hub on multi-part jobs. |
| Operation action | `…/parts/{jobPartId}/operations/{jobOperationId}` | **Mark Complete** / **Undo**, notes + photos, "last time we ran this part" guidance, and a station-mismatch guard. |
| Inventory (optional) | `/operator/{companyId}/inventory[/locations/{id}]` | Feature-gated bin browse + add/remove/adjust stock. |
| Profile | `/operator/{companyId}/profile` | Name, email, current station, sign out. |

## QR codes

- **Station placard** (per work center): selects the station and opens its job list. Posted at
  the machine, printed once; bulk-print all from the work-centers list.
- **Per-operation traveler QR** (`utils/jobTravelerPdf.ts`): deep-links to a specific step's
  action view. An **optional accelerator** for shops mid-transition — not required under the
  paperless-preferred model.

## Admin

- **Operator creation** uses the backend (`POST /api/operators`) with the Supabase service-role
  key — the only operator operation that needs the backend. Everything else uses the Supabase
  client directly with RLS.
- Operator management lives under `/dashboard/{companyId}/team`.

---

## Out of scope (deliberate)

Single-tap completion keeps the operator's burden minimal. Intentionally **not** part of this
module: start/stop, time tracking, shift/clock-in, downtime reasons, operation-level WIP status,
and permanent operator↔station assignment. Scrap/defect capture is in discovery (see
[operator-paperless-flow.md](../operator-paperless-flow.md) §5.4).
