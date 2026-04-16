-- ============================================================================
-- Migration: Linearize routings + relocate materials from operation- to
-- routing/job-level
-- ============================================================================
--
-- Two coordinated changes:
--
-- (1) The routing builder is moving from a DAG (routing_edges) to a simple
--     reorderable linear list. Operations are ordered by a new
--     `routing_nodes.sequence` column. The routing_edges table is dropped.
--
-- (2) Materials are no longer attached to individual operations
--     (routing_nodes.materials JSONB). They live at the routing level
--     (new routing_materials table) and are copied per-job into a new
--     job_materials table. This matches how shops actually think about
--     materials — a job-level shopping list, not a per-operation consumable.
--
-- Pre-launch context: per the user's direction, existing DAG routings are
-- collapsed to linear order based on routing_nodes.created_at. We don't
-- preserve parallel/branching structures. Existing per-operation materials
-- are aggregated to the routing level.
-- ============================================================================

BEGIN;

-- ============================================================================
-- 1. Add `sequence` to routing_nodes; backfill from created_at order
-- ============================================================================

ALTER TABLE routing_nodes
    ADD COLUMN IF NOT EXISTS sequence integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN routing_nodes.sequence
    IS 'Linear order of operations within the routing. Lower values execute first. Steps of 10 (10, 20, 30...) leave room for future inserts.';

WITH ordered AS (
    SELECT id,
           ROW_NUMBER() OVER (PARTITION BY routing_id ORDER BY created_at) * 10 AS seq
    FROM routing_nodes
)
UPDATE routing_nodes rn
SET sequence = ordered.seq
FROM ordered
WHERE rn.id = ordered.id;

ALTER TABLE routing_nodes
    ADD CONSTRAINT routing_nodes_routing_sequence_unique
    UNIQUE (routing_id, sequence)
    DEFERRABLE INITIALLY DEFERRED;

CREATE INDEX IF NOT EXISTS idx_routing_nodes_routing_sequence
    ON public.routing_nodes (routing_id, sequence);

-- ============================================================================
-- 2. Create routing_materials (routing-level materials list)
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.routing_materials (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    routing_id uuid NOT NULL REFERENCES routings(id) ON DELETE CASCADE,
    inventory_item_id uuid NOT NULL REFERENCES inventory_items(id) ON DELETE RESTRICT,
    quantity numeric NOT NULL CHECK (quantity > 0),
    unit text NOT NULL,
    sequence integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT routing_materials_routing_sequence_unique
        UNIQUE (routing_id, sequence) DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX IF NOT EXISTS idx_routing_materials_routing
    ON public.routing_materials (routing_id, sequence);
CREATE INDEX IF NOT EXISTS idx_routing_materials_inventory
    ON public.routing_materials (inventory_item_id);

DROP TRIGGER IF EXISTS routing_materials_updated_at ON public.routing_materials;
CREATE TRIGGER routing_materials_updated_at
    BEFORE UPDATE ON public.routing_materials
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

COMMENT ON TABLE public.routing_materials
    IS 'Materials needed for the entire routing (job-level shopping list). Replaces the per-operation routing_nodes.materials JSONB.';
COMMENT ON COLUMN public.routing_materials.sequence
    IS 'Display order in the routing builder. Steps of 10.';

ALTER TABLE public.routing_materials ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view routing_materials" ON public.routing_materials;
CREATE POLICY "Users can view routing_materials"
    ON public.routing_materials
    FOR SELECT
    USING (routing_id IN (SELECT routings.id FROM routings
                          WHERE routings.company_id IN (SELECT get_user_company_ids())));

DROP POLICY IF EXISTS "Users can insert routing_materials" ON public.routing_materials;
CREATE POLICY "Users can insert routing_materials"
    ON public.routing_materials
    FOR INSERT
    WITH CHECK (routing_id IN (SELECT routings.id FROM routings
                               WHERE routings.company_id IN (SELECT get_user_company_ids())));

DROP POLICY IF EXISTS "Users can update routing_materials" ON public.routing_materials;
CREATE POLICY "Users can update routing_materials"
    ON public.routing_materials
    FOR UPDATE
    USING (routing_id IN (SELECT routings.id FROM routings
                          WHERE routings.company_id IN (SELECT get_user_company_ids())));

DROP POLICY IF EXISTS "Users can delete routing_materials" ON public.routing_materials;
CREATE POLICY "Users can delete routing_materials"
    ON public.routing_materials
    FOR DELETE
    USING (routing_id IN (SELECT routings.id FROM routings
                          WHERE routings.company_id IN (SELECT get_user_company_ids())));

DROP POLICY IF EXISTS "ai_readonly_select" ON public.routing_materials;
CREATE POLICY "ai_readonly_select"
    ON public.routing_materials
    FOR SELECT
    TO jigged_ai_readonly
    USING (EXISTS (SELECT 1 FROM routings
                   WHERE routings.id = routing_materials.routing_id
                     AND routings.company_id = (current_setting('jigged.company_id', true))::uuid));

-- ============================================================================
-- 3. Migrate routing_nodes.materials JSONB → routing_materials
--    Aggregate by (routing, inventory_item, unit). Sequence by first-seen
--    creation order of the source node.
-- ============================================================================

INSERT INTO public.routing_materials (routing_id, inventory_item_id, quantity, unit, sequence)
SELECT
    agg.routing_id,
    agg.inventory_item_id,
    agg.total_quantity,
    agg.unit,
    ROW_NUMBER() OVER (PARTITION BY agg.routing_id ORDER BY agg.first_seen, agg.unit) * 10
FROM (
    SELECT
        rn.routing_id,
        (m->>'inventory_item_id')::uuid AS inventory_item_id,
        m->>'unit' AS unit,
        SUM((m->>'quantity')::numeric) AS total_quantity,
        MIN(rn.created_at) AS first_seen
    FROM routing_nodes rn
    CROSS JOIN LATERAL jsonb_array_elements(rn.materials) AS m
    WHERE jsonb_typeof(rn.materials) = 'array'
      AND m ? 'inventory_item_id'
      AND m ? 'quantity'
      AND m ? 'unit'
      AND (m->>'quantity')::numeric > 0
    GROUP BY rn.routing_id, (m->>'inventory_item_id')::uuid, m->>'unit'
) agg;

-- ============================================================================
-- 4. Create job_materials (per-job material list with consumption tracking)
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.job_materials (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    routing_material_id uuid REFERENCES routing_materials(id) ON DELETE SET NULL,
    inventory_item_id uuid NOT NULL REFERENCES inventory_items(id) ON DELETE RESTRICT,
    expected_quantity numeric NOT NULL DEFAULT 0 CHECK (expected_quantity >= 0),
    actual_quantity numeric CHECK (actual_quantity IS NULL OR actual_quantity >= 0),
    unit text NOT NULL,
    status text NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'consumed', 'skipped')),
    consumed_at timestamptz,
    consumed_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_job_materials_job
    ON public.job_materials (job_id);
CREATE INDEX IF NOT EXISTS idx_job_materials_inventory
    ON public.job_materials (inventory_item_id);
CREATE INDEX IF NOT EXISTS idx_job_materials_routing_material
    ON public.job_materials (routing_material_id);

DROP TRIGGER IF EXISTS job_materials_updated_at ON public.job_materials;
CREATE TRIGGER job_materials_updated_at
    BEFORE UPDATE ON public.job_materials
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

COMMENT ON TABLE public.job_materials
    IS 'Materials expected and consumed for a job. Snapshot from routing_materials at job creation time.';
COMMENT ON COLUMN public.job_materials.routing_material_id
    IS 'Source routing_material this row was copied from. SET NULL if the routing material is later deleted.';
COMMENT ON COLUMN public.job_materials.expected_quantity
    IS 'Quantity expected to be consumed (snapshot from routing_materials.quantity at job creation).';
COMMENT ON COLUMN public.job_materials.actual_quantity
    IS 'Quantity actually consumed, recorded by the operator on completion. NULL until consumed.';

ALTER TABLE public.job_materials ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view job_materials" ON public.job_materials;
CREATE POLICY "Users can view job_materials"
    ON public.job_materials
    FOR SELECT
    USING (job_id IN (SELECT jobs.id FROM jobs
                      WHERE jobs.company_id IN (SELECT get_user_company_ids())));

DROP POLICY IF EXISTS "Users can insert job_materials" ON public.job_materials;
CREATE POLICY "Users can insert job_materials"
    ON public.job_materials
    FOR INSERT
    WITH CHECK (job_id IN (SELECT jobs.id FROM jobs
                           WHERE jobs.company_id IN (SELECT get_user_company_ids())));

DROP POLICY IF EXISTS "Users can update job_materials" ON public.job_materials;
CREATE POLICY "Users can update job_materials"
    ON public.job_materials
    FOR UPDATE
    USING (job_id IN (SELECT jobs.id FROM jobs
                      WHERE jobs.company_id IN (SELECT get_user_company_ids())));

DROP POLICY IF EXISTS "Users can delete job_materials" ON public.job_materials;
CREATE POLICY "Users can delete job_materials"
    ON public.job_materials
    FOR DELETE
    USING (job_id IN (SELECT jobs.id FROM jobs
                      WHERE jobs.company_id IN (SELECT get_user_company_ids())));

DROP POLICY IF EXISTS "ai_readonly_select" ON public.job_materials;
CREATE POLICY "ai_readonly_select"
    ON public.job_materials
    FOR SELECT
    TO jigged_ai_readonly
    USING (EXISTS (SELECT 1 FROM jobs
                   WHERE jobs.id = job_materials.job_id
                     AND jobs.company_id = (current_setting('jigged.company_id', true))::uuid));

-- ============================================================================
-- 5. Backfill job_materials for jobs not yet shipped/cancelled
--    Already-shipped jobs are historical; we don't reconstruct their consumption.
-- ============================================================================

INSERT INTO public.job_materials (job_id, routing_material_id, inventory_item_id, expected_quantity, unit)
SELECT j.id, rm.id, rm.inventory_item_id, rm.quantity, rm.unit
FROM jobs j
JOIN routings r ON r.part_id = j.part_id
JOIN routing_materials rm ON rm.routing_id = r.id
WHERE j.status IN ('not_started', 'in_progress', 'completed');

-- ============================================================================
-- 6. Replace create_job_operations_from_routing: order by sequence + copy materials
-- ============================================================================

CREATE OR REPLACE FUNCTION public.create_job_operations_from_routing(p_job_id uuid, p_routing_id uuid)
RETURNS integer
LANGUAGE plpgsql
AS $function$
DECLARE
    v_count integer := 0;
    v_node record;
    v_seq integer := 10;
BEGIN
    FOR v_node IN
        SELECT rn.*, ot.name AS operation_name
        FROM routing_nodes rn
        JOIN operation_types ot ON rn.operation_type_id = ot.id
        WHERE rn.routing_id = p_routing_id
        ORDER BY rn.sequence, rn.created_at
    LOOP
        INSERT INTO job_operations (
            job_id, sequence, operation_name, operation_type_id,
            instructions, estimated_setup_minutes, estimated_run_minutes_per_unit, status,
            routing_node_id
        ) VALUES (
            p_job_id, v_seq, v_node.operation_name, v_node.operation_type_id,
            v_node.instructions, COALESCE(v_node.setup_time, 0), v_node.run_time_per_unit, 'pending',
            v_node.id
        );
        v_seq := v_seq + 10;
        v_count := v_count + 1;
    END LOOP;

    -- Copy routing_materials → job_materials (idempotent; only inserts if not already present)
    INSERT INTO job_materials (job_id, routing_material_id, inventory_item_id, expected_quantity, unit)
    SELECT p_job_id, rm.id, rm.inventory_item_id, rm.quantity, rm.unit
    FROM routing_materials rm
    WHERE rm.routing_id = p_routing_id
      AND NOT EXISTS (
          SELECT 1 FROM job_materials jm
          WHERE jm.job_id = p_job_id AND jm.routing_material_id = rm.id
      );

    IF v_count > 0 THEN
        UPDATE jobs SET current_operation_sequence = 10 WHERE id = p_job_id;
    END IF;
    RETURN v_count;
END;
$function$;

-- ============================================================================
-- 7. Replace get_ready_operations_batch: sequence-based predecessor check
-- ============================================================================

CREATE OR REPLACE FUNCTION public.get_ready_operations_batch(p_job_ids uuid[])
RETURNS TABLE(job_id uuid, operation_name text, ready_count integer)
LANGUAGE plpgsql
STABLE
AS $function$
BEGIN
    RETURN QUERY
    WITH
    in_progress_ops AS (
        SELECT
            jo.job_id,
            jo.operation_name,
            COUNT(*)::integer AS cnt
        FROM job_operations jo
        WHERE jo.job_id = ANY(p_job_ids)
          AND jo.status = 'in_progress'
        GROUP BY jo.job_id, jo.operation_name
    ),
    jobs_with_in_progress AS (
        SELECT DISTINCT ip.job_id FROM in_progress_ops ip
    ),
    -- Linear readiness: a pending op is ready iff every earlier-sequence op
    -- in the same job is completed or skipped.
    ready_ops AS (
        SELECT
            jo.job_id,
            jo.operation_name
        FROM job_operations jo
        WHERE jo.job_id = ANY(p_job_ids)
          AND jo.job_id NOT IN (SELECT jwi.job_id FROM jobs_with_in_progress jwi)
          AND jo.status = 'pending'
          AND NOT EXISTS (
              SELECT 1
              FROM job_operations prev
              WHERE prev.job_id = jo.job_id
                AND prev.sequence < jo.sequence
                AND prev.status NOT IN ('completed', 'skipped')
          )
    ),
    ready_agg AS (
        SELECT
            ro.job_id,
            MIN(ro.operation_name) AS operation_name,
            COUNT(*)::integer AS ready_count
        FROM ready_ops ro
        GROUP BY ro.job_id
    )
    SELECT ip.job_id, ip.operation_name, ip.cnt AS ready_count
    FROM in_progress_ops ip
    UNION ALL
    SELECT ra.job_id, ra.operation_name, ra.ready_count
    FROM ready_agg ra;
END;
$function$;

-- ============================================================================
-- 8. Replace get_ready_operations_for_station: sequence-based predecessor check
--    Also fixes the stale job-status filter (was 'pending'/'released' from
--    before the 20260406 status simplification).
-- ============================================================================

CREATE OR REPLACE FUNCTION public.get_ready_operations_for_station(
    p_company_id uuid,
    p_operation_type_id uuid
)
RETURNS TABLE(job_id uuid, job_operation_id uuid, operation_name text, op_status text)
LANGUAGE plpgsql
STABLE
AS $function$
BEGIN
    RETURN QUERY
    WITH eligible_jobs AS (
        SELECT j.id
        FROM jobs j
        WHERE j.company_id = p_company_id
          AND j.status IN ('not_started', 'in_progress')
    ),
    station_ops AS (
        SELECT jo.id, jo.job_id, jo.operation_name, jo.status, jo.sequence
        FROM job_operations jo
        JOIN eligible_jobs ej ON ej.id = jo.job_id
        WHERE jo.operation_type_id = p_operation_type_id
          AND jo.status IN ('pending', 'in_progress')
    ),
    ready_or_active AS (
        SELECT so.id, so.job_id, so.operation_name, so.status
        FROM station_ops so
        WHERE so.status = 'in_progress'
           OR NOT EXISTS (
               SELECT 1
               FROM job_operations prev
               WHERE prev.job_id = so.job_id
                 AND prev.sequence < so.sequence
                 AND prev.status NOT IN ('completed', 'skipped')
           )
    )
    SELECT ra.job_id, ra.id AS job_operation_id, ra.operation_name, ra.status AS op_status
    FROM ready_or_active ra;
END;
$function$;

-- ============================================================================
-- 9. Replace seed_demo_data (varchar overload — actively called)
--    - inserts routing_nodes with `sequence` instead of `materials`
--    - aggregates per-node template materials into routing_materials
--    - silently ignores any `edges` array in the template (DAG is gone)
--    - auto-populates job_materials for seeded jobs from their routing
-- ============================================================================

CREATE OR REPLACE FUNCTION public.seed_demo_data(
    p_company_id uuid,
    p_user_id uuid,
    p_template_name character varying DEFAULT 'default'::character varying
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
    v_template JSONB;
    v_ref_map JSONB := '{}';
    v_item JSONB;
    v_new_id UUID;
    v_node JSONB;
    v_op JSONB;
    v_routing_id UUID;
    v_job_id UUID;
    v_node_seq INTEGER;
BEGIN
    SELECT template_data INTO v_template
    FROM demo_data_templates
    WHERE name = p_template_name AND is_active = TRUE
    LIMIT 1;

    IF v_template IS NULL THEN
        RAISE EXCEPTION 'No active demo data template found for name: %', p_template_name;
    END IF;

    -- Customers
    IF v_template->'customers' IS NOT NULL THEN
        FOR v_item IN SELECT * FROM jsonb_array_elements(v_template->'customers') LOOP
            v_new_id := gen_random_uuid();
            v_ref_map := jsonb_set(v_ref_map, ARRAY[v_item->>'_ref'], to_jsonb(v_new_id::TEXT));
            INSERT INTO customers (id, company_id, name, contact_name, contact_email,
                                   contact_phone, city, state, country, created_at)
            VALUES (v_new_id, p_company_id,
                    v_item->>'name', v_item->>'contact_name', v_item->>'contact_email',
                    v_item->>'contact_phone', v_item->>'city', v_item->>'state',
                    COALESCE(v_item->>'country', 'USA'),
                    COALESCE((v_item->>'created_at')::TIMESTAMPTZ, NOW()));
        END LOOP;
    END IF;

    -- Resource groups
    IF v_template->'resource_groups' IS NOT NULL THEN
        FOR v_item IN SELECT * FROM jsonb_array_elements(v_template->'resource_groups') LOOP
            v_new_id := gen_random_uuid();
            v_ref_map := jsonb_set(v_ref_map, ARRAY[v_item->>'_ref'], to_jsonb(v_new_id::TEXT));
            INSERT INTO resource_groups (id, company_id, name, description, created_at)
            VALUES (v_new_id, p_company_id, v_item->>'name', v_item->>'description',
                    COALESCE((v_item->>'created_at')::TIMESTAMPTZ, NOW()));
        END LOOP;
    END IF;

    -- Operation types
    IF v_template->'operation_types' IS NOT NULL THEN
        FOR v_item IN SELECT * FROM jsonb_array_elements(v_template->'operation_types') LOOP
            v_new_id := gen_random_uuid();
            v_ref_map := jsonb_set(v_ref_map, ARRAY[v_item->>'_ref'], to_jsonb(v_new_id::TEXT));
            INSERT INTO operation_types (id, company_id, resource_group_id, name, labor_rate, description, created_at)
            VALUES (v_new_id, p_company_id,
                    (v_ref_map->>(v_item->>'resource_group_ref'))::UUID,
                    v_item->>'name', (v_item->>'labor_rate')::NUMERIC, v_item->>'description',
                    COALESCE((v_item->>'created_at')::TIMESTAMPTZ, NOW()));
        END LOOP;
    END IF;

    -- Part categories
    IF v_template->'part_categories' IS NOT NULL THEN
        FOR v_item IN SELECT * FROM jsonb_array_elements(v_template->'part_categories') LOOP
            v_new_id := gen_random_uuid();
            v_ref_map := jsonb_set(v_ref_map, ARRAY[v_item->>'_ref'], to_jsonb(v_new_id::TEXT));
            INSERT INTO part_categories (id, company_id, name, default_markup_percent, description, created_at)
            VALUES (v_new_id, p_company_id, v_item->>'name',
                    (v_item->>'default_markup_percent')::NUMERIC,
                    v_item->>'description',
                    COALESCE((v_item->>'created_at')::TIMESTAMPTZ, NOW()));
        END LOOP;
    END IF;

    -- Parts
    IF v_template->'parts' IS NOT NULL THEN
        FOR v_item IN SELECT * FROM jsonb_array_elements(v_template->'parts') LOOP
            v_new_id := gen_random_uuid();
            v_ref_map := jsonb_set(v_ref_map, ARRAY[v_item->>'_ref'], to_jsonb(v_new_id::TEXT));
            INSERT INTO parts (id, company_id, part_number, description,
                               category_id, manual_cost, cost_source, created_at)
            VALUES (v_new_id, p_company_id, v_item->>'part_number', v_item->>'description',
                    CASE WHEN v_item->>'category_ref' IS NOT NULL
                         THEN (v_ref_map->>(v_item->>'category_ref'))::UUID ELSE NULL END,
                    (v_item->>'manual_cost')::NUMERIC,
                    v_item->>'cost_source',
                    COALESCE((v_item->>'created_at')::TIMESTAMPTZ, NOW()));
        END LOOP;
    END IF;

    -- Inventory items
    IF v_template->'inventory_items' IS NOT NULL THEN
        FOR v_item IN SELECT * FROM jsonb_array_elements(v_template->'inventory_items') LOOP
            v_new_id := gen_random_uuid();
            v_ref_map := jsonb_set(v_ref_map, ARRAY[v_item->>'_ref'], to_jsonb(v_new_id::TEXT));
            INSERT INTO inventory_items (id, company_id, name, description, sku, primary_unit,
                                         quantity, cost_per_unit, reorder_point, created_at)
            VALUES (v_new_id, p_company_id, v_item->>'name', v_item->>'description',
                    v_item->>'sku', v_item->>'primary_unit',
                    COALESCE((v_item->>'quantity')::NUMERIC, 0),
                    (v_item->>'cost_per_unit')::NUMERIC,
                    (v_item->>'reorder_point')::NUMERIC,
                    COALESCE((v_item->>'created_at')::TIMESTAMPTZ, NOW()));
        END LOOP;
    END IF;

    -- Routings: insert routing, then nodes (with sequence by template order),
    -- then routing_materials (either new top-level "materials" array OR
    -- aggregated from per-node materials). Edges are silently ignored.
    IF v_template->'routings' IS NOT NULL THEN
        FOR v_item IN SELECT * FROM jsonb_array_elements(v_template->'routings') LOOP
            v_new_id := gen_random_uuid();
            v_routing_id := v_new_id;
            v_ref_map := jsonb_set(v_ref_map, ARRAY[v_item->>'_ref'], to_jsonb(v_new_id::TEXT));

            INSERT INTO routings (id, company_id, part_id, name, description, created_by, created_at)
            VALUES (v_new_id, p_company_id,
                    (v_ref_map->>(v_item->>'part_ref'))::UUID,
                    v_item->>'name', v_item->>'description',
                    p_user_id,
                    COALESCE((v_item->>'created_at')::TIMESTAMPTZ, NOW()));

            -- Nodes (sequence = position in template array, steps of 10)
            v_node_seq := 10;
            IF v_item->'nodes' IS NOT NULL THEN
                FOR v_node IN SELECT * FROM jsonb_array_elements(v_item->'nodes') LOOP
                    v_new_id := gen_random_uuid();
                    v_ref_map := jsonb_set(v_ref_map, ARRAY[v_node->>'_ref'], to_jsonb(v_new_id::TEXT));
                    INSERT INTO routing_nodes (id, routing_id, operation_type_id,
                                               run_time_per_unit, setup_time, instructions, sequence)
                    VALUES (v_new_id, v_routing_id,
                            (v_ref_map->>(v_node->>'operation_type_ref'))::UUID,
                            (v_node->>'run_time_per_unit')::NUMERIC,
                            COALESCE((v_node->>'setup_time')::NUMERIC, 0),
                            v_node->>'instructions',
                            v_node_seq);
                    v_node_seq := v_node_seq + 10;
                END LOOP;
            END IF;

            -- Materials: prefer routing-level "materials" array if present,
            -- otherwise aggregate from per-node materials.
            IF v_item->'materials' IS NOT NULL AND jsonb_typeof(v_item->'materials') = 'array' THEN
                INSERT INTO routing_materials (routing_id, inventory_item_id, quantity, unit, sequence)
                SELECT v_routing_id,
                       (v_ref_map->>(mat->>'inventory_item_ref'))::UUID,
                       (mat->>'quantity')::NUMERIC,
                       mat->>'unit',
                       (ord * 10)::INTEGER
                FROM jsonb_array_elements(v_item->'materials') WITH ORDINALITY AS arr(mat, ord)
                WHERE mat->>'inventory_item_ref' IS NOT NULL;
            ELSIF v_item->'nodes' IS NOT NULL THEN
                INSERT INTO routing_materials (routing_id, inventory_item_id, quantity, unit, sequence)
                SELECT
                    v_routing_id,
                    (v_ref_map->>agg.inv_ref)::UUID,
                    agg.qty,
                    agg.unit,
                    (ROW_NUMBER() OVER (ORDER BY agg.first_idx, agg.unit) * 10)::INTEGER
                FROM (
                    SELECT
                        mat->>'inventory_item_ref' AS inv_ref,
                        mat->>'unit' AS unit,
                        SUM((mat->>'quantity')::NUMERIC) AS qty,
                        MIN(node_pos.ord) AS first_idx
                    FROM jsonb_array_elements(v_item->'nodes') WITH ORDINALITY AS node_pos(node, ord)
                    CROSS JOIN LATERAL jsonb_array_elements(node_pos.node->'materials') AS mat
                    WHERE jsonb_typeof(node_pos.node->'materials') = 'array'
                      AND mat->>'inventory_item_ref' IS NOT NULL
                    GROUP BY mat->>'inventory_item_ref', mat->>'unit'
                ) agg;
            END IF;
        END LOOP;
    END IF;

    -- Quotes
    IF v_template->'quotes' IS NOT NULL THEN
        FOR v_item IN SELECT * FROM jsonb_array_elements(v_template->'quotes') LOOP
            v_new_id := gen_random_uuid();
            v_ref_map := jsonb_set(v_ref_map, ARRAY[v_item->>'_ref'], to_jsonb(v_new_id::TEXT));
            INSERT INTO quotes (id, company_id, customer_id, part_id, description,
                                quantity, unit_price, status, created_by,
                                base_cost, markup_percent, cost_source,
                                labor_cost_snapshot, material_cost_snapshot,
                                created_at)
            VALUES (v_new_id, p_company_id,
                    (v_ref_map->>(v_item->>'customer_ref'))::UUID,
                    CASE WHEN v_item->>'part_ref' IS NOT NULL
                         THEN (v_ref_map->>(v_item->>'part_ref'))::UUID ELSE NULL END,
                    v_item->>'description',
                    COALESCE((v_item->>'quantity')::INTEGER, 1),
                    (v_item->>'unit_price')::NUMERIC,
                    COALESCE(v_item->>'status', 'draft'),
                    p_user_id,
                    (v_item->>'base_cost')::NUMERIC,
                    (v_item->>'markup_percent')::NUMERIC,
                    v_item->>'cost_source',
                    (v_item->>'labor_cost_snapshot')::NUMERIC,
                    (v_item->>'material_cost_snapshot')::NUMERIC,
                    COALESCE((v_item->>'created_at')::TIMESTAMPTZ, NOW()));
        END LOOP;
    END IF;

    -- Jobs + job_operations + job_materials (auto-copied from routing)
    IF v_template->'jobs' IS NOT NULL THEN
        FOR v_item IN SELECT * FROM jsonb_array_elements(v_template->'jobs') LOOP
            v_new_id := gen_random_uuid();
            v_job_id := v_new_id;
            v_ref_map := jsonb_set(v_ref_map, ARRAY[v_item->>'_ref'], to_jsonb(v_new_id::TEXT));

            INSERT INTO jobs (id, company_id, customer_id, part_id, quote_id,
                              description, status, created_by, created_at,
                              started_at, completed_at, shipped_at, status_changed_at)
            VALUES (v_new_id, p_company_id,
                    (v_ref_map->>(v_item->>'customer_ref'))::UUID,
                    CASE WHEN v_item->>'part_ref' IS NOT NULL
                         THEN (v_ref_map->>(v_item->>'part_ref'))::UUID ELSE NULL END,
                    CASE WHEN v_item->>'quote_ref' IS NOT NULL
                         THEN (v_ref_map->>(v_item->>'quote_ref'))::UUID ELSE NULL END,
                    v_item->>'description',
                    COALESCE(v_item->>'status', 'not_started'),
                    p_user_id,
                    COALESCE((v_item->>'created_at')::TIMESTAMPTZ, NOW()),
                    (v_item->>'started_at')::TIMESTAMPTZ,
                    (v_item->>'completed_at')::TIMESTAMPTZ,
                    (v_item->>'shipped_at')::TIMESTAMPTZ,
                    (v_item->>'status_changed_at')::TIMESTAMPTZ);

            IF v_item->'operations' IS NOT NULL THEN
                FOR v_op IN SELECT * FROM jsonb_array_elements(v_item->'operations') LOOP
                    v_new_id := gen_random_uuid();
                    v_ref_map := jsonb_set(v_ref_map, ARRAY[v_op->>'_ref'], to_jsonb(v_new_id::TEXT));
                    INSERT INTO job_operations (id, job_id, sequence, operation_name,
                                                operation_type_id, estimated_setup_minutes,
                                                estimated_run_minutes_per_unit,
                                                actual_setup_minutes, actual_run_minutes,
                                                status, routing_node_id, instructions,
                                                started_at, completed_at, created_at)
                    VALUES (v_new_id, v_job_id,
                            (v_op->>'sequence')::INTEGER,
                            v_op->>'operation_name',
                            CASE WHEN v_op->>'operation_type_ref' IS NOT NULL
                                 THEN (v_ref_map->>(v_op->>'operation_type_ref'))::UUID ELSE NULL END,
                            COALESCE((v_op->>'estimated_setup_minutes')::NUMERIC,
                                     (v_op->>'estimated_setup_hours')::NUMERIC * 60, 0),
                            COALESCE((v_op->>'estimated_run_minutes_per_unit')::NUMERIC,
                                     (v_op->>'estimated_run_hours_per_unit')::NUMERIC * 60, 0),
                            COALESCE((v_op->>'actual_setup_minutes')::NUMERIC,
                                     (v_op->>'actual_setup_hours')::NUMERIC * 60),
                            COALESCE((v_op->>'actual_run_minutes')::NUMERIC,
                                     (v_op->>'actual_run_hours')::NUMERIC * 60),
                            COALESCE(v_op->>'status', 'pending'),
                            CASE WHEN v_op->>'routing_node_ref' IS NOT NULL
                                 THEN (v_ref_map->>(v_op->>'routing_node_ref'))::UUID ELSE NULL END,
                            v_op->>'instructions',
                            (v_op->>'started_at')::TIMESTAMPTZ,
                            (v_op->>'completed_at')::TIMESTAMPTZ,
                            COALESCE((v_op->>'created_at')::TIMESTAMPTZ, NOW()));
                END LOOP;
            END IF;

            -- Auto-populate job_materials from this job's part's routing
            IF v_item->>'part_ref' IS NOT NULL THEN
                INSERT INTO job_materials (job_id, routing_material_id, inventory_item_id, expected_quantity, unit)
                SELECT v_job_id, rm.id, rm.inventory_item_id, rm.quantity, rm.unit
                FROM routing_materials rm
                JOIN routings r ON r.id = rm.routing_id
                WHERE r.part_id = (v_ref_map->>(v_item->>'part_ref'))::UUID;
            END IF;
        END LOOP;
    END IF;

    -- Link converted quotes
    IF v_template->'quotes' IS NOT NULL THEN
        FOR v_item IN SELECT * FROM jsonb_array_elements(v_template->'quotes') LOOP
            IF v_item->>'converted_to_job_ref' IS NOT NULL THEN
                UPDATE quotes
                SET converted_to_job_id = (v_ref_map->>(v_item->>'converted_to_job_ref'))::UUID,
                    converted_at = (v_item->>'converted_at')::TIMESTAMPTZ
                WHERE id = (v_ref_map->>(v_item->>'_ref'))::UUID;
            END IF;
        END LOOP;
    END IF;
END;
$function$;

-- ============================================================================
-- 10. Drop the stale jsonb-overload of seed_demo_data (it referenced an
--     ancient customer schema and would already fail at runtime; relying on
--     dropped routing_edges/routing_nodes.materials makes that worse).
-- ============================================================================

DROP FUNCTION IF EXISTS public.seed_demo_data(uuid, uuid, jsonb);

-- ============================================================================
-- 11. Replace reset_demo_company: drop routing_edges DELETE, add new tables
-- ============================================================================

CREATE OR REPLACE FUNCTION public.reset_demo_company(p_source_company_id uuid, p_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
    v_demo_company_id UUID;
BEGIN
    IF p_user_id != auth.uid() THEN
        RAISE EXCEPTION 'Access denied';
    END IF;

    SELECT demo_company_id INTO v_demo_company_id
    FROM companies WHERE id = p_source_company_id;

    IF v_demo_company_id IS NULL THEN
        RAISE EXCEPTION 'No demo company exists for company: %', p_source_company_id;
    END IF;

    -- Delete in reverse FK order
    DELETE FROM operator_sessions WHERE company_id = v_demo_company_id;
    DELETE FROM inventory_transactions WHERE company_id = v_demo_company_id;
    DELETE FROM job_attachments WHERE company_id = v_demo_company_id;
    DELETE FROM quote_attachments WHERE company_id = v_demo_company_id;
    DELETE FROM job_materials WHERE job_id IN (SELECT id FROM jobs WHERE company_id = v_demo_company_id);
    DELETE FROM job_operations WHERE job_id IN (SELECT id FROM jobs WHERE company_id = v_demo_company_id);
    DELETE FROM jobs WHERE company_id = v_demo_company_id;
    DELETE FROM quotes WHERE company_id = v_demo_company_id;
    DELETE FROM routing_materials WHERE routing_id IN (SELECT id FROM routings WHERE company_id = v_demo_company_id);
    DELETE FROM routing_nodes WHERE routing_id IN (SELECT id FROM routings WHERE company_id = v_demo_company_id);
    DELETE FROM routings WHERE company_id = v_demo_company_id;
    DELETE FROM parts WHERE company_id = v_demo_company_id;
    DELETE FROM part_categories WHERE company_id = v_demo_company_id;
    DELETE FROM inventory_items WHERE company_id = v_demo_company_id;
    DELETE FROM operation_types WHERE company_id = v_demo_company_id;
    DELETE FROM resource_groups WHERE company_id = v_demo_company_id;
    DELETE FROM customers WHERE company_id = v_demo_company_id;

    DELETE FROM ai_chat_queries WHERE company_id = v_demo_company_id;
    DELETE FROM ai_insight_cache WHERE company_id = v_demo_company_id;

    PERFORM seed_demo_data(v_demo_company_id, p_user_id);
END;
$function$;

-- ============================================================================
-- 12. Drop routing_edges and routing_nodes.materials (no longer used)
-- ============================================================================

DROP TABLE IF EXISTS public.routing_edges CASCADE;
ALTER TABLE public.routing_nodes DROP COLUMN IF EXISTS materials;

COMMIT;
