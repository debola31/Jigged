-- ============================================================================
-- Shipments — move customer_po_number from quotes to jobs
-- ============================================================================
--
-- Reason. The PO is the customer's commitment to *order*, not their
-- response to a proposal. Most quotes never get a PO (they expire or
-- the deal falls through), so the column sat NULL on quotes for the
-- vast majority of rows. Industry-standard ERPs (E2, JobBOSS, Tangle)
-- carry the PO on the work order / job, captured at the moment the
-- order is firmed up. PR 2's call (PO on quotes, captured at convert
-- time) preserved the column on the wrong table for the lifecycle —
-- the code path that wrote the PO was already the convert path, which
-- is the job's creation event. This migration just moves the column
-- to match where the writer already runs.
--
-- Steps:
--   1. Add jobs.customer_po_number (nullable text)
--   2. Backfill from quotes via the existing jobs.quote_id FK
--   3. Drop the two indexes on quotes.customer_po_number (partial unique
--      + pg_trgm GIN, both from PR 2 / PR 4)
--   4. Rebuild the same shape of indexes on jobs.customer_po_number
--   5. Drop quotes.customer_po_number
--
-- Forward-only; IDEMPOTENT (ADDs guarded by IF NOT EXISTS, backfill
-- only runs when quotes.customer_po_number still exists, DROPs guarded
-- by IF EXISTS).

BEGIN;


-- ============================================================================
-- Phase 1: Add jobs.customer_po_number
-- ============================================================================

ALTER TABLE public.jobs
    ADD COLUMN IF NOT EXISTS customer_po_number text;

COMMENT ON COLUMN public.jobs.customer_po_number IS
    'Customer-issued PO number for this job. Captured at convertQuoteToJob time (or by reorder when applicable). Indexed via the partial unique-per-company index and via pg_trgm for the jobs-list search RPC.';


-- ============================================================================
-- Phase 2: Backfill jobs.customer_po_number from converted quotes
-- ============================================================================
-- Only runs while the legacy column still exists, so re-running the
-- migration after the drop is a no-op.

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'quotes'
           AND column_name = 'customer_po_number'
    ) THEN
        UPDATE public.jobs j
           SET customer_po_number = q.customer_po_number
          FROM public.quotes q
         WHERE j.quote_id = q.id
           AND q.customer_po_number IS NOT NULL
           AND j.customer_po_number IS NULL;
    END IF;
END $$;


-- ============================================================================
-- Phase 3: Drop quotes-side indexes
-- ============================================================================

DROP INDEX IF EXISTS public.idx_quotes_customer_po_number;
DROP INDEX IF EXISTS public.idx_quotes_customer_po_number_trgm;


-- ============================================================================
-- Phase 4: Build jobs-side indexes
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_jobs_customer_po_number
    ON public.jobs(company_id, customer_po_number)
    WHERE customer_po_number IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_jobs_customer_po_number_trgm
    ON public.jobs USING gin (customer_po_number gin_trgm_ops);


-- ============================================================================
-- Phase 5: Drop quotes.customer_po_number
-- ============================================================================

ALTER TABLE public.quotes
    DROP COLUMN IF EXISTS customer_po_number;


-- ============================================================================
-- Phase 6: Rewrite search_jobs_by_identifier to drop the quotes leg
-- ============================================================================
-- The previous body had two UNION ALL legs for customer_po: one on
-- jobs.customer_po_number, one on quotes.customer_po_number via the
-- quote_id join. With the column moved to jobs, the quotes leg is
-- both redundant and (after the DROP above) broken — drop it.

CREATE OR REPLACE FUNCTION public.search_jobs_by_identifier(
    p_company_id uuid,
    p_query text
) RETURNS TABLE(job_id uuid, match_source text)
LANGUAGE plpgsql STABLE
SET search_path = public, pg_temp
AS $$
DECLARE
    v_pattern text;
BEGIN
    IF p_query IS NULL OR length(trim(p_query)) = 0 THEN
        RETURN;
    END IF;
    v_pattern := '%' || replace(replace(replace(trim(p_query), '\', '\\'), '%', '\%'), '_', '\_') || '%';

    RETURN QUERY
        SELECT DISTINCT ON (m.job_id) m.job_id, m.match_source
          FROM (
              SELECT j.id AS job_id, 'packing_slip'::text AS match_source, 1::int AS priority
                FROM public.jobs j
                JOIN public.job_parts jp ON jp.job_id = j.id
                JOIN public.shipment_line_items sli ON sli.job_part_id = jp.id
                JOIN public.shipments s ON s.id = sli.shipment_id
               WHERE j.company_id = p_company_id
                 AND s.voided_at IS NULL
                 AND s.packing_slip_number ILIKE v_pattern
              UNION ALL
              SELECT j.id, 'job_number'::text, 2
                FROM public.jobs j
               WHERE j.company_id = p_company_id
                 AND j.job_number ILIKE v_pattern
              UNION ALL
              SELECT j.id, 'customer_po'::text, 3
                FROM public.jobs j
               WHERE j.company_id = p_company_id
                 AND j.customer_po_number ILIKE v_pattern
              UNION ALL
              SELECT j.id, 'customer'::text, 4
                FROM public.jobs j
                JOIN public.customers c ON c.id = j.customer_id
               WHERE j.company_id = p_company_id
                 AND c.name ILIKE v_pattern
              UNION ALL
              SELECT j.id, 'part'::text, 5
                FROM public.jobs j
                JOIN public.job_parts jp ON jp.job_id = j.id
                JOIN public.parts p ON p.id = jp.part_id
               WHERE j.company_id = p_company_id
                 AND p.part_name ILIKE v_pattern
          ) AS m
         ORDER BY m.job_id, m.priority
         LIMIT 100;
END $$;

COMMENT ON FUNCTION public.search_jobs_by_identifier(uuid, text) IS
    'Extended jobs-list search across job_number, jobs.customer_po_number, customers.name, parts.part_name, shipments.packing_slip_number. Returns one row per matching job with the highest-priority match_source. Capped at 100 rows.';


COMMIT;
