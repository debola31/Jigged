-- ============================================================
-- Demo Mode Cleanup
-- 1. Drop vestigial demo_template_id column from companies
-- 2. Add owner/admin role check to create_demo_company()
-- ============================================================

BEGIN;

-- ============================================================
-- 1. Drop vestigial demo_template_id (unused v1 artifact)
-- ============================================================

ALTER TABLE companies DROP CONSTRAINT IF EXISTS companies_demo_template_id_fkey;
ALTER TABLE companies DROP COLUMN IF EXISTS demo_template_id;

-- ============================================================
-- 2. Re-create create_demo_company() with role check
-- ============================================================

CREATE OR REPLACE FUNCTION public.create_demo_company(
    p_source_company_id uuid,
    p_user_id uuid,
    p_template_name character varying DEFAULT 'default'::character varying
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
    v_source_name TEXT;
    v_demo_company_id UUID;
    v_existing_demo_id UUID;
BEGIN
    -- Auth check: caller must be the requesting user
    IF p_user_id != auth.uid() THEN
        RAISE EXCEPTION 'Access denied: cannot create demo company for another user';
    END IF;

    -- Role check: caller must be owner or admin of source company
    IF NOT EXISTS (
        SELECT 1 FROM user_company_access
        WHERE user_id = p_user_id
          AND company_id = p_source_company_id
          AND role IN ('owner', 'admin')
    ) THEN
        RAISE EXCEPTION 'Access denied: must be owner or admin of source company';
    END IF;

    -- Idempotency: return existing demo company if one exists
    SELECT demo_company_id INTO v_existing_demo_id
    FROM companies
    WHERE id = p_source_company_id;

    IF v_existing_demo_id IS NOT NULL THEN
        RETURN v_existing_demo_id;
    END IF;

    -- Get source company name
    SELECT name INTO v_source_name
    FROM companies WHERE id = p_source_company_id;

    IF v_source_name IS NULL THEN
        RAISE EXCEPTION 'Source company not found: %', p_source_company_id;
    END IF;

    -- Create demo company
    INSERT INTO companies (name, is_demo)
    VALUES (v_source_name || ' - Demo', TRUE)
    RETURNING id INTO v_demo_company_id;

    -- Link demo to source company
    UPDATE companies SET demo_company_id = v_demo_company_id
    WHERE id = p_source_company_id;

    -- Mirror all user_company_access from source to demo
    INSERT INTO user_company_access (user_id, company_id, role, name)
    SELECT uca.user_id, v_demo_company_id, uca.role, uca.name
    FROM user_company_access uca
    WHERE uca.company_id = p_source_company_id;

    -- Seed demo data from active template
    PERFORM seed_demo_data(v_demo_company_id, p_user_id, p_template_name);

    RETURN v_demo_company_id;
END;
$function$;

COMMIT;
