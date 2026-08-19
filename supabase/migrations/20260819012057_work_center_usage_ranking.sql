-- ═══════════════════════════════════════════════════════════════════════════════
-- How often has this shop routed through each station?
-- ═══════════════════════════════════════════════════════════════════════════════
-- The drawings import lets someone route a part by tapping stations rather than
-- filling a form, and the whole reason that stays fast at a shop with forty work
-- centres is the ORDER they appear in. A shop runs the same six on nearly
-- everything: put those first and the common route never scrolls, so the search
-- field is for the exception — the wire EDM job, the one part that gets
-- passivated — rather than for every part.
--
-- Alphabetical would have thrown that away. "Anodize, Assembly, Bead Blast" is
-- a filing order, not a working one.
--
-- ## Why a function rather than a client-side count
--
-- PostgREST cannot GROUP BY, so the alternative was fetching every
-- `routing_operations` row's work_center_id and counting in the browser — tens of
-- thousands of uuids across the wire to compute five numbers.

CREATE OR REPLACE FUNCTION public.work_center_usage(p_company_id uuid)
RETURNS TABLE (work_center_id uuid, uses bigint)
    LANGUAGE sql
    STABLE
    SET search_path TO 'public', 'pg_temp'
    AS $$
    SELECT ro.work_center_id, count(*) AS uses
      FROM public.routing_operations ro
      JOIN public.routings r ON r.id = ro.routing_id
      JOIN public.parts p    ON p.id = r.part_id
     WHERE r.company_id = p_company_id
       -- An archived part's habits are not this shop's habits any more.
       AND p.deleted_at IS NULL
     GROUP BY ro.work_center_id;
$$;

COMMENT ON FUNCTION public.work_center_usage(uuid) IS
  'Operation count per work centre across a company''s live parts, for ranking the station picker so the stations a shop actually uses come first. Archived parts are excluded — their habits are not current.';

-- SECURITY INVOKER (the default), so RLS on routings/parts scopes every row to
-- the caller's own company. The browser calls this directly from the drawings
-- import, so `authenticated` needs EXECUTE; asked about another tenant it sees no
-- rows and returns nothing.
REVOKE EXECUTE ON FUNCTION public.work_center_usage(uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.work_center_usage(uuid) TO authenticated, service_role;
