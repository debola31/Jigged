# Demo Company & Platform Foundation

> **SUPERSEDED:** This PRD has been replaced by [Demo Mode](./demo-mode.md). The demo mode approach revives the demo company architecture (separate `company_id`, RLS isolation) but wraps it in a seamless mode-toggle UX — the demo company is hidden from the user. See [Demo Mode PRD Section 16](./demo-mode.md#16-supersedes) for the full lineage. This file is retained for historical reference only.
>
> **Its schema references are pre-unification and are deliberately left as written.** They describe tables that no longer exist — `inventory_items`, `inventory_unit_conversions`, `routing_nodes`, `routing_edges`, `routing_materials`. Stocked items are now `parts` rows with `is_stocked = true`; routings use `routing_operations`; materials live on `parts_bom`. Do not use this file as a schema reference — see [Inventory](inventory.md), [Routings](routings.md) and [`architecture.md`](../architecture.md).

## 1. Overview

Provide every new user with an isolated sandbox environment pre-populated with realistic manufacturing data to explore Jigged risk-free. Establish platform-level administrative capabilities required to manage demo templates.

### Problem Statement

- New users have no safe way to explore features before committing real data
- Learning curve is steep without example data to reference
- No distinction between company admins and platform-level administrators who manage the entire system

### Solution

1. Create a `system_admins` infrastructure for platform-wide privileges (template management)
2. Every new user automatically receives a personal demo company with realistic mock data that can be reset at any time

### Role Model

The `user_company_access.role` CHECK constraint allows 4 roles:

```
owner, admin, user, operator
```

This PRD uses the `owner` and `operator` roles. The demo company owner receives the `owner` role (matching the existing company creator pattern).

---

## 2. User Stories

### System Admin

- Create and update demo templates
- Set the active template version
- View template usage statistics (future: admin dashboard)

### All Users

- Automatically receive a personal demo company on signup
- Access demo data risk-free (no impact on real companies)
- Reset demo to its original state at any time
- Switch between real and demo companies seamlessly
- Interact with demo operators (view operator sessions, see PIN-authenticated workflows)

---

## 3. Feature Specifications

### 3.1 Demo Company Naming

Format: `"{User's First Name}'s Demo Shop"` (e.g., "John's Demo Shop")

Fallback if no first name available: `"Demo Shop"` (rename prompt on first visit — future enhancement)

### 3.2 Demo Data Included

| Entity | Count | Details |
|--------|-------|---------|
| Customers | 3 | Acme Manufacturing, Ajax Industries, Precision Corp |
| Parts | 6 | With pricing tiers across customers |
| Operation Types | 8 | With labor rates |
| Routings | 3 | With nodes and edges |
| Quotes | 5 | pending_approval, accepted statuses |
| Jobs | 4 | Not started, in_progress, completed statuses |
| Job Operations | 10+ | Across the 4 jobs |
| Inventory Items | 8 | With quantities and units |
| Demo Operators | 2 | Mike Johnson, Sarah Williams — with PIN codes |

### 3.3 Reset Behavior

1. Cascade-deletes all data in the demo company (except the `companies` row and `user_company_access` record)
2. Re-clones from the current active template
3. Preserves company name and user's access record
4. Target: < 3 seconds for the full reset cycle

> Demo companies do NOT count toward any future company limits.

### 3.4 Demo Operators

Demo operators are `user_company_access` records with `role = 'operator'` linked to dedicated `auth.users` entries.

**Auth approach:**
- Generated email addresses: `demo-{operatorSlug}-{userId}@demo.jigged.app` (e.g., `demo-mike-johnson-abc123@demo.jigged.app`)
- Auto-generated passwords (random 32-char strings — users never see these)
- Operators authenticate via the existing PIN-based operator auth (`api/utils/operator_auth.py`), not email/password
- PIN codes are stored as bcrypt hashes in `user_company_access.metadata` (or a dedicated `operator_pins` table if one exists)

**Interactive demo flow:**
- User navigates to the Operator View (`/operator/[companyId]`)
- Selects a demo operator from the list (Mike or Sarah)
- Enters the demo PIN (displayed in a help tooltip during demo: "Demo PIN: 1234")
- Operator JWT is generated via the existing `generate_operator_token()` flow
- User can complete operations, log time, etc. — all within the demo sandbox

> **Key insight:** Operator auth uses its own JWT tokens (`api/utils/operator_auth.py`), completely separate from Supabase Auth sessions. The admin user's session is never affected.

---

## 4. Database Schema

### 4.1 New Table: `system_admins`

```sql
CREATE TABLE system_admins (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    created_by UUID REFERENCES auth.users(id),
    UNIQUE(user_id)
);

-- RLS
ALTER TABLE system_admins ENABLE ROW LEVEL SECURITY;

CREATE POLICY "System admins can read system_admins"
    ON system_admins FOR SELECT
    USING (is_system_admin(auth.uid()));

CREATE POLICY "System admins can insert system_admins"
    ON system_admins FOR INSERT
    WITH CHECK (is_system_admin(auth.uid()));
```

### 4.2 Helper Function: `is_system_admin()`

```sql
CREATE OR REPLACE FUNCTION is_system_admin(check_user_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER  -- Required: must bypass RLS on system_admins table
SET search_path = public
AS $$
    SELECT EXISTS (
        SELECT 1 FROM system_admins WHERE user_id = check_user_id
    );
$$;
```

> **`SECURITY DEFINER` rationale:** RLS on `system_admins` restricts reads to system admins. But `is_system_admin()` must read this table to determine if someone *is* an admin — a chicken-and-egg problem. `SECURITY DEFINER` causes the function to execute with the permissions of the function creator (superuser), bypassing RLS. `SET search_path = public` prevents search-path attacks.

### 4.3 Bootstrap Process

The first system admin must be inserted directly via SQL (Supabase SQL Editor or migration):

```sql
-- Bootstrap: Add first system admin
-- Replace USER_ID with the actual auth.users UUID
INSERT INTO system_admins (user_id, created_by)
VALUES ('USER_ID_HERE', 'USER_ID_HERE');
```

A bootstrap script should be added to `scripts/bootstrap-admin.sql` with instructions.

### 4.4 New Table: `demo_templates`

```sql
CREATE TABLE demo_templates (
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
ALTER TABLE demo_templates ENABLE ROW LEVEL SECURITY;

CREATE POLICY "System admins can manage demo_templates"
    ON demo_templates FOR ALL
    USING (is_system_admin(auth.uid()));

CREATE POLICY "All authenticated users can read active templates"
    ON demo_templates FOR SELECT
    USING (is_active = TRUE);
```

### 4.5 `template_data` JSONB Schema

The template stores data for each entity type, keyed by table name. Each entity has a **template-local ID** (a short string like `"cust-1"`) used for FK cross-references within the template. During cloning, these are mapped to real UUIDs.

```jsonb
{
  "version": 1,
  "schema_version": "2026-02-20",
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
    },
    { "_ref": "cust-2", "name": "Ajax Industries", "..." : "..." },
    { "_ref": "cust-3", "name": "Precision Corp", "..." : "..." }
  ],
  "operation_types": [
    {
      "_ref": "op-1",
      "name": "CNC Milling",
      "labor_rate": 85.00
    }
  ],
  "parts": [
    {
      "_ref": "part-1",
      "part_name": "ACM-001",
      "description": "Precision Bracket",
      "customer_ref": "cust-1",
      "pricing": [{"quantity": 1, "unit_price": 150.00}, {"quantity": 100, "unit_price": 120.00}]
    }
  ],
  "routings": [
    {
      "_ref": "routing-1",
      "name": "Bracket Standard Routing",
      "part_ref": "part-1",
      "nodes": [
        {
          "_ref": "node-1",
          "operation_type_ref": "op-1",
          "run_time_per_unit": 0.5,
          "instructions": "Mill to spec per drawing ACM-001-R3"
        }
      ],
      "edges": [
        { "source_ref": "node-1", "target_ref": "node-2" }
      ]
    }
  ],
  "inventory_items": [
    {
      "_ref": "inv-1",
      "name": "6061 Aluminum Bar Stock",
      "primary_unit": "inches",
      "quantity": 240,
      "cost_per_unit": 3.50
    }
  ],
  "quotes": [
    {
      "_ref": "quote-1",
      "quote_number": "Q-DEMO-001",
      "customer_ref": "cust-1",
      "part_ref": "part-1",
      "routing_ref": "routing-1",
      "quantity": 50,
      "unit_price": 130.00,
      "total_price": 6500.00,
      "status": "accepted"
    }
  ],
  "jobs": [
    {
      "_ref": "job-1",
      "job_number": "J-DEMO-001",
      "customer_ref": "cust-1",
      "part_ref": "part-1",
      "quote_ref": "quote-1",
      "routing_ref": "routing-1",
      "status": "in_progress",
      "operations": [
        {
          "_ref": "jop-1",
          "sequence": 1,
          "operation_name": "CNC Milling",
          "operation_type_ref": "op-1",
          "estimated_run_hours_per_unit": 0.5,
          "quantity_completed": 20,
          "status": "in_progress"
        }
      ]
    }
  ],
  "operators": [
    {
      "_ref": "operator-1",
      "name": "Mike Johnson",
      "email_slug": "mike-johnson",
      "pin": "1234"
    },
    {
      "_ref": "operator-2",
      "name": "Sarah Williams",
      "email_slug": "sarah-williams",
      "pin": "5678"
    }
  ]
}
```

### 4.6 Companies Table Modifications

```sql
ALTER TABLE companies ADD COLUMN is_demo BOOLEAN DEFAULT FALSE;
ALTER TABLE companies ADD COLUMN demo_template_id UUID REFERENCES demo_templates(id);
ALTER TABLE companies ADD COLUMN demo_owner_id UUID REFERENCES auth.users(id);
```

### 4.7 RLS Considerations for `is_demo`

- Demo companies follow the same RLS policies as real companies (access via `user_company_access`)
- Demo data cannot be exported (future: block export API for `is_demo = TRUE`)
- Demo companies cannot be "promoted" to real companies (data is synthetic)

---

## 5. Database Functions

### 5.1 `clone_demo_company()`

```sql
CREATE OR REPLACE FUNCTION clone_demo_company(
    p_user_id UUID,
    p_template_name VARCHAR DEFAULT 'default'
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_template_id UUID;
    v_template JSONB;
    v_company_id UUID;
    v_user_name TEXT;
    v_ref_map JSONB := '{}';  -- Maps "_ref" strings to real UUIDs
    v_item JSONB;
    v_new_id UUID;
    v_node JSONB;
    v_edge JSONB;
    v_op JSONB;
    v_operator JSONB;
    v_operator_user_id UUID;
    v_pin_hash TEXT;
BEGIN
    -- 1. Get active template
    SELECT id, template_data INTO v_template_id, v_template
    FROM demo_templates
    WHERE name = p_template_name AND is_active = TRUE
    LIMIT 1;

    IF v_template_id IS NULL THEN
        RAISE EXCEPTION 'No active demo template found for name: %', p_template_name;
    END IF;

    -- 2. Get user's display name
    SELECT raw_user_meta_data->>'name'
    INTO v_user_name
    FROM auth.users WHERE id = p_user_id;

    v_user_name := COALESCE(v_user_name, 'Demo');

    -- 3. Create demo company
    INSERT INTO companies (name, is_demo, demo_template_id, demo_owner_id)
    VALUES (v_user_name || '''s Demo Shop', TRUE, v_template_id, p_user_id)
    RETURNING id INTO v_company_id;

    -- 4. Create user_company_access (owner role)
    INSERT INTO user_company_access (user_id, company_id, role, name)
    VALUES (p_user_id, v_company_id, 'owner', v_user_name);

    -- 5. Insert customers (no FK deps besides company_id)
    FOR v_item IN SELECT * FROM jsonb_array_elements(v_template->'customers')
    LOOP
        v_new_id := gen_random_uuid();
        v_ref_map := jsonb_set(v_ref_map, ARRAY[v_item->>'_ref'], to_jsonb(v_new_id::TEXT));

        INSERT INTO customers (id, company_id, name, contact_name, contact_email,
                               contact_phone, city, state, country)
        VALUES (v_new_id, v_company_id,
                v_item->>'name', v_item->>'contact_name', v_item->>'contact_email',
                v_item->>'contact_phone', v_item->>'city', v_item->>'state',
                COALESCE(v_item->>'country', 'USA'));
    END LOOP;

    -- 6. Insert operation_types (no FK deps besides company_id)
    FOR v_item IN SELECT * FROM jsonb_array_elements(v_template->'operation_types')
    LOOP
        v_new_id := gen_random_uuid();
        v_ref_map := jsonb_set(v_ref_map, ARRAY[v_item->>'_ref'], to_jsonb(v_new_id::TEXT));

        INSERT INTO operation_types (id, company_id, name, labor_rate, description)
        VALUES (v_new_id, v_company_id,
                v_item->>'name',
                (v_item->>'labor_rate')::NUMERIC,
                v_item->>'description');
    END LOOP;

    -- 7. Insert parts (depends on customers)
    FOR v_item IN SELECT * FROM jsonb_array_elements(v_template->'parts')
    LOOP
        v_new_id := gen_random_uuid();
        v_ref_map := jsonb_set(v_ref_map, ARRAY[v_item->>'_ref'], to_jsonb(v_new_id::TEXT));

        INSERT INTO parts (id, company_id, customer_id, part_name, description, pricing)
        VALUES (v_new_id, v_company_id,
                (v_ref_map->>(v_item->>'customer_ref'))::UUID,
                v_item->>'part_name',
                v_item->>'description',
                COALESCE(v_item->'pricing', '[]'::JSONB));
    END LOOP;

    -- 9. Insert inventory_items (no FK deps besides company_id)
    FOR v_item IN SELECT * FROM jsonb_array_elements(v_template->'inventory_items')
    LOOP
        v_new_id := gen_random_uuid();
        v_ref_map := jsonb_set(v_ref_map, ARRAY[v_item->>'_ref'], to_jsonb(v_new_id::TEXT));

        INSERT INTO inventory_items (id, company_id, name, primary_unit, quantity, cost_per_unit)
        VALUES (v_new_id, v_company_id,
                v_item->>'name', v_item->>'primary_unit',
                COALESCE((v_item->>'quantity')::NUMERIC, 0),
                (v_item->>'cost_per_unit')::NUMERIC);
    END LOOP;

    -- 10. Insert routings + nodes + edges (depends on parts, operation_types)
    FOR v_item IN SELECT * FROM jsonb_array_elements(v_template->'routings')
    LOOP
        v_new_id := gen_random_uuid();
        v_ref_map := jsonb_set(v_ref_map, ARRAY[v_item->>'_ref'], to_jsonb(v_new_id::TEXT));

        INSERT INTO routings (id, company_id, part_id, name, description, created_by)
        VALUES (v_new_id, v_company_id,
                (v_ref_map->>(v_item->>'part_ref'))::UUID,
                v_item->>'name', v_item->>'description', p_user_id);

        -- Insert nodes for this routing
        IF v_item->'nodes' IS NOT NULL THEN
            FOR v_node IN SELECT * FROM jsonb_array_elements(v_item->'nodes')
            LOOP
                v_new_id := gen_random_uuid();
                v_ref_map := jsonb_set(v_ref_map, ARRAY[v_node->>'_ref'], to_jsonb(v_new_id::TEXT));

                INSERT INTO routing_nodes (id, routing_id, operation_type_id,
                                           run_time_per_unit, instructions, materials)
                VALUES (v_new_id,
                        (v_ref_map->>(v_item->>'_ref'))::UUID,
                        (v_ref_map->>(v_node->>'operation_type_ref'))::UUID,
                        (v_node->>'run_time_per_unit')::NUMERIC,
                        v_node->>'instructions',
                        COALESCE(v_node->'materials', '[]'::JSONB));
            END LOOP;
        END IF;

        -- Insert edges for this routing
        IF v_item->'edges' IS NOT NULL THEN
            FOR v_edge IN SELECT * FROM jsonb_array_elements(v_item->'edges')
            LOOP
                INSERT INTO routing_edges (routing_id, source_node_id, target_node_id)
                VALUES (
                    (v_ref_map->>(v_item->>'_ref'))::UUID,
                    (v_ref_map->>(v_edge->>'source_ref'))::UUID,
                    (v_ref_map->>(v_edge->>'target_ref'))::UUID
                );
            END LOOP;
        END IF;
    END LOOP;

    -- 11. Insert quotes (depends on customers, parts, routings)
    FOR v_item IN SELECT * FROM jsonb_array_elements(v_template->'quotes')
    LOOP
        v_new_id := gen_random_uuid();
        v_ref_map := jsonb_set(v_ref_map, ARRAY[v_item->>'_ref'], to_jsonb(v_new_id::TEXT));

        INSERT INTO quotes (id, company_id, quote_number, customer_id, part_id,
                            routing_id, quantity, unit_price, total_price, status, created_by)
        VALUES (v_new_id, v_company_id,
                v_item->>'quote_number',
                (v_ref_map->>(v_item->>'customer_ref'))::UUID,
                (v_ref_map->>(v_item->>'part_ref'))::UUID,
                (v_ref_map->>(v_item->>'routing_ref'))::UUID,
                COALESCE((v_item->>'quantity')::INTEGER, 1),
                (v_item->>'unit_price')::NUMERIC,
                (v_item->>'total_price')::NUMERIC,
                COALESCE(v_item->>'status', 'draft'),
                p_user_id);
    END LOOP;

    -- 12. Insert jobs + job_operations (depends on customers, parts, quotes, routings)
    FOR v_item IN SELECT * FROM jsonb_array_elements(v_template->'jobs')
    LOOP
        v_new_id := gen_random_uuid();
        v_ref_map := jsonb_set(v_ref_map, ARRAY[v_item->>'_ref'], to_jsonb(v_new_id::TEXT));

        INSERT INTO jobs (id, company_id, job_number, customer_id, part_id,
                          quote_id, routing_id, description, status, created_by)
        VALUES (v_new_id, v_company_id,
                v_item->>'job_number',
                (v_ref_map->>(v_item->>'customer_ref'))::UUID,
                (v_ref_map->>(v_item->>'part_ref'))::UUID,
                (v_ref_map->>(v_item->>'quote_ref'))::UUID,
                (v_ref_map->>(v_item->>'routing_ref'))::UUID,
                v_item->>'description',
                COALESCE(v_item->>'status', 'not_started'),
                p_user_id);

        -- Insert job_operations
        IF v_item->'operations' IS NOT NULL THEN
            FOR v_op IN SELECT * FROM jsonb_array_elements(v_item->'operations')
            LOOP
                v_new_id := gen_random_uuid();
                v_ref_map := jsonb_set(v_ref_map, ARRAY[v_op->>'_ref'], to_jsonb(v_new_id::TEXT));

                INSERT INTO job_operations (id, job_id, sequence, operation_name,
                                            operation_type_id, estimated_run_hours_per_unit,
                                            quantity_completed, status)
                VALUES (v_new_id,
                        (v_ref_map->>(v_item->>'_ref'))::UUID,
                        (v_op->>'sequence')::INTEGER,
                        v_op->>'operation_name',
                        (v_ref_map->>(v_op->>'operation_type_ref'))::UUID,
                        (v_op->>'estimated_run_hours_per_unit')::NUMERIC,
                        COALESCE((v_op->>'quantity_completed')::INTEGER, 0),
                        COALESCE(v_op->>'status', 'pending'));
            END LOOP;
        END IF;
    END LOOP;

    -- 13. Create demo operators
    IF v_template->'operators' IS NOT NULL THEN
        FOR v_operator IN SELECT * FROM jsonb_array_elements(v_template->'operators')
        LOOP
            -- Create auth.users entry for the operator
            -- Note: This requires SECURITY DEFINER and service-role access
            -- In practice, operator creation should go through the Supabase Admin API
            -- from the FastAPI layer. The DB function records the access + PIN;
            -- the API layer handles auth.users creation.

            -- Create user_company_access for operator
            -- (operator_user_id will be passed from the API layer after creating auth.users)
            -- See API section for the full operator creation flow.
            NULL; -- Placeholder: operator creation handled by API layer
        END LOOP;
    END IF;

    RETURN v_company_id;
END;
$$;
```

**Table insertion order** (respects FK dependencies):

```
1. companies           (root)
2. user_company_access  (depends on: companies)
3. customers            (depends on: companies)
4. operation_types      (depends on: companies)
5. parts                (depends on: companies, customers)
6. inventory_items      (depends on: companies)
7. routings             (depends on: companies, parts)
8. routing_nodes        (depends on: routings, operation_types)
9. routing_edges        (depends on: routings, routing_nodes)
10. quotes              (depends on: companies, customers, parts, routings)
11. jobs                (depends on: companies, customers, parts, quotes, routings)
12. job_operations      (depends on: jobs, operation_types)
13. operators           (via API — auth.users + user_company_access)
```

### 5.2 `reset_demo_company()`

```sql
CREATE OR REPLACE FUNCTION reset_demo_company(p_company_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_template_id UUID;
    v_owner_id UUID;
    v_is_demo BOOLEAN;
BEGIN
    -- 1. Verify this is a demo company
    SELECT is_demo, demo_template_id, demo_owner_id
    INTO v_is_demo, v_template_id, v_owner_id
    FROM companies
    WHERE id = p_company_id;

    IF NOT v_is_demo THEN
        RAISE EXCEPTION 'Cannot reset: company % is not a demo company', p_company_id;
    END IF;

    -- 2. Delete all company data (CASCADE handles dependent tables)
    -- Delete in reverse FK order for tables that don't CASCADE automatically
    DELETE FROM inventory_transactions WHERE company_id = p_company_id;
    DELETE FROM operator_sessions WHERE company_id = p_company_id;
    DELETE FROM jobs WHERE company_id = p_company_id;
    -- (job_parts, job_operations, job_materials cascade-deleted via jobs)
    DELETE FROM quotes WHERE company_id = p_company_id;
    DELETE FROM routings WHERE company_id = p_company_id;
    -- (routing_nodes, routing_edges cascade-deleted via routings)
    DELETE FROM parts WHERE company_id = p_company_id;
    DELETE FROM inventory_items WHERE company_id = p_company_id;
    -- (inventory_unit_conversions cascade-deleted via inventory_items)
    DELETE FROM operation_types WHERE company_id = p_company_id;
    DELETE FROM customers WHERE company_id = p_company_id;

    -- Delete demo operator user_company_access (but NOT the owner's)
    DELETE FROM user_company_access
    WHERE company_id = p_company_id AND user_id != v_owner_id;

    -- 3. Re-clone from template
    -- Note: This calls the same logic as clone_demo_company but skips
    -- company creation and owner access creation.
    -- Implementation: extract shared logic into _populate_demo_company()
    PERFORM _populate_demo_company(p_company_id, v_owner_id, v_template_id);
END;
$$;
```

> **Performance note:** For the demo dataset (~50 rows across all tables), cascade deletes + re-inserts should complete well within 3 seconds. If performance becomes a concern, consider using `TRUNCATE ... CASCADE` (requires superuser) or a dedicated `_populate_demo_company()` helper to avoid code duplication.

### 5.3 Shared Helper: `_populate_demo_company()`

Extract the data insertion logic (steps 5-13 from `clone_demo_company`) into a private helper function:

```sql
CREATE OR REPLACE FUNCTION _populate_demo_company(
    p_company_id UUID,
    p_user_id UUID,
    p_template_id UUID
) RETURNS VOID
-- Contains the shared insertion logic used by both clone and reset
```

This avoids duplicating ~200 lines of insertion code between `clone_demo_company()` and `reset_demo_company()`.

---

## 6. User Flows

### 6.1 Demo Creation on Signup

```
User completes signup
    → Email verification completed
    → Supabase Auth triggers webhook to POST /api/demo/create
    → API validates auth, calls clone_demo_company(user_id)
    → API creates demo operators via Supabase Admin API
    → Demo company created with user's name
    → user_company_access record created (role: owner)
    → getPostLoginRoute() returns /dashboard/{demoCompanyId}
    → User lands on demo dashboard with DemoBanner visible
```

**Signup hook mechanism:** A Supabase Database Webhook on `auth.users` INSERT triggers a call to the FastAPI endpoint `POST /api/demo/create`. This is preferred over an Edge Function or in-app trigger because:

1. It runs server-side with service role access (needed for operator creation)
2. It decouples demo creation from the frontend auth flow
3. It works regardless of how the user was created (direct signup, invitation acceptance, etc.)

**Alternative approach:** If Supabase webhooks are unreliable, use a synchronous call from `getPostLoginRoute()` — check if user has any companies, and if not, call the demo creation API before routing.

### 6.2 Demo Reset Flow

```
User clicks "Reset Demo" button (in DemoBanner or Settings)
    → Confirmation modal: "This will delete all your changes and restore the original demo data."
    → User confirms
    → Loading spinner shown
    → POST /api/demo/reset/{company_id}
    → API calls reset_demo_company()
    → API re-creates demo operators
    → Page reloads with fresh data
    → Success toast: "Demo has been reset"
```

### 6.3 Company Switching (Demo vs Real)

- Company switcher in the sidebar shows all companies
- Demo companies display a "(Demo)" suffix and a distinct icon/color badge
- Switching between demo and real companies uses the existing company switching flow
- `user_preferences.last_company_id` is updated on switch

---

## 7. UI Components

### 7.1 DemoBanner

A sticky banner at the top of the dashboard when viewing a demo company.

```
┌──────────────────────────────────────────────────────────┐
│  🏭  You're viewing your demo company.  [Reset Demo]     │
└──────────────────────────────────────────────────────────┘
```

- Appears on all pages when `company.is_demo === true`
- Contains "Reset Demo" button (opens confirmation dialog)
- Uses MUI `Alert` component with `severity="info"` and custom styling
- Positioned below the Header component, above page content

### 7.2 DemoResetButton

- Appears in DemoBanner and in company Settings page
- Opens confirmation dialog before executing reset
- Shows `CircularProgress` during reset
- Disabled while reset is in progress

### 7.3 Company Switcher Enhancement

- Demo company shows "(Demo)" suffix in dropdown
- Different icon or color badge for demo companies
- Demo company is visually distinct but not hidden

### 7.4 Pages

No new pages required. Demo features integrate into existing pages:

- Dashboard pages: DemoBanner injected conditionally
- Settings page: DemoResetButton added
- Company switcher: Enhanced with demo badge

---

## 8. API Endpoints

All endpoints are **FastAPI routes** registered in `api/index.py`. They use the Supabase service role client for database operations and verify the calling user's identity via the Supabase JWT from the request headers.

### 8.1 `POST /api/demo/create`

Creates a demo company for the authenticated user.

- **Auth:** Supabase JWT (any authenticated user)
- **Logic:**
  1. Extract user_id from JWT
  2. Check if user already has a demo company (`SELECT FROM companies WHERE demo_owner_id = user_id AND is_demo = TRUE`)
  3. If exists, return existing company_id
  4. Call `clone_demo_company(user_id)`
  5. Create demo operators via Supabase Admin API (`supabase.auth.admin.createUser()`)
  6. Create `user_company_access` records for operators
  7. Hash and store operator PINs
  8. Return `{ company_id, company_name }`

### 8.2 `POST /api/demo/reset/{company_id}`

Resets a demo company to its template state.

- **Auth:** Supabase JWT (must be the demo_owner_id)
- **Logic:**
  1. Verify company is demo and caller is owner
  2. Delete existing demo operator auth.users entries
  3. Call `reset_demo_company(company_id)`
  4. Re-create demo operators (new auth.users entries)
  5. Return `{ success: true }`

### 8.3 `GET /api/demo/templates` (System Admin)

List all demo templates.

- **Auth:** Supabase JWT + `is_system_admin()` check

### 8.4 `POST /api/demo/templates` (System Admin)

Create a new demo template.

- **Auth:** Supabase JWT + `is_system_admin()` check

### 8.5 `PUT /api/demo/templates/{id}/activate` (System Admin)

Set a template as the active template (deactivates all others with the same name).

- **Auth:** Supabase JWT + `is_system_admin()` check

---

## 9. Template Versioning & Schema Evolution

### Problem

When the database schema changes (e.g., a migration adds `materials` to `routing_nodes` or drops `setup_time`), existing template data becomes stale.

### Strategy

1. **`schema_version` field:** Each template includes a `schema_version` string (date-based, e.g., `"2026-02-20"`) matching the schema version it was created for.

2. **Validation on clone:** `clone_demo_company()` should gracefully handle missing optional fields by using `COALESCE` defaults. New required columns must be added to the template data.

3. **Template update process:**
   - When a schema migration is applied, check if the active template's `schema_version` is older
   - If so, update the template JSONB to include new fields and increment the version number
   - This is a manual process performed by system admins
   - Future enhancement: automated template validation script that compares template fields against the actual schema

4. **Backward compatibility:** The clone function uses `COALESCE` for all optional fields, so templates with missing new fields will still clone successfully (with default values).

---

## 10. Migration Plan for Existing Users

### Scenario: Demo feature deployed after users already exist

1. **New signups:** Automatically receive demo company (via webhook/API)
2. **Existing users without demo:** Two options:
   - **Option A (Recommended):** Lazy creation — on next login, `getPostLoginRoute()` checks if user has a demo company. If not, calls `POST /api/demo/create` before routing. Transparent to the user.
   - **Option B:** Batch migration — run a one-time script that creates demo companies for all existing users. More complex, but ensures all users have demo on next visit.

### Implementation (Option A)

Add to `getPostLoginRoute()` in `utils/companyAccess.ts`:

```typescript
// After fetching companies, check if user has a demo company
const hasDemoCompany = companies.some(c => c.companies.is_demo);
if (!hasDemoCompany) {
  // Create demo company for this user
  await fetch('/api/demo/create', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` }
  });
  // Re-fetch companies
  companies = await getUserCompanies(userId);
}
```

---

## 11. Testing Strategy

### Unit Tests

| Test | Description |
|------|-------------|
| `is_system_admin()` | Returns true for admins, false for non-admins, handles null |
| `clone_demo_company()` | Creates company with correct name, all entities inserted, FK refs mapped correctly, operator access created |
| `reset_demo_company()` | Deletes all data, re-populates, preserves owner access, rejects non-demo companies |
| `_populate_demo_company()` | Correct entity counts, correct FK relationships |
| Template JSONB validation | Schema matches expected structure, _ref values are unique, all refs resolve |

### Integration Tests

| Test | Description |
|------|-------------|
| Signup → Demo creation | New user gets demo company, lands on dashboard |
| Demo reset flow | Reset button → confirmation → loading → fresh data |
| Company switching | Switch between demo and real, correct DemoBanner state |
| Demo operator auth | PIN entry → operator JWT → can view jobs |
| Existing user migration | User without demo gets one on next login |

### Performance Tests

| Test | Target |
|------|--------|
| `clone_demo_company()` | < 2 seconds |
| `reset_demo_company()` | < 3 seconds |
| Demo dataset row count | ~50 rows across all tables |

---

## 12. Acceptance Criteria

> **SUPERSEDED — historical, not verifiable.** This checklist describes the v1 Demo Company design, which was never built and does not ship. None of the artifacts below exist in the codebase (`demo_templates`, `clone_demo_company()`, `companies.demo_template_id`/`demo_owner_id`, `DemoBanner`, the `/api/demo/*` routes, PIN-authenticated demo operators). The shipping feature is [Demo Mode](./demo-mode.md) — see its §12 for the live acceptance criteria and `docs/testing/divergence/demo-company.md` for the supersession evidence. The items are kept below verbatim for historical record only.

- ~~`system_admins` table exists with RLS policies~~ *(revived under Demo Mode)*
- ~~`is_system_admin()` function works correctly with `SECURITY DEFINER`~~ *(revived under Demo Mode)*
- ~~At least one bootstrap admin can be added via direct SQL~~
- ~~`demo_templates` table exists with RLS policies~~ *(v3 renamed → `demo_data_templates`)*
- ~~`template_data` JSONB follows defined schema with `_ref` cross-references~~ *(v3 schema differs)*
- ~~`companies` table has `is_demo`, `demo_template_id`, `demo_owner_id` columns~~ *(v3 uses `is_demo` + `demo_company_id`)*
- ~~`clone_demo_company()` creates a fully populated demo company~~ *(never built; v3 = `create_demo_company()`)*
- ~~`reset_demo_company()` deletes and re-populates within 3 seconds~~ *(v3 signature differs)*
- ~~Signup flow creates demo company automatically~~ *(v3 = lazy, user-initiated from Settings)*
- ~~Demo operators can be authenticated via PIN in Operator View~~ *(not built; v3 mirrors access instead)*
- ~~DemoBanner displays when viewing a demo company~~ *(v3 = `DemoModeBanner`)*
- ~~Demo company appears in company switcher with "(Demo)" badge~~ *(v3 hides the demo company)*
- ~~Reset Demo button works with confirmation dialog~~ *(shipped under Demo Mode)*
- ~~Existing users receive demo company on next login (lazy creation)~~ *(v3 = onboarding card / Settings)*
- ~~Template versioning handles schema evolution gracefully~~

---

## 13. Open Questions (Resolved)

| # | Question | Resolution |
|---|----------|------------|
| 1 | Should demo companies count toward any limits? | No |
| 2 | Should demo operators be interactive? | Yes — via existing PIN auth + operator JWT |
| 3 | JSONB template vs programmatic seeder? | JSONB template with `_ref` mapping. Easier to version and manage via admin UI. Seeder approach rejected: harder to manage templates through a UI, and template data is small enough that JSONB is practical. |
| 4 | Demo user role: `owner` or `admin`? | `owner` — matches the existing company creator pattern. `is_company_admin()` already checks for both `owner` and `admin`. |
| 5 | How do demo operators auth without email/password? | PIN auth is already separate from Supabase Auth sessions. Generate throwaway `auth.users` entries for operator records; users interact via PIN only. |
| 6 | Where does demo creation trigger? | Supabase Database Webhook on `auth.users` INSERT → `POST /api/demo/create`. Fallback: lazy creation in `getPostLoginRoute()`. |

---

## 14. Dependencies

- **None on [Invitation System](./invitation-system.md):** Demo Company is fully independent. The Invitation System may optionally call `POST /api/demo/create` after invitation acceptance, but this is additive and not required.
- **Supabase Database Webhooks:** Must be configured for the signup hook. If unavailable, the lazy creation fallback in `getPostLoginRoute()` provides equivalent functionality.

---

## 15. Success Metrics

- **Demo engagement:** % of users who interact with demo data before creating real data
- **Demo reset usage:** Frequency of demo resets (indicates exploration behavior)
- **Time to first real job:** How quickly users go from signup to creating real jobs
- **Demo-to-real conversion:** % of users who create a real company after using demo
