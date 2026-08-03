# Dashboard Module

> **Condensed 2026-08-03** for [#634](https://github.com/debola31/Jigged/issues/634): **2,460 → ~940 words.**
> Cut: the acceptance-criteria block (45% of the doc — bullets that restated their own citation); the
> ~150-word "Quick Actions" section, which said only what the Overview already says; the User Stories table,
> which restated the metric list. **Data Refresh** and **Future Enhancements** described the *same* deferred
> decision three times — now stated once.
> **Kept:** the deliberate exclusions (no quick-create, no floor chatter on the card, no auto-poll, no SSE for
> KPIs), the QuickActions dead-code note, the UNION-on-read design note.
>
> **Corrections.** *(1) The `/activity` page's source list omitted **inventory** — `collectActivity` fetches
> `inventory_transactions` under `ActivityType='inventory'` and has done since the locations work. Added.
> (2) The refresh model was tagged "Planned — see #550"; **#550 is CLOSED** (the #332 audit's finished
> checklist), so it is now an untracked intention.)*

## Overview

The read/overview home screen after login, at `/dashboard/{companyId}`. **There are no quick-create actions**
— no "New Quote", no "New Job". Quotes are created from the Quotes list; jobs only by converting an accepted
quote ([Quotes](quotes.md) → "Convert to Job"), and `/jobs/new` does not exist. The only create affordance is
the onboarding card shown to an empty tenant; otherwise the tiles' drill-downs are the way out.

*(Dead code: `components/dashboard/QuickActions.tsx` — a "New Quote" button — and `SummaryCard.tsx` are both
re-exported from `components/dashboard/index.ts`, but `page.tsx` mounts neither.)*

**Priority:** Should Have · **Dependencies:** quotes, jobs, shipments, inventory.

---

## Metric scorecards (pinned metrics)

A configurable grid, not a fixed set. The user pins up to `PINNED_METRIC_SLOTS` (= 4) metrics as primary
tiles; the rest page in via a left/right pager. Selection and order live in
`user_preferences.preferences.dashboard_pinned_metrics` (JSONB), edited through `MetricPickerModal`. See
[`PinnedMetrics.tsx`](../../components/dashboard/PinnedMetrics.tsx), `MetricScorecard.tsx`, and
`getPinnedMetricValues` in [`utils/dashboardAccess.ts`](../../utils/dashboardAccess.ts).

`AVAILABLE_METRICS`, with each tile's drill-down (`drillDownHref` in `PinnedMetrics.tsx`). Every href below is
prefixed `/dashboard/{companyId}` — *(⚠ this doc previously listed them without that prefix, as bare
`/quotes?…`; those paths do not exist.)*

| Key | Label | Value | Drill-down |
|---|---|---|---|
| `open_quotes` | Open Quotes | count `quotes.status = 'active'` | `/quotes?status=active` |
| `not_started_jobs` | Jobs Not Started | count `jobs.production_status = 'not_started'` | `/jobs?status=not_started` |
| `in_progress_jobs` | Jobs In Progress | count `jobs.production_status = 'in_progress'` | `/jobs?status=in_progress` |
| `revenue` | Revenue (currency) | sum of related `quote_line_items.total_price` for jobs `fulfillment_status = 'fully_shipped'`, bucketed by `updated_at` in the period | `/jobs?status=shipped` |
| `completed_jobs` | Completed Jobs | count `jobs.fulfillment_status = 'fully_shipped'` in the period | `/jobs?status=completed` |
| `overdue_jobs` | Overdue Jobs | the shared `applyOverdueJobsFilter` predicate — same one the jobs list uses | `/jobs?overdue=true` |

Never `jobs.status`; that column was removed (the May 2026 prod regression).

**Defaults** (`DEFAULT_PINNED_METRICS`, when nothing is stored): Overdue Jobs, Open Quotes, Jobs Not Started,
Jobs In Progress. Overdue is a normal pickable metric; a one-time migration folds it into pre-existing
dashboards, gated by `dashboard_overdue_selectable_migrated` **so a deliberate removal sticks**.

**Time period.** A global Today / This Week toggle below the grid (weeks run Sunday 00:00 local → next
Sunday). Only `revenue` and `completed_jobs` carry `supportsTimePeriod`; those show a period suffix and a
period-over-period delta chip ("vs last week" / "vs yesterday"). The choice persists per metric in
`user_preferences.preferences.dashboard_metric_periods`. Stateful counts get no delta — that would need
historical snapshots. Overdue Jobs renders in an `alert` (red) tone when > 0.

**Stored keys migrated or dropped on read** (`getPinnedMetricKeys`, persisted when it changes):
`weekly_revenue` / `monthly_revenue` → `revenue`; `active_jobs` → `not_started_jobs` (the old union metric was
split in two — keep one tile in roughly the same slot); `REMOVED_KEYS` = `at_risk_count`,
`low_inventory_count`, `total_customers`, `total_parts` dropped outright. **Those four are retired — the
at-risk / alert-bell surface is gone and must not be re-promised.**

**Withdrawn:** bucket revenue by `jobs.shipped_at`, or select `job_last_ship_date` as a computed column —
wrong because `shipped_at` does not exist in the dual-status model and `job_last_ship_date` is a `(uuid)`
function, not a jobs-row column, so PostgREST answered 400. `updated_at` is the in-range proxy instead.

**Deliberate approximation:** "completed" is counted from the fulfillment half (`fully_shipped`) of the FR-18
done predicate, not both — a fully-shipped job is by definition done, so that clause is the tighter one.

**Two gaps, verified in the code, fixed nowhere:** `getCount` — backing `open_quotes`, `not_started_jobs`,
`in_progress_jobs` — does **not** filter `deleted_at IS NULL`, so those three tiles count archived rows, while
`getOverdueJobs` / `getRevenueInRange` / `getCompletedJobsInRange` all do; this contradicts the soft-delete
standard in CLAUDE.md. And `getPinnedMetricValues` catches a per-metric failure as `{ value: 0 }`, so a failed
read is indistinguishable from a real zero.

---

## Recent Activity

A glanceable feed built **UNION-on-read over the authoritative tables** — deliberate, not a pending "activity
log table": per-tenant volume is tiny and the timestamps already live on the source rows, so a second source
of truth would only invite drift. `getDashboardActivity` / `getActivityStream` in `utils/dashboardAccess.ts`;
card rendered by `components/dashboard/RecentActivity.tsx`, a collapsible accordion whose state persists in
`localStorage` (`jigged-recent-activity-expanded`).

| Surface | Sources | Limit (per source before the merge) |
|---|---|---|
| Dashboard card | Quote created, job created, job completed, shipment (`shipments.created_at` → "shipped") | 6 (`max(limit × 3, 12)`) |
| `/dashboard/{companyId}/activity` | the above **plus** notes (split into note vs photo events), `job_operations` — both plain completions and vendor-tagged `sent`/`received` for outside operations — and **`inventory_transactions`** (`stock_in` / `stock_out` / `moved` / `counted`, carrying location + quantity, transfers folded to one row by `foldTransfers`, and excluded unless the type is explicitly requested). Type-filter chips + `before`-cursor "Load more" | 30 (`ACTIVITY_PER_SOURCE = 50`) |

Shipments come from the real `shipments` table — there is no `jobs.shipped_at` in the dual-status model.
**Floor chatter is deliberately excluded from the card** and lives only on the `/activity` page. Each row:
type-coloured icon, entity number (Q-0089 / J-0042), action text, relative timestamp with an absolute-time
tooltip. Empty: "No recent activity." on the card, "No activity yet." on the page.

---

## AI Insights

Below Recent Activity: ask-bar (`InsightsChat`) + saved charts (`InsightsSection`), gated on the `ai_insights`
flag, which is **opt-out** (on unless a system admin turns it off for the tenant) and stays hidden while the
flag loads so it never flashes in then out. Full spec — text-to-SQL flow, persistence, prompts, and the "AI
only on explicit user action" contract — is in [AI Insights & Charts](ai-insights.md).

---

## Responsive

≥ 900px (MUI `md`): 4 scorecards per row (`repeat(4, 1fr)`); < 900px: 2 (`repeat(2, 1fr)`). Sections stack
single-column at every width.

---

## Data refresh

**As built:** everything is fetched **once on mount** and never again — metrics via `useLoad` in
`PinnedMetrics` (and `InsightsSection`), Recent Activity and the empty-state check via `useEffect` in
`page.tsx`. No auto-poll, no live subscription, no refresh button, no pull-to-refresh; fresh data requires
re-navigating.

**Intended, not built** *(untracked — was "see #550", now closed)*: manual refresh button + fresh-on-mount + a
visible "last updated HH:MM", so numbers are user-driven and their age is legible. Deliberately excluded from
the default: **no live subscription, no default auto-poll — KPI tiles must never poll on their own.** A
hands-free wall display may *opt in* to a slow 5–15 minute refresh. SSE is reserved for a genuinely
time-critical surface such as machine status or alarms; KPI tiles never use it.

**Withdrawn:** "auto-refresh every 60s + pull-to-refresh on mobile" — superseded by the model above, not
planned as written.

Also wanted: a wider period range for time-aware metrics (Month / Year / All Time).

---

## Verified behaviour

As-built, verified 2026-08-03.

| Behaviour | Enforced by |
|---|---|
| Defaults when nothing is stored; the Overdue fold-in migration, capped at the slot count (and that a deliberate removal sticks); legacy key migration (`weekly_revenue` → `revenue`); the pins/periods upsert round-trip | `__tests__/utils/dashboardPinnedMetrics.test.ts` — `describe('getPinnedMetricKeys — Overdue-selectable migration')`, 7 its |
| Reopening the picker re-seeds from the stored pins, dropping an unsaved in-modal addition | `__tests__/components/dashboard/MetricPickerModal.test.tsx` — `describe('MetricPickerModal — reopen re-seeds selection from currentKeys')`, 1 it |
| The overdue count uses one canonical clause set on the same builder as the jobs list, so tile and list agree | `__tests__/utils/jobsAccess.test.ts` — `describe('applyOverdueJobsFilter')`, 1 it |
| The card returns only business milestones — never notes/photos/operations — newest-first, capped to the requested limit | `__tests__/utils/dashboardAccess.test.ts` — `describe('getDashboardActivity')`, 2 its |
| `/activity` adds floor activity, separates text notes from photo notes, tags outside-op sent/received by vendor, merges sources newest-first, and **degrades best-effort when one source query errors** (returns the others, never throws) | same file — `describe('getActivityStream')`, 5 its |
| Inventory events say what moved, how much and where; a transfer folds to the leg saying where stock ended up; a lone depletion leg survives; an adjustment reads as a count; the type is left out unless asked for | same file — `describe('inventory activity')`, 5 its |

**Gaps, automation-pending ([#367](https://github.com/debola31/Jigged/issues/367)):** every scorecard *value*
(`getMetricValue`, `getMetricValueWithDelta`, `getRevenueInRange`, `getOverdueJobs`) — there is no
scorecard-value unit test; the 4-slot cap in `MetricPickerModal`; period persistence across reload; the
accordion's `localStorage` round-trip; tile → filtered-list navigation; the empty-tenant OnboardingCard
branch.
