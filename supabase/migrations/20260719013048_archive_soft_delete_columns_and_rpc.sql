-- Universal soft-delete (archive) for the user-facing entities.
--
-- "Delete" becomes archive: set deleted_at instead of DELETEing the row. The row survives, so
-- every downstream reference (quotes, jobs, shipments, invoices, BOM lines) keeps resolving and
-- nothing is ever blocked by a foreign key. Reads (lists/search/pickers/counts/dashboards) filter
-- `deleted_at IS NULL`.
--
-- Name uniqueness stays a FULL constraint (NOT a partial index): the data-import system upserts
-- every entity on its name key (ON CONFLICT (company_id, part_name|name)), which PostgREST cannot
-- point at a partial index. Name is therefore the natural identity — reusing a name (via import
-- upsert or the create path) REVIVES the archived row rather than duplicating it, so there is only
-- ever one row per name and a full constraint is correct.
--
-- See docs/architecture.md "Deletion & archiving policy".

-- 1. deleted_at columns ------------------------------------------------------------------------
ALTER TABLE public.parts        ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE public.customers    ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE public.vendors      ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE public.work_centers ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE public.jobs         ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE public.quotes       ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

COMMENT ON COLUMN public.parts.deleted_at IS
  'Archive marker. When set, the part is hidden from all lists/search/pickers/dashboards (reads filter deleted_at IS NULL) but the row and its references survive. Reusing part_name (create or import upsert) revives it (clears deleted_at). Archiving a part also detaches it as a BOM child so parents recompute cost — see archive_parts().';
COMMENT ON COLUMN public.customers.deleted_at IS 'Archive marker (see parts.deleted_at). Reads filter deleted_at IS NULL; reusing the name revives the row.';
COMMENT ON COLUMN public.vendors.deleted_at IS 'Archive marker (see parts.deleted_at). Reads filter deleted_at IS NULL; reusing the name revives the row.';
COMMENT ON COLUMN public.work_centers.deleted_at IS 'Archive marker (see parts.deleted_at). Reads filter deleted_at IS NULL; reusing the name revives the row.';
COMMENT ON COLUMN public.jobs.deleted_at IS 'Archive marker (see parts.deleted_at). Distinct from the cancelled production_status, which is a shop-floor outcome, not deletion.';
COMMENT ON COLUMN public.quotes.deleted_at IS 'Archive marker (see parts.deleted_at). Reads filter deleted_at IS NULL.';

-- 2. Partial indexes so live-row list reads skip archived rows efficiently ----------------------
CREATE INDEX IF NOT EXISTS idx_parts_live_by_company        ON public.parts        (company_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_customers_live_by_company    ON public.customers    (company_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_vendors_live_by_company      ON public.vendors      (company_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_work_centers_live_by_company ON public.work_centers (company_id) WHERE deleted_at IS NULL;

-- 3. archive_parts(): archive parts and detach them as BOM children -----------------------------
-- SECURITY INVOKER so RLS enforces tenant isolation: the caller can only archive parts in a company
-- they belong to (parts UPDATE policy) and can only delete parts_bom rows whose PARENT part is in
-- their company (parts_bom DELETE policy keys on parent_part_id) — deleting rows by child_part_id
-- passes because the parents stay company-visible. part_location_stock is intentionally left alone
-- (it has only a SELECT policy, so an INVOKER function can't DELETE it) — an archived part's stock
-- is hidden by read-filtering, and comes back if the part is revived.
CREATE OR REPLACE FUNCTION public.archive_parts(p_ids uuid[])
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
    -- Idempotent: only stamp rows that aren't already archived, so a re-archive keeps the
    -- original archive time.
    UPDATE public.parts
       SET deleted_at = now(),
           updated_at = now()
     WHERE id = ANY(p_ids)
       AND deleted_at IS NULL;

    -- Remove the archived parts from every parent part's BOM so those parents' live cost
    -- rollups (compute_part_cost_at_qty reads parts_bom) recompute without them.
    DELETE FROM public.parts_bom
     WHERE child_part_id = ANY(p_ids);
END;
$function$;

REVOKE ALL ON FUNCTION public.archive_parts(uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.archive_parts(uuid[]) TO authenticated, service_role;

-- 4. parts_deletion_impact(): aggregate reference counts for the pre-archive warning ----------
-- Returns, for the parts about to be archived: how many distinct quotes and jobs reference them
-- (history that will be kept), and how many OTHER parts have them as a BOM component and will thus
-- have their cost recomputed. Runs SECURITY INVOKER, so RLS scopes every count to the caller's
-- company. Taking a uuid[] argument (POST body) avoids the URL-length limit of a huge .in() filter
-- when the user bulk-selects thousands of parts.
CREATE OR REPLACE FUNCTION public.parts_deletion_impact(p_ids uuid[])
RETURNS TABLE(quotes_count integer, jobs_count integer, bom_parents_count integer)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path TO 'public', 'pg_temp'
AS $function$
    SELECT
        (SELECT count(DISTINCT qli.quote_id)
           FROM public.quote_line_items qli
          WHERE qli.part_id = ANY(p_ids))::int,
        (SELECT count(DISTINCT jp.job_id)
           FROM public.job_parts jp
          WHERE jp.part_id = ANY(p_ids))::int,
        (SELECT count(DISTINCT pb.parent_part_id)
           FROM public.parts_bom pb
          WHERE pb.child_part_id = ANY(p_ids)
            AND pb.parent_part_id <> ALL(p_ids))::int;
$function$;

REVOKE ALL ON FUNCTION public.parts_deletion_impact(uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.parts_deletion_impact(uuid[]) TO authenticated, service_role;
