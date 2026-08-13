# Dashboard Module

## Overview

The read/overview home screen after login, at `/dashboard/{companyId}`. It answers one question — *how is the
shop doing* — and hands off everywhere else.

**There are no quick-create actions** — no "New Quote", no "New Job". Quotes are created from the Quotes list;
jobs only by converting an accepted quote ([Quotes](quotes.md) → "Convert to Job"), and `/jobs/new` does not
exist. The only create affordance is the onboarding card shown to an empty tenant; otherwise the scorecards'
drill-downs are the way out.

**Priority:** Should Have · **Dependencies:** quotes, jobs, shipments, inventory.

---

## Metric scorecards

Four fixed cards, one row, no picker and no pager. They read left to right as an alert followed by the flow of
work — what is late, what is on the floor, what went out, what might come in.

See [`DashboardMetrics.tsx`](../../components/dashboard/DashboardMetrics.tsx), `MetricScorecard.tsx`, and
`getDashboardMetrics` in [`utils/dashboardAccess.ts`](../../utils/dashboardAccess.ts). Every drill-down href
is prefixed `/dashboard/{companyId}`.

| Key | Label | Count | Money | Drill-down |
|---|---|---|---|---|
| `overdue_jobs` | Overdue Jobs | the shared `applyOverdueJobsFilter` predicate — the same one the jobs list uses | "not yet shipped" | `/jobs?overdue=true` |
| `open_jobs` | Open Jobs | `production_status IN ('not_started','in_progress')` AND not `fully_shipped` | ordered **minus already shipped** — "not yet shipped" | `/jobs?status=not_started` |
| `completed_jobs` | Completed Jobs | distinct jobs **shipped from** in the period | value shipped in the period — "shipped this week" / "shipped today", with a period-over-period delta | `/jobs?status=completed` |
| `open_quotes` | Open Quotes | `quotes.status = 'active'` | none — see below | `/quotes?status=active` |

Never `jobs.status`; that column was removed (the May 2026 prod regression).

### The count is primary; the money is the second line

A shop owner acts on jobs, not on dollars, so the count stays the big number and the money sits under it. It
also keeps `0` as the all-clear on Overdue, which is a stronger signal than `$0`. Overdue renders in an
`alert` (red) tone when > 0.

### Two kinds of money, and what the labels are for

The money on these cards is not one pot. **Overdue and Open Jobs are committed work not yet earned; Completed
is revenue already earned.** A bare dollar figure on each would flatten that distinction, and the first thing
anyone does with several dollar figures on one screen is add them up.

The label says which KIND of money it is; the card title already says which slice of work it belongs to. So
the row reads as one axis — *not yet shipped* → *shipped this week* — and **Overdue and Open Jobs deliberately
share a label**, because overdue money is a slice of open-jobs money rather than a separate pot and a distinct
word would imply otherwise. Both phrases are the product's existing fulfilment vocabulary, not terms coined
for this card. Words rather than a colour code, so the distinction survives bright shop lighting and colour
blindness.

**Overdue's money is a slice of Open Jobs', not a fifth pot.** `applyOverdueJobsFilter` restricts to
`production_status IN ('not_started','in_progress')`, so every overdue job is also counted in Open Jobs.
Nothing on this row is safe to add together except the two halves of the Open Jobs split, which are disjoint
by construction.

### Open Quotes carries no money, deliberately

A quote may hold several priced options for the same part so the customer can choose one. Summing its lines
adds up alternatives that were never all going to happen — on the pilot shop's live data that overstates the
open book by about 8%. The point is not that the figure is approximate but that it is **undefined**: nobody has
chosen yet. `MetricValue.money` is `null` here, not `0`, because `0` would render as a claim.

### Revenue comes from the job, never from the quote

Money on a job is the sum of its own `job_parts.total_price` (falling back to `unit_price × quantity`). The job
part is the post-conversion source of truth, so this follows a quantity edited after conversion, counts a job
created without a quote at all, and does not over-count a price-options quote's unchosen lines.
`insights_service._job_part_revenue` is the same rule on the backend and the two must not drift; the rule
itself is stated once in [AI Insights](ai-insights.md).

### The Open Jobs split

The merged tile shows `51 Not Started · 12 In Progress` beneath the money. The total answers *how much work is
on the books*; the split answers *is it flowing or piling up*, which a single number would hide. The split is
visible to everyone — it carries no money.

The two state names come from `PRODUCTION_STATUS_CONFIG` rather than being spelled out in the card, so they
are the same words the jobs list and its status chips use. A synonym invented for one card ("queued",
"running") makes a reader wonder whether it means something different.

### Money is admin-only

Only a company `admin` sees the money lines. A `user` — a salesperson — sees the counts and the split, and
still sees every price on the quotes and jobs they work; what they do not get is the shop's whole book totalled
on the landing page.

**This is a display choice, not a security boundary.** RLS is company-scoped, not column-scoped, so the figures
remain readable through the API by anyone who can reach the company. Do not describe it to a customer as
"financials are admin-only".

### Time period

Only Completed is scoped to a period, so the Today / This Week toggle sits **on that card** rather than over
the row. "Today" is midnight to midnight and "This Week" opens on Sunday, both in the **browser's**
timezone — the device's clock, not a stored company setting, so a laptop carried across a timezone
shifts the window with it. The other three are a snapshot of right now — "12 jobs in progress this week" is not a thing, and a
control that three of four cards ignored would read as broken. Weeks run Sunday 00:00 local → next Sunday
00:00. The choice persists in `user_preferences.preferences.dashboard_completed_period`.

Completed carries a period-over-period delta on its **money**, which is the sentence an owner wants; a count
delta is the less interesting half. The other three cards get no delta — that would need historical snapshots.

### Revenue is what shipped, not what a job is worth

Money on the Completed card is **shipped quantity x the agreed unit price, dated by
`shipments.ship_date`** — summed over `shipment_line_items`, voided shipments excluded. The count
follows the money: distinct jobs *shipped from* in the window, not jobs that reached `fully_shipped`.
Both halves then describe the same act, so "6 · $12,480 shipped this week" is one statement.

This replaced a proxy that was wrong three ways. There is no ship date on a job — `jobs.shipped_at`
is not in the dual-status model, and `job_last_ship_date` is a `(uuid)` function rather than a column,
so PostgREST answers 400 if you select it — and the card used `jobs.updated_at` instead. That meant:

- **"Last written", not "shipped".** Editing a PO number on a job shipped in March pulled it into
  this week, and rows only ever drifted *into* the current window, never out.
- **A partial shipment earned nothing.** A job 60% shipped had 60% of its money in the customer's
  hands, contributed $0 here, and had its *full* value sitting in Open Jobs as backlog.
- **A job landed at its whole value** the moment it went `fully_shipped`, even if it shipped across
  two months.

Reading the shipment fixes all three at once, and removes a double count: Open Jobs now excludes
fully-shipped work and counts only what a job still **owes** (ordered minus shipped), so a
part-shipped job's delivered half is revenue exactly once. On the pilot shop that moved Open Jobs
from 65 jobs / $85,955 to 26 / $43,987 — the earlier figure counted $37,769 of already-delivered work
as backlog while the same money also counted as revenue.

**Both axes, or neither.** `production_status` and `fulfillment_status` are independent: a shop that
ships without operators closing out operations leaves jobs `not_started` **and** `fully_shipped` at
the same time, which is 39 jobs on the pilot shop. Filtering on production alone is what put
delivered work under the words "not yet shipped". `applyOverdueJobsFilter` always excluded
fully-shipped; the other tiles now agree with it.

`ship_date` is a **DATE**, so the window is a calendar comparison with nothing to smear — unlike the
old `updated_at` timestamp, where a Saturday-evening ship could land in Sunday because the office is
west of UTC.

**Known limit:** `job_parts.unit_price` is read live rather than snapshotted per shipment, so
repricing a line retrospectively moves historical revenue. In practice a part's price locks once any
quantity of it is invoiced ([jobs.md](jobs.md)), which covers the case that matters.

### Failure and archived rows

Every metric filters `deleted_at IS NULL`. Each of the five reads is allowed to fail on its own so one broken
metric cannot blank the row, but a failure leaves that metric **absent** rather than zero — "couldn't check"
must never render as a confident `0`.

---

## Recent Activity

A glanceable feed built **UNION-on-read over the authoritative tables** — deliberate, not a pending "activity
log table": per-tenant volume is tiny and the timestamps already live on the source rows, so a second source of
truth would only invite drift. `getDashboardActivity` / `getActivityStream` in `utils/dashboardAccess.ts`; card
rendered by `components/dashboard/RecentActivity.tsx`, a collapsible accordion whose state persists in
`localStorage` (`jigged-recent-activity-expanded`).

| Surface | Sources | Limit (per source before the merge) |
|---|---|---|
| Dashboard card | Quote created, job created, job completed, shipment (`shipments.created_at` → "shipped") | 6 (`max(limit × 3, 12)`) |
| `/dashboard/{companyId}/activity` | the above **plus** notes (split into note vs photo events), `job_operations` — both plain completions and vendor-tagged `sent`/`received` for outside operations — and **`inventory_transactions`** (`stock_in` / `stock_out` / `moved` / `counted`, carrying location + quantity, transfers folded to one row by `foldTransfers`, and excluded unless the type is explicitly requested). Type-filter chips + `before`-cursor "Load more" | 30 (`ACTIVITY_PER_SOURCE = 50`) |

Shipments come from the real `shipments` table — there is no `jobs.shipped_at` in the dual-status model.
**Floor chatter is deliberately excluded from the card** and lives only on the `/activity` page, reached by the
card's **"View all activity"** link (`viewAllHref`, set by `page.tsx`; the link renders only when it is). Each
row: type-coloured icon, entity number (Q-0089 / J-0042), action text, relative timestamp with an absolute-time
tooltip. Empty: "No recent activity." on the card, "No activity yet." on the page.

---

## AI Insights

Below Recent Activity: ask-bar (`InsightsChat`) + saved charts (`InsightsSection`), gated on the `ai_insights`
flag, which is **opt-out** (on unless a system admin turns it off for the tenant) and stays hidden while the
flag loads so it never flashes in then out. Full spec — text-to-SQL flow, persistence, prompts, and the "AI only
on explicit user action" contract — is in [AI Insights & Charts](ai-insights.md).

**Nothing on this page may call a paid AI provider on mount.** `page.tsx`'s effects fire plain Supabase reads
only (`isDashboardEmpty`, `getDashboardActivity`); the ask-bar is driven by a submit. This is stated here, not
just deferred, because **this is the page the rule was written from** — `AlertBadge` →
`/api/insights/{id}/dashboard` once fired five Anthropic calls per dashboard load, nobody ever read the output,
and it burned the credits in days (CLAUDE.md, "AI calls require an explicit user action"). A new tile is the
obvious way to reintroduce it.

---

## Responsive

≥ 900px (MUI `md`): 4 scorecards per row (`repeat(4, 1fr)`); < 900px: 2 (`repeat(2, 1fr)`). Sections stack
single-column at every width.

---

## Data refresh

**As built:** everything is fetched **once on mount** and never again — metrics via `useLoad` in
`DashboardMetrics` (and `InsightsSection`), Recent Activity and the empty-state check via `useEffect` in
`page.tsx`. Changing the Completed card's period refetches. Otherwise there is no auto-poll, no live
subscription, no refresh button and no pull-to-refresh; fresh data requires re-navigating.

**Intended, not built:** a manual refresh button plus a visible "last updated HH:MM", so numbers are
user-driven and their age is legible. Deliberately excluded from the default: **no live subscription, no
default auto-poll — KPI tiles must never poll on their own.** A hands-free wall display may *opt in* to a slow
5–15 minute refresh. SSE is reserved for a genuinely time-critical surface such as machine status or alarms;
KPI tiles never use it.

Also wanted: a wider period range for Completed (Month / Year / All Time).

---

## Verified behaviour

| Behaviour | Enforced by |
|---|---|
| Exactly four metrics in flow order; only Completed is period-scoped | `__tests__/utils/dashboardMetrics.test.ts` — 2 its |
| Revenue reads `job_parts` and never the quote; a shipped job with no quote still counts; `unit_price × quantity` fallback; the prior period is carried for the delta | same file — 4 its |
| Open Jobs merges the two states, keeps the Not Started / In Progress split, and its two halves sum to its total | same file — 1 it |
| Open Quotes has a count and a `null` money — absent, not zero | same file — 1 it |
| Overdue is built from the shared predicate rather than a local copy | same file — 1 it |
| Every metric filters `deleted_at`; a failed metric is absent rather than `0` | same file — 2 its |
| Four cards render with no picker and no pager; the period toggle appears once, on Completed | `__tests__/components/dashboard/DashboardMetrics.test.tsx` — 2 its |
| An admin sees the money, with Overdue and Open Jobs sharing one label; a non-admin sees no dollar figure anywhere, but still sees counts and the split named as the jobs list names it | same file — 3 its |
| Open Quotes shows no money even for an admin; changing the period refetches and persists | same file — 2 its |
| The overdue count uses one canonical clause set on the same builder as the jobs list, so tile and list agree | `__tests__/utils/jobsAccess.test.ts` — `describe('applyOverdueJobsFilter')`, 1 it |
| The card returns only business milestones — never notes/photos/operations — newest-first, capped to the requested limit | `__tests__/utils/dashboardAccess.test.ts` — `describe('getDashboardActivity')`, 2 its |
| `/activity` adds floor activity, separates text notes from photo notes, tags outside-op sent/received by vendor, merges sources newest-first, and **degrades best-effort when one source query errors** (returns the others, never throws) | same file — `describe('getActivityStream')`, 5 its |
| Inventory events say what moved, how much and where; a transfer folds to the leg saying where stock ended up; a lone depletion leg survives; an adjustment reads as a count; the type is left out unless asked for | same file — `describe('inventory activity')`, 5 its |

**Gaps, automation-pending ([#367](https://github.com/debola31/Jigged/issues/367)):** period persistence across
reload; the accordion's `localStorage` round-trip; tile → filtered-list navigation; the empty-tenant
OnboardingCard branch.
