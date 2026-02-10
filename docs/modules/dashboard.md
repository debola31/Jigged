# Dashboard Module

## Overview

The Dashboard is the home screen after login - a high-level overview of the shop's current state. It shows key metrics, highlights urgent items, and provides quick actions to create quotes and jobs.

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
| Owner | Quickly create a new quote | I can respond to customer inquiries fast |
| Owner | Quickly create a new job | I can get rush orders into production |
| Owner | See recent activity | I know what's been happening |

---

## Summary Cards

### Card 1: Open Quotes

**Query:** Count quotes where status IN ('draft', 'pending_approval')

**Display:**

- Large number

- Label: "Open Quotes"

- Click → Navigate to Quotes list (filtered to open)

**Color:** Default/neutral

### Card 2: Active Jobs

**Query:** Count jobs where status IN ('pending', 'in_progress')

**Display:**

- Large number

- Label: "Active Jobs"

- Click → Navigate to Jobs list (filtered to active)

**Color:** Default/neutral

### Card 3: Revenue (This Week)

**Query:** Sum of `quotes.total_price` from jobs where `status = 'shipped'` AND `shipped_at` >= start of current week (via quote relation)

**Display:**

- Currency formatted value (e.g., "$12,450")

- Label: "Revenue This Week"

- Click → Navigate to shipped jobs list (optional)

**Color:** Success/green

**Future Enhancement:** Allow user to toggle time period (Week/Month/All Time)

---

## Recent Activity Section

**Query:** Most recent activity inferred from timestamps

- Combine quotes and jobs by their timestamp fields
- ORDER BY timestamp DESC
- LIMIT 10

**Activity Types (inferrable from timestamps):**

- Quote created (`quotes.created_at`)
- Job created (`jobs.created_at`)
- Job started (`jobs.started_at`)
- Job completed (`jobs.completed_at`)
- Job shipped (`jobs.shipped_at`)

**Note:** Quote status changes (approved, rejected) cannot be inferred from timestamps alone. These will be added when an activity log table is implemented in a future phase.

**Display per row:**

- Icon (quote icon or job icon)

- Entity number (Q-0089 or J-0042)

- Action text ("created", "started", "completed", "shipped")

- Relative timestamp ("2h ago", "yesterday")

**"View All" link:** Future feature - Activity log page

**Empty State:** "No recent activity."

**Implementation Note for Phase 0:**

Activity is derived from `created_at`, `started_at`, `completed_at`, `shipped_at` timestamps rather than a separate activity log table. A proper activity/audit log table will be added in a later phase to capture all status changes including quote approvals/rejections and job operation changes.

---

## Quick Actions

### + New Quote Button

- Primary button style

- Click → Navigate to `/dashboard/{companyId}/quotes/new`

### + New Job Button

- Secondary button style

- Click → Navigate to `/dashboard/{companyId}/jobs/new`

---

## Responsive Behavior

**Desktop (> 1024px):**

- 3 summary cards in a row

- Two-column layout for sections below

**Tablet (768px - 1024px):**

- 3 summary cards in a row (smaller)

- Single column for sections

**Mobile (< 768px):**

- 1 summary card per row (stacked)

- Single column, stacked sections

- Quick action buttons full width

---

## Data Refresh

**On page load:** Fetch all dashboard data

**Auto-refresh:** Optional - refresh every 60 seconds (can be Phase 0+)

**Manual refresh:** Pull-to-refresh on mobile, refresh button on desktop

---

## Acceptance Criteria

- [ ] Dashboard loads as home page after login

- [ ] Shows count of open quotes (draft + pending_approval)

- [ ] Shows count of active jobs (pending + in_progress)

- [ ] Shows revenue for the current week (shipped jobs)

- [ ] Clicking summary cards navigates to filtered list

- [ ] Shows recent activity feed

- [ ] "+ New Quote" button navigates to quote creation

- [ ] "+ New Job" button navigates to job creation

- [ ] Dashboard is responsive on mobile

- [ ] Empty states display when no data

---

## Future Enhancements

- [ ] Activity log table for complete audit trail
- [ ] Time period selector for Revenue card (Week/Month/Year/All Time)
- [ ] Auto-refresh every 60 seconds
- [ ] Pull-to-refresh on mobile
