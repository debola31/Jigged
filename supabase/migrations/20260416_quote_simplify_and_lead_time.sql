-- Migration: Simplify quote lifecycle, add lead time / expiration / cost snapshots,
-- and set up job due-date tracking.
--
-- Summary:
--   * quotes: DROP description; ADD lead_time_days, expiration_date; collapse
--     status to active|expired (with converted_to_job_id as conversion flag).
--   * jobs: ADD due_date, lead_time_days for overdue tracking.
--   * NEW tables: quote_operations, quote_materials — per-line cost snapshot
--     captured at quote creation so the breakdown is immune to later routing edits.
--   * convert_quote_to_job(): drop approval gate, copy lead_time to the job,
--     compute due_date, and stop flipping the quote to a 'converted' status.

BEGIN;

-- ============================================================
-- 1. quotes table
-- ============================================================

ALTER TABLE quotes DROP COLUMN IF EXISTS description;

ALTER TABLE quotes ADD COLUMN IF NOT EXISTS lead_time_days  integer;
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS expiration_date date;

-- Backfill expiration_date for existing quotes (10-day default from creation).
UPDATE quotes
SET expiration_date = (created_at::date + INTERVAL '10 days')::date
WHERE expiration_date IS NULL;

-- Drop the old CHECK first so the backfill UPDATE isn't blocked by it
-- (the old constraint permitted pending_approval/approved/rejected/accepted/
-- expired/converted — not 'active', so updating to 'active' would fail until
-- the constraint is gone). Then backfill, then add the new narrower CHECK.
ALTER TABLE quotes DROP CONSTRAINT IF EXISTS quotes_status_check;

UPDATE quotes SET status = 'active' WHERE status <> 'expired';

ALTER TABLE quotes ADD CONSTRAINT quotes_status_check
  CHECK (status IN ('active', 'expired'));
ALTER TABLE quotes ALTER COLUMN status SET DEFAULT 'active';


-- ============================================================
-- 2. jobs table
-- ============================================================

ALTER TABLE jobs ADD COLUMN IF NOT EXISTS due_date       date;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS lead_time_days integer;


-- ============================================================
-- 3. quote_operations (per-operation cost snapshot)
-- ============================================================

CREATE TABLE IF NOT EXISTS public.quote_operations (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_id           uuid NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
  company_id         uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  sequence           integer NOT NULL,
  operation_name     text NOT NULL,
  run_time_minutes   numeric,
  setup_time_minutes numeric,
  labor_rate         numeric,
  run_cost           numeric,
  setup_cost         numeric,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_quote_operations_quote   ON quote_operations (quote_id, sequence);
CREATE INDEX IF NOT EXISTS idx_quote_operations_company ON quote_operations (company_id);

ALTER TABLE public.quote_operations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "quote_operations_select" ON public.quote_operations;
CREATE POLICY "quote_operations_select"
    ON public.quote_operations
    FOR SELECT
    USING (company_id IN (SELECT user_company_access.company_id
                            FROM user_company_access
                           WHERE user_company_access.user_id = auth.uid()));

DROP POLICY IF EXISTS "quote_operations_insert" ON public.quote_operations;
CREATE POLICY "quote_operations_insert"
    ON public.quote_operations
    FOR INSERT
    WITH CHECK (company_id IN (SELECT user_company_access.company_id
                                 FROM user_company_access
                                WHERE user_company_access.user_id = auth.uid()));

DROP POLICY IF EXISTS "quote_operations_update" ON public.quote_operations;
CREATE POLICY "quote_operations_update"
    ON public.quote_operations
    FOR UPDATE
    USING (company_id IN (SELECT user_company_access.company_id
                            FROM user_company_access
                           WHERE user_company_access.user_id = auth.uid()));

DROP POLICY IF EXISTS "quote_operations_delete" ON public.quote_operations;
CREATE POLICY "quote_operations_delete"
    ON public.quote_operations
    FOR DELETE
    USING (company_id IN (SELECT user_company_access.company_id
                            FROM user_company_access
                           WHERE user_company_access.user_id = auth.uid()));

DROP POLICY IF EXISTS "ai_readonly_select" ON public.quote_operations;
CREATE POLICY "ai_readonly_select"
    ON public.quote_operations
    FOR SELECT
    TO jigged_ai_readonly
    USING (company_id = (current_setting('jigged.company_id', true))::uuid);


-- ============================================================
-- 4. quote_materials (per-material cost snapshot)
-- ============================================================

CREATE TABLE IF NOT EXISTS public.quote_materials (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_id          uuid NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
  company_id        uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  sequence          integer NOT NULL,
  inventory_item_id uuid,
  item_name         text NOT NULL,
  quantity          numeric NOT NULL,
  unit              text,
  cost_per_unit     numeric,
  line_cost         numeric,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_quote_materials_quote   ON quote_materials (quote_id, sequence);
CREATE INDEX IF NOT EXISTS idx_quote_materials_company ON quote_materials (company_id);

ALTER TABLE public.quote_materials ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "quote_materials_select" ON public.quote_materials;
CREATE POLICY "quote_materials_select"
    ON public.quote_materials
    FOR SELECT
    USING (company_id IN (SELECT user_company_access.company_id
                            FROM user_company_access
                           WHERE user_company_access.user_id = auth.uid()));

DROP POLICY IF EXISTS "quote_materials_insert" ON public.quote_materials;
CREATE POLICY "quote_materials_insert"
    ON public.quote_materials
    FOR INSERT
    WITH CHECK (company_id IN (SELECT user_company_access.company_id
                                 FROM user_company_access
                                WHERE user_company_access.user_id = auth.uid()));

DROP POLICY IF EXISTS "quote_materials_update" ON public.quote_materials;
CREATE POLICY "quote_materials_update"
    ON public.quote_materials
    FOR UPDATE
    USING (company_id IN (SELECT user_company_access.company_id
                            FROM user_company_access
                           WHERE user_company_access.user_id = auth.uid()));

DROP POLICY IF EXISTS "quote_materials_delete" ON public.quote_materials;
CREATE POLICY "quote_materials_delete"
    ON public.quote_materials
    FOR DELETE
    USING (company_id IN (SELECT user_company_access.company_id
                            FROM user_company_access
                           WHERE user_company_access.user_id = auth.uid()));

DROP POLICY IF EXISTS "ai_readonly_select" ON public.quote_materials;
CREATE POLICY "ai_readonly_select"
    ON public.quote_materials
    FOR SELECT
    TO jigged_ai_readonly
    USING (company_id = (current_setting('jigged.company_id', true))::uuid);


-- ============================================================
-- 5. convert_quote_to_job RPC
-- ============================================================
--
-- Previous version required status='accepted' and flipped the quote to
-- 'converted' on success. Both are gone. We now:
--   * only guard against already-converted quotes and missing routing
--   * copy lead_time_days to the job
--   * set jobs.due_date = CURRENT_DATE + lead_time_days when we have one
--   * accept an optional p_lead_time_days override from the caller

CREATE OR REPLACE FUNCTION public.convert_quote_to_job(
  p_quote_id         uuid,
  p_notes            text    DEFAULT NULL,
  p_lead_time_days   integer DEFAULT NULL
)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_quote      RECORD;
  v_job_id     uuid;
  v_routing_id uuid;
  v_ops_count  integer;
  v_lead_time  integer;
  v_due_date   date;
BEGIN
  SELECT * INTO v_quote FROM quotes WHERE id = p_quote_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Quote not found: %', p_quote_id;
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

  -- Lead time: explicit override wins, else fall back to quote value
  v_lead_time := COALESCE(p_lead_time_days, v_quote.lead_time_days);
  IF v_lead_time IS NOT NULL THEN
    v_due_date := (CURRENT_DATE + (v_lead_time || ' days')::interval)::date;
  END IF;

  INSERT INTO jobs (
    company_id,
    quote_id,
    customer_id,
    part_id,
    description,
    due_date,
    lead_time_days,
    created_by
  ) VALUES (
    v_quote.company_id,
    v_quote.id,
    v_quote.customer_id,
    v_quote.part_id,
    p_notes,
    v_due_date,
    v_lead_time,
    v_quote.created_by
  )
  RETURNING id INTO v_job_id;

  IF v_routing_id IS NOT NULL THEN
    SELECT create_job_operations_from_routing(v_job_id, v_routing_id) INTO v_ops_count;
  END IF;

  UPDATE quotes
  SET
    converted_to_job_id = v_job_id,
    converted_at        = NOW(),
    status_changed_at   = NOW()
  WHERE id = p_quote_id;

  RETURN v_job_id;
END;
$function$;


-- ============================================================
-- 6. Table + column comments
-- ============================================================

COMMENT ON TABLE public.quote_operations
  IS 'Per-operation cost snapshot captured at quote creation from the part routing. Rows are immutable after creation so the cost breakdown survives later routing edits.';

COMMENT ON TABLE public.quote_materials
  IS 'Per-material cost snapshot captured at quote creation from the part routing. Rows are immutable after creation so the cost breakdown survives later routing edits.';

COMMENT ON COLUMN public.quotes.lead_time_days
  IS 'Lead time promised to the customer in days. Copied to jobs.lead_time_days on conversion.';

COMMENT ON COLUMN public.quotes.expiration_date
  IS 'Date at which the quote expires. Defaults to created_at + 10 days. Informational — expiration never blocks conversion.';

COMMENT ON COLUMN public.jobs.due_date
  IS 'Date the job is due to ship. Typically CURRENT_DATE + lead_time_days at conversion. Used to flag overdue jobs.';

COMMENT ON COLUMN public.jobs.lead_time_days
  IS 'Lead time in days, copied from the source quote at conversion. Editable on the job after the fact.';

COMMIT;
