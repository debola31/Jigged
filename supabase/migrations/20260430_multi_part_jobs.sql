-- Multi-part jobs: a job is now the project header (mirrors a quote 1:1) and
-- carries N child job_parts, each with their own routing-derived operations
-- and materials, status, and timestamps.
--
-- Steps:
--   1. Create job_parts table + RLS.
--   2. Add job_part_id to job_operations + job_materials (nullable).
--   3. Backfill: one job_parts row per existing job; rewire children.
--   4. Drop legacy columns from jobs (part_id, source_quote_line_item_id,
--      current_operation_sequence). Make job_part_id NOT NULL on children.
--      Replace the (job_id, sequence) unique on job_operations with
--      (job_part_id, sequence).
--   5. Drop the per-company auto-numbering trigger + function on jobs. Job
--      numbers are now mirrored from the source quote at insert time
--      (`Q-NNNN` → `J-NNNN`); manual job creation is no longer supported.
--   6. Replace create_job_operations_from_routing(job_id, routing_id) with
--      create_job_part_operations_from_routing(job_part_id, routing_id).
--   7. Update get_ready_operations_for_station to surface job_part_id +
--      part name + part quantity, scope readiness DAG to job_part_id.
--   8. Update get_ready_operations_batch to scope readiness DAG to job_part_id.
--   9. Add compute_job_status(job_id) + AFTER trigger on job_parts that keeps
--      jobs.status / status_changed_at / started_at / completed_at / shipped_at
--      in sync with the aggregate of its children.
--  10. Update reset_demo_company to drop the now-removed quote_attachments
--      and job_attachments DELETEs.
--  11. Update seed_demo_data: insert one job_parts per (job, part) and use
--      the new job_part_id when creating operations + materials.

BEGIN;

-- ============================================================================
-- 1. Create job_parts
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.job_parts (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL,
  company_id uuid NOT NULL,
  part_id uuid NOT NULL,
  source_quote_line_item_id uuid,
  sequence integer NOT NULL,
  quantity integer NOT NULL,
  status text NOT NULL DEFAULT 'not_started',
  status_changed_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  shipped_at timestamptz,
  current_operation_sequence integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT job_parts_pkey PRIMARY KEY (id),
  CONSTRAINT job_parts_job_sequence_unique UNIQUE (job_id, sequence),
  CONSTRAINT job_parts_job_part_unique UNIQUE (job_id, part_id),
  CONSTRAINT job_parts_quantity_check CHECK (quantity > 0),
  CONSTRAINT job_parts_status_check CHECK (
    status IN ('not_started','in_progress','completed','shipped','cancelled')
  ),
  CONSTRAINT job_parts_job_id_fkey
    FOREIGN KEY (job_id) REFERENCES public.jobs(id) ON DELETE CASCADE,
  CONSTRAINT job_parts_company_id_fkey
    FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE,
  CONSTRAINT job_parts_part_id_fkey
    FOREIGN KEY (part_id) REFERENCES public.parts(id),
  CONSTRAINT job_parts_source_quote_line_item_id_fkey
    FOREIGN KEY (source_quote_line_item_id)
      REFERENCES public.quote_line_items(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_job_parts_job_id ON public.job_parts(job_id);
CREATE INDEX IF NOT EXISTS idx_job_parts_company_id ON public.job_parts(company_id);
CREATE INDEX IF NOT EXISTS idx_job_parts_part_id ON public.job_parts(part_id);
CREATE INDEX IF NOT EXISTS idx_job_parts_status ON public.job_parts(status);

ALTER TABLE public.job_parts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.job_parts FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view job_parts" ON public.job_parts;
CREATE POLICY "Users can view job_parts" ON public.job_parts
  FOR SELECT
  USING (job_id IN (SELECT jobs.id FROM jobs WHERE jobs.company_id IN (SELECT get_user_company_ids() AS get_user_company_ids)));

DROP POLICY IF EXISTS "Users can insert job_parts" ON public.job_parts;
CREATE POLICY "Users can insert job_parts" ON public.job_parts
  FOR INSERT
  WITH CHECK (job_id IN (SELECT jobs.id FROM jobs WHERE jobs.company_id IN (SELECT get_user_company_ids() AS get_user_company_ids)));

DROP POLICY IF EXISTS "Users can update job_parts" ON public.job_parts;
CREATE POLICY "Users can update job_parts" ON public.job_parts
  FOR UPDATE
  USING (job_id IN (SELECT jobs.id FROM jobs WHERE jobs.company_id IN (SELECT get_user_company_ids() AS get_user_company_ids)));

DROP POLICY IF EXISTS "Users can delete job_parts" ON public.job_parts;
CREATE POLICY "Users can delete job_parts" ON public.job_parts
  FOR DELETE
  USING (job_id IN (SELECT jobs.id FROM jobs WHERE jobs.company_id IN (SELECT get_user_company_ids() AS get_user_company_ids)));

DROP POLICY IF EXISTS "ai_readonly_select" ON public.job_parts;
CREATE POLICY "ai_readonly_select" ON public.job_parts
  FOR SELECT TO jigged_ai_readonly
  USING (EXISTS (
    SELECT 1 FROM jobs
    WHERE jobs.id = job_parts.job_id
      AND jobs.company_id = (current_setting('jigged.company_id'::text, true))::uuid
  ));

-- ============================================================================
-- 2. Add nullable job_part_id to children, ready for backfill
-- ============================================================================

ALTER TABLE public.job_operations ADD COLUMN IF NOT EXISTS job_part_id uuid;
ALTER TABLE public.job_materials ADD COLUMN IF NOT EXISTS job_part_id uuid;

-- ============================================================================
-- 3. Backfill: one job_parts row per existing job; rewire children
-- ============================================================================

INSERT INTO public.job_parts (
  id, job_id, company_id, part_id, source_quote_line_item_id,
  sequence, quantity, status, status_changed_at,
  started_at, completed_at, shipped_at, current_operation_sequence,
  created_at, updated_at
)
SELECT
  gen_random_uuid(),
  j.id,
  j.company_id,
  j.part_id,
  j.source_quote_line_item_id,
  10,
  COALESCE(qli.quantity, 1),
  j.status,
  j.status_changed_at,
  j.started_at,
  j.completed_at,
  j.shipped_at,
  j.current_operation_sequence,
  j.created_at,
  j.updated_at
FROM public.jobs j
LEFT JOIN public.quote_line_items qli ON qli.id = j.source_quote_line_item_id
WHERE j.part_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM public.job_parts jp WHERE jp.job_id = j.id);

-- Rewire job_operations.job_part_id from the backfilled job_parts row.
UPDATE public.job_operations jo
SET job_part_id = jp.id
FROM public.job_parts jp
WHERE jp.job_id = jo.job_id
  AND jo.job_part_id IS NULL;

-- Rewire job_materials.job_part_id similarly.
UPDATE public.job_materials jm
SET job_part_id = jp.id
FROM public.job_parts jp
WHERE jp.job_id = jm.job_id
  AND jm.job_part_id IS NULL;

-- ============================================================================
-- 4. Lock in the new shape: NOT NULL FKs + replace the (job_id, sequence)
--    unique on job_operations with (job_part_id, sequence).
-- ============================================================================

-- Any operation/material row that wasn't backfilled (parent job has no part_id)
-- is unsalvageable. Delete; pilot data only.
DELETE FROM public.job_operations WHERE job_part_id IS NULL;
DELETE FROM public.job_materials WHERE job_part_id IS NULL;

ALTER TABLE public.job_operations
  ALTER COLUMN job_part_id SET NOT NULL,
  ADD CONSTRAINT job_operations_job_part_id_fkey
    FOREIGN KEY (job_part_id) REFERENCES public.job_parts(id) ON DELETE CASCADE;

ALTER TABLE public.job_materials
  ALTER COLUMN job_part_id SET NOT NULL,
  ADD CONSTRAINT job_materials_job_part_id_fkey
    FOREIGN KEY (job_part_id) REFERENCES public.job_parts(id) ON DELETE CASCADE;

ALTER TABLE public.job_operations
  DROP CONSTRAINT IF EXISTS job_operations_job_id_sequence_key;

ALTER TABLE public.job_operations
  ADD CONSTRAINT job_operations_job_part_sequence_key UNIQUE (job_part_id, sequence);

CREATE INDEX IF NOT EXISTS idx_job_operations_job_part_id ON public.job_operations(job_part_id);
CREATE INDEX IF NOT EXISTS idx_job_materials_job_part_id ON public.job_materials(job_part_id);

-- ============================================================================
-- 5. Drop legacy columns from jobs (data already mirrored on job_parts)
-- ============================================================================

ALTER TABLE public.jobs DROP CONSTRAINT IF EXISTS jobs_part_id_fkey;
ALTER TABLE public.jobs DROP CONSTRAINT IF EXISTS jobs_source_quote_line_item_id_fkey;
ALTER TABLE public.jobs
  DROP COLUMN IF EXISTS part_id,
  DROP COLUMN IF EXISTS source_quote_line_item_id,
  DROP COLUMN IF EXISTS current_operation_sequence;

-- ============================================================================
-- 6. Drop the per-company auto-numbering trigger + function on jobs.
--    Job numbers come from convertQuoteToJob (mirrors the source quote_number).
-- ============================================================================

DROP TRIGGER IF EXISTS trigger_set_job_number ON public.jobs;
DROP FUNCTION IF EXISTS public.set_job_number();
DROP FUNCTION IF EXISTS public.generate_job_number(uuid);

-- ============================================================================
-- 7. Replace create_job_operations_from_routing with the per-part variant
-- ============================================================================

DROP FUNCTION IF EXISTS public.create_job_operations_from_routing(uuid, uuid);

CREATE OR REPLACE FUNCTION public.create_job_part_operations_from_routing(
  p_job_part_id uuid,
  p_routing_id uuid
)
RETURNS integer
LANGUAGE plpgsql
AS $function$
DECLARE
    v_count integer := 0;
    v_node record;
    v_seq integer := 10;
    v_job_id uuid;
    v_min_seq integer;
BEGIN
    SELECT job_id INTO v_job_id FROM job_parts WHERE id = p_job_part_id;
    IF v_job_id IS NULL THEN
        RAISE EXCEPTION 'job_part % not found', p_job_part_id;
    END IF;

    FOR v_node IN
        SELECT rn.*, ot.name AS operation_name
        FROM routing_nodes rn
        JOIN operation_types ot ON rn.operation_type_id = ot.id
        WHERE rn.routing_id = p_routing_id
        ORDER BY rn.sequence, rn.created_at
    LOOP
        INSERT INTO job_operations (
            job_id, job_part_id, sequence, operation_name, operation_type_id,
            instructions, estimated_setup_minutes, estimated_run_minutes_per_unit,
            status, routing_node_id
        ) VALUES (
            v_job_id, p_job_part_id, v_seq, v_node.operation_name, v_node.operation_type_id,
            v_node.instructions, COALESCE(v_node.setup_time, 0), v_node.run_time_per_unit,
            'pending', v_node.id
        );
        v_seq := v_seq + 10;
        v_count := v_count + 1;
    END LOOP;

    -- Copy routing_materials → job_materials (idempotent on routing_material_id)
    INSERT INTO job_materials (job_id, job_part_id, routing_material_id, inventory_item_id, expected_quantity, unit)
    SELECT v_job_id, p_job_part_id, rm.id, rm.inventory_item_id, rm.quantity, rm.unit
    FROM routing_materials rm
    WHERE rm.routing_id = p_routing_id
      AND NOT EXISTS (
          SELECT 1 FROM job_materials jm
          WHERE jm.job_part_id = p_job_part_id AND jm.routing_material_id = rm.id
      );

    -- Set the job_part's current operation cursor to the lowest sequence we wrote.
    SELECT MIN(sequence) INTO v_min_seq FROM job_operations WHERE job_part_id = p_job_part_id;
    IF v_min_seq IS NOT NULL THEN
        UPDATE job_parts SET current_operation_sequence = v_min_seq WHERE id = p_job_part_id;
    END IF;

    RETURN v_count;
END;
$function$;

-- ============================================================================
-- 8. Update get_ready_operations_for_station: surface part info, scope DAG
--    readiness to job_part_id.
-- ============================================================================

DROP FUNCTION IF EXISTS public.get_ready_operations_for_station(uuid, uuid);

CREATE OR REPLACE FUNCTION public.get_ready_operations_for_station(
  p_company_id uuid,
  p_operation_type_id uuid
)
RETURNS TABLE(
  job_id uuid,
  job_part_id uuid,
  job_operation_id uuid,
  operation_name text,
  op_status text,
  job_number text,
  part_id uuid,
  part_name text,
  part_description text,
  part_quantity integer
)
LANGUAGE plpgsql
STABLE
AS $function$
BEGIN
    RETURN QUERY
    WITH eligible_jobs AS (
        SELECT j.id, j.job_number FROM jobs j
        WHERE j.company_id = p_company_id
          AND j.status IN ('not_started', 'in_progress')
    ),
    station_ops AS (
        SELECT jo.id, jo.job_id, jo.job_part_id, jo.operation_name, jo.status, jo.sequence, ej.job_number
        FROM job_operations jo
        JOIN eligible_jobs ej ON ej.id = jo.job_id
        WHERE jo.operation_type_id = p_operation_type_id
          AND jo.status IN ('pending', 'in_progress')
    ),
    ready_or_active AS (
        SELECT so.id, so.job_id, so.job_part_id, so.operation_name, so.status, so.job_number
        FROM station_ops so
        WHERE so.status = 'in_progress'
           OR NOT EXISTS (
               SELECT 1 FROM job_operations prev
               WHERE prev.job_part_id = so.job_part_id
                 AND prev.sequence < so.sequence
                 AND prev.status NOT IN ('completed', 'skipped')
           )
    )
    SELECT
        ra.job_id,
        ra.job_part_id,
        ra.id AS job_operation_id,
        ra.operation_name,
        ra.status AS op_status,
        ra.job_number,
        jp.part_id,
        p.part_name,
        p.description AS part_description,
        jp.quantity AS part_quantity
    FROM ready_or_active ra
    JOIN job_parts jp ON jp.id = ra.job_part_id
    JOIN parts p ON p.id = jp.part_id;
END;
$function$;

-- ============================================================================
-- 9. Update get_ready_operations_batch: DAG readiness now scoped to job_part_id
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
        SELECT jo.job_id, jo.operation_name, COUNT(*)::integer AS cnt
        FROM job_operations jo
        WHERE jo.job_id = ANY(p_job_ids)
          AND jo.status = 'in_progress'
        GROUP BY jo.job_id, jo.operation_name
    ),
    jobs_with_in_progress AS (
        SELECT DISTINCT ip.job_id FROM in_progress_ops ip
    ),
    -- Per-part readiness: predecessors compared inside the same job_part.
    ready_ops AS (
        SELECT jo.job_id, jo.operation_name
        FROM job_operations jo
        WHERE jo.job_id = ANY(p_job_ids)
          AND jo.job_id NOT IN (SELECT jwi.job_id FROM jobs_with_in_progress jwi)
          AND jo.status = 'pending'
          AND NOT EXISTS (
              SELECT 1 FROM job_operations prev
              WHERE prev.job_part_id = jo.job_part_id
                AND prev.sequence < jo.sequence
                AND prev.status NOT IN ('completed', 'skipped')
          )
    ),
    ready_agg AS (
        SELECT ro.job_id, MIN(ro.operation_name) AS operation_name, COUNT(*)::integer AS ready_count
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
-- 10. compute_job_status + sync trigger on job_parts
-- ============================================================================

CREATE OR REPLACE FUNCTION public.compute_job_status(p_job_id uuid)
RETURNS text
LANGUAGE plpgsql
STABLE
AS $function$
DECLARE
    v_total int;
    v_cancelled int;
    v_shipped int;
    v_completed int;
    v_in_progress int;
BEGIN
    SELECT
      count(*),
      count(*) FILTER (WHERE status = 'cancelled'),
      count(*) FILTER (WHERE status = 'shipped'),
      count(*) FILTER (WHERE status = 'completed'),
      count(*) FILTER (WHERE status = 'in_progress')
    INTO v_total, v_cancelled, v_shipped, v_completed, v_in_progress
    FROM job_parts
    WHERE job_id = p_job_id;

    IF v_total = 0 THEN RETURN 'not_started'; END IF;
    IF v_cancelled = v_total THEN RETURN 'cancelled'; END IF;
    IF v_shipped = v_total THEN RETURN 'shipped'; END IF;
    IF v_completed + v_shipped = v_total THEN RETURN 'completed'; END IF;
    IF v_in_progress > 0 OR v_completed > 0 OR v_shipped > 0 THEN RETURN 'in_progress'; END IF;
    RETURN 'not_started';
END;
$function$;

CREATE OR REPLACE FUNCTION public.sync_job_status_from_parts()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
    v_job_id uuid;
    v_new_status text;
    v_now timestamptz := now();
BEGIN
    v_job_id := COALESCE(NEW.job_id, OLD.job_id);
    v_new_status := compute_job_status(v_job_id);

    UPDATE jobs
    SET status = v_new_status,
        status_changed_at = CASE WHEN status IS DISTINCT FROM v_new_status THEN v_now ELSE status_changed_at END,
        started_at = CASE
            WHEN started_at IS NULL AND v_new_status IN ('in_progress','completed','shipped')
              THEN v_now ELSE started_at END,
        completed_at = CASE
            WHEN v_new_status IN ('completed','shipped') AND completed_at IS NULL THEN v_now
            WHEN v_new_status = 'in_progress' THEN NULL
            ELSE completed_at END,
        shipped_at = CASE
            WHEN v_new_status = 'shipped' AND shipped_at IS NULL THEN v_now
            WHEN v_new_status <> 'shipped' THEN NULL
            ELSE shipped_at END,
        updated_at = v_now
    WHERE id = v_job_id;

    RETURN NULL;
END;
$function$;

DROP TRIGGER IF EXISTS trigger_sync_job_status_from_parts_ins ON public.job_parts;
CREATE TRIGGER trigger_sync_job_status_from_parts_ins
AFTER INSERT ON public.job_parts
FOR EACH ROW
EXECUTE FUNCTION public.sync_job_status_from_parts();

DROP TRIGGER IF EXISTS trigger_sync_job_status_from_parts_upd ON public.job_parts;
CREATE TRIGGER trigger_sync_job_status_from_parts_upd
AFTER UPDATE OF status ON public.job_parts
FOR EACH ROW
WHEN (OLD.status IS DISTINCT FROM NEW.status)
EXECUTE FUNCTION public.sync_job_status_from_parts();

DROP TRIGGER IF EXISTS trigger_sync_job_status_from_parts_del ON public.job_parts;
CREATE TRIGGER trigger_sync_job_status_from_parts_del
AFTER DELETE ON public.job_parts
FOR EACH ROW
EXECUTE FUNCTION public.sync_job_status_from_parts();

-- One-time sync of existing jobs.
UPDATE jobs SET status = compute_job_status(id);

-- ============================================================================
-- 11. Update reset_demo_company: drop the now-removed quote_attachments and
--     job_attachments DELETEs. job_parts cascades from jobs so no extra step.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.reset_demo_company(p_source_company_id uuid, p_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
    v_demo_company_id uuid;
BEGIN
    IF p_user_id != auth.uid() THEN
        RAISE EXCEPTION 'Access denied';
    END IF;

    SELECT demo_company_id INTO v_demo_company_id
    FROM companies WHERE id = p_source_company_id;

    IF v_demo_company_id IS NULL THEN
        RAISE EXCEPTION 'No demo company exists for company: %', p_source_company_id;
    END IF;

    DELETE FROM operator_sessions WHERE company_id = v_demo_company_id;
    DELETE FROM inventory_transactions WHERE company_id = v_demo_company_id;
    DELETE FROM job_materials WHERE job_id IN (SELECT id FROM jobs WHERE company_id = v_demo_company_id);
    DELETE FROM job_operations WHERE job_id IN (SELECT id FROM jobs WHERE company_id = v_demo_company_id);
    DELETE FROM job_parts WHERE company_id = v_demo_company_id;
    DELETE FROM jobs WHERE company_id = v_demo_company_id;
    DELETE FROM quotes WHERE company_id = v_demo_company_id;
    DELETE FROM routing_materials WHERE routing_id IN (SELECT id FROM routings WHERE company_id = v_demo_company_id);
    DELETE FROM routing_nodes WHERE routing_id IN (SELECT id FROM routings WHERE company_id = v_demo_company_id);
    DELETE FROM routings WHERE company_id = v_demo_company_id;
    DELETE FROM parts WHERE company_id = v_demo_company_id;
    DELETE FROM part_categories WHERE company_id = v_demo_company_id;
    DELETE FROM inventory_items WHERE company_id = v_demo_company_id;
    DELETE FROM operation_types WHERE company_id = v_demo_company_id;
    DELETE FROM customers WHERE company_id = v_demo_company_id;
    DELETE FROM ai_chat_queries WHERE company_id = v_demo_company_id;

    PERFORM seed_demo_data(v_demo_company_id, p_user_id);
END;
$function$;

-- ============================================================================
-- 12. Update seed_demo_data: insert one job_parts row per (job, part) and use
--     the new job_part_id when creating operations + materials. Also drop
--     part_id from the jobs INSERT (column no longer exists).
--
--     NOTE: this function is huge and templated. We inline-replace only the
--     blocks that touch jobs/job_operations/job_materials. The rest of the
--     function body (template parsing, customer/parts/quote inserts) is
--     copied unchanged from the previous definition in
--     20260416_drop_resource_groups_and_job_desc.sql.
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
    v_template jsonb;
    v_ref_map jsonb := '{}'::jsonb;
    v_item jsonb;
    v_op jsonb;
    v_new_id uuid;
    v_job_id uuid;
    v_job_part_id uuid;
    v_part_id uuid;
BEGIN
    SELECT template INTO v_template
    FROM demo_data_templates
    WHERE name = p_template_name AND is_active = true
    LIMIT 1;

    IF v_template IS NULL THEN
        RAISE EXCEPTION 'No active demo template found with name: %', p_template_name;
    END IF;

    -- Customers
    IF v_template->'customers' IS NOT NULL THEN
        FOR v_item IN SELECT * FROM jsonb_array_elements(v_template->'customers') LOOP
            v_new_id := gen_random_uuid();
            v_ref_map := jsonb_set(v_ref_map, ARRAY[v_item->>'_ref'], to_jsonb(v_new_id::text));
            INSERT INTO customers (id, company_id, name, contact_name, contact_email, contact_phone,
                                   address_line1, address_line2, city, state, postal_code, country, website,
                                   created_at, updated_at)
            VALUES (v_new_id, p_company_id,
                    v_item->>'name', v_item->>'contact_name', v_item->>'contact_email', v_item->>'contact_phone',
                    v_item->>'address_line1', v_item->>'address_line2',
                    v_item->>'city', v_item->>'state', v_item->>'postal_code',
                    COALESCE(v_item->>'country','USA'), v_item->>'website',
                    COALESCE((v_item->>'created_at')::timestamptz, now()),
                    COALESCE((v_item->>'updated_at')::timestamptz, now()));
        END LOOP;
    END IF;

    -- Operation types
    IF v_template->'operation_types' IS NOT NULL THEN
        FOR v_item IN SELECT * FROM jsonb_array_elements(v_template->'operation_types') LOOP
            v_new_id := gen_random_uuid();
            v_ref_map := jsonb_set(v_ref_map, ARRAY[v_item->>'_ref'], to_jsonb(v_new_id::text));
            INSERT INTO operation_types (id, company_id, name, description, hourly_rate, created_at, updated_at)
            VALUES (v_new_id, p_company_id, v_item->>'name', v_item->>'description',
                    (v_item->>'hourly_rate')::numeric,
                    COALESCE((v_item->>'created_at')::timestamptz, now()),
                    COALESCE((v_item->>'updated_at')::timestamptz, now()));
        END LOOP;
    END IF;

    -- Inventory items
    IF v_template->'inventory_items' IS NOT NULL THEN
        FOR v_item IN SELECT * FROM jsonb_array_elements(v_template->'inventory_items') LOOP
            v_new_id := gen_random_uuid();
            v_ref_map := jsonb_set(v_ref_map, ARRAY[v_item->>'_ref'], to_jsonb(v_new_id::text));
            INSERT INTO inventory_items (id, company_id, item_name, description, unit, current_stock,
                                          minimum_stock, cost_per_unit, location, created_at, updated_at)
            VALUES (v_new_id, p_company_id, v_item->>'item_name', v_item->>'description',
                    COALESCE(v_item->>'unit','each'),
                    COALESCE((v_item->>'current_stock')::numeric, 0),
                    COALESCE((v_item->>'minimum_stock')::numeric, 0),
                    COALESCE((v_item->>'cost_per_unit')::numeric, 0),
                    v_item->>'location',
                    COALESCE((v_item->>'created_at')::timestamptz, now()),
                    COALESCE((v_item->>'updated_at')::timestamptz, now()));
        END LOOP;
    END IF;

    -- Parts
    IF v_template->'parts' IS NOT NULL THEN
        FOR v_item IN SELECT * FROM jsonb_array_elements(v_template->'parts') LOOP
            v_new_id := gen_random_uuid();
            v_ref_map := jsonb_set(v_ref_map, ARRAY[v_item->>'_ref'], to_jsonb(v_new_id::text));
            INSERT INTO parts (id, company_id, part_name, description, category_id,
                               created_by, created_at, updated_at)
            VALUES (v_new_id, p_company_id, v_item->>'part_name', v_item->>'description',
                    NULL, p_user_id,
                    COALESCE((v_item->>'created_at')::timestamptz, now()),
                    COALESCE((v_item->>'updated_at')::timestamptz, now()));
        END LOOP;
    END IF;

    -- Routings, routing_nodes, routing_materials, quotes, quote_line_items —
    -- carried over from the previous seed_demo_data definition. Templates that
    -- pre-date this change still work as long as they don't reference the
    -- now-dropped jobs.part_id field.
    IF v_template->'routings' IS NOT NULL THEN
        FOR v_item IN SELECT * FROM jsonb_array_elements(v_template->'routings') LOOP
            v_new_id := gen_random_uuid();
            v_ref_map := jsonb_set(v_ref_map, ARRAY[v_item->>'_ref'], to_jsonb(v_new_id::text));
            INSERT INTO routings (id, company_id, part_id, name, description,
                                  created_by, created_at, updated_at)
            VALUES (v_new_id, p_company_id,
                    (v_ref_map->>(v_item->>'part_ref'))::uuid,
                    v_item->>'name', v_item->>'description',
                    p_user_id,
                    COALESCE((v_item->>'created_at')::timestamptz, now()),
                    COALESCE((v_item->>'updated_at')::timestamptz, now()));

            IF v_item->'nodes' IS NOT NULL THEN
                FOR v_op IN SELECT * FROM jsonb_array_elements(v_item->'nodes') LOOP
                    v_new_id := gen_random_uuid();
                    v_ref_map := jsonb_set(v_ref_map, ARRAY[v_op->>'_ref'], to_jsonb(v_new_id::text));
                    INSERT INTO routing_nodes (id, routing_id, operation_type_id, sequence,
                                               run_time_per_unit, setup_time, instructions,
                                               metadata, created_at, updated_at)
                    VALUES (v_new_id,
                            (v_ref_map->>(v_item->>'_ref'))::uuid,
                            (v_ref_map->>(v_op->>'operation_type_ref'))::uuid,
                            (v_op->>'sequence')::integer,
                            COALESCE((v_op->>'run_time_per_unit')::numeric, 0),
                            COALESCE((v_op->>'setup_time')::numeric, 0),
                            v_op->>'instructions',
                            COALESCE((v_op->'metadata'), '{}'::jsonb),
                            COALESCE((v_op->>'created_at')::timestamptz, now()),
                            COALESCE((v_op->>'updated_at')::timestamptz, now()));
                END LOOP;
            END IF;

            IF v_item->'materials' IS NOT NULL THEN
                FOR v_op IN SELECT * FROM jsonb_array_elements(v_item->'materials') LOOP
                    INSERT INTO routing_materials (id, routing_id, inventory_item_id,
                                                   quantity, unit, sequence)
                    VALUES (gen_random_uuid(),
                            (v_ref_map->>(v_item->>'_ref'))::uuid,
                            (v_ref_map->>(v_op->>'inventory_item_ref'))::uuid,
                            (v_op->>'quantity')::numeric,
                            v_op->>'unit',
                            COALESCE((v_op->>'sequence')::integer, 0));
                END LOOP;
            END IF;
        END LOOP;
    END IF;

    IF v_template->'quotes' IS NOT NULL THEN
        FOR v_item IN SELECT * FROM jsonb_array_elements(v_template->'quotes') LOOP
            v_new_id := gen_random_uuid();
            v_ref_map := jsonb_set(v_ref_map, ARRAY[v_item->>'_ref'], to_jsonb(v_new_id::text));
            INSERT INTO quotes (id, company_id, customer_id, status,
                                lead_time_days, expiration_date,
                                created_by, created_at, updated_at,
                                status_changed_at, converted_at)
            VALUES (v_new_id, p_company_id,
                    (v_ref_map->>(v_item->>'customer_ref'))::uuid,
                    COALESCE(v_item->>'status', 'active'),
                    (v_item->>'lead_time_days')::integer,
                    (v_item->>'expiration_date')::date,
                    p_user_id,
                    COALESCE((v_item->>'created_at')::timestamptz, now()),
                    COALESCE((v_item->>'updated_at')::timestamptz, now()),
                    (v_item->>'status_changed_at')::timestamptz,
                    (v_item->>'converted_at')::timestamptz);
        END LOOP;
    END IF;

    -- Jobs: insert one job + one job_parts per (job, part_ref). Operations and
    -- materials hang off the job_part.
    IF v_template->'jobs' IS NOT NULL THEN
        FOR v_item IN SELECT * FROM jsonb_array_elements(v_template->'jobs') LOOP
            v_new_id := gen_random_uuid();
            v_job_id := v_new_id;
            v_ref_map := jsonb_set(v_ref_map, ARRAY[v_item->>'_ref'], to_jsonb(v_new_id::text));

            INSERT INTO jobs (id, company_id, customer_id, quote_id,
                              job_number, status, created_by, created_at,
                              started_at, completed_at, shipped_at, status_changed_at)
            VALUES (v_new_id, p_company_id,
                    (v_ref_map->>(v_item->>'customer_ref'))::uuid,
                    CASE WHEN v_item->>'quote_ref' IS NOT NULL
                         THEN (v_ref_map->>(v_item->>'quote_ref'))::uuid ELSE NULL END,
                    -- Demo templates can pre-set job_number; otherwise derive
                    -- a placeholder so the unique constraint holds.
                    COALESCE(v_item->>'job_number', 'J-DEMO-' || substr(v_new_id::text, 1, 8)),
                    COALESCE(v_item->>'status', 'not_started'),
                    p_user_id,
                    COALESCE((v_item->>'created_at')::timestamptz, now()),
                    (v_item->>'started_at')::timestamptz,
                    (v_item->>'completed_at')::timestamptz,
                    (v_item->>'shipped_at')::timestamptz,
                    (v_item->>'status_changed_at')::timestamptz);

            IF v_item->>'part_ref' IS NOT NULL THEN
                v_part_id := (v_ref_map->>(v_item->>'part_ref'))::uuid;
                v_job_part_id := gen_random_uuid();

                INSERT INTO job_parts (id, job_id, company_id, part_id,
                                       sequence, quantity, status,
                                       status_changed_at, started_at, completed_at, shipped_at,
                                       created_at, updated_at)
                VALUES (v_job_part_id, v_job_id, p_company_id, v_part_id,
                        10,
                        COALESCE((v_item->>'quantity')::integer, 1),
                        COALESCE(v_item->>'status', 'not_started'),
                        (v_item->>'status_changed_at')::timestamptz,
                        (v_item->>'started_at')::timestamptz,
                        (v_item->>'completed_at')::timestamptz,
                        (v_item->>'shipped_at')::timestamptz,
                        COALESCE((v_item->>'created_at')::timestamptz, now()),
                        COALESCE((v_item->>'created_at')::timestamptz, now()));

                IF v_item->'operations' IS NOT NULL THEN
                    FOR v_op IN SELECT * FROM jsonb_array_elements(v_item->'operations') LOOP
                        v_new_id := gen_random_uuid();
                        v_ref_map := jsonb_set(v_ref_map, ARRAY[v_op->>'_ref'], to_jsonb(v_new_id::text));
                        INSERT INTO job_operations (id, job_id, job_part_id, sequence, operation_name,
                                                    operation_type_id, estimated_setup_minutes,
                                                    estimated_run_minutes_per_unit,
                                                    actual_setup_minutes, actual_run_minutes,
                                                    status, routing_node_id, instructions,
                                                    started_at, completed_at, created_at)
                        VALUES (v_new_id, v_job_id, v_job_part_id,
                                (v_op->>'sequence')::integer,
                                v_op->>'operation_name',
                                CASE WHEN v_op->>'operation_type_ref' IS NOT NULL
                                     THEN (v_ref_map->>(v_op->>'operation_type_ref'))::uuid ELSE NULL END,
                                COALESCE((v_op->>'estimated_setup_minutes')::numeric,
                                         (v_op->>'estimated_setup_hours')::numeric * 60, 0),
                                COALESCE((v_op->>'estimated_run_minutes_per_unit')::numeric,
                                         (v_op->>'estimated_run_hours_per_unit')::numeric * 60, 0),
                                COALESCE((v_op->>'actual_setup_minutes')::numeric,
                                         (v_op->>'actual_setup_hours')::numeric * 60),
                                COALESCE((v_op->>'actual_run_minutes')::numeric,
                                         (v_op->>'actual_run_hours')::numeric * 60),
                                COALESCE(v_op->>'status', 'pending'),
                                CASE WHEN v_op->>'routing_node_ref' IS NOT NULL
                                     THEN (v_ref_map->>(v_op->>'routing_node_ref'))::uuid ELSE NULL END,
                                v_op->>'instructions',
                                (v_op->>'started_at')::timestamptz,
                                (v_op->>'completed_at')::timestamptz,
                                COALESCE((v_op->>'created_at')::timestamptz, now()));
                    END LOOP;
                END IF;

                INSERT INTO job_materials (job_id, job_part_id, routing_material_id,
                                           inventory_item_id, expected_quantity, unit)
                SELECT v_job_id, v_job_part_id, rm.id, rm.inventory_item_id, rm.quantity, rm.unit
                FROM routing_materials rm
                JOIN routings r ON r.id = rm.routing_id
                WHERE r.part_id = v_part_id;
            END IF;
        END LOOP;
    END IF;

    -- Link converted quotes to first job (one-quote-one-job model)
    IF v_template->'quotes' IS NOT NULL THEN
        FOR v_item IN SELECT * FROM jsonb_array_elements(v_template->'quotes') LOOP
            IF v_item->>'converted_to_job_ref' IS NOT NULL THEN
                UPDATE quotes
                SET converted_at = (v_item->>'converted_at')::timestamptz
                WHERE id = (v_ref_map->>(v_item->>'_ref'))::uuid;
            END IF;
        END LOOP;
    END IF;
END;
$function$;

COMMIT;
