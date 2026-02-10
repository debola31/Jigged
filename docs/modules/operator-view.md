# Operator View Module

## Overview

The Operator View module provides a mobile-first interface for shop floor operators to log in with email/password, scan station QR codes to identify their workstation, view their assigned jobs, track time on operations, and mark work complete. This is the primary touchpoint for operators using Jigged on the shop floor.

**Priority:** Must Have (Build after Jobs module)

**Dependencies:**

- Jobs module (operators work on jobs)

- Authentication system (operator login)

- Operations module (for operation types)

**Database Tables:** `operators`, `operator_sessions`

**Route:** `/operator/{companyId}` (dedicated mobile-first interface)

---

## User Stories

| As a... | I want to... | So that... |
|---|---|---|
| Operator | Scan a station QR code to identify my workstation | The system knows which station I am working at |
| Operator | Log in with my email and password | I can access my work using credentials I already have |
| Operator | View a list of pending jobs | I know what work is available |
| Operator | Start work on a job | Time tracking begins and others see Im working on it |
| Operator | Stop work on a job | I can take a break or switch to another job |
| Operator | Mark a job operation as complete | The job moves to the next operation or completion |
| Owner | See which operators are currently active | I have real-time visibility into shop floor activity |
| Owner | Create and manage operator accounts | I control who can access the operator view |

---

## Data Model

### Operators Table

| Field | Type | Required | Description |
|---|---|---|---|
| id | uuid | Yes | Primary key |
| company_id | uuid | Yes | FK to companies |
| name | text | Yes | Operator display name |
| user_id | uuid | Yes | FK to auth.users (Supabase user) |
| is_active | boolean | Yes | Whether operator can log in (default true) |
| last_login_at | timestamptz | No | Updated on each successful login |
| created_at | timestamptz | Yes | Record creation timestamp |
| updated_at | timestamptz | Yes | Last update timestamp |

### Operator Sessions Table

| Column | Type | Required | Description |
|---|---|---|---|
| id | uuid | Yes | Primary key |
| company_id | uuid | Yes | FK to companies |
| operator_id | uuid | Yes | FK to operators |
| job_id | uuid | Yes | FK to jobs (current job being worked) |
| operation_type_id | uuid | Yes | FK to operation_types (from station QR code) |
| job_operation_id | uuid | No | FK to job_operations (the specific operation step being worked) |
| started_at | timestamptz | Yes | When work session started |
| ended_at | timestamptz | No | When work session ended (null if in progress) |

---

## Routing & Session Tracking

Operators work on specific routing nodes (operation steps) within a job. The session tracking system must capture which exact step was worked.

### Key Relationships

`Job → Routing → Routing Nodes (each node is an operation_type)`

- Station QR codes encode `operation_type_id` (station = operation_type)

- When starting work, the system finds the matching uncompleted job_operation for that operation_type

- Sessions track both the operation_type_id (from QR) and job_operation_id (specific step)

### Data Model Update

**operator_sessions table changes:**

- Rename `station_id` (text) → `operation_type_id` (uuid FK to operation_types)

- Add job_operation_id (uuid FK to job_operations) - which specific operation step was worked

---

## Job List Filtering Logic

When an operator scans a station QR code (encoding an operation_type_id), the job list is filtered to show only relevant jobs:

1. Job status is `PENDING` or `IN_PROGRESS`

2. Job has an uncompleted job_operation matching the operator's operation_type

3. All predecessor nodes in the routing DAG must be complete (node is "ready" to work)

4. Sorted by due date (urgent first), then by job number

**API:** `GET /api/operator/jobs?operation_type_id={uuid}`

### How routing_node_id is Determined

When an operator starts work on a job, the system infers the specific job_operation_id:

1. Operator scans station QR → provides `operation_type_id`

2. Operator selects a job → provides `job_id`

3. System queries to find the job_operation where:

- `routing_id` matches the jobs parts routing

- `operation_type_id` matches the scanned station

- `completed_at` is NULL (not yet completed)

1. This gives the specific job_operation_id to track in the session

---

## Routing Advancement Logic

When an operator marks an operation as complete:

1. The specific job_operation is marked as completed with timestamp

2. The current operator_session is ended (end_time set)

3. If job was in PENDING status, it transitions to IN_PROGRESS

4. System checks if ALL job_operations for this job are now complete

5. If all nodes complete → Job status automatically transitions to COMPLETE

6. Downstream nodes (successors in the DAG) become "ready" for operators at those stations

**Note:** For parallel routing branches, multiple nodes can be in progress simultaneously on different stations.

---

## UI Screens

### 1. Station Login

**Route:** `/operator/{companyId}/login`

Mobile-first login screen with email/password authentication. Station is pre-selected if operator scanned a station QR code:

- Email and password form - mobile-optimized input fields with large touch targets

- Station QR code parameter auto-captured from URL when scanned

- Clear error messaging for invalid credentials

### Password Change (First Login)

Route: /operator/{companyId}/change-password

When operator logs in for the first time with temp password set by admin:

- Show "Change Password" prompt (required before proceeding)

- Fields: Current password, New password, Confirm password

- Minimum 8 characters for new password

- On success: Clear needs_password_change flag, redirect to jobs list

- Store flag in Supabase user metadata: needs_password_change: false

Implementation: Use supabase.auth.updateUser() with password and data fields.

### 2. Job List

**Route:** `/operator/{companyId}/jobs`

List of available jobs the operator can work on:

- Large, tappable job cards with job number, customer, and part info

- Visual status indicators (pending, in progress by others)

- Due date with color coding (on time = green, at risk = yellow, overdue = red)

- Refresh button for latest job data

- Bottom navigation bar with Jobs, Active, Profile tabs

### 3. Active Job View

**Route:** `/operator/{companyId}/jobs/{jobId}`

Job detail screen when operator is working on a job:

- Job header with job number, customer, part details

- Live timer showing time on current session

- Large STOP button to pause work

- COMPLETE button to mark operation done

- View attached files (PDFs, drawings)

- Optional notes field for operator comments

### 4. Job Complete Confirmation

Modal/screen shown after marking a job complete:

- Summary of time spent on job

- Optional quality notes or issue flagging

- Confirm button to finalize

- Returns to job list after confirmation

---

## API Endpoints

| Method | Endpoint | Description | Auth |
|---|---|---|---|
| POST | /api/operators | Create operator (admin only - requires service role key) | Admin JWT |
| GET | /api/operators?company_id={id} | List all operators with emails for a company | Service Role |
| GET | /api/operators/{operator_id} | Get single operator with email | Service Role |

Authentication Note: Operators authenticate using Supabase Auth (same as admin users) but access a dedicated operator interface. The system verifies the user has an active operator record for the company.

Direct Supabase Operations (no backend API needed):

- Sign in: supabase.auth.signInWithPassword()

- Sign out: supabase.auth.signOut()

- Validate operator: Query operators table with RLS

- List jobs: Query jobs table with RLS

- Start/stop/complete session: CRUD operator_sessions with RLS

- Update password: supabase.auth.updateUser()

---

## Mobile Design Requirements

The operator view is designed mobile-first for use on smartphones in shop floor environments. Key design considerations:

### Touch Targets

- Minimum 48px x 48px touch targets for all interactive elements

- Large buttons for primary actions (Start, Stop, Complete)

- Generous spacing between tappable elements to prevent mis-taps

### Visibility

- High contrast colors for readability under bright shop floor lighting

- Minimum 16px font size for body text

- Clear status indicators with color + icon (not color alone)

- Dark theme to reduce glare and match admin interface

### Navigation

- Bottom navigation bar (thumb-friendly)

- Simple 3-tab structure: Jobs, Active, Profile

- No complex nested navigation

### Performance

- Fast initial load (target < 3 seconds on 4G)

- Offline-tolerant - queue actions if connection drops

- Optimized for portrait orientation

---

## Acceptance Criteria

### Authentication

- [ ] Operator can scan station QR code to identify workstation

- [ ] Operator can authenticate via email/password

- [ ] Invalid credentials show clear error message

- [ ] Session persists until explicit logout or timeout

### Job Management

- [ ] Operator can view list of pending/available jobs

- [ ] Operator can start work on a job

- [ ] Starting work creates a session record with start_time

- [ ] Job status updates to In Progress when started

- [ ] Operator can pause/stop work on a job

- [ ] Stopping work records end_time on session

- [ ] Operator can mark job operation as complete

### Time Tracking

- [ ] Active session shows live timer on job view

- [ ] Multiple sessions per job are tracked separately

- [ ] Total time per job is calculated from all sessions

### Admin Features

- [ ] Owner can create operator accounts with name and email

- [ ] Owner can view list of active operators

- [ ] Owner can deactivate operator accounts

- [ ] Owner can reset operator password via email

- [ ] Owner can bulk delete operators

- [ ] Owner can export operators to CSV

## Material Consumption Logging

> 🚧 Future Enhancement: This feature is planned but not yet implemented in the current release. The Job Complete Modal currently supports quantity tracking and notes only.

When completing an operation, operators log materials consumed. Expected materials are pre-defined in routing nodes.

### Workflow

1. Routing nodes define expected materials (inventory_item_id, quantity, unit)

2. When operator taps "Complete", system shows materials expected for this operation

3. Operator can confirm quantities or adjust if different amounts were used

4. On submit, inventory transactions are created (type: depletion)

5. Transactions link to job_id and operator_id for traceability

### UI Update: Job Complete Confirmation Screen

- Add "Materials Used" section showing expected materials from routing

- Editable quantity fields for each material

- Unit selector (primary + secondary units)

- "No materials used" option if routing has no materials defined

---

## Admin Screens (Operator Management)

Owners manage operator accounts from the admin dashboard.

### 1. Operator List

**Route:** `/dashboard/{companyId}/team` (tabbed interface with Operators tab)

- Table: Name, Status (Active/Inactive), Last Login, Actions

- + New Operator button

- Active Operators Now widget showing currently logged-in operators

### 2. Create/Edit Operator

**Route:** `/dashboard/{companyId}/team/operators/new` or `/{id}`

- Name (required)

- Email (required) - linked to Supabase user account

- Active toggle

- View Work History (link to sessions list)

---

## QR Code Specification

### Station QR Codes

**Format:** URL encoding operation_type UUID

`https://app.jigged.io/operator/{companyId}/login?station={operation_type_id}`

- Printed and posted at each workstation/machine

- Operator scans to identify which station they are working at

- Generated from the Operations module (each operation_type has a QR code)

### 

---

## Token & Session Lifecycle

- Authentication: Supabase Auth (email/password)

- Session: Managed by Supabase (standard user session)

- Storage: Supabase client handles session storage

- On Expiry: Redirect to login screen (Supabase handles session refresh)

- Refresh: Automatic via Supabase session refresh tokens

---

## Edge Cases & Concurrent Sessions

### Job Already In Progress

If operator tries to start a job/routing node already being worked by someone else:

- Show warning: "John is currently working on this operation"

- Allow "Take Over" option (ends Johns session, starts new session)

- Johns time is still recorded up to takeover point

### Operator Has Active Session

If operator with an active session tries to start a new job:

- Auto-stop current session (end_time set to now)

- Start new session on the new job

- Show brief confirmation toast

### Multi-Device Login

If same operator logs in from a different device:

- Both sessions remain valid (operators may switch devices)

- Work sessions are tied to operator, not device

- Future: Consider notifying when active session exists on another device

---
