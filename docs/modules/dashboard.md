# Dashboard Module

## Overview

The Dashboard is the home screen after login - a high-level overview of the shop's current state. It shows key metrics, highlights urgent items, and surfaces recent activity. It is a read/overview surface: there are **no quick-create actions** on the dashboard (no "New Quote" or "New Job" CTA). Quotes are created from the Quotes list; jobs are created only by converting an accepted quote (see [Quotes](quotes.md) → "Convert to Job"). The only create affordance the dashboard offers is the onboarding card shown to an empty tenant, plus drill-down links from the metric tiles into the filtered lists.

**Priority:** Should Have (Build Last in Phase 0)

**Dependencies:** All other modules (displays data from quotes and jobs)

**Route:** `/dashboard/{companyId}`

---

## User Stories

| As a... | I want to... | So that... |
|---|---|---|
| Owner | See a summary of open quotes | I know how much potential work is in the pipeline |
| Owner | See a count of active jobs | I know how busy the shop is |
| Owner | See revenue for this week | I know how the business is performing |
| Owner | See recent activity | I know what's been happening |

---

## Metric Scorecards (pinned metrics)

The top of the dashboard is a configurable scorecard grid, not a fixed set of
cards. The user pins **up to 4** metrics (`PINNED_METRIC_SLOTS`) that render as
the primary tiles; the rest are reachable via a left/right pager. Pinned
selection and order live in `user_preferences.preferences.dashboard_pinned_metrics`
(JSONB) and are edited through `MetricPickerModal` (checkbox to pin/unpin,
up/down arrows to reorder). Implemented by `components/dashboard/PinnedMetrics.tsx`
+ `MetricScorecard.tsx`; values are fetched by `getPinnedMetricValues` in
`utils/dashboardAccess.ts`.

**Available metrics** (`AVAILABLE_METRICS`):

| Key | Label | Format | Query |
|---|---|---|---|
| `open_quotes` | Open Quotes | number | Count `quotes` where `status = 'active'` |
| `not_started_jobs` | Jobs Not Started | number | Count `jobs` where `production_status = 'not_started'` |
| `in_progress_jobs` | Jobs In Progress | number | Count `jobs` where `production_status = 'in_progress'` |
| `revenue` | Revenue | currency | Sum of related `quote_line_items.total_price` for `jobs` where `fulfillment_status = 'fully_shipped'`, bucketed by `updated_at` within the selected period |
| `completed_jobs` | Completed Jobs | number | Count `jobs` where `fulfillment_status = 'fully_shipped'` within the selected period |
| `overdue_jobs` | Overdue Jobs | number | Shared overdue predicate (`applyOverdueJobsFilter`, same as the jobs list) |

**Defaults** (`DEFAULT_PINNED_METRICS`, shown when no preference is stored):
`overdue_jobs`, `open_quotes`, `not_started_jobs`, `in_progress_jobs`. Overdue
Jobs is a normal pickable metric (a one-time migration folds it into
pre-existing dashboards, gated by `dashboard_overdue_selectable_migrated` so a
deliberate removal sticks).

**Time period toggle:** a global **Today / This Week** toggle sits below the
grid. Time-aware metrics (`revenue`, `completed_jobs` — `supportsTimePeriod`)
show a period suffix and a period-over-period delta ("vs last week" /
"vs yesterday"). The chosen period persists per metric in
`user_preferences.preferences.dashboard_metric_periods`.

**Display per tile:**

- Large formatted value (number, or currency e.g. "$12,450")
- Label + optional period suffix
- Delta chip vs the prior period (time-aware metrics only)
- Overdue Jobs renders with an `alert` (red-tinted) tone when its value > 0
- Click → drill-down to the filtered list (`drillDownHref`):
  - `open_quotes` → `/quotes?status=active`
  - `not_started_jobs` → `/jobs?status=not_started`
  - `in_progress_jobs` → `/jobs?status=in_progress`
  - `completed_jobs` → `/jobs?status=completed`
  - `overdue_jobs` → `/jobs?overdue=true`
  - `revenue` → `/jobs?status=shipped`

---

## Recent Activity Section

A compact, glanceable feed of the latest **business milestones**, built
UNION-on-read over the authoritative tables (no separate activity/audit table).
Implemented by `getDashboardActivity` (`utils/dashboardAccess.ts`) and rendered
by `components/dashboard/RecentActivity.tsx` (a collapsible accordion whose
open/closed state persists in `localStorage`).

**Query:** merge the sources below, ORDER BY timestamp DESC, default LIMIT 6.

**Dashboard card sources** (business milestones only):

- Quote created (`quotes.created_at`)
- Job created (`jobs.created_at`)
- Job completed (`jobs.completed_at`)
- Shipment (`shipments.created_at` → action "shipped")

Shipments come from the real `shipments` table (there is no `jobs.shipped_at`
column in the dual-status model). Floor chatter — notes, photos, and operation
completions — is deliberately **excluded** from the dashboard card and lives on
the dedicated `/activity` page instead.

**Display per row:**

- Icon (colored per activity type)

- Entity number (Q-0089 or J-0042)

- Action text ("created", "completed", "shipped")

- Relative timestamp ("2h ago", "yesterday") with an absolute-time tooltip

**"View all activity" link:** navigates to the full activity stream at
`/dashboard/{companyId}/activity` (`app/dashboard/[companyId]/activity/page.tsx`)
— `getActivityStream` there adds `notes` (as note/photo events) and
`job_operations` completions, with type-filter chips and `before`-cursor
pagination ("Load more").

**Empty State:** "No recent activity." on the dashboard card; "No activity yet."
on the `/activity` page.

---

## AI Insights

Below Recent Activity the dashboard renders the AI Insights area — an ask-bar
(`InsightsChat`) and a grid of saved charts (`InsightsSection`) — gated on the
per-company `ai_insights` feature flag (`page.tsx` shows it only when
`features.ai_insights` is set and the flag has finished loading). It is **not**
documented here to avoid duplication: see [AI Insights & Charts](ai-insights.md)
for the full spec (text-to-SQL flow, saved-insight persistence, prompts, and the
"AI only on explicit user action" contract). This module doc only records that
the dashboard hosts it, flag-gated.

---

## Quick Actions

**The dashboard has no quick-create actions.** There is no "New Quote" or
"New Job" button on this page — quotes are created from the Quotes list and jobs
are created only by converting an accepted quote (see [Quotes](quotes.md) →
"Convert to Job"). This is intentional: the dashboard is an overview surface, not
a creation entry point.

> **Note:** A `components/dashboard/QuickActions.tsx` component (a "New Quote"
> button linking to `/dashboard/{companyId}/quotes/new`) still exists in the tree
> and is re-exported from `components/dashboard/index.ts`, but the live
> `page.tsx` never mounts it — it is unmounted dead code and renders nothing. A
> separate "+ New Job" button pointing at `/dashboard/{companyId}/jobs/new` was
> removed earlier when jobs moved to quote-conversion-only; that route no longer
> exists.

---

## Responsive Behavior

**Desktop / Tablet (≥ 900px, MUI `md`):**

- 4 metric scorecards in a row (`repeat(4, 1fr)`)

- Single-column stack for the sections below (metrics → activity → insights)

**Mobile (< 900px):**

- 2 metric scorecards per row (`repeat(2, 1fr)`)

- Single column, stacked sections

---

## Data Refresh

**Current behavior (shipped):** the dashboard fetches all of its data **once on
mount** and does not refresh after that. Metrics load via `useLoad` in
`PinnedMetrics` (and `InsightsSection`); Recent Activity and the empty-state
check load via `useEffect` in `page.tsx`. There is no auto-poll, no live
subscription, no refresh button, and no pull-to-refresh — a user sees fresh data
only by re-navigating to the page.

**Canonical refresh model (Planned — see #550):** the intended shape is a
**manual refresh button** plus **fresh-on-mount** plus a visible
**"last updated HH:MM" timestamp**, so the numbers are user-driven and their age
is always legible. Deliberately excluded from the default: **no live
subscription** and **no default auto-poll** — KPI tiles must never poll on their
own.

- **Opt-in slow refresh (Planned — see #550):** a hands-free wall display may
  opt into a slow periodic refresh (5–15 minutes). This is opt-in only, never
  the default, and is intended purely for an unattended screen.
- **Real-time (SSE) — only for a time-critical board:** escalate to a real-time
  push (SSE) *only* for a genuinely time-critical surface such as machine
  status / alarms. KPI tiles never use SSE.

None of the above ships today; the section describes the target so the current
"fetch once on mount" behavior is not mistaken for the end state.

---

## Acceptance Criteria

Each bullet is a Given/When/Then scenario carrying a verification clause — a pointer to the test that proves it, a manual procedure, or an explicit automation-pending tag. Every editable entity has at least one edit -> save -> reload -> persists bullet. Doc-vs-code disagreements this audit surfaced are recorded in the divergence report on issue #340.

**Metric scorecards (values & drill-down)**

- [ ] **Given** a company with no stored pinned-metric preference, **when** the dashboard loads, **then** the four default tiles (Overdue Jobs, Open Quotes, Jobs Not Started, Jobs In Progress) render — *verified by `__tests__/utils/dashboardPinnedMetrics.test.ts > 'getPinnedMetricKeys — Overdue-selectable migration' > 'returns defaults (which include Overdue) when no prefs are stored'*.
- [ ] **Given** the Open Quotes metric, **when** its value is computed, **then** it counts quotes with `status = 'active'` for the company — *automation-pending (`getMetricValue` → `getCount('quotes', …, { status: ['active'] })`); no scorecard-value unit test yet*.
- [ ] **Given** the Jobs-Not-Started and Jobs-In-Progress metrics, **when** they are computed, **then** they count `jobs.production_status = 'not_started'` and `= 'in_progress'` respectively (never the removed `jobs.status`) — *automation-pending (`getMetricValueWithDelta`)*.
- [ ] **Given** the Revenue metric with This Week selected, **when** it is computed, **then** it sums related `quote_line_items.total_price` for jobs with `fulfillment_status = 'fully_shipped'` bucketed by `updated_at`, and returns a prior-period value for the delta — *automation-pending (`getRevenueInRange` / `getMetricValueWithDelta` `case 'revenue'`)*.
- [ ] **Given** the Overdue Jobs tile with a value > 0, **when** it renders, **then** it uses the alert (red) tone and its count matches the jobs-list overdue filter (shared `applyOverdueJobsFilter`) — *automation-pending (`getOverdueJobs`)*.
- [ ] **Given** any metric tile, **when** it is clicked, **then** it navigates to the matching filtered list (e.g. Open Quotes → `/quotes?status=active`, Jobs Not Started → `/jobs?status=not_started`, Overdue Jobs → `/jobs?overdue=true`), and that list honours the query param — *manual: click each tile; the jobs/quotes list pages read `useSearchParams` (`app/dashboard/[companyId]/jobs/page.tsx`, `.../quotes/page.tsx`)*.

**Edit pinned metrics (edit -> save -> reload -> persists)**

- [ ] **Given** the metric picker open, **when** the user pins/unpins and reorders metrics (up to 4) and saves, **then** the selection + order write to `user_preferences.preferences.dashboard_pinned_metrics` and survive a reload — *write path verified by `__tests__/utils/dashboardPinnedMetrics.test.ts > 'getPinnedMetricKeys — Overdue-selectable migration' > 'persists the folded list AND stamps the migration flag'` (which exercises the read/upsert round-trip via `setPinnedMetricKeys`); reload-persistence E2E automation-pending (#367)*.
- [ ] **Given** the picker already holds 4 metrics, **when** the user tries to add a fifth, **then** the unpicked rows are disabled and the selection stays capped at 4 — *automation-pending (`MetricPickerModal` `PINNED_METRIC_SLOTS` guard; `handleToggle`)*.
- [ ] **Given** a metric was added inside the picker but not saved, **when** the picker is reopened, **then** the selection re-seeds from the stored pins (no stale in-modal addition) — *verified by `__tests__/components/dashboard/MetricPickerModal.test.tsx > 'MetricPickerModal — reopen re-seeds selection from currentKeys' > 'drops an in-modal-added metric when reopened with the SAME currentKeys (no stale selection)'*.
- [ ] **Given** pre-existing prefs from before Overdue Jobs was a selectable metric, **when** they load once, **then** Overdue is folded into the front (capped at 4) and the migration flag is stamped so a later deliberate removal sticks — *verified by `__tests__/utils/dashboardPinnedMetrics.test.ts > 'getPinnedMetricKeys — Overdue-selectable migration' > 'folds Overdue into the front of a pre-existing list (flag absent)'` AND `'does NOT re-add Overdue once the migration flag is set (deliberate removal sticks)'`*.
- [ ] **Given** a stored legacy metric key (e.g. `weekly_revenue`), **when** the pinned keys load, **then** it is migrated to the current key (`revenue`) — *verified by `__tests__/utils/dashboardPinnedMetrics.test.ts > 'getPinnedMetricKeys — Overdue-selectable migration' > 'still migrates legacy keys while folding Overdue in'*.

**Edit time period (edit -> save -> reload -> persists)**

- [ ] **Given** the Today / This Week toggle, **when** the user switches period, **then** time-aware tiles re-fetch for that window and the choice writes to `user_preferences.preferences.dashboard_metric_periods` so it is restored on reload — *write path verified indirectly by the `user_preferences` upsert round-trip in `__tests__/utils/dashboardPinnedMetrics.test.ts`; period-specific persistence + reload E2E automation-pending (#367) (`setMetricTimePeriod` / `getMetricTimePeriods`)*.

**Recent Activity feed**

- [ ] **Given** the dashboard, **when** the Recent Activity card loads, **then** it shows only business milestones (jobs created/completed, quotes created, shipments) — never notes/photos/operations — newest first — *verified by `__tests__/utils/dashboardAccess.test.ts > 'getDashboardActivity' > 'returns only business milestones (no notes/photos/operations), newest first'*.
- [ ] **Given** a requested limit, **when** the dashboard activity is fetched, **then** it is capped to that many rows, still newest-first — *verified by `__tests__/utils/dashboardAccess.test.ts > 'getDashboardActivity' > 'caps the card to the requested limit'*.
- [ ] **Given** the full `/activity` page, **when** it loads, **then** it also surfaces floor activity and separates text notes from photo notes — *verified by `__tests__/utils/dashboardAccess.test.ts > 'getActivityStream' > 'includes floor activity and separates text notes from photo notes'*.
- [ ] **Given** the `/activity` stream with a limit, **when** multiple sources are merged, **then** results are newest-first and capped to the limit — *verified by `__tests__/utils/dashboardAccess.test.ts > 'getActivityStream' > 'merges multiple sources newest-first and caps to the limit'*.
- [ ] **Given** one activity source query errors, **when** the stream is assembled, **then** it degrades best-effort (returns the other sources / empty, never throws) — *verified by `__tests__/utils/dashboardAccess.test.ts > 'getActivityStream' > 'returns [] (best-effort) when a source query errors'*.
- [ ] **Given** the Recent Activity accordion, **when** the user expands/collapses it, **then** the open state persists across reload via `localStorage` — *automation-pending (`RecentActivity` `STORAGE_KEY = 'jigged-recent-activity-expanded'`)*.
- [ ] **Given** the Recent Activity card, **when** "View all activity" is clicked, **then** it navigates to `/dashboard/{companyId}/activity` — *manual: the link renders when `viewAllHref` is set (`app/dashboard/[companyId]/page.tsx`)*.

**Load, empty states & no-AI-on-mount**

- [ ] **Given** a logged-in user, **when** they land on `/dashboard/{companyId}`, **then** the dashboard renders as the home screen — *manual: post-login redirect resolves to the dashboard route*.
- [ ] **Given** a tenant whose four core metrics are all 0, **when** the dashboard loads, **then** the OnboardingCard shows (whole-dashboard empty state) and the Recent Activity card shows "No recent activity." — *automation-pending (`page.tsx` `isEmpty`; `RecentActivity` empty branch)*.
- [ ] **Given** the dashboard mounts, **when** its effects run, **then** only plain Supabase reads fire (metrics + activity) and no AI endpoint is called on mount — the AI Insights area is gated on the `ai_insights` feature flag and driven by explicit user action — *manual: per the "AI calls require an explicit user action" engineering principle; `page.tsx` fetches via `getMetricValue`/`getDashboardActivity` only*.
- [ ] **Given** the app, **when** a user looks for a manual "New Job" create route from the dashboard, **then** none exists (jobs are created via quote conversion) — *manual: no `/jobs/new` route under `app/dashboard/[companyId]/jobs/`*.

---

## Future Enhancements

- Wider time-period range for time-aware metrics (Month / Year / All Time — a **Today / This Week** toggle already ships; see Metric Scorecards)
- The canonical refresh model (manual refresh button + last-updated timestamp, optional opt-in slow refresh for a wall display, SSE only for a time-critical board) is tracked separately — see the **Data Refresh** section above and **#550**. The old "auto-refresh every 60s / pull-to-refresh on mobile" idea is superseded by that model and is not planned as written.

> **Note:** activity is served UNION-on-read over the source tables (jobs,
> quotes, shipments, job_notes, job_operations) — a deliberate design choice, not
> a pending "activity log table." See `getActivityStream` in
> `utils/dashboardAccess.ts`.
