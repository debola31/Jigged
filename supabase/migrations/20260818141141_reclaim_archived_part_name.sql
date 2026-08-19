-- ═══════════════════════════════════════════════════════════════════════════════
-- Re-using an archived part's name creates a NEW part, and moves the old one aside
-- ═══════════════════════════════════════════════════════════════════════════════
-- Until now, name reuse REVIVED: archive "1003308", create it again, and the archived row came
-- back wearing the new form's values. That is right for a shop re-importing its own catalogue and
-- wrong for a shop importing a customer's drawings, where the number belongs to whoever sent it.
-- It also meant the drawings importer had to show "this exists but is archived" on every row of a
-- re-imported package and ask a question nobody wanted to answer.
--
-- ## Why a rename rather than a partial unique index
--
-- Making `parts_unique_per_company` partial over live rows is the obvious fix and is **withdrawn**
-- (architecture.md §16): the data-import system upserts on the name key with
-- `ON CONFLICT (company_id, part_name)`, and PostgREST cannot point `on_conflict` at a partial
-- index. The constraint therefore stays FULL, and the archived row gives its name up instead —
-- the macOS trash rule, where the thing you throw away is renamed rather than blocking the name.
--
-- ## Why it is LAZY, and this is the whole design
--
-- `quote_line_items` and `job_parts` store only `part_id`. Every quote, packing slip, job screen
-- and QuickBooks push reads `parts.part_name` LIVE — a documented gap (architecture.md §15). So
-- renaming a part rewrites how its history reads, and renaming on *every* archive would stamp
-- "(archived)" across years of customer-facing PDFs for parts nobody ever asked about again.
--
-- This function is therefore called only at the moment something actually TAKES the name — on the
-- `23505` from an insert, never on archive. An archived part nobody collides with keeps its name
-- and its documents forever. Where a rename does happen, the shop has just deliberately reassigned
-- that number to a different part, which is exactly when the old quote should not claim it.
--
-- The real fix for the underlying gap is snapshotting name and description onto the document rows;
-- that is its own change and does not belong here.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Move an archived holder aside
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.reclaim_part_name(p_company_id uuid, p_name text)
RETURNS boolean
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
    v_holder_id uuid;
    v_candidate text;
    v_suffix    integer := 1;
BEGIN
    -- Only an ARCHIVED holder gives up its name. A live one is a genuine duplicate and the
    -- caller's 23505 stands: two live parts of one name is the thing the constraint is for.
    SELECT id INTO v_holder_id
      FROM public.parts
     WHERE company_id = p_company_id
       AND part_name = p_name
       AND deleted_at IS NOT NULL;

    IF v_holder_id IS NULL THEN
        RETURN false;
    END IF;

    -- "(archived)", then "(archived 2)" — the trash can hold more than one of these, because a
    -- name can be reclaimed, archived and reclaimed again.
    v_candidate := p_name || ' (archived)';
    WHILE EXISTS (
        SELECT 1 FROM public.parts
         WHERE company_id = p_company_id AND part_name = v_candidate
    ) LOOP
        v_suffix := v_suffix + 1;
        v_candidate := p_name || ' (archived ' || v_suffix || ')';
    END LOOP;

    UPDATE public.parts
       SET part_name = v_candidate,
           updated_at = now()
     WHERE id = v_holder_id;

    RETURN true;
END;
$$;

COMMENT ON FUNCTION public.reclaim_part_name(uuid, text) IS
'Frees a part name held by an ARCHIVED row by renaming it to "<name> (archived)". Returns true if a
rename happened. Called ONLY on an insert''s 23505, never on archive: part names are read live by
quotes, jobs and invoices, so renaming eagerly would rewrite the history of every archived part.
A LIVE holder is left alone — that collision is a real duplicate.';

-- SECURITY INVOKER (the default): it runs as the caller, so RLS decides which company's parts it
-- can see and rename. That is why it is safe for the browser to call.
REVOKE EXECUTE ON FUNCTION public.reclaim_part_name(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reclaim_part_name(uuid, text) TO authenticated, service_role;
