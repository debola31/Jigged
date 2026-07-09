-- Fix reset_demo_company: it still deleted from operator_sessions, a table that
-- was dropped in 20260621132129_drop_operator_time_tracking. That migration's
-- comment claimed "No SQL function/trigger/view references the objects dropped
-- here" — but this function did, so "Reset demo" (Settings / demo banner ->
-- resetDemoCompany -> rpc('reset_demo_company')) errored with
-- `relation "operator_sessions" does not exist` for any demo company.
--
-- CREATE OR REPLACE with the operator_sessions DELETE removed; everything else
-- is the prior definition unchanged.

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

    -- Delete in FK-respecting order. job_materials/job_operations live under
    -- jobs (not company-scoped directly), so we pivot through jobs first.
    DELETE FROM inventory_transactions WHERE company_id = v_demo_company_id;
    DELETE FROM job_materials WHERE job_id IN (SELECT id FROM jobs WHERE company_id = v_demo_company_id);
    DELETE FROM job_operations WHERE job_id IN (SELECT id FROM jobs WHERE company_id = v_demo_company_id);
    DELETE FROM job_parts WHERE company_id = v_demo_company_id;
    DELETE FROM jobs WHERE company_id = v_demo_company_id;
    DELETE FROM quote_line_items WHERE company_id = v_demo_company_id;
    DELETE FROM quote_materials WHERE company_id = v_demo_company_id;
    DELETE FROM quote_operations WHERE company_id = v_demo_company_id;
    DELETE FROM quotes WHERE company_id = v_demo_company_id;
    -- routing_operations cascades from routings (FK ON DELETE CASCADE), but
    -- being explicit makes the order obvious.
    DELETE FROM routing_operations
        WHERE routing_id IN (SELECT id FROM routings WHERE company_id = v_demo_company_id);
    DELETE FROM routings WHERE company_id = v_demo_company_id;
    -- parts_bom rows have no company_id; pivot through the parent part.
    DELETE FROM parts_bom
        WHERE parent_part_id IN (SELECT id FROM parts WHERE company_id = v_demo_company_id);
    DELETE FROM part_pricing_tiers WHERE company_id = v_demo_company_id;
    -- parts_unit_conversions also has no company_id; pivot through part.
    DELETE FROM parts_unit_conversions
        WHERE part_id IN (SELECT id FROM parts WHERE company_id = v_demo_company_id);
    DELETE FROM parts WHERE company_id = v_demo_company_id;
    DELETE FROM work_centers WHERE company_id = v_demo_company_id;
    DELETE FROM vendors WHERE company_id = v_demo_company_id;
    DELETE FROM customers WHERE company_id = v_demo_company_id;
    DELETE FROM ai_chat_queries WHERE company_id = v_demo_company_id;

    PERFORM seed_demo_data(v_demo_company_id, p_user_id);
END;
$function$;
