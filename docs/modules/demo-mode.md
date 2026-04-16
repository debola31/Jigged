# Demo Mode

## 1. Overview

Provide new users with a pre-populated sandbox they can explore within their own company context — without mixing demo data with real data or exposing any multi-company complexity.

### Problem Statement

- New users face an empty dashboard with no reference for how the system looks when populated
- Learning the quote-to-job workflow is difficult without seeing example data
- Users need to practice workflows (creating jobs, editing routings) in a risk-free environment

### Solution

1. Users can **enter Demo Mode** from Settings — this creates a hidden demo company behind the scenes, pre-populated with realistic manufacturing data
2. The UI presents this as a **mode toggle**, not a company switch — users see their company name with a "DEMO" badge, and a banner on every page
3. Users can **reset** the demo to its original state at any time
4. **Full CRUD** — users can create, edit, and delete demo records freely

### Why a Hidden Demo Company?

The demo company is architecturally separate (own `company_id`, full RLS isolation) but invisible to the user. This gives us:

- **Zero query overhead:** All existing queries filter by `company_id` via RLS. No additional filters needed — now or for any future module.
- **Zero maintenance burden:** Adding new entity tables requires no changes to demo infrastructure.
- **Automatic dashboard/analytics support:** KPIs, charts, and AI Insights naturally scope to the active `company_id`.
- **Simple cleanup:** Reset = delete all data in demo company + re-seed. One operation.

### Why Not an `is_sample` Column?

An earlier design used `is_sample BOOLEAN` on every data table with application-layer query filtering. This was rejected because:

- Every query, dropdown, dashboard KPI, and future module would need `.eq('is_sample', isSampleView)` — a permanent tax on every developer
- A missed filter silently leaks demo data into the real view (or vice versa) — the failure mode is invisible
- Load/clear functions must be updated every time a new entity table is added
- It pushes data isolation to the application layer, working against Supabase's RLS-based isolation

The hidden demo company approach leverages RLS (`company_id` filtering) which is already universal and enforced at the database level. Every current and future feature gets demo isolation for free.

---

## 2. User Stories

### Company Owner / Admin

- Enter Demo Mode from Settings or the onboarding card
- Browse demo customers, parts, quotes, jobs, and routings to understand the system
- Practice creating jobs, editing routings, and adjusting inventory in a risk-free environment
- Test the operator view by entering Demo Mode as an operator
- Reset the demo to its original state when ready for a fresh start
- Exit Demo Mode anytime via the banner or Settings

### Operator

- Enter Demo Mode to see sample jobs and operations
- Practice the operator workflow without affecting real production data

### System Admin (Platform)

- Create and update demo data templates
- Set the active template version
- Manage template versioning as schema evolves

---

## 3. Feature Specifications

### 3.1 Demo Data Included

| Entity | Count | Details |
|--------|-------|---------|
| Customers | 3 | Acme Manufacturing, Ajax Industries, Precision Corp |
| Parts | 6 | With pricing tiers across customers |
| Resource Groups | 4 | CNC, Manual, Quality, Finishing |
| Operation Types | 8 | With labor rates, linked to resource groups |
| Routings | 3 | With nodes and edges |
| Quotes | 5 | pending_approval, accepted statuses |
| Jobs | 4 | Pending, in_progress, completed statuses |
| Job Operations | 10+ | Across the 4 jobs |
| Inventory Items | 8 | With quantities and units |

### 3.2 Demo Mode Behavior

Users enter and exit Demo Mode via the **Settings page** or the **Demo Mode banner** (which appears on every page while in demo mode).

| Mode | What's Shown | CRUD Available | When |
|------|-------------|----------------|------|
| **Normal** (default) | Real company data | Full CRUD — creates real records | Always |
| **Demo Mode** | Demo company data | Full CRUD — creates/edits demo records | When demo mode is entered |

**Key behaviors:**

- Default mode is always Normal (real company)
- Entering demo mode navigates to `/dashboard/[demoCompanyId]/...`, preserving the current page (if on `/parts`, land on `/parts` in demo)
- Exiting demo mode navigates back to `/dashboard/[realCompanyId]/...`, preserving page context
- The header shows the **real company name** with a "DEMO" badge — the user's mental model is "my company in demo mode"
- All CRUD operations work normally — it's a real company, just pre-populated
- Users can practice the full workflow: create a quote from a demo customer, convert it to a job, edit a routing, adjust inventory
- The Operator View works normally — operators see demo jobs/operations when in demo mode
- "Reset Demo" restores the demo to its original template state (discards all user edits, re-seeds from template)
- The back button works naturally (browser history)

### 3.3 Data Isolation

Isolation is automatic. The demo company has a different `company_id`. All existing queries filter by `company_id` via RLS. No additional filters needed — now or for any future module.

- **In Normal mode:** All queries scope to the real company's `company_id`. Demo data is in a completely separate company — it cannot appear in dropdowns, selectors, or search results.
- **In Demo Mode:** All queries scope to the demo company's `company_id`. Any records created or modified are normal records in the demo company.
- **No FK conflicts:** Demo records reference other demo records. Real records reference other real records. They're in different companies — the two graphs never connect.

> This is enforced by RLS at the database level. No application-layer filtering required.

### 3.4 Enter Demo Mode

- Available during onboarding (first login card) and from the Settings page
- **First time:** Creates a hidden demo company, seeds it with template data, mirrors all `user_company_access` entries, then navigates to the demo company
- **Subsequent times:** Navigates to the existing demo company (lazy-syncs access for new team members)
- After entering, the Demo Mode banner appears and the header shows the DEMO badge

### 3.5 Exit Demo Mode

- Available from the Demo Mode banner ("Back to My Company") and the Settings page
- Navigates back to the real company's dashboard, preserving page context
- The demo company persists — re-entering is instant

### 3.6 Reset Demo

- Available from the Demo Mode banner and Settings page (only when demo company exists)
- Confirmation dialog: "This will restore the demo to its original state. Any changes you made in demo mode will be lost."
- Deletes all data in the demo company, then re-seeds from the active template
- Keeps the demo company row and `user_company_access` entries — only data is wiped

### 3.7 No Delete Action

The demo company is hidden from the company switcher, login redirect, and billing. It takes up ~50 rows of storage — negligible. Reset handles "start fresh." Keeping it around means re-entering demo mode is instant with no creation delay.

If a delete action is ever needed, it can be trivially added later (CASCADE delete on the company row).

### 3.8 Operator View

Operators already have `user_company_access` for the demo company (roles are mirrored at creation and lazy-synced on entry). They enter demo mode the same way everyone else does — via Settings. No special toggle mechanism needed.

> Demo data does NOT count toward any future usage limits or billing. Filter by `companies.is_demo = FALSE` in any billing/limits queries.

---

## 4. Database Schema

### 4.1 Companies Table Modifications

```sql
-- Link real company to its demo company
ALTER TABLE companies ADD COLUMN demo_company_id UUID REFERENCES companies(id) ON DELETE SET NULL;

-- Flag to identify demo companies
ALTER TABLE companies ADD COLUMN is_demo BOOLEAN DEFAULT FALSE;
```

- `demo_company_id`: Set on the real company, points to its demo company. NULL means no demo exists.
- `is_demo`: Set on the demo company itself. Used to filter demo companies out of the company selector, login redirect, and billing queries.

### 4.2 `demo_data_templates` Table

```sql
CREATE TABLE demo_data_templates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(100) NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    is_active BOOLEAN DEFAULT FALSE,
    template_data JSONB NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    created_by UUID REFERENCES auth.users(id),
    UNIQUE(name, version)
);

-- RLS
ALTER TABLE demo_data_templates ENABLE ROW LEVEL SECURITY;

CREATE POLICY "System admins can manage demo_data_templates"
    ON demo_data_templates FOR ALL
    USING (is_system_admin(auth.uid()));

CREATE POLICY "All authenticated users can read active templates"
    ON demo_data_templates FOR SELECT
    USING (is_active = TRUE);
```

### 4.3 `template_data` JSONB Schema

Template-local `_ref` IDs are mapped to real UUIDs during seeding:

```jsonb
{
  "version": 1,
  "schema_version": "2026-03-04",
  "customers": [
    {
      "_ref": "cust-1",
      "name": "Acme Manufacturing",
      "contact_name": "Bob Smith",
      "contact_email": "bob@acme.example.com",
      "contact_phone": "555-0101",
      "city": "Chicago",
      "state": "IL",
      "country": "USA"
    }
  ],
  "resource_groups": [
    { "_ref": "rg-1", "name": "CNC", "description": "CNC Machining" }
  ],
  "operation_types": [
    { "_ref": "op-1", "name": "CNC Milling", "labor_rate": 85.00, "resource_group_ref": "rg-1" }
  ],
  "parts": [
    { "_ref": "part-1", "part_name": "ACM-001", "description": "Precision Bracket", "customer_ref": "cust-1", "pricing": [{"quantity": 1, "unit_price": 150.00}] }
  ],
  "routings": [
    {
      "_ref": "routing-1", "name": "Bracket Standard Routing", "part_ref": "part-1",
      "nodes": [{ "_ref": "node-1", "operation_type_ref": "op-1", "run_time_per_unit": 0.5, "instructions": "Mill to spec" }],
      "edges": [{ "source_ref": "node-1", "target_ref": "node-2" }]
    }
  ],
  "inventory_items": [
    { "_ref": "inv-1", "name": "6061 Aluminum Bar Stock", "sku": "AL-6061-BAR", "primary_unit": "inches", "quantity": 240, "cost_per_unit": 3.50 }
  ],
  "quotes": [
    { "_ref": "quote-1", "quote_number": "Q-DEMO-001", "customer_ref": "cust-1", "part_ref": "part-1", "routing_ref": "routing-1", "quantity": 50, "unit_price": 130.00, "total_price": 6500.00, "status": "accepted" }
  ],
  "jobs": [
    {
      "_ref": "job-1", "job_number": "J-DEMO-001", "customer_ref": "cust-1", "part_ref": "part-1", "quote_ref": "quote-1", "routing_ref": "routing-1", "status": "in_progress", "description": "Precision Brackets - 50 units",
      "operations": [
        { "_ref": "jop-1", "sequence": 1, "operation_name": "CNC Milling", "operation_type_ref": "op-1", "estimated_run_hours_per_unit": 0.5, "quantity_completed": 20, "status": "in_progress" }
      ]
    }
  ]
}
```

### 4.4 RLS Considerations

- The demo company follows the same RLS policies as any real company (access via `user_company_access`)
- No additional RLS policies needed — `company_id` isolation handles everything
- Demo companies are excluded from non-data queries (company selector, billing) by filtering `WHERE is_demo = FALSE`

### 4.5 Platform Foundation: System Admin Infrastructure

Template management requires platform-level admin privileges.

#### `system_admins` Table

```sql
CREATE TABLE system_admins (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    created_by UUID REFERENCES auth.users(id),
    UNIQUE(user_id)
);

ALTER TABLE system_admins ENABLE ROW LEVEL SECURITY;

CREATE POLICY "System admins can read system_admins"
    ON system_admins FOR SELECT
    USING (is_system_admin(auth.uid()));

CREATE POLICY "System admins can insert system_admins"
    ON system_admins FOR INSERT
    WITH CHECK (is_system_admin(auth.uid()));
```

#### `is_system_admin()` Helper Function

```sql
CREATE OR REPLACE FUNCTION is_system_admin(check_user_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT EXISTS (
        SELECT 1 FROM system_admins WHERE user_id = check_user_id
    );
$$;
```

> **`SECURITY DEFINER` rationale:** RLS on `system_admins` restricts reads to system admins, but `is_system_admin()` must read this table to determine admin status — a chicken-and-egg problem. `SECURITY DEFINER` executes with the function creator's permissions, bypassing RLS.

#### Bootstrap Process

The first system admin must be inserted directly via SQL:

```sql
-- Run via Supabase SQL Editor
INSERT INTO system_admins (user_id, created_by)
VALUES ('FIRST_ADMIN_USER_ID', 'FIRST_ADMIN_USER_ID');
```

---

## 5. Database Functions

### 5.1 `seed_demo_data()` — Shared Seeding Helper

Extracted helper that seeds a company with demo data from the active template. Used by both `create_demo_company()` and `reset_demo_company()`.

```sql
CREATE OR REPLACE FUNCTION seed_demo_data(
    p_company_id UUID,
    p_user_id UUID,
    p_template_name VARCHAR DEFAULT 'default'
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
-- Reads active template from demo_data_templates
-- Iterates each entity array, mapping _ref keys to real UUIDs via v_ref_map
-- Insert order (respects FK dependencies):
--   customers → resource_groups → operation_types → parts →
--   inventory_items → routings (+ nodes + edges) →
--   quotes → jobs (+ job_operations)
-- Post-pass: links quotes.converted_to_job_id (circular FK)
-- Supports temporal fields: created_at, started_at, completed_at, shipped_at
$$;
```

> **Implementation:** See `supabase/migrations/20260305100000_demo_mode_transform.sql` section 10 for the full function body (~200 lines). The seeding logic is adapted from the battle-tested `_populate_demo_company()` function, updated for the current schema (no `parts.customer_id`, no `quotes.routing_id`, no `jobs.routing_id`).

### 5.2 `create_demo_company()`

```sql
CREATE OR REPLACE FUNCTION create_demo_company(
    p_source_company_id UUID,
    p_user_id UUID,
    p_template_name VARCHAR DEFAULT 'default'
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_source_name TEXT;
    v_demo_company_id UUID;
    v_existing_demo_id UUID;
BEGIN
    -- Auth check: caller must be the requesting user
    IF p_user_id != auth.uid() THEN
        RAISE EXCEPTION 'Access denied';
    END IF;

    -- Idempotency: return existing demo company if one exists
    SELECT demo_company_id INTO v_existing_demo_id
    FROM companies WHERE id = p_source_company_id;

    IF v_existing_demo_id IS NOT NULL THEN
        RETURN v_existing_demo_id;
    END IF;

    -- Get source company name
    SELECT name INTO v_source_name
    FROM companies WHERE id = p_source_company_id;

    -- Create demo company
    INSERT INTO companies (name, is_demo)
    VALUES (v_source_name || ' - Demo', TRUE)
    RETURNING id INTO v_demo_company_id;

    -- Link demo to source company
    UPDATE companies SET demo_company_id = v_demo_company_id
    WHERE id = p_source_company_id;

    -- Mirror all user_company_access from source to demo
    INSERT INTO user_company_access (user_id, company_id, role, name)
    SELECT uca.user_id, v_demo_company_id, uca.role, uca.name
    FROM user_company_access uca
    WHERE uca.company_id = p_source_company_id;

    -- Seed demo data from active template
    PERFORM seed_demo_data(v_demo_company_id, p_user_id, p_template_name);

    RETURN v_demo_company_id;
END;
$$;
```

### 5.3 `reset_demo_company()`

```sql
CREATE OR REPLACE FUNCTION reset_demo_company(
    p_source_company_id UUID,
    p_user_id UUID
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_demo_company_id UUID;
BEGIN
    -- Auth check
    IF p_user_id != auth.uid() THEN
        RAISE EXCEPTION 'Access denied';
    END IF;

    -- Get demo company id from source company
    SELECT demo_company_id INTO v_demo_company_id
    FROM companies WHERE id = p_source_company_id;

    IF v_demo_company_id IS NULL THEN
        RAISE EXCEPTION 'No demo company exists for company: %', p_source_company_id;
    END IF;

    -- Delete all data in demo company (reverse FK order)
    DELETE FROM operator_sessions WHERE company_id = v_demo_company_id;
    DELETE FROM inventory_transactions WHERE company_id = v_demo_company_id;
    DELETE FROM job_attachments WHERE company_id = v_demo_company_id;
    DELETE FROM quote_attachments WHERE company_id = v_demo_company_id;
    DELETE FROM job_operations WHERE job_id IN (SELECT id FROM jobs WHERE company_id = v_demo_company_id);
    DELETE FROM jobs WHERE company_id = v_demo_company_id;
    DELETE FROM quotes WHERE company_id = v_demo_company_id;
    DELETE FROM routing_edges WHERE routing_id IN (SELECT id FROM routings WHERE company_id = v_demo_company_id);
    DELETE FROM routing_nodes WHERE routing_id IN (SELECT id FROM routings WHERE company_id = v_demo_company_id);
    DELETE FROM routings WHERE company_id = v_demo_company_id;
    DELETE FROM parts WHERE company_id = v_demo_company_id;
    DELETE FROM inventory_items WHERE company_id = v_demo_company_id;
    DELETE FROM operation_types WHERE company_id = v_demo_company_id;
    DELETE FROM resource_groups WHERE company_id = v_demo_company_id;
    DELETE FROM customers WHERE company_id = v_demo_company_id;

    -- Delete AI data for demo company
    DELETE FROM ai_chat_queries WHERE company_id = v_demo_company_id;

    -- Re-seed from template
    PERFORM seed_demo_data(v_demo_company_id, p_user_id);
END;
$$;
```

### 5.4 Access Mirroring (Lazy Sync)

When a user enters demo mode, ensure all current team members have access:

```sql
CREATE OR REPLACE FUNCTION sync_demo_access(
    p_source_company_id UUID,
    p_demo_company_id UUID
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    -- Add any missing access entries (new team members since demo was created)
    INSERT INTO user_company_access (user_id, company_id, role)
    SELECT uca.user_id, p_demo_company_id, uca.role
    FROM user_company_access uca
    WHERE uca.company_id = p_source_company_id
      AND NOT EXISTS (
        SELECT 1 FROM user_company_access
        WHERE user_id = uca.user_id AND company_id = p_demo_company_id
      );

    -- Update roles that changed
    UPDATE user_company_access demo_uca
    SET role = source_uca.role
    FROM user_company_access source_uca
    WHERE demo_uca.company_id = p_demo_company_id
      AND source_uca.company_id = p_source_company_id
      AND demo_uca.user_id = source_uca.user_id
      AND demo_uca.role != source_uca.role;
END;
$$;
```

Called by the API when entering demo mode. Keeps roles in sync without triggers.

---

## 6. User Flows

### 6.1 First-Time Onboarding

```
User signs up ("Join the Beta")
    → Company created (name provided at signup)
    → User lands on dashboard (empty)
    → Onboarding card: "Want to see what Jigged looks like with real data?"
    → [Enter Demo Mode] button
    → POST /api/demo/create
    → Demo company created, seeded, access mirrored
    → App navigates to /dashboard/[demoCompanyId]/...
    → Demo Mode banner appears, header shows company name + DEMO badge
    → User browses populated dashboard, customers, parts, quotes, jobs
    → When ready: clicks "Back to My Company" in banner
    → App navigates to /dashboard/[realCompanyId]/...
    → User starts entering real data
```

### 6.2 Entering Demo Mode (From Settings)

```
User navigates to Settings → Demo Mode section
    → [Enter Demo Mode] button
    → If first time: POST /api/demo/create (loading spinner)
    → If demo exists: Sync access, navigate immediately
    → App navigates to /dashboard/[demoCompanyId]/...
    → Demo Mode banner appears on every page
```

### 6.3 Exiting Demo Mode

```
User clicks "Back to My Company" (from banner or Settings)
    → App navigates to /dashboard/[realCompanyId]/...
    → Demo Mode banner disappears
    → User sees their real company data
```

### 6.4 Resetting Demo

```
User clicks "Reset Demo" (from banner or Settings)
    → Confirmation dialog: "This will restore the demo to its original state. Any changes you made in demo mode will be lost."
    → User confirms
    → Loading spinner
    → POST /api/demo/reset
    → All demo data wiped and re-seeded
    → User stays in demo mode with fresh data
    → Success toast: "Demo reset to original state"
```

---

## 7. UI Components

### 7.1 Settings: Demo Mode Section

Demo mode controls live on the Settings page (`/dashboard/[companyId]/settings/demo`).

```
Demo Mode
─────────────────────────────────
Status: Active / Not set up

[Enter Demo Mode]          (if no demo exists — creates + enters)
[Enter Demo Mode]          (if demo exists, currently in real company)
[Back to My Company]       (if currently in demo mode)
[Reset Demo]               (restores to original state)
```

- "Enter Demo Mode" calls `POST /api/demo/create` (first time) or navigates directly (subsequent)
- "Back to My Company" navigates back to the real company
- "Reset Demo" calls `POST /api/demo/reset` (confirmation dialog first)

### 7.2 Demo Mode Banner

When in demo mode, a persistent info banner appears below the header on every page:

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│  ℹ  You're in demo mode. Changes here won't affect your real company.  [Back to My Company]  [Reset]  │
└──────────────────────────────────────────────────────────────────────────────────┘
```

- MUI `Alert` with `severity="info"`
- Positioned below Header, above page content
- "Back to My Company" is the primary escape — navigates to real company
- "Reset" restores demo to original template state (confirmation dialog)

### 7.3 Header: DEMO Badge

When in demo mode, the header shows the **real company name** (not the demo company's internal name) with a "DEMO" badge:

```
┌─────────────────────────────────────────────┐
│  Acme Machine Shop  [DEMO]                  │
└─────────────────────────────────────────────┘
```

The `DemoModeProvider` context provides the real company name for display.

### 7.4 Onboarding Card

Shown on the dashboard when the company has no data and no demo company:

```
┌──────────────────────────────────────────────┐
│  Welcome to Jigged!                          │
│                                              │
│  Want to see what a populated shop looks     │
│  like? Enter demo mode to explore.           │
│                                              │
│  [Enter Demo Mode]    [Skip, I'll start fresh]  │
└──────────────────────────────────────────────┘
```

- MUI `Card` with `elevation={2}`
- Disappears after the user makes a choice or creates their first record

---

## 8. Frontend Architecture

### 8.1 DemoModeProvider

```tsx
// components/providers/DemoModeProvider.tsx

interface DemoModeContext {
  hasDemoCompany: boolean;      // company.demo_company_id !== null
  isDemoMode: boolean;          // currently viewing demo company
  demoCompanyId: string | null;
  realCompanyId: string;
  realCompanyName: string;      // for DEMO badge display
  enterDemoMode: () => Promise<void>;
  exitDemoMode: () => void;
  resetDemo: () => Promise<void>;
  isLoading: boolean;
}
```

Wraps the dashboard layout. Determines `isDemoMode` by checking if the current `companyId` URL param matches `company.demo_company_id`.

### 8.2 Navigation

The trickiest UX detail — mode switching is URL navigation:

- `enterDemoMode()`: Replace `companyId` in the current URL path with `demoCompanyId`, navigate via `router.push()`
- `exitDemoMode()`: Replace `demoCompanyId` with `realCompanyId`, navigate
- **Preserve page context:** `/dashboard/[realId]/parts` → `/dashboard/[demoId]/parts`
- **Back button:** Works naturally (browser history)

```tsx
const enterDemoMode = async () => {
  if (!demoCompanyId) {
    // First time — create demo company
    const { demo_company_id } = await fetch('/api/demo/create', { method: 'POST', ... });
    setDemoCompanyId(demo_company_id);
  }
  // Navigate to demo company, preserving current page
  const currentPath = pathname.replace(realCompanyId, demoCompanyId);
  router.push(currentPath);
};

const exitDemoMode = () => {
  const currentPath = pathname.replace(demoCompanyId, realCompanyId);
  router.push(currentPath);
};
```

### 8.3 Company Switcher & Login

Demo companies must be hidden from non-demo-mode contexts:

- **Company selector page:** Filter `WHERE is_demo = FALSE` when listing companies
- **`getPostLoginRoute()`:** Skip demo companies when looking up `last_company_id`. If the user's last company was a demo, fall back to finding a real company.
- **`user_preferences.last_company_id`:** Never set to a demo company ID

### 8.4 Dashboard & Analytics

**No special handling needed.** When in demo mode, the active `company_id` is the demo company. All dashboard KPIs, activity feeds, and AI Insights queries naturally scope to this company. This is the primary architectural advantage of the hidden demo company approach.

---

## 9. API Endpoints

All endpoints are FastAPI routes. Use the Supabase service role client for database operations.

### 9.1 `POST /api/demo/create`

Creates a demo company for the user's real company.

- **Auth:** Supabase JWT (must be owner or admin of the company)
- **Body:** `{ company_id: string }`
- **Logic:**
  1. Verify caller is owner/admin of company
  2. Check if demo already exists (`demo_company_id`)
  3. If exists: sync access, return `{ demo_company_id, already_existed: true }`
  4. If not: call `create_demo_company(company_id, user_id)`
  5. Return `{ demo_company_id, already_existed: false }`

### 9.2 `POST /api/demo/reset`

Resets the demo company to its original template state.

- **Auth:** Supabase JWT (must be owner or admin of the source company)
- **Body:** `{ company_id: string }` (the real company ID)
- **Logic:**
  1. Verify caller is owner/admin
  2. Call `reset_demo_company(company_id, user_id)`
  3. Return `{ success: true }`

### 9.3 `GET /api/demo/status`

Returns the demo mode status for a company.

- **Auth:** Supabase JWT (must have access to the company)
- **Query:** `?company_id=X`
- **Returns:** `{ has_demo: boolean, demo_company_id: string | null }`

### 9.4 Template Management (System Admin)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/demo/templates` | List all templates |
| `POST` | `/api/demo/templates` | Create new template |
| `PUT` | `/api/demo/templates/{id}/activate` | Set template as active |

All require system admin auth.

---

## 10. Template Management

### 10.1 Template Authoring Workflow

Templates are authored and maintained via direct JSON editing, not through a UI. This is a low-frequency operation performed by system admins (the development team), not end users.

#### Authoring Process

1. **Initial creation:** Write the template JSONB in a seed file (`scripts/seed-demo-template.sql`). This file contains the full `INSERT INTO demo_data_templates` statement with the JSONB payload.

2. **Validation:** Before inserting, validate the template against these rules:
   - All `_ref` values are unique across the entire template
   - All `*_ref` foreign key references resolve to a `_ref` defined earlier in the template
   - All required fields per entity type are present
   - `schema_version` matches the current database schema date

3. **Insertion:** Run the seed file via Supabase SQL Editor or as a migration:
   ```sql
   INSERT INTO demo_data_templates (name, version, is_active, template_data, created_by)
   VALUES ('default', 1, TRUE, '{...}'::JSONB, 'SYSTEM_ADMIN_USER_ID');
   ```

4. **Updating:** Create a new version, activate it, deactivate the old:
   ```sql
   INSERT INTO demo_data_templates (name, version, is_active, template_data, created_by)
   VALUES ('default', 2, TRUE, '{...}'::JSONB, 'SYSTEM_ADMIN_USER_ID');

   UPDATE demo_data_templates SET is_active = FALSE WHERE name = 'default' AND version = 1;
   ```

#### No Admin UI (Phase 0)

The template management API endpoints (section 9.4) exist for programmatic access and future admin UI integration. For Phase 0, templates are managed via SQL.

### 10.2 Template Versioning & Schema Evolution

1. Each template includes a `schema_version` field (date-based, e.g., `"2026-03-04"`)
2. `seed_demo_data()` uses `COALESCE` for all optional fields — templates with missing new fields load successfully with defaults
3. When schema changes, update the template JSONB and increment the version number
4. Backward compatibility maintained via `COALESCE` defaults

---

## 11. Testing Strategy

### Unit Tests

| Test | Description |
|------|-------------|
| `create_demo_company()` | Creates company with `is_demo = TRUE`, seeds all entities, mirrors access, idempotent |
| `reset_demo_company()` | Wipes all data in demo company, re-seeds from template, preserves access |
| `sync_demo_access()` | Adds missing access entries, updates changed roles |
| Company selector | Filters out `is_demo = TRUE` companies |
| Login redirect | Never redirects to a demo company |

### Integration Tests

| Test | Description |
|------|-------------|
| Enter demo mode (first time) | Create → seed → navigate → banner appears → DEMO badge in header |
| Enter demo mode (existing) | Navigate → sync access → banner appears |
| Exit demo mode | Navigate back → banner disappears → real data shown |
| Reset demo | Confirm → wipe → re-seed → fresh data in demo |
| Mixed companies | User has real company + demo → company selector shows only real |
| New team member | Added to real company → enters demo mode → auto-gets access |
| Operator flow | Operator enters demo mode → sees demo jobs and operations |

### Performance Tests

| Test | Target |
|------|--------|
| `create_demo_company()` | < 2 seconds |
| `reset_demo_company()` | < 2 seconds |
| Demo dataset row count | ~50 rows across all tables |

---

## 12. Acceptance Criteria

- [ ] `companies.demo_company_id` column exists
- [ ] `companies.is_demo` column exists
- [ ] `demo_data_templates` table exists with RLS policies
- [ ] `system_admins` table and `is_system_admin()` function exist
- [ ] `create_demo_company()` creates and seeds a demo company
- [ ] `reset_demo_company()` wipes and re-seeds demo data
- [ ] `sync_demo_access()` mirrors access entries on demo entry
- [ ] Settings page shows demo mode controls (Enter/Exit/Reset)
- [ ] Demo Mode banner appears on every page in demo mode
- [ ] Header shows real company name + DEMO badge in demo mode
- [ ] Full CRUD works in demo mode (standard company behavior)
- [ ] Company selector hides demo companies (`is_demo = TRUE`)
- [ ] Login redirect never targets a demo company
- [ ] Onboarding card offers "Enter Demo Mode" on first visit
- [ ] Entering demo mode preserves current page context
- [ ] Exiting demo mode preserves current page context
- [ ] Template versioning handles schema evolution gracefully
- [ ] Demo data does not count toward usage limits or billing

---

## 13. Open Questions (Resolved)

| # | Question | Resolution |
|---|----------|------------|
| 1 | Should demo data count toward usage limits? | No — filter by `is_demo = FALSE` in billing queries |
| 2 | Should demo mode be read-only? | No — full CRUD. It's a real company, users can practice freely. Reset available. |
| 3 | JSONB template vs programmatic seeder? | JSONB template with `_ref` mapping |
| 4 | Separate demo company vs `is_sample` column? | Separate demo company. `is_sample` creates a permanent query-filter tax. RLS handles isolation for free. |
| 5 | Should each user get their own demo? | No — one shared demo per real company. All team members share it. |
| 6 | How to keep demo access in sync? | Lazy sync on demo entry — `sync_demo_access()` mirrors roles. |
| 7 | Should we support deleting the demo? | Not for Phase 0. The demo is hidden and takes negligible storage. Reset handles "start fresh." |

---

## 14. Dependencies

- **Platform Foundation:** `system_admins` table and `is_system_admin()` function (defined in Section 4.5 above) required for template management RLS policies
- **Settings page layout:** Defined in the [Invitation System PRD](./invitation-system.md#123-settings-navigation). Demo mode adds a `demo` section to this layout.
- **No dependency on Invitation System features:** Demo mode is fully independent of invitations/referrals — they just share the Settings page layout.

---

## 15. Success Metrics

- **Demo mode entry rate:** % of new users who enter demo mode during onboarding
- **Browse duration:** Time spent in demo mode before exiting to real company
- **Time to first real record:** How quickly users create their first real customer/part/quote after exploring the demo
- **Reset rate:** % of users who reset the demo (indicates active exploration)

---

## 16. Supersedes

This PRD supersedes both the [Demo Company](./demo-company.md) PRD and the [Sample Data](./sample-data.md) PRD.

**Lineage:**

1. **Demo Company PRD** (original): Separate demo company per user, visible in company switcher, permanent lifecycle.
2. **Sample Data PRD** (v2): In-company `is_sample` column with view toggle. Rejected due to query-filter tax — every query needs the filter, silent failure mode on missed filters.
3. **Demo Mode PRD** (v3, this document): Hidden demo company per real company, presented as a mode toggle. Combines the architectural simplicity of a separate company (RLS isolation) with the UX simplicity of a toggle (no company switcher confusion).

| Aspect | Demo Company (v1) | Sample Data (v2) | Demo Mode (v3) |
|--------|-------------------|-------------------|----------------|
| Data location | Separate company (visible) | Same company, `is_sample` column | Separate company (hidden) |
| Company switcher | Shows "(Demo)" entry | No change | No change — demo hidden |
| Data isolation | RLS (free) | Application-layer filter (every query) | RLS (free) |
| New table maintenance | None | Must add `is_sample` + update functions | None |
| Dashboard/analytics | Just works | Must add filter to every query | Just works |
| Lifecycle | Auto-created on signup | User-initiated load | Lazy — created on first entry |
| Cleanup | Delete company | Per-table delete in FK order | Reset = wipe + re-seed |
| UX | Company switch | View toggle in settings | Mode toggle in settings |
