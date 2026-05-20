-- ============================================================================
-- Shipments — PR 6: reorder link + extended jobs-list search
-- ============================================================================
--
-- Two related changes ship together because PR 6 surfaces both on
-- /jobs:
--   1. `jobs.related_to_job_id` — uuid FK to another job in the same
--      company. Set when a closed job is re-ordered ("Create reorder")
--      so the new job carries a link back to the original. Same-company
--      enforcement is by trigger because a CHECK cannot reference other
--      rows. The reorder workflow is in utils/jobsAccess.ts; the
--      forward + reverse "Related jobs" section is on the detail page.
--
--   2. `search_jobs_by_identifier(p_company_id, p_query)` — the
--      jobs-list search RPC. ILIKE-joins job_number, quotes.customer_po_number,
--      jobs.customer_po_number, customers.name, parts.part_name (via
--      job_parts), and shipments.packing_slip_number (via shipment_line_items
--      → job_parts → jobs). Returns one row per matching job with a
--      match_source label so the UI can render "matched packing slip"
--      sub-text under the job-number cell. pg_trgm GIN indexes on the
--      five searchable columns ship in PR 4 (migration 20260524); this
--      migration just adds the RPC that consumes them.
--
-- IDEMPOTENT. Forward-only. Single BEGIN/COMMIT.

BEGIN;


-- ============================================================================
-- Phase 1: jobs.related_to_job_id
-- ============================================================================

ALTER TABLE public.jobs
    ADD COLUMN IF NOT EXISTS related_to_job_id uuid REFERENCES public.jobs(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_jobs_related_to_job_id
    ON public.jobs(related_to_job_id)
    WHERE related_to_job_id IS NOT NULL;

COMMENT ON COLUMN public.jobs.related_to_job_id IS
    'Forward link to the job this row was reordered from. Same-company enforced by enforce_jobs_related_to_same_company_trg. Reverse lookups use the partial index above.';

-- Same-company trigger. A CHECK can not reference other rows, so the
-- cross-row assertion lives here.
CREATE OR REPLACE FUNCTION public.enforce_jobs_related_to_same_company()
    RETURNS trigger LANGUAGE plpgsql
    SET search_path = public, pg_temp
AS $$
DECLARE
    v_related_company uuid;
BEGIN
    IF NEW.related_to_job_id IS NULL THEN
        RETURN NEW;
    END IF;
    IF NEW.related_to_job_id = NEW.id THEN
        RAISE EXCEPTION 'jobs.related_to_job_id cannot reference itself (job %)', NEW.id
            USING ERRCODE = 'check_violation';
    END IF;
    SELECT company_id INTO v_related_company
      FROM public.jobs WHERE id = NEW.related_to_job_id;
    IF v_related_company IS NULL THEN
        RAISE EXCEPTION 'related_to_job_id % does not exist', NEW.related_to_job_id
            USING ERRCODE = 'foreign_key_violation';
    END IF;
    IF v_related_company <> NEW.company_id THEN
        RAISE EXCEPTION 'related_to_job_id % belongs to a different company',
            NEW.related_to_job_id
            USING ERRCODE = 'foreign_key_violation';
    END IF;
    RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS enforce_jobs_related_to_same_company_trg ON public.jobs;
CREATE TRIGGER enforce_jobs_related_to_same_company_trg
    BEFORE INSERT OR UPDATE OF related_to_job_id ON public.jobs
    FOR EACH ROW EXECUTE FUNCTION public.enforce_jobs_related_to_same_company();


-- ============================================================================
-- Phase 2: search_jobs_by_identifier RPC
-- ============================================================================
-- Returns up to 100 rows per call — enough to drive the jobs-list filter
-- preview without flooding AG Grid with thousands. The UI pages further
-- if needed. Uses ILIKE rather than the GIN trigram operators because
-- the rendered column needs deterministic ordering by match priority
-- (PS# > job# > PO# > customer > part).
--
-- match_source values are stable strings consumed by the cell renderer:
--   'job_number', 'customer_po', 'customer', 'part', 'packing_slip'

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
        SELECT DISTINCT ON (jobs.id) jobs.id, m.match_source
          FROM public.jobs
          JOIN LATERAL (
              SELECT 'packing_slip'::text AS match_source, 1::int AS priority
                FROM public.shipments s
                JOIN public.shipment_line_items sli ON sli.shipment_id = s.id
                JOIN public.job_parts jp ON jp.id = sli.job_part_id
               WHERE jp.job_id = jobs.id
                 AND s.voided_at IS NULL
                 AND s.packing_slip_number ILIKE v_pattern
               LIMIT 1
              UNION ALL
              SELECT 'job_number', 2
               WHERE jobs.job_number ILIKE v_pattern
              UNION ALL
              SELECT 'customer_po', 3
               WHERE jobs.customer_po_number ILIKE v_pattern
              UNION ALL
              SELECT 'customer_po', 3
                FROM public.quotes q
               WHERE q.id = jobs.quote_id
                 AND q.customer_po_number ILIKE v_pattern
              UNION ALL
              SELECT 'customer', 4
                FROM public.customers c
               WHERE c.id = jobs.customer_id
                 AND c.name ILIKE v_pattern
              UNION ALL
              SELECT 'part', 5
                FROM public.job_parts jp
                JOIN public.parts p ON p.id = jp.part_id
               WHERE jp.job_id = jobs.id
                 AND p.part_name ILIKE v_pattern
               LIMIT 1
          ) AS m ON TRUE
         WHERE jobs.company_id = p_company_id
         ORDER BY jobs.id, m.priority
         LIMIT 100;
END $$;

COMMENT ON FUNCTION public.search_jobs_by_identifier(uuid, text) IS
    'Extended jobs-list search across job_number, customer_po (jobs + quotes), customers.name, parts.part_name, shipments.packing_slip_number. Returns one row per matching job with the highest-priority match_source. Capped at 100 rows.';

REVOKE ALL ON FUNCTION public.search_jobs_by_identifier(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.search_jobs_by_identifier(uuid, text) TO authenticated;


COMMIT;
