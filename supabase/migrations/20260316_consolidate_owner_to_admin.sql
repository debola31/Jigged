-- ============================================================
-- Role Consolidation: Merge 'owner' into 'admin' (4 → 3 roles)
--
-- Per PRD Section 2.1: Jigged uses a simplified 3-role permission model.
-- "Owner" is consolidated into Admin. The first user to create a company
-- is automatically an Admin.
--
-- Roles after migration: admin, user, operator
-- ============================================================

BEGIN;

-- 1. Migrate existing 'owner' records to 'admin'
UPDATE user_company_access SET role = 'admin' WHERE role = 'owner';

-- 2. Update CHECK constraint to enforce 3 roles only
ALTER TABLE user_company_access DROP CONSTRAINT user_company_access_role_check;
ALTER TABLE user_company_access ADD CONSTRAINT user_company_access_role_check
  CHECK (role = ANY (ARRAY['admin'::text, 'user'::text, 'operator'::text]));

-- 3. Update is_company_admin() function — remove 'owner' reference
CREATE OR REPLACE FUNCTION public.is_company_admin(check_company_id uuid)
  RETURNS boolean
  LANGUAGE sql
  STABLE SECURITY DEFINER
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM user_company_access
    WHERE user_id = auth.uid()
      AND company_id = check_company_id
      AND role = 'admin'
  );
$function$;

-- 4. Update create_demo_company() function — remove 'owner' from role check
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

    -- Role check: caller must be admin of source company
    IF NOT EXISTS (
        SELECT 1 FROM user_company_access
        WHERE user_id = p_user_id
          AND company_id = p_source_company_id
          AND role = 'admin'
    ) THEN
        RAISE EXCEPTION 'Access denied: must be admin of source company';
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

-- 5. Update RLS policies on ai_chat_queries — remove 'owner' from role arrays
DROP POLICY IF EXISTS "Users can insert chat queries for own company" ON "public"."ai_chat_queries";
CREATE POLICY "Users can insert chat queries for own company"
    ON "public"."ai_chat_queries"
    FOR INSERT
    WITH CHECK ((company_id IN (
        SELECT user_company_access.company_id
        FROM user_company_access
        WHERE user_company_access.user_id = auth.uid()
          AND user_company_access.role = ANY (ARRAY['admin'::text, 'user'::text])
    )));

DROP POLICY IF EXISTS "Users can read own company chat history" ON "public"."ai_chat_queries";
CREATE POLICY "Users can read own company chat history"
    ON "public"."ai_chat_queries"
    FOR SELECT
    USING ((company_id IN (
        SELECT user_company_access.company_id
        FROM user_company_access
        WHERE user_company_access.user_id = auth.uid()
          AND user_company_access.role = ANY (ARRAY['admin'::text, 'user'::text])
    )));

COMMIT;
