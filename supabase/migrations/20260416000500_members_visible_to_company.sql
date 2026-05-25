-- Migration: Let every company member read every other member's profile row
-- (name + email) in their own company.
--
-- The existing RLS on user_company_access restricted SELECT to:
--   * your own row, or
--   * any row in your company IF you are an admin.
--
-- That meant non-admin users couldn't resolve "who prepared this quote?" when
-- the creator wasn't themselves — the name was stuck in a row they couldn't
-- see. Rather than shipping a service-role Edge Function or denormalising
-- names onto every table, we add a plain-member read policy scoped to the
-- caller's own company. The team page already displays these rows to admins;
-- this just extends visibility to regular users for display/lookup purposes.

BEGIN;

DROP POLICY IF EXISTS "Members can view company member profiles" ON public.user_company_access;
CREATE POLICY "Members can view company member profiles"
    ON public.user_company_access
    FOR SELECT
    USING (company_id IN (SELECT get_user_company_ids()));

COMMIT;
