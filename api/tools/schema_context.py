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
- deleted_at: TIMESTAMPTZ (archived when set — filter `deleted_at IS NULL` for
  any list, count or ranking; a by-id lookup deliberately does not)
- default_payment_terms: TEXT
  -- the customer's STANDING term, applied to NEW quotes only. A quote's own
  payment_terms / lead_time_text are what that quote was issued
  with; never answer "what terms is quote X on?" from these columns.
- created_at: TIMESTAMPTZ, updated_at: TIMESTAMPTZ
- NOTE: There are no contact_name/contact_phone/contact_email columns. Contacts
  live on customer_contacts (one row per person, is_primary flags the main one).
- NOTE: Address fields are stored on a separate customer_addresses table,
  one row per address tagged with default_billing/default_shipping flags.

### customer_addresses
- id: UUID (PK)
- customer_id: UUID (FK -> customers.id) -- join via customer.id
- address_line1: TEXT, address_line2: TEXT
- city: TEXT, state: TEXT, postal_code: TEXT, country: TEXT (default 'USA')
- default_billing: BOOLEAN (at most one per customer by product rule)
- default_shipping: BOOLEAN (at most one per customer by product rule)
- Both flags can be unset; the row stays on file as a reference.
- attention_to: TEXT (optional "ATTN:" recipient line for packing slips)
- created_at: TIMESTAMPTZ, updated_at: TIMESTAMPTZ

### vendors (suppliers and outside-process providers)
- id: UUID (PK)
- company_id: UUID -- ALWAYS filter with $1
- name: TEXT (unique per company)
- deleted_at: TIMESTAMPTZ (archive marker -- filter `deleted_at IS NULL` on lists)
- created_at: TIMESTAMPTZ, updated_at: TIMESTAMPTZ
- NOTE: a vendor row is IDENTITY ONLY. There are no contact_* columns (dropped
  20260504), no notes column, and no address columns (dropped 20260824).
  Contacts are vendor_contacts, addresses are vendor_addresses, services are
  vendor_services -- each 1-to-many, so a vendor is not limited to one of any.

### vendor_addresses (a vendor's postal addresses, 1-to-many)
- id: UUID (PK)
- vendor_id: UUID (FK -> vendors.id) -- NO company_id; scope through the vendor
- address_line1: TEXT, address_line2: TEXT
- city: TEXT, state: TEXT, postal_code: TEXT, country: TEXT
- attention_to: TEXT (the ATTN: line)
- is_default: BOOLEAN -- at most one true per vendor. ONE flag, not the
  default_billing/default_shipping pair customer_addresses carries.
- created_at: TIMESTAMPTZ, updated_at: TIMESTAMPTZ
- NOTE: vendors do NOT carry capability flags. Whether a vendor supplies
  materials vs. performs outside ops is derived from references:
    * "supplies materials" = some part has parts.preferred_vendor_id = vendor.id
    * "performs outside ops" = some vendor_services row has vendor_id = vendor.id

### parts (UNIFIED — absorbs the old `inventory_items` table)
- id: UUID (PK)
- company_id: UUID -- ALWAYS filter with $1
- part_name: TEXT (unique per company)
- description: TEXT
- source: TEXT (CHECK 'made'|'bought'; default 'made') -- 'made' = produced in-shop (has a routing); 'bought' = procured from a vendor
- primary_unit: TEXT (required for EVERY part; e.g. 'ea', 'lb', 'ft')
- quantity: NUMERIC (default 0; current stock-on-hand, >= 0)
- (Cost is computed live by compute_part_cost_at_qty(part_id, qty); no
  cost column on parts. For bought parts the cost comes from
  part_procurement_tiers; for made parts it's labor + setup/qty + BOM rollup.)
- reorder_point: NUMERIC (nullable; reorder when quantity drops to this)
- preferred_vendor_id: UUID (FK -> vendors.id, nullable)
- created_at: TIMESTAMPTZ, updated_at: TIMESTAMPTZ
- There is no is_stocked column. EVERY part can carry stock and starts at quantity 0, so
  "is this part stocked" is answered by quantity > 0, never by a flag. `source` is the only
  classification axis: 'made' parts are produced in-shop, 'bought' parts are procured.

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

### quotes
- id: UUID (PK)
- company_id: UUID -- ALWAYS filter with $1
- quote_number: TEXT (unique per company, e.g. 'Q-001'; auto-generated)
- customer_id: UUID (FK -> customers.id, nullable)
- status: TEXT -- one of: 'active', 'expired'
- status_changed_at: TIMESTAMPTZ
- converted_at: TIMESTAMPTZ (when accepted/converted to a job)
- lead_time_text: TEXT (free-text lead time as stated, e.g. "2–3 weeks", "In stock"; does not drive the job due date)
- payment_terms: TEXT (e.g. 'Net 30', '2/10 Net 30'), expiration_date: DATE
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
- due_date: DATE
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
- quantity: NUMERIC (>0) -- editable after job creation; fractional allowed
- unit_price: NUMERIC(12,4) -- agreed price per unit (the per-part revenue source)
- total_price: NUMERIC(12,4) -- agreed line total (quantity * unit_price); USE THIS for job revenue
- true_cost_per_unit: NUMERIC (nullable) -- USE THIS for job cost. The all-in TRUE cost of
  one unit (labor + materials + the whole nested BOM), FROZEN when the job_part was created
  and re-taken only when its quantity changes. Cost of the line = true_cost_per_unit *
  quantity; profit = total_price - that. Never recompute cost from the part's current
  routing or rates — that would make a shipped job's profit move when a rate changes.
  NULL means the cost could not be determined at snapshot time: EXCLUDE that job_part from
  profit answers and say so. Never treat NULL as zero cost.
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
- labor_rate_snapshot: NUMERIC(10,2) (nullable) -- internal ops: the per-hour rate FROZEN at
  cloning. Use this, not work_centers.labor_rate, for anything historical.
- external_unit_price_snapshot: NUMERIC(12,4) (nullable) -- external ops: price per unit, frozen
- NOTE: these three make LABOR itemisable per operation without reading a live rate:
    internal: (estimated_setup_minutes + estimated_run_minutes_per_unit * job_parts.quantity)
              / 60 * labor_rate_snapshot
    external: external_unit_price_snapshot * job_parts.quantity
  MATERIALS are not itemised per line anywhere. Get them by subtraction:
  material cost = job_parts.true_cost_per_unit * quantity - (labor summed as above).
- status: TEXT -- one of: 'pending', 'in_progress', 'completed', 'sent'
- completed_at: TIMESTAMPTZ, completed_by: UUID
- sent_at: TIMESTAMPTZ, sent_by: UUID -- external ops only (send/receive lifecycle)
- instructions: TEXT, notes: TEXT
-- NOTE: started_at and assigned_to were DROPPED (20260708225938). They were listed
-- here until 2026-08-16, so any query the model had learned using them returned a
-- 400. RECORDED TIME now lives in job_operation_intervals (below), not on this table.

### job_operation_intervals (recorded time on an operation — 20260816203641)
- id: UUID (PK)
- company_id: UUID (FK -> companies.id)
- job_operation_id: UUID (FK -> job_operations.id)
- job_part_id: UUID (FK -> job_parts.id)
- work_center_id: UUID (nullable) -- the chain key: one OPEN interval per work centre
- operator_id: UUID (FK -> user_company_access.id)
- started_at / ended_at: TIMESTAMPTZ -- RAW, immutable. ended_at NULL = still running
- adjusted_started_at / adjusted_ended_at: TIMESTAMPTZ (nullable) -- the operator's correction
- effective_started_at / effective_ended_at: TIMESTAMPTZ (GENERATED COALESCE of the two)
- close_reason: TEXT -- 'completed' | 'switched' | 'done_for_day' | 'left_running'
- capture_source: TEXT -- 'operator' | 'sensor' | 'system'
- voided_at / voided_by
- ALWAYS read effective_*, never the raw pair, unless the question is specifically
  about corrections. ALWAYS filter voided_at IS NULL.
- An interval with ended_at IS NULL has NO duration. Exclude it from any SUM and
  report it separately — do not clamp it to now(), which invents time nobody worked.
- DO NOT aggregate by operator_id. Time is reported per job / operation / work
  centre, and there is NO per-person reporting path at all: get_operator_time_detail(),
  the one function that resolved recorded time to a named person, was dropped along
  with its access log. See docs/modules/operator-view.md#surveillance-guardrail-non-negotiable.

### job_materials (expected-BOM snapshot for a specific job_part — NO company_id, join via jobs)
- id: UUID (PK)
- job_id: UUID (FK -> jobs.id)
- job_part_id: UUID (FK -> job_parts.id)
- parts_bom_id: UUID (FK -> parts_bom.id, nullable if source deleted)
- material_part_id: UUID (FK -> parts.id) -- the material
- expected_quantity: NUMERIC (>=0)
- unit: TEXT
-- Consumption is no longer tracked here; the part BOM (parts_bom) is the source of truth.

### work_centers (IN-HOUSE capacity only; e.g. 'CNC Mill #1', 'Deburr Bench')
- id: UUID (PK)
- company_id: UUID -- ALWAYS filter with $1
- name: TEXT (unique per company)
- labor_rate: NUMERIC(10,2) (per-hour rate)
- description: TEXT, metadata: JSONB
- deleted_at: TIMESTAMPTZ (archive marker -- filter `deleted_at IS NULL` on lists)
- created_at: TIMESTAMPTZ, updated_at: TIMESTAMPTZ
- NOTE: there is NO `kind` and NO `vendor_id` here. Outsourced processes are
  NOT work centres -- they are vendor_services (below). A query looking for
  outside work in this table will find nothing.

### vendor_services (a process an outside vendor performs, e.g. 'Anodize')
- id: UUID (PK)
- company_id: UUID -- ALWAYS filter with $1
- vendor_id: UUID (FK -> vendors.id) -- the vendor performing it
- name: TEXT -- the PROCESS, unique per vendor (two vendors may both offer 'Anodize')
- unit_price: NUMERIC(12,4) -- price per piece; INHERITED by routing operations
- description: TEXT
- deleted_at: TIMESTAMPTZ (archive marker -- filter `deleted_at IS NULL` on lists)
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
- work_center_id: UUID (FK -> work_centers.id) -- NULL when this step is outside work
- vendor_service_id: UUID (FK -> vendor_services.id) -- NULL when this step runs in-house
  -- EXACTLY ONE of work_center_id / vendor_service_id is set on every row
  --   (CHECK routing_operations_exactly_one_target). `vendor_service_id IS NOT NULL`
  --   is how you ask "is this outside work?" -- there is no kind column any more.
- sequence: INTEGER (unique per routing; lower runs first)
- setup_minutes: NUMERIC(8,2) (default 0) -- MINUTES; one-time per batch (internal only)
- cycle_minutes_per_unit: NUMERIC(8,4) -- MINUTES per unit (internal only)
- labor_rate_override: NUMERIC(10,2) -- per-op override of work_centers.labor_rate (internal only)
- external_unit_price: NUMERIC(12,4) -- price per output unit (external only)
- instructions: TEXT, metadata: JSONB
- created_at: TIMESTAMPTZ, updated_at: TIMESTAMPTZ
- NOTE: external_setup_cost was DROPPED (migration 20260623022617). Do not reference it.
- COST CONTRACT (mirrors compute_part_cost_at_qty, migration 20260514):
    * internal: cost = (setup_minutes/qty + cycle_minutes_per_unit)
                       * COALESCE(labor_rate_override, work_centers.labor_rate)
                       / 60.0
    * external: cost = external_unit_price
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
- routings.part_id -> parts.id (1:1)
- routing_operations.routing_id -> routings.id
- routing_operations.work_center_id -> work_centers.id
- vendor_services.vendor_id -> vendors.id
- vendor_addresses.vendor_id -> vendors.id
- routing_operations.vendor_service_id -> vendor_services.id
- job_operations.vendor_service_id -> vendor_services.id
- parts.preferred_vendor_id -> vendors.id
- parts_bom.parent_part_id -> parts.id, .child_part_id -> parts.id
- parts_unit_conversions.part_id -> parts.id
- inventory_transactions.part_id -> parts.id

## Important Notes
- Tables WITHOUT company_id: job_operations, job_materials, routing_operations,
  parts_bom, parts_unit_conversions. Filter these via JOIN to their parent table.
  Example: `SELECT jo.* FROM job_operations jo JOIN jobs j ON jo.job_id = j.id WHERE j.company_id = $1`
- A "started" job means started_at IS NOT NULL or production_status = 'in_progress'.
- A "shipped" job means fulfillment_status = 'fully_shipped'. The last ship
  date comes from public.job_last_ship_date(job_id), which sums non-voided
  shipments. There is no jobs.shipped_at column anymore.
- Revenue per OPEN quote (pipeline / not yet converted) = SUM(quote_line_items.total_price) WHERE quote_id = ?.
- Revenue per job (realized) = SUM(job_parts.total_price) for that job's parts.
  Use job_parts, NOT the source quote line — job_parts.quantity/unit_price are
  the post-conversion source of truth (a quantity edited after conversion shows
  here), and a price-options quote keeps unchosen lines that would over-count.
- Use DATE_TRUNC('week', timestamp) for weekly grouping, DATE_TRUNC('month', ...) for monthly.
- All TIMESTAMPTZ columns are UTC.
- Cost contract for internal routing/job operations:
    labor_rate = COALESCE(routing_operations.labor_rate_override, work_centers.labor_rate)
    cost      = (estimated_setup_minutes + estimated_run_minutes_per_unit * qty)
                / 60.0 * labor_rate
  For external operations the cost is external_unit_price * qty + external_setup_cost.
- Time fields are MINUTES on both routing_operations (setup_minutes,
  cycle_minutes_per_unit) and job_operations (estimated_setup_minutes,
  estimated_run_minutes_per_unit).
  Divide by 60 before multiplying by an hourly labor_rate.

## Example Queries

-- Jobs started last week
SELECT COUNT(*) AS job_count
FROM jobs
WHERE company_id = $1
  AND started_at >= DATE_TRUNC('week', NOW()) - INTERVAL '1 week'
  AND started_at <  DATE_TRUNC('week', NOW());

-- Revenue by month (last 6 months) — sum job_parts.total_price (the agreed
-- per-part line total, post-conversion source of truth). Uses the
-- public.job_last_ship_date(jobs.id) helper instead of the dropped shipped_at.
SELECT DATE_TRUNC('month', public.job_last_ship_date(j.id)::timestamptz) AS month,
       SUM(jp.total_price)              AS revenue,
       COUNT(DISTINCT j.id)             AS job_count
FROM jobs j
JOIN job_parts jp ON jp.job_id = j.id
WHERE j.company_id = $1
  AND j.fulfillment_status = 'fully_shipped'
  AND public.job_last_ship_date(j.id) >= (CURRENT_DATE - INTERVAL '6 months')
GROUP BY DATE_TRUNC('month', public.job_last_ship_date(j.id)::timestamptz)
ORDER BY month;

-- Top 5 customers by revenue
SELECT c.name,
       SUM(jp.total_price) AS revenue,
       COUNT(DISTINCT j.id) AS job_count
FROM jobs j
JOIN customers c  ON c.id = j.customer_id
JOIN job_parts jp ON jp.job_id = j.id
WHERE j.company_id = $1 AND j.fulfillment_status = 'fully_shipped'
GROUP BY c.name
ORDER BY revenue DESC
LIMIT 5;

-- Parts below their reorder point
SELECT part_name, quantity, reorder_point, primary_unit,
       (reorder_point - quantity) AS deficit
FROM parts
WHERE company_id = $1
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
    "quotes",
    "quote_line_items",
    "jobs",
    "job_parts",
    "job_operations",
    "job_materials",
    "work_centers",
    "vendor_services",
    "vendor_addresses",
    "routings",
    "routing_operations",
    "inventory_transactions",
})

# Denylist of sensitive auth/system tables the AI must NEVER query. The
# ALLOWED_TABLES allowlist above is the primary boundary; this is a
# guaranteed-catch backstop: the validator rejects any query in which one of
# these names appears as a whole word — comma-join, CTE, subquery, or alias —
# regardless of how table extraction parses it. Database Row-Level Security is
# the final backstop. Keep this in sync with the "Excluded Tables" section of
# docs/modules/ai-insights.md.
SENSITIVE_TABLES = frozenset({
    "user_company_access",
    "user_preferences",
    "system_admins",
    "auth_audit_log",
    "ai_chat_queries",
    "ai_config",
    "saved_insights",
    "demo_data_templates",
    "quickbooks_connections",
    "quickbooks_customer_map",
    # The customer's own carrier account number — their shared secret, not ours.
    # "Which customers ship on their own UPS account?" is a reasonable question
    # for an owner to type, and answering it from this table would put account
    # numbers into an AI response and into ai_chat_queries. Triple-blocked, the
    # same way the quickbooks_* tables are: absent from ALLOWED_TABLES (the
    # primary boundary), REVOKEd from jigged_ai_readonly in the migration
    # (the baseline's ALTER DEFAULT PRIVILEGES grants SELECT on every new public
    # table, so that revoke is load-bearing, not decorative), and no
    # ai_readonly_select policy. This entry is the whole-word backstop.
    "customer_carrier_accounts",
    "quickbooks_invoice_links",
    # The clickwrap record: who accepted which legal document, from which IP.
    # Blocked for the same reason as customer_carrier_accounts and for one more.
    # It carries IP addresses and user agents, which are personal data nobody
    # needs an AI summary of; and it is a legal audit trail, so putting it in
    # reach of generated SQL creates a path by which a question about it lands
    # in ai_chat_queries. Triple-blocked: absent from ALLOWED_TABLES, REVOKEd
    # from jigged_ai_readonly in 20260818142814, and named here as the
    # whole-word backstop.
    "terms_acceptances",
    # Read-tracking and capture-funnel instrumentation. "Which operators read the
    # setup notes?" is a natural question for a shop owner to type, and answering
    # it is exactly what the product forbids: if an owner can audit who reads
    # notes, reading becomes an admission of ignorance and the read side dies.
    # These are already triple-blocked (absent from ALLOWED_TABLES, no grant to
    # jigged_ai_readonly, no ai_readonly_select policy); this is the whole-word
    # backstop. Never grant these to jigged_ai_readonly and never add them to
    # ALLOWED_TABLES. notes.viewer_count / usage_count riding along if `notes` is
    # ever allowlisted is fine — those are aggregate counts, not identities.
    "note_views",
    "operator_events",
    # The AI layer's own plumbing: the work queue, the per-attempt spend ledger,
    # and the desktop worker registry. "How much are we spending on AI?" is a
    # perfectly natural thing for an owner to type, and ai_calls is the table that
    # would answer it -- which is exactly why it must not be reachable from
    # generated SQL. ai_jobs is worse: its payload column carries the questions
    # other companies asked. Triple-blocked like the rest -- absent from
    # ALLOWED_TABLES, REVOKEd from jigged_ai_readonly in the migrations that create
    # them (the baseline's ALTER DEFAULT PRIVILEGES grants SELECT on every new
    # public table, so those revokes are load-bearing), and named here as the
    # whole-word backstop. ai_call_write_leaks() and ai_job_write_leaks() assert
    # the first two layers on every CI run.
    "ai_calls",
    "ai_jobs",
    "ai_workers",
})
