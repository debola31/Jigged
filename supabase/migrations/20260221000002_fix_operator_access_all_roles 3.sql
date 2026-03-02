-- Migration: fix_operator_access_all_roles
-- Description: Allow all roles (admin, owner, etc.) to access the operator view
--              and create/read/update operator_sessions. The PRD specifies that
--              Operator View access is available to all roles, not just 'operator'.
-- Date: 2026-02-21
--
-- Root Cause:
-- The get_operator_access_id() function (created in 20260219000000) restricts
-- to role = 'operator', preventing admins and other roles from using the operator
-- interface. Since user_company_access has a UNIQUE(user_id, company_id) constraint,
-- an admin cannot also have an operator row — so the role filter must be removed.
--
-- Solution:
-- Update get_operator_access_id() to return the user_company_access.id for ANY
-- role in the given company. The three operator_sessions RLS policies that use
-- this function (SELECT, INSERT, UPDATE) will automatically work for all roles.

CREATE OR REPLACE FUNCTION public.get_operator_access_id(check_company_id uuid)
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
AS $function$
  SELECT id FROM user_company_access
  WHERE user_id = auth.uid()
    AND company_id = check_company_id
  LIMIT 1;
$function$;

COMMENT ON FUNCTION public.get_operator_access_id(uuid) IS
'Returns the user_company_access.id for the current auth user if they have any role in the given company. SECURITY DEFINER to bypass RLS on user_company_access. Used by operator_sessions RLS policies to allow all company members to use the operator view.';
