-- Migration: Consolidate 7-role model to 4-role model
-- Roles: owner, admin, user, operator
-- Removed: bookkeeper, engineer, quality, sales (all mapped to 'user')

BEGIN;

-- 1. Migrate existing rows with old roles to 'user'
UPDATE user_company_access
SET role = 'user'
WHERE role IN ('bookkeeper', 'engineer', 'quality', 'sales');

-- 2. Drop the old CHECK constraint and add the new one
ALTER TABLE user_company_access
  DROP CONSTRAINT user_company_access_role_check;

ALTER TABLE user_company_access
  ADD CONSTRAINT user_company_access_role_check
  CHECK (role = ANY (ARRAY['owner', 'admin', 'user', 'operator']));

-- 3. Update the column comment to reflect the new role model
COMMENT ON COLUMN user_company_access.role
  IS 'Role in the company: owner (company creator, same permissions as admin), admin (full access), user (can use all modules), operator (shop floor access only)';

COMMIT;
