"""
Database schema context for the AI system prompt.

Handcrafted representation of the 17 business tables available for SQL queries.
This string is injected into the system prompt so the AI can generate correct SQL.
"""

SCHEMA_CONTEXT = """
## Database Schema (PostgreSQL)

### companies
- id: UUID (PK)
- name: TEXT
- slug: TEXT (unique)
- settings: JSONB
- is_demo: BOOLEAN
- created_at: TIMESTAMPTZ
- updated_at: TIMESTAMPTZ

### customers
- id: UUID (PK)
- company_id: UUID (FK -> companies.id) -- ALWAYS filter with $1
- name: TEXT (unique per company)
- website: TEXT
- contact_name: TEXT
- contact_phone: TEXT
- contact_email: TEXT
- address_line1: TEXT, address_line2: TEXT
- city: TEXT, state: TEXT, postal_code: TEXT, country: TEXT (default 'USA')
- created_at: TIMESTAMPTZ, updated_at: TIMESTAMPTZ

### quotes
- id: UUID (PK)
- company_id: UUID -- ALWAYS filter with $1
- quote_number: TEXT (unique per company, e.g. "Q-001")
- customer_id: UUID (FK -> customers.id)
- part_id: UUID (FK -> parts.id)
- description: TEXT
- quantity: INTEGER (default 1)
- unit_price: NUMERIC(12,4)
- total_price: NUMERIC(12,4)
- status: TEXT -- one of: 'pending_approval', 'approved', 'rejected', 'accepted', 'expired', 'converted'
- status_changed_at: TIMESTAMPTZ
- converted_to_job_id: UUID (FK -> jobs.id, set when quote becomes a job)
- converted_at: TIMESTAMPTZ
- created_at: TIMESTAMPTZ, updated_at: TIMESTAMPTZ

### quote_attachments
- id: UUID (PK)
- quote_id: UUID (FK -> quotes.id)
- company_id: UUID -- ALWAYS filter with $1
- file_name: TEXT, file_path: TEXT, file_size: INTEGER, mime_type: TEXT

### parts
- id: UUID (PK)
- company_id: UUID -- ALWAYS filter with $1
- part_name: TEXT (unique per company, e.g. "P-001")
- description: TEXT
- pricing: JSONB (array of pricing tiers)
- created_at: TIMESTAMPTZ, updated_at: TIMESTAMPTZ

### routings (1:1 with parts -- each part has one routing)
- id: UUID (PK)
- company_id: UUID -- ALWAYS filter with $1
- part_id: UUID (FK -> parts.id, UNIQUE)
- name: TEXT
- description: TEXT
- created_at: TIMESTAMPTZ, updated_at: TIMESTAMPTZ

### routing_nodes (operations in a routing, ordered by `sequence` -- NO company_id, join via routings)
- id: UUID (PK)
- routing_id: UUID (FK -> routings.id)
- operation_type_id: UUID (FK -> operation_types.id)
- run_time_per_unit: NUMERIC (minutes per unit)
- setup_time: NUMERIC (one-time setup minutes per batch)
- instructions: TEXT
- sequence: INTEGER (linear order within routing, lower runs first)

### routing_materials (materials for the routing as a whole -- NO company_id, join via routings)
- id: UUID (PK)
- routing_id: UUID (FK -> routings.id)
- inventory_item_id: UUID (FK -> inventory_items.id)
- quantity: NUMERIC (> 0)
- unit: TEXT
- sequence: INTEGER (display order)

### job_materials (materials snapshot for a specific job -- NO company_id, join via jobs)
- id: UUID (PK)
- job_id: UUID (FK -> jobs.id)
- routing_material_id: UUID (FK -> routing_materials.id, nullable if source deleted)
- inventory_item_id: UUID (FK -> inventory_items.id)
- expected_quantity: NUMERIC, actual_quantity: NUMERIC (nullable until consumed)
- unit: TEXT
- status: TEXT -- one of: 'pending', 'consumed', 'skipped'
- consumed_at: TIMESTAMPTZ, consumed_by: UUID (nullable)

### jobs
- id: UUID (PK)
- company_id: UUID -- ALWAYS filter with $1
- job_number: TEXT (unique per company, e.g. "J-001")
- quote_id: UUID (FK -> quotes.id, nullable)
- customer_id: UUID (FK -> customers.id, nullable)
- part_id: UUID (FK -> parts.id, nullable)
- description: TEXT
- status: TEXT -- one of: 'not_started', 'in_progress', 'completed', 'shipped', 'cancelled'
- status_changed_at: TIMESTAMPTZ
- current_operation_sequence: INTEGER
- started_at: TIMESTAMPTZ (when work began, nullable)
- completed_at: TIMESTAMPTZ (when all operations finished, nullable)
- shipped_at: TIMESTAMPTZ (when shipped to customer, nullable)
- created_at: TIMESTAMPTZ, updated_at: TIMESTAMPTZ

### job_operations (steps within a job -- NO company_id, join via jobs)
- id: UUID (PK)
- job_id: UUID (FK -> jobs.id)
- sequence: INTEGER (order within job, unique per job)
- operation_name: TEXT
- operation_type_id: UUID (FK -> operation_types.id, nullable)
- estimated_setup_hours: NUMERIC(8,2) (default 0)
- estimated_run_hours_per_unit: NUMERIC(8,4) (default 0)
- actual_setup_hours: NUMERIC(8,2)
- actual_run_hours: NUMERIC(8,2)
- status: TEXT -- one of: 'pending', 'in_progress', 'completed', 'skipped'
- started_at: TIMESTAMPTZ
- completed_at: TIMESTAMPTZ
- assigned_to: UUID (operator user)
- instructions: TEXT, notes: TEXT

### job_attachments
- id: UUID (PK)
- job_id: UUID (FK -> jobs.id)
- company_id: UUID -- ALWAYS filter with $1
- file_name: TEXT, file_path: TEXT, file_size: INTEGER, mime_type: TEXT

### operation_types (e.g. "CNC Milling", "Lathe", "Grinding")
- id: UUID (PK)
- company_id: UUID -- ALWAYS filter with $1
- name: TEXT (unique per company)
- labor_rate: NUMERIC(10,2) (cost per hour)
- description: TEXT

### operator_sessions (time tracking for operators working on jobs)
- id: UUID (PK)
- company_id: UUID -- ALWAYS filter with $1
- operator_id: UUID
- job_id: UUID (FK -> jobs.id)
- job_operation_id: UUID (FK -> job_operations.id, nullable)
- operation_type_id: UUID (FK -> operation_types.id)
- started_at: TIMESTAMPTZ
- ended_at: TIMESTAMPTZ (null = currently active)
- notes: TEXT

### inventory_items
- id: UUID (PK)
- company_id: UUID -- ALWAYS filter with $1
- name: TEXT
- description: TEXT
- primary_unit: TEXT (e.g. "ft", "ea", "lb")
- quantity: NUMERIC (current stock level, >= 0)
- cost_per_unit: NUMERIC(12,4)
- reorder_point: NUMERIC (nullable -- reorder when quantity drops to this)
- created_at: TIMESTAMPTZ, updated_at: TIMESTAMPTZ

### inventory_unit_conversions (NO company_id, join via inventory_items)
- id: UUID (PK)
- inventory_item_id: UUID (FK -> inventory_items.id)
- from_unit: TEXT (unique per item)
- to_primary_factor: NUMERIC (> 0, multiply by this to convert to primary_unit)

### inventory_transactions (stock movements)
- id: UUID (PK)
- company_id: UUID -- ALWAYS filter with $1
- inventory_item_id: UUID (FK -> inventory_items.id, nullable)
- item_name: TEXT
- type: TEXT -- one of: 'addition', 'depletion', 'adjustment'
- quantity: NUMERIC (>= 0)
- unit: TEXT
- converted_quantity: NUMERIC (quantity in primary units)
- job_id: UUID (FK -> jobs.id, nullable)
- job_operation_id: UUID (nullable)
- operator_id: UUID (nullable)
- notes: TEXT
- created_at: TIMESTAMPTZ

## Key Relationships
- jobs.quote_id -> quotes.id (a job may come from a quote)
- jobs.customer_id -> customers.id
- jobs.part_id -> parts.id
- job_operations.job_id -> jobs.id (a job has many operations)
- job_operations.operation_type_id -> operation_types.id
- quotes.customer_id -> customers.id
- quotes.part_id -> parts.id
- routings.part_id -> parts.id (1:1)
- routing_nodes.routing_id -> routings.id
- routing_nodes.operation_type_id -> operation_types.id
- routing_materials.routing_id -> routings.id
- routing_materials.inventory_item_id -> inventory_items.id
- job_materials.job_id -> jobs.id
- job_materials.routing_material_id -> routing_materials.id
- job_materials.inventory_item_id -> inventory_items.id
- inventory_transactions.inventory_item_id -> inventory_items.id
- inventory_unit_conversions.inventory_item_id -> inventory_items.id
- operator_sessions.job_id -> jobs.id

## Important Notes
- Tables WITHOUT company_id: job_operations, job_materials, routing_nodes, routing_materials, inventory_unit_conversions. Filter these via JOIN to their parent table.
  Example: `SELECT jo.* FROM job_operations jo JOIN jobs j ON jo.job_id = j.id WHERE j.company_id = $1`
- Revenue = quotes.total_price for shipped jobs (jobs.status = 'shipped', joined via jobs.quote_id)
- A "started" job means started_at IS NOT NULL or status = 'in_progress'
- Use DATE_TRUNC('week', timestamp) for weekly grouping, DATE_TRUNC('month', ...) for monthly
- All TIMESTAMPTZ columns are UTC

## Example Queries

-- Jobs started last week
SELECT COUNT(*) as job_count
FROM jobs
WHERE company_id = $1
  AND started_at >= DATE_TRUNC('week', NOW()) - INTERVAL '1 week'
  AND started_at < DATE_TRUNC('week', NOW());

-- Revenue by month (last 6 months)
SELECT DATE_TRUNC('month', j.shipped_at) as month,
       SUM(q.total_price) as revenue,
       COUNT(j.id) as job_count
FROM jobs j
JOIN quotes q ON j.quote_id = q.id
WHERE j.company_id = $1
  AND j.status = 'shipped'
  AND j.shipped_at >= NOW() - INTERVAL '6 months'
GROUP BY DATE_TRUNC('month', j.shipped_at)
ORDER BY month;

-- Top 5 customers by revenue
SELECT c.name, SUM(q.total_price) as revenue, COUNT(j.id) as job_count
FROM jobs j
JOIN customers c ON j.customer_id = c.id
JOIN quotes q ON j.quote_id = q.id
WHERE j.company_id = $1 AND j.status = 'shipped'
GROUP BY c.name
ORDER BY revenue DESC
LIMIT 5;

-- Inventory items below reorder point
SELECT name, quantity, reorder_point, primary_unit,
       (reorder_point - quantity) as deficit
FROM inventory_items
WHERE company_id = $1
  AND reorder_point IS NOT NULL
  AND quantity <= reorder_point
ORDER BY (reorder_point - quantity) DESC;
"""

# Allowlist of tables the AI is permitted to query
ALLOWED_TABLES = frozenset({
    "companies",
    "customers",
    "quotes",
    "quote_attachments",
    "parts",
    "routings",
    "routing_nodes",
    "routing_materials",
    "jobs",
    "job_operations",
    "job_materials",
    "job_attachments",
    "operation_types",
    "operator_sessions",
    "inventory_items",
    "inventory_unit_conversions",
    "inventory_transactions",
})
