-- ============================================================================
-- The insights AI stops seeing the children of archived parents
-- ============================================================================
-- An archived vendor's contacts and addresses were readable by jigged_ai_readonly.
-- Their ai_readonly_select policies scope through the vendor for the COMPANY and
-- for nothing else, so "who do we call at <vendor>?" answered for a vendor no
-- screen shows -- the six-phantom-jobs bug of 20260827114613, one level down.
-- CLAUDE.md's rule is that ai_readonly_select policies carry the soft-delete
-- filter. The guard that enforces it, ai_policies_missing_soft_delete_filter(),
-- read only a table's OWN deleted_at, so a child with none of its own passed it
-- vacuously whatever its parent's state.
--
-- Extending the guard to every table a policy reads (section 2) found the same
-- leak on six more children, fixed here too because a guard cannot ship red:
--   customer_addresses                          -> customers
--   job_materials, job_operations, job_parts    -> jobs
--   parts_bom, parts_unit_conversions           -> parts
-- Each policy is rebuilt from its NEWEST definition with one clause added -- the
-- parent must be live -- the shape customer_contacts (20260827114613) and
-- vendor_purchase_order_lines (20261110043600) already have. Nothing else in any
-- of them changes; grants are untouched.
--
-- WHAT IT COSTS, as 20260827114613 said of the parents: the model cannot answer
-- about an archived job's parts or an archived vendor's contacts. It already
-- could not see the job or the vendor, so a child it could see was an orphan it
-- would report as live. parts_bom hides an archived ASSEMBLY's structure; a live
-- assembly whose BOM names an archived component keeps the row, and the
-- component itself stays hidden by parts' own policy.


-- ============================================================================
-- 1. The policies, each from its newest definition plus "the parent is live"
-- ============================================================================

-- vendor_contacts: baseline (20260527151536).
DROP POLICY IF EXISTS ai_readonly_select ON public.vendor_contacts;
CREATE POLICY ai_readonly_select ON public.vendor_contacts
    FOR SELECT TO jigged_ai_readonly
    USING (
      vendor_id IN (
        SELECT v.id FROM public.vendors v
         WHERE v.company_id = (current_setting('jigged.company_id', true))::uuid
           AND v.deleted_at IS NULL
      )
    );

-- vendor_addresses: 20260824022226.
DROP POLICY IF EXISTS ai_readonly_select ON public.vendor_addresses;
CREATE POLICY ai_readonly_select ON public.vendor_addresses
    FOR SELECT TO jigged_ai_readonly
    USING (
      EXISTS (
        SELECT 1 FROM public.vendors v
         WHERE v.id = vendor_addresses.vendor_id
           AND v.company_id = (current_setting('jigged.company_id', true))::uuid
           AND v.deleted_at IS NULL
      )
    );

-- customer_addresses: 20260826112948.
DROP POLICY IF EXISTS ai_readonly_select ON public.customer_addresses;
CREATE POLICY ai_readonly_select ON public.customer_addresses
    FOR SELECT TO jigged_ai_readonly
    USING (
      customer_id IN (
        SELECT c.id FROM public.customers c
         WHERE c.company_id = (current_setting('jigged.company_id', true))::uuid
           AND c.deleted_at IS NULL
      )
    );

-- job_materials, job_operations, job_parts: baseline (20260527151536).
DROP POLICY IF EXISTS ai_readonly_select ON public.job_materials;
CREATE POLICY ai_readonly_select ON public.job_materials
    FOR SELECT TO jigged_ai_readonly
    USING (
      EXISTS (
        SELECT 1 FROM public.jobs
         WHERE jobs.id = job_materials.job_id
           AND jobs.company_id = (current_setting('jigged.company_id', true))::uuid
           AND jobs.deleted_at IS NULL
      )
    );

DROP POLICY IF EXISTS ai_readonly_select ON public.job_operations;
CREATE POLICY ai_readonly_select ON public.job_operations
    FOR SELECT TO jigged_ai_readonly
    USING (
      EXISTS (
        SELECT 1 FROM public.jobs
         WHERE jobs.id = job_operations.job_id
           AND jobs.company_id = (current_setting('jigged.company_id', true))::uuid
           AND jobs.deleted_at IS NULL
      )
    );

DROP POLICY IF EXISTS ai_readonly_select ON public.job_parts;
CREATE POLICY ai_readonly_select ON public.job_parts
    FOR SELECT TO jigged_ai_readonly
    USING (
      EXISTS (
        SELECT 1 FROM public.jobs
         WHERE jobs.id = job_parts.job_id
           AND jobs.company_id = (current_setting('jigged.company_id', true))::uuid
           AND jobs.deleted_at IS NULL
      )
    );

-- parts_bom, parts_unit_conversions: baseline (20260527151536).
DROP POLICY IF EXISTS ai_readonly_select ON public.parts_bom;
CREATE POLICY ai_readonly_select ON public.parts_bom
    FOR SELECT TO jigged_ai_readonly
    USING (
      EXISTS (
        SELECT 1 FROM public.parts
         WHERE parts.id = parts_bom.parent_part_id
           AND parts.company_id = (current_setting('jigged.company_id', true))::uuid
           AND parts.deleted_at IS NULL
      )
    );

DROP POLICY IF EXISTS ai_readonly_select ON public.parts_unit_conversions;
CREATE POLICY ai_readonly_select ON public.parts_unit_conversions
    FOR SELECT TO jigged_ai_readonly
    USING (
      EXISTS (
        SELECT 1 FROM public.parts
         WHERE parts.id = parts_unit_conversions.part_id
           AND parts.company_id = (current_setting('jigged.company_id', true))::uuid
           AND parts.deleted_at IS NULL
      )
    );


-- ============================================================================
-- 2. The guard sees the tables a policy READS, not only the table it is on
-- ============================================================================
-- Rebuilt from its newest definition (20260827114613). Branch (1) is that body
-- verbatim but for its ORDER BY, which now closes the UNION.
--
-- Branch (2) asks pg_depend rather than the policy's text. CREATE POLICY records
-- a dependency on every column its expression reads -- inside a subquery too --
-- which is why such a column cannot be dropped out from under the policy. So
-- "this policy reads vendors and filters vendors.deleted_at" is a catalogue fact:
-- a dependency on vendors with no dependency on vendors.deleted_at is the leak.
-- A text match (branch (1)'s method) cannot tell which table a "deleted_at" in
-- the expression belongs to; customer_contacts mentions it twice for that reason.
CREATE OR REPLACE FUNCTION public.ai_policies_missing_soft_delete_filter()
RETURNS TABLE(table_name text)
LANGUAGE sql
STABLE
AS $fn$
  -- (1) The table's OWN deleted_at.
  SELECT c.relname::text
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_policy  p ON p.polrelid = c.oid AND p.polname = 'ai_readonly_select'
  WHERE n.nspname = 'public'
    AND c.relkind = 'r'
    AND EXISTS (
      SELECT 1 FROM pg_attribute a
       WHERE a.attrelid = c.oid AND a.attname = 'deleted_at' AND NOT a.attisdropped
    )
    AND pg_get_expr(p.polqual, p.polrelid) NOT LIKE '%deleted_at%'
  UNION
  -- (2) Every OTHER soft-deletable table the policy reads -- a parent it scopes
  -- through -- must have its deleted_at read too.
  SELECT c.relname::text
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_policy  p ON p.polrelid = c.oid AND p.polname = 'ai_readonly_select'
  JOIN pg_depend  d ON d.classid = 'pg_policy'::regclass AND d.objid = p.oid
                   AND d.refclassid = 'pg_class'::regclass
  JOIN pg_class   r ON r.oid = d.refobjid AND r.relkind = 'r' AND r.oid <> c.oid
  JOIN pg_attribute del ON del.attrelid = r.oid AND del.attname = 'deleted_at'
                       AND NOT del.attisdropped
  WHERE n.nspname = 'public'
    AND c.relkind = 'r'
    AND NOT EXISTS (
      SELECT 1 FROM pg_depend d2
       WHERE d2.classid = 'pg_policy'::regclass AND d2.objid = p.oid
         AND d2.refclassid = 'pg_class'::regclass
         AND d2.refobjid = r.oid AND d2.refobjsubid = del.attnum
    )
  ORDER BY 1;
$fn$;

-- CREATE OR REPLACE keeps the ACL; the COMMENT is re-issued, and so are the
-- grants, so this file states the whole posture on its own.
COMMENT ON FUNCTION public.ai_policies_missing_soft_delete_filter() IS
  'Tables the insights sandbox can read through an ai_readonly_select policy that lets archived rows through: (1) the table has a deleted_at column the policy does not mention, or (2) the policy reads another table that has one -- a parent it scopes through -- without reading that table''s deleted_at (checked in pg_depend, so it names the table, not a substring). Should always be empty; asserted by test_ai_read_access.py. Branch (2) since 20261112193919, when an archived vendor''s contacts and addresses, and six other children, were found readable. Six phantom "late jobs" were reported to a shop owner in August 2026 because branch (1) held for jobs and only prose said otherwise.';

REVOKE EXECUTE ON FUNCTION public.ai_policies_missing_soft_delete_filter() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ai_policies_missing_soft_delete_filter() TO service_role;


-- ============================================================================
-- 3. This migration's own tables pass the guard it extends
-- ============================================================================
-- Scoped to the eight rebuilt here, as 20261110044000 scopes its check to the
-- purchasing tables: the whole list is CI's assertion, and an unrelated drift
-- elsewhere must not hold this migration hostage.
DO $check$
DECLARE
    v_left text;
BEGIN
    SELECT string_agg(t.table_name, ', ') INTO v_left
      FROM public.ai_policies_missing_soft_delete_filter() t
     WHERE t.table_name = ANY (ARRAY[
         'vendor_contacts', 'vendor_addresses', 'customer_addresses',
         'job_materials', 'job_operations', 'job_parts',
         'parts_bom', 'parts_unit_conversions']);
    IF v_left IS NOT NULL THEN
        RAISE EXCEPTION 'ai_policies_missing_soft_delete_filter() still flags: %', v_left;
    END IF;
END
$check$;
