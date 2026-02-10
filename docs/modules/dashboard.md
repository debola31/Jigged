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
| Owner | Quickly create a new quote | I can respond to customer inquiries fast |
| Owner | Quickly create a new job | I can get rush orders into production |
| Owner | See recent activity | I know what's been happening |

---

## Summary Cards

### Card 1: Open Quotes

**Query:** Count quotes where status IN ('draft', 'sent')

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

---

## Recent Activity Section

**Query:** Most recent status changes from quotes and jobs

- UNION of quote status changes and job status changes

- ORDER BY timestamp DESC

- LIMIT 10

**Activity Types:**

- Quote created

- Quote sent

- Quote accepted

- Quote declined

- Job created

- Job started

- Job completed

- Job shipped

**Display per row:**

- Icon (quote icon or job icon)

- Entity number (Q-0089 or J-0042)

- Action text ("sent to XYZ Corp", "marked complete")

- Relative timestamp ("2h ago", "yesterday")

**"View All" link:** Future feature - Activity log page

**Empty State:** "No recent activity."

**Implementation Note for Phase 0:**

For simplicity, this can be derived from `created_at`, `status_changed_at`, `started_at`, `completed_at`, `shipped_at` timestamps rather than a separate activity log table. A proper activity/audit log can be added in a later phase.

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

- 4 summary cards in a row

- Two-column layout for sections below

**Tablet (768px - 1024px):**

- 2 summary cards per row (2x2 grid)

- Single column for sections

**Mobile (< 768px):**

- 2 summary cards per row (2x2 grid, smaller)

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

- [ ] Shows count of open quotes (draft + sent)

- [ ] Shows count of active jobs (pending + in_progress)

- [ ] Shows count of overdue jobs with warning indicator

- [ ] Clicking summary cards navigates to filtered list

- [ ] Shows recent activity feed

- [ ] "+ New Quote" button navigates to quote creation

- [ ] "+ New Job" button navigates to job creation

- [ ] Dashboard is responsive on mobile

- [ ] Empty states display when no data
