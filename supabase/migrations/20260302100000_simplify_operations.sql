-- ============================================================
-- Migration: Simplify Operations
-- 1. Decouple parts from customers (remove customer_id)
-- 2. Enforce one routing per part (1:1)
-- 3. Remove routing_id from jobs and quotes
-- 4. Update convert_quote_to_job() to auto-resolve routing
-- ============================================================

BEGIN;

-- ============================================================
-- A1. Parts — Remove customer_id
-- ============================================================

-- Handle part_number conflicts: same company + part_number but different customer_id.
-- Append customer name suffix to duplicates to preserve uniqueness.
DO $$
DECLARE
  r RECORD;
  suffix TEXT;
BEGIN
  FOR r IN
    WITH ranked AS (
      SELECT p.id, p.company_id, p.part_number, p.customer_id,
             c.name AS customer_name,
             ROW_NUMBER() OVER (
               PARTITION BY p.company_id, p.part_number
               ORDER BY p.customer_id NULLS FIRST, p.updated_at DESC
             ) AS rn
      FROM parts p
      LEFT JOIN customers c ON p.customer_id = c.id
    )
    SELECT id, part_number, customer_name, rn
    FROM ranked
    WHERE rn > 1
  LOOP
    suffix := COALESCE(' (' || r.customer_name || ')', ' (' || r.rn::text || ')');
    UPDATE parts SET part_number = r.part_number || suffix WHERE id = r.id;
  END LOOP;
END $$;

-- Drop old constraint and column
ALTER TABLE parts DROP CONSTRAINT IF EXISTS parts_unique_per_customer;
ALTER TABLE parts DROP CONSTRAINT IF EXISTS parts_customer_id_fkey;
DROP INDEX IF EXISTS idx_parts_customer_id;
ALTER TABLE parts DROP COLUMN IF EXISTS customer_id;

-- Add new company-wide unique constraint
ALTER TABLE parts ADD CONSTRAINT parts_unique_per_company UNIQUE (company_id, part_number);


-- ============================================================
-- A2. Routings — Enforce one routing per part
-- ============================================================

-- For parts with multiple routings: keep the default (or most recently updated), delete the rest.
-- CASCADE on routing_nodes FK will clean up nodes and edges.
DELETE FROM routings
WHERE id IN (
  SELECT id FROM (
    SELECT id,
           ROW_NUMBER() OVER (
             PARTITION BY part_id
             ORDER BY is_default DESC, updated_at DESC
           ) AS rn
    FROM routings
    WHERE part_id IS NOT NULL
  ) ranked
  WHERE rn > 1
);

-- Delete orphaned routings (no part_id)
DELETE FROM routings WHERE part_id IS NULL;

-- Make part_id NOT NULL
ALTER TABLE routings ALTER COLUMN part_id SET NOT NULL;

-- Add UNIQUE constraint (one routing per part)
ALTER TABLE routings ADD CONSTRAINT routings_part_id_unique UNIQUE (part_id);

-- Drop is_default column
ALTER TABLE routings DROP COLUMN IF EXISTS is_default;

-- Update FK to CASCADE on delete (deleting a part deletes its routing)
ALTER TABLE routings DROP CONSTRAINT IF EXISTS routings_part_id_fkey;
ALTER TABLE routings ADD CONSTRAINT routings_part_id_fkey
  FOREIGN KEY (part_id) REFERENCES parts(id) ON DELETE CASCADE;

-- Drop the old default index (no longer needed)
DROP INDEX IF EXISTS idx_routings_default;


-- ============================================================
-- A3. Jobs & Quotes — Remove routing_id
-- ============================================================

-- Jobs
ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_routing_id_fkey;
DROP INDEX IF EXISTS idx_jobs_routing;
ALTER TABLE jobs DROP COLUMN IF EXISTS routing_id;

-- Quotes
ALTER TABLE quotes DROP CONSTRAINT IF EXISTS quotes_routing_id_fkey;
DROP INDEX IF EXISTS idx_quotes_routing;
ALTER TABLE quotes DROP COLUMN IF EXISTS routing_id;


-- ============================================================
-- A4. Update convert_quote_to_job() — auto-resolve routing from part
-- ============================================================

-- Drop both overloaded versions first
DROP FUNCTION IF EXISTS public.convert_quote_to_job(uuid, uuid, date, text);
DROP FUNCTION IF EXISTS public.convert_quote_to_job(uuid, uuid, date, text, text);

CREATE OR REPLACE FUNCTION public.convert_quote_to_job(
  p_quote_id uuid,
  p_due_date date DEFAULT NULL,
  p_priority text DEFAULT 'normal',
  p_notes text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
  v_quote RECORD;
  v_job_id UUID;
  v_routing_id UUID;
  v_ops_count INTEGER;
BEGIN
  -- Get the quote
  SELECT * INTO v_quote FROM quotes WHERE id = p_quote_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Quote not found: %', p_quote_id;
  END IF;

  IF v_quote.status != 'accepted' THEN
    RAISE EXCEPTION 'Quote must be accepted before converting. Current status: %', v_quote.status;
  END IF;

  IF v_quote.converted_to_job_id IS NOT NULL THEN
    RAISE EXCEPTION 'Quote already converted to job: %', v_quote.converted_to_job_id;
  END IF;

  -- Auto-resolve routing from part
  IF v_quote.part_id IS NOT NULL THEN
    SELECT id INTO v_routing_id FROM routings WHERE part_id = v_quote.part_id;
  END IF;

  IF v_routing_id IS NULL AND v_quote.part_id IS NOT NULL THEN
    RAISE EXCEPTION 'No routing defined for part. Create a routing before converting to a job.';
  END IF;

  -- Create the job
  INSERT INTO jobs (
    company_id,
    quote_id,
    customer_id,
    part_id,
    part_number_text,
    description,
    quantity_ordered,
    due_date,
    priority,
    notes,
    created_by
  ) VALUES (
    v_quote.company_id,
    v_quote.id,
    v_quote.customer_id,
    v_quote.part_id,
    v_quote.part_number_text,
    v_quote.description,
    v_quote.quantity,
    p_due_date,
    p_priority,
    COALESCE(p_notes, v_quote.notes),
    v_quote.created_by
  )
  RETURNING id INTO v_job_id;

  -- If there's a routing, copy operations to the job
  IF v_routing_id IS NOT NULL THEN
    SELECT create_job_operations_from_routing(v_job_id, v_routing_id) INTO v_ops_count;
  END IF;

  -- Update the quote with conversion info
  UPDATE quotes
  SET
    converted_to_job_id = v_job_id,
    converted_at = NOW()
  WHERE id = p_quote_id;

  RETURN v_job_id;
END;
$function$;


-- ============================================================
-- Update comments
-- ============================================================
COMMENT ON TABLE "public"."parts"
    IS 'Parts catalog. Each part has a company-unique part number, description, and flexible volume-based pricing stored as JSONB. Parts are company-wide entities (not customer-specific). Referenced by quotes, jobs, and routings (1:1).';

COMMENT ON TABLE "public"."routings"
    IS 'Manufacturing process definitions (one per part). Each routing is a DAG of operation nodes connected by edges defining execution dependencies. Deleting a part cascades to its routing.';

COMMIT;
