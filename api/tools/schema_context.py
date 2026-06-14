"""
Database schema context for the AI system prompt.

Handcrafted representation of the business tables available for SQL queries.
This string is injected into the system prompt so the AI can generate correct SQL.

Reflects the unified `parts` schema (parts absorbed inventory_items),
`work_centers` (replaces operation_types), `vendors`, `routing_operations`
(replaces routing_nodes), `parts_bom` (replaces routing_materials), and
`job_parts` (the new intermediary that lets a single job ship multiple parts).
"""

SCHEMA_CONTEXT = """
## Database Schema (PostgreSQL)

### companies
- id: UUID (PK)
- name: TEXT
- settings: JSONB
- demo_company_id: UUID (FK -> companies.id, nullable)
- created_at: TIMESTAMPTZ, updated_at: TIMESTAMPTZ

### customers
- id: UUID (PK)
- company_id: UUID (FK -> companies.id) -- ALWAYS filter with $1
- name: TEXT (unique per company)
- website: TEXT
- contact_name: TEXT, contact_phone: TEXT, contact_email: TEXT
- created_at: TIMESTAMPTZ, updated_at: TIMESTAMPTZ
- NOTE: Address fields are stored on a separate customer_addresses table,
  one row per address tagged with default_billing/default_shipping flags.

### customer_addresses
- id: UUID (PK)
- customer_id: UUID (FK -> customers.id) -- join via customer.id
- address_line1: TEXT, address_line2: TEXT
- city: TEXT, state: TEXT, postal_code: TEXT, country: TEXT (default 'USA')
- default_billing: BOOLEAN (at most one per customer — unique partial index)
- default_shipping: BOOLEAN (at most one per customer — unique partial index)
- Both flags can be unset; the row stays on file as a reference.
- attention_to: TEXT (optional "ATTN:" recipient line for packing slips)
- created_at: TIMESTAMPTZ, updated_at: TIMESTAMPTZ

### vendors (suppliers and outside-process providers)
- id: UUID (PK)
- company_id: UUID -- ALWAYS filter with $1
- name: TEXT (unique per company)
- contact_name: TEXT, contact_email: TEXT, contact_phone: TEXT
- address_line1: TEXT, address_line2: TEXT
- city: TEXT, state: TEXT, postal_code: TEXT, country: TEXT
- notes: TEXT
- legacy_id: TEXT (unique per company; carried from a prior system on import)
- created_at: TIMESTAMPTZ, updated_at: TIMESTAMPTZ
- NOTE: vendors do NOT carry capability flags. Whether a vendor supplies
  materials vs. performs outside ops is derived from references:
    * "supplies materials" = some part has parts.preferred_vendor_id = vendor.id
    * "performs outside ops" = some work_centers row has kind='external' AND
      vendor_id = vendor.id

### parts (UNIFIED — absorbs the old `inventory_items` table)
- id: UUID (PK)
- company_id: UUID -- ALWAYS filter with $1
- part_name: TEXT (unique per company)
- description: TEXT
- source: TEXT (CHECK 'made'|'bought'; default 'made') -- 'made' = produced in-shop (has a routing); 'bought' = procured from a vendor
- is_stocked: BOOLEAN (default false) -- this part is tracked as on-hand stock
- primary_unit: TEXT (required when is_stocked=true; e.g. 'ea', 'lb', 'ft')
- quantity: NUMERIC (default 0; current stock-on-hand, >= 0)
- (Cost is computed live by compute_part_cost_at_qty(part_id, qty); no
  cost column on parts. For bought parts the cost comes from
  part_procurement_tiers; for made parts it's labor + setup/qty + BOM rollup.)
- reorder_point: NUMERIC (nullable; reorder when quantity drops to this)
- preferred_vendor_id: UUID (FK -> vendors.id, nullable)
- legacy_id: TEXT (unique per company; carried from a prior system on import)
- created_at: TIMESTAMPTZ, updated_at: TIMESTAMPTZ
- The four (source, is_stocked) quadrants mean:
    * (made,   false) → Custom Made (built to order)
    * (made,   true)  → Sub-assembly (made AND stocked)
    * (bought, true)  → Raw Material (vendor stock kept on hand)
    * (bought, false) → Service / Drop-ship

### part_pricing_tiers (volume-pricing tiers per part)
- id: UUID (PK)
- part_id: UUID (FK -> parts.id)
- company_id: UUID -- ALWAYS filter with $1
- sequence: INTEGER (unique per part)
- quantity: INTEGER (>0; tier breakpoint)
- markup_percent: NUMERIC(5,2)
- unit_price: NUMERIC(12,4) (computed at save time: live base × (1 + markup/100))
- created_at: TIMESTAMPTZ, updated_at: TIMESTAMPTZ
- The base cost for a tier is recomputed live via
  compute_part_cost_at_qty(part_id, tier.quantity) — no stored
  base_cost_per_unit column.

### parts_bom (Bill-Of-Materials — REPLACES routing_materials; NO company_id, join via parts)
- id: UUID (PK)
- parent_part_id: UUID (FK -> parts.id) -- the assembly
- child_part_id: UUID (FK -> parts.id) -- the component (must differ from parent)
- quantity: NUMERIC (>0; how much of the child this assembly consumes)
- unit: TEXT (the BOM unit; converted to child.primary_unit via parts_unit_conversions if different)
- sequence: INTEGER (display order within the BOM)
- notes: TEXT
- created_at: TIMESTAMPTZ, updated_at: TIMESTAMPTZ
- One row per (parent_part_id, child_part_id). Cycles are blocked by trigger.

### parts_unit_conversions (NO company_id, join via parts)
- id: UUID (PK)
- part_id: UUID (FK -> parts.id) -- the part this conversion belongs to
- from_unit: TEXT (unique per part)
- to_primary_factor: NUMERIC (>0; multiply a from_unit qty by this to get primary_unit qty)

### markup_rates
- id: UUID (PK)
- company_id: UUID -- ALWAYS filter with $1
- name: TEXT (unique per company)
- breakpoints: JSONB (array of quantity → markup_percent rows)
- is_default: BOOLEAN
- created_at: TIMESTAMPTZ, updated_at: TIMESTAMPTZ

### quotes
- id: UUID (PK)
- company_id: UUID -- ALWAYS filter with $1
- quote_number: TEXT (unique per company, e.g. 'Q-001'; auto-generated)
- customer_id: UUID (FK -> customers.id, nullable)
- status: TEXT -- one of: 'active', 'expired'
- status_changed_at: TIMESTAMPTZ
- converted_at: TIMESTAMPTZ (when accepted/converted to a job)
- lead_time_days: INTEGER, expiration_date: DATE
- created_by: UUID, created_at: TIMESTAMPTZ, updated_at: TIMESTAMPTZ
- NOTE: revenue is NOT on quotes anymore. Sum quote_line_items.total_price
  for per-quote revenue.

### quote_line_items (one row per part on a quote)
- id: UUID (PK)
- quote_id: UUID (FK -> quotes.id)
- company_id: UUID -- ALWAYS filter with $1
- part_id: UUID (FK -> parts.id)
- source_tier_id: UUID (FK -> part_pricing_tiers.id, nullable)
- sequence: INTEGER (unique per quote)
- quantity: INTEGER (>0)
- unit_price: NUMERIC(12,4)
- total_price: NUMERIC(12,4) -- per-line subtotal; the per-quote revenue is SUM(total_price)
- markup_percent: NUMERIC(5,2)
- base_cost_per_unit: NUMERIC(12,4)
- is_quote_override: BOOLEAN (true when the user manually overrode the price)
- created_at: TIMESTAMPTZ

### quote_materials (extra material lines on a quote, beyond the part's BOM)
- id: UUID (PK)
- quote_id: UUID (FK -> quotes.id)
- company_id: UUID -- ALWAYS filter with $1
- part_id: UUID (FK -> parts.id) -- the parent part this material belongs to
- material_part_id: UUID (FK -> parts.id, nullable) -- the material itself
- sequence: INTEGER
- item_name: TEXT, quantity: NUMERIC, unit: TEXT
- cost_per_unit: NUMERIC, line_cost: NUMERIC
- created_at: TIMESTAMPTZ

### quote_operations (extra operation lines on a quote, beyond the part's routing)
- id: UUID (PK)
- quote_id: UUID (FK -> quotes.id)
- company_id: UUID -- ALWAYS filter with $1
- part_id: UUID (FK -> parts.id)
- sequence: INTEGER
- operation_name: TEXT
- run_time_minutes: NUMERIC, setup_time_minutes: NUMERIC
- labor_rate: NUMERIC, run_cost: NUMERIC, setup_cost: NUMERIC
- created_at: TIMESTAMPTZ

### jobs
- id: UUID (PK)
- company_id: UUID -- ALWAYS filter with $1
- job_number: TEXT (unique per company, e.g. 'J-001')
- quote_id: UUID (FK -> quotes.id, nullable)
- customer_id: UUID (FK -> customers.id, nullable)
- customer_po_number: TEXT (set during quote-to-job conversion)
- production_status: TEXT -- one of: 'not_started', 'in_progress', 'completed', 'cancelled'
  (operator-driven; aggregated from job_parts.production_status)
- fulfillment_status: TEXT -- one of: 'unshipped', 'partially_shipped', 'fully_shipped'
  (shipment-driven; aggregated from job_parts.fulfillment_status, populated in PR 4)
- status_changed_at: TIMESTAMPTZ
- started_at: TIMESTAMPTZ, completed_at: TIMESTAMPTZ
- due_date: DATE, lead_time_days: INTEGER
- created_by: UUID, created_at: TIMESTAMPTZ, updated_at: TIMESTAMPTZ
- NOTE: jobs no longer carry part_id. A job ships one or more parts via job_parts.
- NOTE: shipped_at column was dropped. Use the SQL helper
  public.job_last_ship_date(job_id) for the last ship date — it sums
  non-voided shipments.

### job_parts (intermediate between jobs and parts; lets one job ship multiple parts)
- id: UUID (PK)
- job_id: UUID (FK -> jobs.id)
- company_id: UUID -- ALWAYS filter with $1
- part_id: UUID (FK -> parts.id)
- source_quote_line_item_id: UUID (FK -> quote_line_items.id, nullable)
- sequence: INTEGER (unique per job)
- quantity: INTEGER (>0)
- production_status: TEXT -- one of: 'not_started', 'in_progress', 'completed', 'cancelled'
- fulfillment_status: TEXT -- one of: 'unshipped', 'partially_shipped', 'fully_shipped'
- status_changed_at: TIMESTAMPTZ
- started_at: TIMESTAMPTZ, completed_at: TIMESTAMPTZ
- current_operation_sequence: INTEGER
- created_at: TIMESTAMPTZ, updated_at: TIMESTAMPTZ
- NOTE: shipped_at column was dropped. Use public.job_part_last_ship_date(job_part_id)
  for the part's last ship date.

### job_operations (steps within a job — NO company_id, join via jobs)
- id: UUID (PK)
- job_id: UUID (FK -> jobs.id)
- job_part_id: UUID (FK -> job_parts.id) -- which part this op produces
- sequence: INTEGER (unique per job_part)
- operation_name: TEXT (snapshot, immune to renames)
- work_center_id: UUID (FK -> work_centers.id, nullable; was operation_type_id)
- routing_operation_id: UUID (FK -> routing_operations.id, nullable; the source row)
- estimated_setup_minutes: NUMERIC(8,2) (default 0) -- MINUTES, not hours
- estimated_run_minutes_per_unit: NUMERIC(8,4) (default 0) -- MINUTES per unit
- actual_setup_minutes: NUMERIC(8,2), actual_run_minutes: NUMERIC(8,2)
- status: TEXT -- one of: 'pending', 'in_progress', 'completed', 'skipped'
- started_at: TIMESTAMPTZ, completed_at: TIMESTAMPTZ
- assigned_to: UUID, completed_by: UUID
- instructions: TEXT, notes: TEXT

### job_materials (expected-BOM snapshot for a specific job_part — NO company_id, join via jobs)
- id: UUID (PK)
- job_id: UUID (FK -> jobs.id)
- job_part_id: UUID (FK -> job_parts.id)
- parts_bom_id: UUID (FK -> parts_bom.id, nullable if source deleted)
- material_part_id: UUID (FK -> parts.id) -- the material
- expected_quantity: NUMERIC (>=0)
- unit: TEXT
-- Consumption is no longer tracked here; the part BOM (parts_bom) is the source of truth.

### work_centers (REPLACES operation_types; e.g. 'CNC Mill #1', 'Outside Plating')
- id: UUID (PK)
- company_id: UUID -- ALWAYS filter with $1
- name: TEXT (unique per company)
- kind: TEXT -- one of: 'internal', 'external'
- vendor_id: UUID (FK -> vendors.id; required when kind='external', null when internal)
- labor_rate: NUMERIC(10,2) (per-hour rate; meaningful only for kind='internal')
- description: TEXT, metadata: JSONB
- created_at: TIMESTAMPTZ, updated_at: TIMESTAMPTZ

### routings (1:1 with manufacturable parts)
- id: UUID (PK)
- company_id: UUID -- ALWAYS filter with $1
- part_id: UUID (FK -> parts.id, UNIQUE)
- name: TEXT, description: TEXT
- created_by: UUID, created_at: TIMESTAMPTZ, updated_at: TIMESTAMPTZ

### routing_operations (REPLACES routing_nodes; ordered by `sequence`; NO company_id, join via routings)
- id: UUID (PK)
- routing_id: UUID (FK -> routings.id)
- work_center_id: UUID (FK -> work_centers.id) -- was operation_type_id
- sequence: INTEGER (unique per routing; lower runs first)
- setup_minutes: NUMERIC(8,2) (default 0) -- MINUTES; one-time per batch (internal only)
- cycle_minutes_per_unit: NUMERIC(8,4) -- MINUTES per unit (internal only)
- labor_rate_override: NUMERIC(10,2) -- per-op override of work_centers.labor_rate (internal only)
- external_unit_price: NUMERIC(12,4) -- price per output unit (external only)
- external_setup_cost: NUMERIC(12,4) -- one-time per job (external only)
- instructions: TEXT, metadata: JSONB
- created_at: TIMESTAMPTZ, updated_at: TIMESTAMPTZ
- COST CONTRACT (mirrors compute_part_cost_at_qty, migration 20260514):
    * internal: cost = (setup_minutes/qty + cycle_minutes_per_unit)
                       * COALESCE(labor_rate_override, work_centers.labor_rate)
                       / 60.0
    * external: cost = external_unit_price + external_setup_cost / qty
  Setup amortization for sub-assemblies follows from bom_qty * sub_cost_at(
  cumulative_qty): one sub-assembly setup spread across the whole parent
  batch run, contributing sub_setup / parent_order_qty per parent unit.

### inventory_transactions (stock movements; references parts.id, NOT inventory_items)
- id: UUID (PK)
- company_id: UUID -- ALWAYS filter with $1
- part_id: UUID (FK -> parts.id, nullable) -- the part whose stock moved
- item_name: TEXT (denormalized snapshot)
- type: TEXT -- one of: 'addition', 'depletion', 'adjustment'
- quantity: NUMERIC (>= 0)
- unit: TEXT, converted_quantity: NUMERIC (in primary units)
- job_id: UUID (FK -> jobs.id, nullable)
- job_operation_id: UUID (FK -> job_operations.id, nullable)
- operator_id: UUID, created_by: UUID
- has_discrepancy: BOOLEAN (default false)
- notes: TEXT, created_at: TIMESTAMPTZ

### operator_sessions (time tracking for operators working on jobs)
- id: UUID (PK)
- company_id: UUID -- ALWAYS filter with $1
- operator_id: UUID
- job_id: UUID (FK -> jobs.id)
- job_operation_id: UUID (FK -> job_operations.id, nullable)
- work_center_id: UUID (FK -> work_centers.id) -- was operation_type_id
- started_at: TIMESTAMPTZ, ended_at: TIMESTAMPTZ (null = currently active)
- created_at: TIMESTAMPTZ, updated_at: TIMESTAMPTZ

## Key Relationships
- jobs.quote_id -> quotes.id (a job may come from a quote)
- jobs.customer_id -> customers.id
- job_parts.job_id -> jobs.id (a job has many job_parts)
- job_parts.part_id -> parts.id
- job_parts.source_quote_line_item_id -> quote_line_items.id
- job_operations.job_id -> jobs.id
- job_operations.job_part_id -> job_parts.id
- job_operations.work_center_id -> work_centers.id
- job_operations.routing_operation_id -> routing_operations.id
- job_materials.job_id -> jobs.id
- job_materials.job_part_id -> job_parts.id
- job_materials.material_part_id -> parts.id
- job_materials.parts_bom_id -> parts_bom.id
- quotes.customer_id -> customers.id
- quote_line_items.quote_id -> quotes.id
- quote_line_items.part_id -> parts.id
- quote_materials.quote_id -> quotes.id, .part_id -> parts.id, .material_part_id -> parts.id
- quote_operations.quote_id -> quotes.id, .part_id -> parts.id
- routings.part_id -> parts.id (1:1)
- routing_operations.routing_id -> routings.id
- routing_operations.work_center_id -> work_centers.id
- work_centers.vendor_id -> vendors.id (when kind='external')
- parts.preferred_vendor_id -> vendors.id
- parts_bom.parent_part_id -> parts.id, .child_part_id -> parts.id
- parts_unit_conversions.part_id -> parts.id
- inventory_transactions.part_id -> parts.id
- operator_sessions.job_id -> jobs.id
- operator_sessions.work_center_id -> work_centers.id

## Important Notes
- Tables WITHOUT company_id: job_operations, job_materials, routing_operations,
  parts_bom, parts_unit_conversions. Filter these via JOIN to their parent table.
  Example: `SELECT jo.* FROM job_operations jo JOIN jobs j ON jo.job_id = j.id WHERE j.company_id = $1`
- A "started" job means started_at IS NOT NULL or production_status = 'in_progress'.
- A "shipped" job means fulfillment_status = 'fully_shipped'. The last ship
  date comes from public.job_last_ship_date(job_id), which sums non-voided
  shipments. There is no jobs.shipped_at column anymore.
- Revenue per quote = SUM(quote_line_items.total_price) WHERE quote_id = ?.
- Revenue per shipped job = SUM through job_parts → quote_line_items
  (each job_part links to the quote_line_item it was created from).
- Use DATE_TRUNC('week', timestamp) for weekly grouping, DATE_TRUNC('month', ...) for monthly.
- All TIMESTAMPTZ columns are UTC.
- Cost contract for internal routing/job operations:
    labor_rate = COALESCE(routing_operations.labor_rate_override, work_centers.labor_rate)
    cost      = (estimated_setup_minutes + estimated_run_minutes_per_unit * qty)
                / 60.0 * labor_rate
  For external operations the cost is external_unit_price * qty + external_setup_cost.
- Time fields are MINUTES on both routing_operations (setup_minutes,
  cycle_minutes_per_unit) and job_operations (estimated_setup_minutes,
  estimated_run_minutes_per_unit, actual_setup_minutes, actual_run_minutes).
  Divide by 60 before multiplying by an hourly labor_rate.

## Example Queries

-- Jobs started last week
SELECT COUNT(*) AS job_count
FROM jobs
WHERE company_id = $1
  AND started_at >= DATE_TRUNC('week', NOW()) - INTERVAL '1 week'
  AND started_at <  DATE_TRUNC('week', NOW());

-- Revenue by month (last 6 months) — sum quote_line_items via job_parts.
-- Uses the public.job_last_ship_date(jobs.id) helper instead of the dropped
-- shipped_at column.
SELECT DATE_TRUNC('month', public.job_last_ship_date(j.id)::timestamptz) AS month,
       SUM(qli.total_price)              AS revenue,
       COUNT(DISTINCT j.id)              AS job_count
FROM jobs j
JOIN job_parts jp        ON jp.job_id = j.id
JOIN quote_line_items qli ON qli.id = jp.source_quote_line_item_id
WHERE j.company_id = $1
  AND j.fulfillment_status = 'fully_shipped'
  AND public.job_last_ship_date(j.id) >= (CURRENT_DATE - INTERVAL '6 months')
GROUP BY DATE_TRUNC('month', public.job_last_ship_date(j.id)::timestamptz)
ORDER BY month;

-- Top 5 customers by revenue
SELECT c.name,
       SUM(qli.total_price) AS revenue,
       COUNT(DISTINCT j.id) AS job_count
FROM jobs j
JOIN customers c          ON c.id = j.customer_id
JOIN job_parts jp         ON jp.job_id = j.id
JOIN quote_line_items qli ON qli.id = jp.source_quote_line_item_id
WHERE j.company_id = $1 AND j.fulfillment_status = 'fully_shipped'
GROUP BY c.name
ORDER BY revenue DESC
LIMIT 5;

-- Stocked parts below their reorder point
SELECT part_name, quantity, reorder_point, primary_unit,
       (reorder_point - quantity) AS deficit
FROM parts
WHERE company_id = $1
  AND is_stocked = true
  AND reorder_point IS NOT NULL
  AND quantity <= reorder_point
ORDER BY (reorder_point - quantity) DESC;

-- Estimated labor hours by work center over the last 30 days
SELECT wc.name,
       SUM(jo.estimated_setup_minutes
           + jo.estimated_run_minutes_per_unit * jp.quantity) / 60.0 AS hours
FROM job_operations jo
JOIN jobs j          ON j.id = jo.job_id
JOIN job_parts jp    ON jp.id = jo.job_part_id
JOIN work_centers wc ON wc.id = jo.work_center_id
WHERE j.company_id = $1
  AND jo.created_at >= NOW() - INTERVAL '30 days'
GROUP BY wc.name
ORDER BY hours DESC;

-- BOM children for a given parent part
SELECT c.part_name AS child_part, b.quantity, b.unit
FROM parts_bom b
JOIN parts p ON p.id = b.parent_part_id
JOIN parts c ON c.id = b.child_part_id
WHERE p.company_id = $1
  AND p.part_name = 'WIDGET-A'
ORDER BY b.sequence;
"""

# Allowlist of tables the AI is permitted to query.
# Mirrors the new schema — old names (operation_types, inventory_items,
# routing_nodes, routing_materials, inventory_unit_conversions) are gone.
ALLOWED_TABLES = frozenset({
    "companies",
    "customers",
    "vendors",
    "parts",
    "part_pricing_tiers",
    "parts_bom",
    "parts_unit_conversions",
    "markup_rates",
    "quotes",
    "quote_line_items",
    "quote_materials",
    "quote_operations",
    "jobs",
    "job_parts",
    "job_operations",
    "job_materials",
    "work_centers",
    "routings",
    "routing_operations",
    "operator_sessions",
    "inventory_transactions",
})
