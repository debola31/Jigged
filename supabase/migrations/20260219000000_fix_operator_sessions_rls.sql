-- Migration: fix_operator_sessions_rls
-- Description: Fix broken RLS policies on operator_sessions that reference
--              the deprecated/removed 'operators' table. Replace with policies
--              that use user_company_access via a SECURITY DEFINER function.
-- Date: 2026-02-19
--
-- Root Cause:
-- Migration 20260113221408 created operator policies on operator_sessions that
-- referenced `SELECT id FROM operators WHERE user_id = auth.uid()`. The operators
-- table was deprecated in 20260115004359 and has since been removed. This leaves
-- operators unable to INSERT, UPDATE, or SELECT their own sessions.
--
-- Solution:
-- 1. Create a SECURITY DEFINER function `get_operator_access_id(company_id)` that
--    returns the user_company_access.id for the current user if they are an operator
--    in the given company. This bypasses RLS on user_company_access, avoiding
--    potential recursion issues (same pattern as is_company_admin).
-- 2. Drop the three broken operator policies.
-- 3. Create three new operator policies using the SECURITY DEFINER function.
-- 4. Update the two existing admin policies to use is_company_admin() for
--    consistency with the rest of the codebase.

-- ============================================================
-- 1. CREATE SECURITY DEFINER FUNCTION
-- ============================================================

-- Returns the user_company_access.id for the currently authenticated user
-- if they have the 'operator' role in the given company, or NULL otherwise.
-- SECURITY DEFINER bypasses RLS on user_company_access, preventing recursion.
-- STABLE means the function does not modify the database and returns the same
-- result for the same arguments within a single statement.
CREATE OR REPLACE FUNCTION public.get_operator_access_id(check_company_id uuid)
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
AS $function$
  SELECT id FROM user_company_access
  WHERE user_id = auth.uid()
    AND company_id = check_company_id
    AND role = 'operator'
  LIMIT 1;
$function$;

COMMENT ON FUNCTION public.get_operator_access_id(uuid) IS
'Returns the user_company_access.id for the current auth user if they are an operator in the given company. SECURITY DEFINER to bypass RLS on user_company_access. Used by operator_sessions RLS policies.';

-- ============================================================
-- 2. DROP BROKEN OPERATOR POLICIES
-- ============================================================

-- These policies reference the removed 'operators' table and fail
-- at evaluation time.
DROP POLICY IF EXISTS "Operators can read own sessions" ON "public"."operator_sessions";
DROP POLICY IF EXISTS "Operators can insert own sessions" ON "public"."operator_sessions";
DROP POLICY IF EXISTS "Operators can update own sessions" ON "public"."operator_sessions";

-- ============================================================
-- 3. CREATE NEW OPERATOR POLICIES
-- ============================================================

-- Operators can SELECT their own sessions.
CREATE POLICY "Operators can read own sessions"
ON "public"."operator_sessions"
FOR SELECT
USING (
    operator_id = get_operator_access_id(company_id)
);

-- Operators can INSERT their own sessions.
CREATE POLICY "Operators can insert own sessions"
ON "public"."operator_sessions"
FOR INSERT
WITH CHECK (
    operator_id = get_operator_access_id(company_id)
);

-- Operators can UPDATE their own sessions (e.g., setting ended_at, notes).
-- USING controls which existing rows can be targeted for update.
-- WITH CHECK controls what the row looks like after the update.
CREATE POLICY "Operators can update own sessions"
ON "public"."operator_sessions"
FOR UPDATE
USING (
    operator_id = get_operator_access_id(company_id)
)
WITH CHECK (
    operator_id = get_operator_access_id(company_id)
);

-- ============================================================
-- 4. UPDATE ADMIN POLICIES TO USE is_company_admin()
-- ============================================================

-- Refresh admin policies to use SECURITY DEFINER function for consistency.

DROP POLICY IF EXISTS "Admins can read company sessions" ON "public"."operator_sessions";
CREATE POLICY "Admins can read company sessions"
ON "public"."operator_sessions"
FOR SELECT
USING (
    is_company_admin(company_id)
);

DROP POLICY IF EXISTS "Admins can delete company sessions" ON "public"."operator_sessions";
CREATE POLICY "Admins can delete company sessions"
ON "public"."operator_sessions"
FOR DELETE
USING (
    is_company_admin(company_id)
);

-- ============================================================
-- 5. FINAL POLICIES SUMMARY ON operator_sessions
-- ============================================================
-- SELECT:
--   - "Operators can read own sessions"   (get_operator_access_id)
--   - "Admins can read company sessions"  (is_company_admin)
--
-- INSERT:
--   - "Operators can insert own sessions" (get_operator_access_id)
--
-- UPDATE:
--   - "Operators can update own sessions" (get_operator_access_id)
--
-- DELETE:
--   - "Admins can delete company sessions" (is_company_admin)
