# Sample Data

> **SUPERSEDED:** This PRD has been replaced by [Demo Mode](./demo-mode.md). The `is_sample` column approach was rejected due to the permanent query-filter tax it imposes on every query. The demo mode approach uses a hidden demo company with RLS-based isolation instead. This file is retained for historical reference only.

## 1. Overview

Provide users with pre-populated sample data they can browse within their own company to understand how Jigged works — without creating a separate demo company or mixing sample records with real data.

### Problem Statement

- New users face an empty dashboard with no reference for how the system looks when populated
- Learning the quote-to-job workflow is difficult without seeing example data
- A separate demo company creates permanent clutter in the company switcher and confuses the mental model

### Solution

1. Users can **load sample data** into their company — realistic manufacturing records (customers, parts, quotes, jobs, etc.) marked with `is_sample = TRUE`
2. A **view toggle** lets users switch between "My Company" (real data) and "Sample Data" views — never seeing both at once
3. Users can **clear sample data** with one action when they no longer need it

### Why Not a Separate Demo Company?

With a freemium model (free beta / 3-month trial), the user's real company IS the trial. A separate demo company:
- Adds permanent UI clutter (extra entry in company switcher)
- Creates confusion about which company they're "supposed" to use
- Requires lifecycle management (archiving, hiding, deleting)

Sample data within the same company provides the same exploration value with zero clutter. The view toggle ensures complete separation — users never have to figure out "is this record sample or real?"

---

## 2. User Stories

### Company Owner

- Load sample data during onboarding or from settings
- Toggle between "My Company" and "Sample Data" views
- Browse sample customers, parts, quotes, jobs, and routings to understand the system
- Test the operator view by logging in as a real operator and switching to Sample Data view
- Clear all sample data with one click when ready to focus on real data

### System Admin (Platform)

- Create and update sample data templates
- Set the active template version
- Manage template versioning as schema evolves

---

## 3. Feature Specifications

### 3.1 Sample Data Included

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

### 3.2 View Toggle Behavior

Users switch between two modes via the **Settings page** or the **Sample Data banner** (which appears on every page in Sample Data mode):

| Mode | What's Shown | CRUD Available | When |
|------|-------------|----------------|------|
| **My Company** (default) | Real data only (`is_sample = FALSE`) | Full CRUD — creates real records | Always |
| **Sample Data** | Sample data only (`is_sample = TRUE`) | Full CRUD — creates/edits sample records | Only when sample data is loaded |

**Key behaviors:**

- Default mode is always "My Company"
- View switching is available from Settings (load/view/clear controls) and the Sample Data banner ("Back to My Company" link)
- In Sample Data mode, all CRUD operations work normally — but any records created or modified are tagged `is_sample = TRUE`
- Users can practice the full workflow: create a quote from a sample customer, convert it to a job, edit a routing, adjust inventory
- Navigation between records works normally (click a customer → see their parts → see their quotes)
- The Operator View respects the view toggle — real operators see sample jobs/operations when in Sample Data mode
- Admins testing the operator flow create a real operator account, log in via PIN, then switch to Sample Data view
- "Clear Sample Data" removes everything (template records + user-created sample records)
- "Reset Sample Data" restores back to the original template state (discards user edits, re-loads from template)

### 3.3 Data Isolation

The view toggle prevents any cross-contamination between sample and real data:

- **In "My Company" mode:** All queries filter `is_sample = FALSE`. Sample entities never appear in dropdowns, selectors, or search results. Users cannot accidentally create a real quote referencing a sample customer — those entities simply don't exist in this view.
- **In "Sample Data" mode:** All queries filter `is_sample = TRUE`. Any records created or modified in this mode are automatically tagged `is_sample = TRUE`. Users can practice the full workflow (create quotes, jobs, edit routings) without any impact on real company data.
- **No FK conflicts:** Sample records reference other sample records. Real records reference other real records. The two graphs never connect because entity selectors (customer dropdown, part picker, etc.) only show records matching the current view mode.
- **Full sandbox:** Clearing sample data removes everything — both the original template data and any records the user created while exploring. Resetting restores just the original template.

> This is enforced by the application layer (query filters), not RLS. RLS continues to enforce company-level isolation as before.

### 3.4 Load Sample Data

- Available during onboarding (first login) and from Settings page
- Inserts all sample records with `is_sample = TRUE` into the user's company
- Sets `companies.has_sample_data = TRUE`
- After loading, automatically switches to Sample Data view so user sees the populated data
- Idempotent: if sample data already exists, no-op (return existing)

### 3.5 Clear Sample Data

- Available from the Sample Data banner and Settings page
- Confirmation dialog: "This will permanently remove all sample data. Your company data is not affected."
- Deletes all records where `is_sample = TRUE` for the company (template data + user-created sample records)
- Sets `companies.has_sample_data = FALSE`
- Switches view back to "My Company"
- The Settings page shows "Not loaded" status and the "Load Sample Data" button reappears

### 3.6 Reset Sample Data

- Available from the Sample Data banner and Settings page (only when sample data is loaded)
- Confirmation dialog: "This will restore sample data to its original state. Any changes you made to sample data will be lost."
- Deletes all `is_sample = TRUE` records, then re-loads from the active template
- Useful when users have experimented with sample data and want a fresh starting point
- Implementation: calls `clear_sample_data()` followed by `load_sample_data()` within a transaction

### 3.7 Operator View with Sample Data

No sample operators are created. Real operators (or admins testing the operator flow) interact with sample data by switching to Sample Data view:

1. Admin creates a real operator account (via existing team management)
2. Operator logs in via PIN as normal
3. Operator (or admin testing as operator) switches view toggle to "Sample Data"
4. Sample jobs and operations appear — operator can browse the full workflow

This avoids the complexity of generating throwaway `auth.users` entries, fake emails, and synthetic PINs. The sample data demonstrates the *data flow* (jobs, operations, statuses), not the authentication mechanism.

> Sample data does NOT count toward any future usage limits or billing.

---

## 4. Database Schema

### 4.1 `is_sample` Column on Data Tables

Add `is_sample BOOLEAN DEFAULT FALSE` to all data tables:

```sql
ALTER TABLE customers ADD COLUMN is_sample BOOLEAN DEFAULT FALSE;
ALTER TABLE parts ADD COLUMN is_sample BOOLEAN DEFAULT FALSE;
ALTER TABLE resource_groups ADD COLUMN is_sample BOOLEAN DEFAULT FALSE;
ALTER TABLE operation_types ADD COLUMN is_sample BOOLEAN DEFAULT FALSE;
ALTER TABLE routings ADD COLUMN is_sample BOOLEAN DEFAULT FALSE;
ALTER TABLE routing_nodes ADD COLUMN is_sample BOOLEAN DEFAULT FALSE;
ALTER TABLE routing_edges ADD COLUMN is_sample BOOLEAN DEFAULT FALSE;
ALTER TABLE quotes ADD COLUMN is_sample BOOLEAN DEFAULT FALSE;
ALTER TABLE jobs ADD COLUMN is_sample BOOLEAN DEFAULT FALSE;
ALTER TABLE job_operations ADD COLUMN is_sample BOOLEAN DEFAULT FALSE;
ALTER TABLE inventory_items ADD COLUMN is_sample BOOLEAN DEFAULT FALSE;
```

> **Migration note:** Adding a boolean column with a default value is a non-blocking operation in PostgreSQL — no table rewrite required.

**Index for query performance:**

```sql
-- Partial indexes for efficient filtering
CREATE INDEX idx_customers_sample ON customers(company_id) WHERE is_sample = TRUE;
CREATE INDEX idx_parts_sample ON parts(company_id) WHERE is_sample = TRUE;
CREATE INDEX idx_jobs_sample ON jobs(company_id) WHERE is_sample = TRUE;
CREATE INDEX idx_quotes_sample ON quotes(company_id) WHERE is_sample = TRUE;
```

### 4.2 Companies Table Modification

```sql
ALTER TABLE companies ADD COLUMN has_sample_data BOOLEAN DEFAULT FALSE;
```

This is a quick-check flag so the UI knows whether to show the view toggle without querying data tables.

### 4.3 `sample_data_templates` Table

```sql
CREATE TABLE sample_data_templates (
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
ALTER TABLE sample_data_templates ENABLE ROW LEVEL SECURITY;

CREATE POLICY "System admins can manage sample_data_templates"
    ON sample_data_templates FOR ALL
    USING (is_system_admin(auth.uid()));

CREATE POLICY "All authenticated users can read active templates"
    ON sample_data_templates FOR SELECT
    USING (is_active = TRUE);
```

### 4.4 `template_data` JSONB Schema

Same structure as the previous demo company template — template-local `_ref` IDs mapped to real UUIDs during loading:

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
    { "_ref": "quote-1", "quote_number": "Q-SAMPLE-001", "customer_ref": "cust-1", "part_ref": "part-1", "routing_ref": "routing-1", "quantity": 50, "unit_price": 130.00, "total_price": 6500.00, "status": "accepted" }
  ],
  "jobs": [
    {
      "_ref": "job-1", "job_number": "J-SAMPLE-001", "customer_ref": "cust-1", "part_ref": "part-1", "quote_ref": "quote-1", "routing_ref": "routing-1", "status": "in_progress", "description": "Precision Brackets - 50 units",
      "operations": [
        { "_ref": "jop-1", "sequence": 1, "operation_name": "CNC Milling", "operation_type_ref": "op-1", "estimated_run_hours_per_unit": 0.5, "quantity_completed": 20, "status": "in_progress" }
      ]
    }
  ]
}
```

### 4.5 RLS Considerations

- Sample data follows the same RLS policies as real data (access via `user_company_access`)
- The `is_sample` filter is applied at the **application layer** (query parameter), not via RLS
- This keeps RLS policies simple and avoids coupling security to view-mode state

---

## 5. Database Functions

### 5.1 `load_sample_data()`

```sql
CREATE OR REPLACE FUNCTION load_sample_data(
    p_company_id UUID,
    p_user_id UUID,
    p_template_name VARCHAR DEFAULT 'default'
) RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_template_id UUID;
    v_template JSONB;
    v_has_sample BOOLEAN;
    v_ref_map JSONB := '{}';
    v_item JSONB;
    v_new_id UUID;
    v_node JSONB;
    v_edge JSONB;
    v_op JSONB;
BEGIN
    -- 1. Check if sample data already loaded
    SELECT has_sample_data INTO v_has_sample
    FROM companies WHERE id = p_company_id;

    IF v_has_sample THEN
        RETURN FALSE; -- Already loaded, no-op
    END IF;

    -- 2. Get active template
    SELECT id, template_data INTO v_template_id, v_template
    FROM sample_data_templates
    WHERE name = p_template_name AND is_active = TRUE
    LIMIT 1;

    IF v_template_id IS NULL THEN
        RAISE EXCEPTION 'No active sample data template found for name: %', p_template_name;
    END IF;

    -- 3. Insert customers (is_sample = TRUE)
    FOR v_item IN SELECT * FROM jsonb_array_elements(v_template->'customers')
    LOOP
        v_new_id := gen_random_uuid();
        v_ref_map := jsonb_set(v_ref_map, ARRAY[v_item->>'_ref'], to_jsonb(v_new_id::TEXT));

        INSERT INTO customers (id, company_id, name, contact_name, contact_email,
                               contact_phone, city, state, country, is_sample)
        VALUES (v_new_id, p_company_id,
                v_item->>'name', v_item->>'contact_name', v_item->>'contact_email',
                v_item->>'contact_phone', v_item->>'city', v_item->>'state',
                COALESCE(v_item->>'country', 'USA'), TRUE);
    END LOOP;

    -- 4. Insert resource_groups
    FOR v_item IN SELECT * FROM jsonb_array_elements(v_template->'resource_groups')
    LOOP
        v_new_id := gen_random_uuid();
        v_ref_map := jsonb_set(v_ref_map, ARRAY[v_item->>'_ref'], to_jsonb(v_new_id::TEXT));

        INSERT INTO resource_groups (id, company_id, name, description, is_sample)
        VALUES (v_new_id, p_company_id, v_item->>'name', v_item->>'description', TRUE);
    END LOOP;

    -- 5. Insert operation_types (depends on resource_groups)
    FOR v_item IN SELECT * FROM jsonb_array_elements(v_template->'operation_types')
    LOOP
        v_new_id := gen_random_uuid();
        v_ref_map := jsonb_set(v_ref_map, ARRAY[v_item->>'_ref'], to_jsonb(v_new_id::TEXT));

        INSERT INTO operation_types (id, company_id, resource_group_id, name, labor_rate, description, is_sample)
        VALUES (v_new_id, p_company_id,
                (v_ref_map->>(v_item->>'resource_group_ref'))::UUID,
                v_item->>'name', (v_item->>'labor_rate')::NUMERIC,
                v_item->>'description', TRUE);
    END LOOP;

    -- 6. Insert parts (depends on customers)
    FOR v_item IN SELECT * FROM jsonb_array_elements(v_template->'parts')
    LOOP
        v_new_id := gen_random_uuid();
        v_ref_map := jsonb_set(v_ref_map, ARRAY[v_item->>'_ref'], to_jsonb(v_new_id::TEXT));

        INSERT INTO parts (id, company_id, customer_id, part_name, description, pricing, is_sample)
        VALUES (v_new_id, p_company_id,
                (v_ref_map->>(v_item->>'customer_ref'))::UUID,
                v_item->>'part_name', v_item->>'description',
                COALESCE(v_item->'pricing', '[]'::JSONB), TRUE);
    END LOOP;

    -- 7. Insert inventory_items
    FOR v_item IN SELECT * FROM jsonb_array_elements(v_template->'inventory_items')
    LOOP
        v_new_id := gen_random_uuid();
        v_ref_map := jsonb_set(v_ref_map, ARRAY[v_item->>'_ref'], to_jsonb(v_new_id::TEXT));

        INSERT INTO inventory_items (id, company_id, name, sku, primary_unit, quantity, cost_per_unit, is_sample)
        VALUES (v_new_id, p_company_id,
                v_item->>'name', v_item->>'sku', v_item->>'primary_unit',
                COALESCE((v_item->>'quantity')::NUMERIC, 0),
                (v_item->>'cost_per_unit')::NUMERIC, TRUE);
    END LOOP;

    -- 8. Insert routings + nodes + edges (depends on parts, operation_types)
    FOR v_item IN SELECT * FROM jsonb_array_elements(v_template->'routings')
    LOOP
        v_new_id := gen_random_uuid();
        v_ref_map := jsonb_set(v_ref_map, ARRAY[v_item->>'_ref'], to_jsonb(v_new_id::TEXT));

        INSERT INTO routings (id, company_id, part_id, name, description, created_by, is_sample)
        VALUES (v_new_id, p_company_id,
                (v_ref_map->>(v_item->>'part_ref'))::UUID,
                v_item->>'name', v_item->>'description', p_user_id, TRUE);

        IF v_item->'nodes' IS NOT NULL THEN
            FOR v_node IN SELECT * FROM jsonb_array_elements(v_item->'nodes')
            LOOP
                v_new_id := gen_random_uuid();
                v_ref_map := jsonb_set(v_ref_map, ARRAY[v_node->>'_ref'], to_jsonb(v_new_id::TEXT));

                INSERT INTO routing_nodes (id, routing_id, operation_type_id,
                                           run_time_per_unit, instructions, materials, is_sample)
                VALUES (v_new_id,
                        (v_ref_map->>(v_item->>'_ref'))::UUID,
                        (v_ref_map->>(v_node->>'operation_type_ref'))::UUID,
                        (v_node->>'run_time_per_unit')::NUMERIC,
                        v_node->>'instructions',
                        COALESCE(v_node->'materials', '[]'::JSONB), TRUE);
            END LOOP;
        END IF;

        IF v_item->'edges' IS NOT NULL THEN
            FOR v_edge IN SELECT * FROM jsonb_array_elements(v_item->'edges')
            LOOP
                INSERT INTO routing_edges (routing_id, source_node_id, target_node_id, is_sample)
                VALUES (
                    (v_ref_map->>(v_item->>'_ref'))::UUID,
                    (v_ref_map->>(v_edge->>'source_ref'))::UUID,
                    (v_ref_map->>(v_edge->>'target_ref'))::UUID, TRUE);
            END LOOP;
        END IF;
    END LOOP;

    -- 9. Insert quotes (depends on customers, parts, routings)
    FOR v_item IN SELECT * FROM jsonb_array_elements(v_template->'quotes')
    LOOP
        v_new_id := gen_random_uuid();
        v_ref_map := jsonb_set(v_ref_map, ARRAY[v_item->>'_ref'], to_jsonb(v_new_id::TEXT));

        INSERT INTO quotes (id, company_id, quote_number, customer_id, part_id,
                            routing_id, quantity, unit_price, total_price, status, created_by, is_sample)
        VALUES (v_new_id, p_company_id,
                v_item->>'quote_number',
                (v_ref_map->>(v_item->>'customer_ref'))::UUID,
                (v_ref_map->>(v_item->>'part_ref'))::UUID,
                (v_ref_map->>(v_item->>'routing_ref'))::UUID,
                COALESCE((v_item->>'quantity')::INTEGER, 1),
                (v_item->>'unit_price')::NUMERIC,
                (v_item->>'total_price')::NUMERIC,
                COALESCE(v_item->>'status', 'pending_approval'),
                p_user_id, TRUE);
    END LOOP;

    -- 10. Insert jobs + job_operations
    FOR v_item IN SELECT * FROM jsonb_array_elements(v_template->'jobs')
    LOOP
        v_new_id := gen_random_uuid();
        v_ref_map := jsonb_set(v_ref_map, ARRAY[v_item->>'_ref'], to_jsonb(v_new_id::TEXT));

        INSERT INTO jobs (id, company_id, job_number, customer_id, part_id,
                          quote_id, routing_id, description, status, created_by, is_sample)
        VALUES (v_new_id, p_company_id,
                v_item->>'job_number',
                (v_ref_map->>(v_item->>'customer_ref'))::UUID,
                (v_ref_map->>(v_item->>'part_ref'))::UUID,
                (v_ref_map->>(v_item->>'quote_ref'))::UUID,
                (v_ref_map->>(v_item->>'routing_ref'))::UUID,
                v_item->>'description',
                COALESCE(v_item->>'status', 'pending'),
                p_user_id, TRUE);

        IF v_item->'operations' IS NOT NULL THEN
            FOR v_op IN SELECT * FROM jsonb_array_elements(v_item->'operations')
            LOOP
                v_new_id := gen_random_uuid();
                v_ref_map := jsonb_set(v_ref_map, ARRAY[v_op->>'_ref'], to_jsonb(v_new_id::TEXT));

                INSERT INTO job_operations (id, job_id, sequence, operation_name,
                                            operation_type_id, estimated_run_hours_per_unit,
                                            quantity_completed, status, is_sample)
                VALUES (v_new_id,
                        (v_ref_map->>(v_item->>'_ref'))::UUID,
                        (v_op->>'sequence')::INTEGER,
                        v_op->>'operation_name',
                        (v_ref_map->>(v_op->>'operation_type_ref'))::UUID,
                        (v_op->>'estimated_run_hours_per_unit')::NUMERIC,
                        COALESCE((v_op->>'quantity_completed')::INTEGER, 0),
                        COALESCE(v_op->>'status', 'pending'), TRUE);
            END LOOP;
        END IF;
    END LOOP;

    -- 11. Mark company as having sample data
    UPDATE companies SET has_sample_data = TRUE WHERE id = p_company_id;

    RETURN TRUE;
END;
$$;
```

### 5.2 `clear_sample_data()`

```sql
CREATE OR REPLACE FUNCTION clear_sample_data(p_company_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    -- Delete in reverse FK order
    DELETE FROM job_operations WHERE is_sample = TRUE
        AND job_id IN (SELECT id FROM jobs WHERE company_id = p_company_id AND is_sample = TRUE);
    DELETE FROM jobs WHERE company_id = p_company_id AND is_sample = TRUE;
    DELETE FROM quotes WHERE company_id = p_company_id AND is_sample = TRUE;
    DELETE FROM routing_edges WHERE is_sample = TRUE
        AND routing_id IN (SELECT id FROM routings WHERE company_id = p_company_id AND is_sample = TRUE);
    DELETE FROM routing_nodes WHERE is_sample = TRUE
        AND routing_id IN (SELECT id FROM routings WHERE company_id = p_company_id AND is_sample = TRUE);
    DELETE FROM routings WHERE company_id = p_company_id AND is_sample = TRUE;
    DELETE FROM parts WHERE company_id = p_company_id AND is_sample = TRUE;
    DELETE FROM inventory_items WHERE company_id = p_company_id AND is_sample = TRUE;
    DELETE FROM operation_types WHERE company_id = p_company_id AND is_sample = TRUE;
    DELETE FROM resource_groups WHERE company_id = p_company_id AND is_sample = TRUE;
    DELETE FROM customers WHERE company_id = p_company_id AND is_sample = TRUE;

    -- Mark company as no longer having sample data
    UPDATE companies SET has_sample_data = FALSE WHERE id = p_company_id;
END;
$$;
```

> **Performance:** ~50 rows across all tables. These operations complete well within 1 second.

---

## 6. User Flows

### 6.1 First-Time Onboarding

```
User signs up ("Join the Beta")
    → Company created (name provided at signup)
    → User lands on dashboard (empty)
    → Onboarding card: "Want to see what Jigged looks like with real data?"
    → [Load Sample Data] button
    → POST /api/sample-data/load
    → Sample data inserted with is_sample = TRUE
    → View switches to "Sample Data" mode
    → User browses populated dashboard, customers, parts, quotes, jobs
    → When ready: switches toggle to "My Company" and starts entering real data
    → Eventually: "Clear Sample Data" from settings or banner
```

### 6.2 Loading Sample Data (From Settings)

```
User navigates to Settings
    → "Sample Data" section
    → [Load Sample Data] button (if not already loaded)
    → Confirmation: "This will add sample manufacturing data you can browse. It won't affect your company data."
    → Loading spinner
    → POST /api/sample-data/load
    → Success toast: "Sample data loaded. Use the banner to switch back anytime."
    → View switches to Sample Data mode
```

### 6.3 Toggling Views

```
User clicks "View Sample Data" in Settings or banner appears with "Back to My Company"
    → Switches between "My Company" and "Sample Data" modes
    → All list pages re-query with is_sample filter
    → Navigation state preserved (if on /parts, stays on /parts)
    → Sample Data banner appears on every page with "Back to My Company" escape
```

### 6.4 Clearing Sample Data

```
User clicks "Clear Sample Data" (from banner or Settings)
    → Confirmation dialog: "Remove all sample data? Your company data is not affected."
    → User confirms
    → Loading spinner
    → POST /api/sample-data/clear
    → All is_sample = TRUE records deleted
    → companies.has_sample_data = FALSE
    → View resets to "My Company"
    → Sample Data banner disappears
    → Success toast: "Sample data cleared"
```

---

## 7. UI Components

### 7.1 Settings: Sample Data Section

Sample data controls live on the Settings page (`/dashboard/[companyId]/settings/sample-data`), not in the dashboard header. Users toggle views 2-3 times during onboarding — it doesn't warrant permanent header real estate.

```
Sample Data
─────────────────────────────────
Status: Loaded / Not loaded

[Load Sample Data]           (if not loaded)
[View Sample Data]           (if loaded, currently in My Company mode)
[Back to My Company]         (if loaded, currently in Sample Data mode)
[Reset Sample Data]          (restores to template)
[Clear Sample Data]          (removes entirely)
```

- "Load Sample Data" calls `POST /api/sample-data/load` and switches to Sample Data view
- "View Sample Data" sets `isSampleView = true` in the `SampleDataProvider` context
- "Back to My Company" sets `isSampleView = false`
- "Reset Sample Data" calls `POST /api/sample-data/reset` (confirmation dialog first)
- "Clear Sample Data" calls `POST /api/sample-data/clear` (confirmation dialog first)
- View state persisted in React context (not URL or localStorage — resets on page reload to "My Company")

### 7.2 Sample Data Banner

When in Sample Data view mode, a persistent info banner appears below the header on every page:

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│  ℹ  You're viewing sample data. Changes here won't affect your company.  [Back to My Company]  [Reset]  [Clear]  │
└──────────────────────────────────────────────────────────────────────────────────┘
```

- MUI `Alert` with `severity="info"`
- Positioned below Header, above page content
- "Back to My Company" is the primary escape — sets `isSampleView = false` (no page navigation needed)
- "Reset" restores sample data to original template state (confirmation dialog)
- "Clear" removes all sample data entirely (confirmation dialog)

### 7.3 Onboarding Card

Shown on the dashboard when the company has no data and no sample data:

```
┌──────────────────────────────────────────────┐
│  Welcome to Jigged!                          │
│                                              │
│  Want to see what a populated shop looks     │
│  like? Load sample data to explore.          │
│                                              │
│  [Load Sample Data]    [Skip, I'll start fresh]  │
└──────────────────────────────────────────────┘
```

- MUI `Card` with `elevation={2}`
- Disappears after the user makes a choice or creates their first record

### 7.4 Sample Data Mode Behavior

When `isSampleView === true`:
- All CRUD operations work normally — users can create, edit, and delete sample records
- New records created in this mode are automatically tagged `is_sample = TRUE` (handled by the query layer)
- The Sample Data banner remains visible as a persistent reminder of which mode the user is in
- "Import" buttons are hidden (importing into sample data doesn't make sense)

---

## 8. Frontend Architecture

### 8.1 SampleDataProvider

```tsx
// components/providers/SampleDataProvider.tsx

interface SampleDataContext {
  hasSampleData: boolean;       // company.has_sample_data
  isSampleView: boolean;        // current toggle state
  toggleView: () => void;       // switch between modes
  loadSampleData: () => Promise<void>;
  clearSampleData: () => Promise<void>;
  isLoading: boolean;           // loading/clearing in progress
}
```

Wraps the dashboard layout. All data-fetching hooks read `isSampleView` from this context.

### 8.2 Query Filter Pattern

Every Supabase query that fetches company data adds the `is_sample` filter, and inserts tag new records appropriately:

```tsx
// Read queries: filter by view mode
const { data } = await supabase
  .from('customers')
  .select('*')
  .eq('company_id', companyId)
  .eq('is_sample', isSampleView);

// Insert queries: tag with current view mode
const { data } = await supabase
  .from('customers')
  .insert({ ...customerData, company_id: companyId, is_sample: isSampleView });
```

This can be centralized in a helper or applied via a custom hook that wraps Supabase queries. The `isSampleView` value comes from the `SampleDataProvider` context.

---

## 9. API Endpoints

All endpoints are FastAPI routes. Use the Supabase service role client for database operations.

### 9.1 `POST /api/sample-data/load`

Loads sample data into the user's company.

- **Auth:** Supabase JWT (must be owner or admin of the company)
- **Body:** `{ company_id: string }`
- **Logic:**
  1. Verify caller is owner/admin of company
  2. Check if sample data already loaded (`has_sample_data`)
  3. If already loaded, return `{ already_loaded: true, company_id }`
  4. Call `load_sample_data(company_id, user_id)`
  5. Return `{ success: true, company_id }`

### 9.2 `POST /api/sample-data/reset`

Resets sample data to original template state (discards user edits).

- **Auth:** Supabase JWT (must be owner or admin of the company)
- **Body:** `{ company_id: string }`
- **Logic:**
  1. Verify caller is owner/admin
  2. Call `clear_sample_data(company_id)` then `load_sample_data(company_id, user_id)` in a transaction
  3. Return `{ success: true }`

### 9.3 `POST /api/sample-data/clear`

Clears all sample data from a company.

- **Auth:** Supabase JWT (must be owner or admin of the company)
- **Body:** `{ company_id: string }`
- **Logic:**
  1. Verify caller is owner/admin
  2. Call `clear_sample_data(company_id)`
  3. Return `{ success: true }`

### 9.4 Template Management (System Admin)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/sample-data/templates` | List all templates |
| `POST` | `/api/sample-data/templates` | Create new template |
| `PUT` | `/api/sample-data/templates/{id}/activate` | Set template as active |

All require system admin auth.

---

## 10. Template Versioning & Schema Evolution

### Strategy

1. Each template includes a `schema_version` field (date-based, e.g., `"2026-03-04"`)
2. `load_sample_data()` uses `COALESCE` for all optional fields — templates with missing new fields load successfully with defaults
3. When schema changes, update the template JSONB and increment the version number
4. Backward compatibility maintained via `COALESCE` defaults

---

## 11. Testing Strategy

### Unit Tests

| Test | Description |
|------|-------------|
| `load_sample_data()` | Creates all entities with `is_sample = TRUE`, correct FK refs, idempotent |
| `clear_sample_data()` | Removes only `is_sample = TRUE` records, preserves real data, resets flag |
| View toggle state | Context provides correct `isSampleView` state, toggle switches correctly |
| CRUD in sample mode | New records tagged `is_sample = TRUE`, don't appear in My Company view |
| Query filtering | All list queries include `is_sample` filter matching view mode |

### Integration Tests

| Test | Description |
|------|-------------|
| Load flow | Load sample data → toggle appears → sample data visible → switch to My Company → sample data hidden |
| Clear flow | Clear sample data → toggle disappears → only real data remains |
| Operator flow | Load sample data → create real operator → operator logs in → switches to Sample Data view → sees sample jobs |
| Mixed data | Real data + sample data exist → My Company shows only real → Sample Data shows only sample |

### Performance Tests

| Test | Target |
|------|--------|
| `load_sample_data()` | < 2 seconds |
| `clear_sample_data()` | < 1 second |
| Sample dataset row count | ~50 rows across all tables |

---

## 12. Acceptance Criteria

- [ ] `is_sample BOOLEAN DEFAULT FALSE` column exists on all data tables
- [ ] `companies.has_sample_data` column exists
- [ ] `sample_data_templates` table exists with RLS policies
- [ ] `template_data` JSONB follows defined schema with `_ref` cross-references
- [ ] `load_sample_data()` inserts all entities with `is_sample = TRUE`
- [ ] `clear_sample_data()` removes all sample data without affecting real data
- [ ] Settings page shows sample data controls (Load/View/Back/Reset/Clear)
- [ ] View switching works between "My Company" and "Sample Data" modes
- [ ] In Sample Data mode, full CRUD works and new records are tagged `is_sample = TRUE`
- [ ] Records created in Sample Data mode do not appear in "My Company" view
- [ ] Reset restores sample data to original template state
- [ ] Real operators can switch to Sample Data view and see sample jobs
- [ ] Onboarding card offers "Load Sample Data" on first visit
- [ ] Sample data banner displays on every page in Sample Data view mode with "Back to My Company" link
- [ ] Clearing sample data resets to My Company view and removes banner
- [ ] Template versioning handles schema evolution gracefully

---

## 13. Open Questions (Resolved)

| # | Question | Resolution |
|---|----------|------------|
| 1 | Should sample data count toward usage limits? | No |
| 2 | Should sample data view be read-only? | No — full CRUD so users can practice workflows. Records created in sample mode are tagged `is_sample = TRUE` and isolated from real data. Reset available to restore original template. |
| 3 | JSONB template vs programmatic seeder? | JSONB template with `_ref` mapping (same as previous demo company approach) |
| 4 | Should the view toggle persist across page reloads? | No — always defaults to "My Company" to prevent confusion |
| 5 | Can users re-load sample data after clearing? | Yes — Load Sample Data button reappears in Settings |
| 6 | Do we need sample operators? | No — real operators (or admins testing as operators) switch to Sample Data view to see sample jobs. No throwaway auth.users needed. |

---

## 14. Dependencies

- **[Platform Foundation](./demo-company.md#4-database-schema):** `system_admins` table and `is_system_admin()` function required for template management
- **Settings page layout:** Defined in the [Invitation System PRD](./invitation-system.md#123-settings-navigation). Sample data adds a `sample-data` section to this layout.
- **No dependency on Invitation System features:** Sample data is fully independent of invitations/referrals — they just share the Settings page layout.

---

## 15. Success Metrics

- **Sample data load rate:** % of new users who load sample data during onboarding
- **Browse duration:** Time spent in Sample Data view before switching to My Company
- **Time to first real record:** How quickly users create their first real customer/part/quote after exploring sample data
- **Clear rate:** % of users who eventually clear sample data (indicates they've graduated to real usage)

---

## 16. Supersedes

This PRD supersedes the [Demo Company](./demo-company.md) PRD. The demo company concept (separate company per user with `is_demo` flag) has been replaced by in-company sample data with a view toggle. Key differences:

| Aspect | Demo Company (old) | Sample Data (new) |
|--------|-------------------|-------------------|
| Data location | Separate company | Same company, `is_sample` column |
| Company switcher | Shows "(Demo)" entry | No change — single company |
| View separation | Switch companies | Toggle within company |
| Lifecycle | Auto-created on signup | User-initiated load |
| Cleanup | Never (permanent) | User-initiated clear |
| Schema changes | `companies.is_demo`, `demo_template_id`, `demo_owner_id` | `companies.has_sample_data`, `is_sample` on data tables |
