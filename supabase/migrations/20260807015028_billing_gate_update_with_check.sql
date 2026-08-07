-- Make a billing-blocked UPDATE fail loudly instead of silently doing nothing.
--
-- ═══════════════════════════════════════════════════════════════════════════════
-- THE PROBLEM
-- ═══════════════════════════════════════════════════════════════════════════════
-- The billing gate blocks UPDATE through a RESTRICTIVE policy's USING clause:
--
--   USING (company_can_write(company_id)) WITH CHECK (company_can_write(company_id))
--
-- USING FILTERS. It removes the row from the statement's scan rather than raising,
-- so a blocked UPDATE affects zero rows and reports no error at all. What the user
-- gets depends only on how the call site was written:
--
--   .update(...).select().single()  →  PGRST116 "JSON object requested, multiple
--                                      (or no) rows returned" — a misleading
--                                      "not found" for a write that was refused
--   .update(...)                    →  nothing. The save appears to succeed.
--
-- The second is the dangerous one. `markOperationReceived` returned
-- `{ success: true }` and told the shop floor that outside work was back while the
-- row sat untouched. (That call site is now checked in TypeScript too, but the
-- database should not have been able to lie to it in the first place.)
--
-- INSERT never had this problem: a WITH CHECK failure raises 42501, and because
-- restrictive policies each get their own WithCheckOption the message even names
-- the policy — which is what lets the UI tell a lapsed subscription apart from a
-- plain permission denial.
--
-- ═══════════════════════════════════════════════════════════════════════════════
-- THE FIX, AND WHY IT IS EQUIVALENT
-- ═══════════════════════════════════════════════════════════════════════════════
--   USING (true) WITH CHECK (company_can_write(company_id))
--
-- The gate stops pruning rows; the WITH CHECK still refuses the write, now raising
--   ERROR: new row violates row-level security policy "billing_gate_update" for table "parts"
-- with SQLSTATE 42501 — classifiable, and carrying the policy name the UI keys on.
--
-- Enforcement is unchanged because NEW.company_id ≡ OLD.company_id on every real
-- path: no access function in utils/ writes company_id, or a gate-resolving parent
-- FK. The one case that separates the two shapes is a caller who deliberately
-- CHANGES the key to a company they may write in — which the trigger below closes,
-- so the equivalence is enforced rather than argued.
--
-- It is also cheaper: the old shape evaluated company_can_write() twice per row
-- (once in the scan qual, once in the check), the new one evaluates it once.
--
-- DELETE IS DELIBERATELY LEFT ALONE. There is no WITH CHECK for DELETE, so the
-- only RLS-shaped fix would be USING (true) plus a BEFORE DELETE trigger that
-- raises — which inverts the failure mode from fail-closed to fail-OPEN if that
-- trigger is ever dropped. Not worth it here: this repo soft-deletes every
-- user-facing entity (archive is an UPDATE, so it is covered by the above), and
-- the remaining hard deletes are line items, contacts, tiers and reactions, where
-- the worst outcome is the row reappearing on reload. Those call sites assert the
-- returned row count instead — see assertDeleted in lib/supabaseErrors.ts.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. The immutability guard
-- ─────────────────────────────────────────────────────────────────────────────
-- With USING (true), a user who belongs to BOTH a lapsed company A and a writable
-- company B could hand-craft a PATCH setting company_id = B on an A row: the
-- restrictive WITH CHECK passes (B is writable) and so does the permissive
-- membership check. That is not a billing bypass — it does not let them write in A
-- — but it is a genuine loosening versus the old shape, and it is cheap to close.
--
-- Scoped to the browser roles on purpose. A future migration that legitimately
-- re-parents rows runs as the owner or postgres and must not be blocked by this;
-- the threat model is a crafted PostgREST request, not our own DDL.
CREATE OR REPLACE FUNCTION public.reject_gate_key_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'the billing-gate key column on %.% is immutable', TG_TABLE_SCHEMA, TG_TABLE_NAME
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

COMMENT ON FUNCTION public.reject_gate_key_change() IS
  'BEFORE UPDATE trigger that refuses a change to the column the billing write-gate resolves on (company_id, or the parent FK for a child table). Exists so `billing_gate_update USING (true)` is provably equivalent to the old USING (company_can_write(...)) shape rather than merely close. Trigger function: needs no EXECUTE grant.';

-- Trigger functions are permission-checked when the trigger is CREATED, not when
-- it fires, so this needs no grant. Revoking is free and correct under either
-- default (see CLAUDE.md "Function EXECUTE grants").
REVOKE EXECUTE ON FUNCTION public.reject_gate_key_change() FROM PUBLIC, anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. The helper new tenant tables call
-- ─────────────────────────────────────────────────────────────────────────────
-- CREATE OR REPLACE, so the ACL survives — but the COMMENT is re-issued because a
-- future DROP would take both (CLAUDE.md).
CREATE OR REPLACE FUNCTION public.apply_billing_write_gate(p_table regclass)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_name text := (SELECT relname FROM pg_class WHERE oid = p_table);
BEGIN
  EXECUTE format('DROP POLICY IF EXISTS billing_gate_insert ON %s', p_table);
  EXECUTE format('DROP POLICY IF EXISTS billing_gate_update ON %s', p_table);
  EXECUTE format('DROP POLICY IF EXISTS billing_gate_delete ON %s', p_table);

  EXECUTE format(
    'CREATE POLICY billing_gate_insert ON %s AS RESTRICTIVE FOR INSERT TO authenticated '
    'WITH CHECK (public.company_can_write(company_id))', p_table);
  -- USING (true): the check, not the filter, is what refuses the write — so it
  -- raises 42501 instead of quietly matching zero rows. See the header.
  EXECUTE format(
    'CREATE POLICY billing_gate_update ON %s AS RESTRICTIVE FOR UPDATE TO authenticated '
    'USING (true) WITH CHECK (public.company_can_write(company_id))', p_table);
  EXECUTE format(
    'CREATE POLICY billing_gate_delete ON %s AS RESTRICTIVE FOR DELETE TO authenticated '
    'USING (public.company_can_write(company_id))', p_table);

  EXECUTE format('DROP TRIGGER IF EXISTS %I ON %s', v_name || '_gate_key_immutable', p_table);
  EXECUTE format(
    'CREATE TRIGGER %I BEFORE UPDATE ON %s FOR EACH ROW '
    'WHEN (NEW.company_id IS DISTINCT FROM OLD.company_id '
    '      AND current_user IN (''authenticated'', ''anon'')) '
    'EXECUTE FUNCTION public.reject_gate_key_change()',
    v_name || '_gate_key_immutable', p_table);
END;
$$;

COMMENT ON FUNCTION public.apply_billing_write_gate(regclass) IS
  'Attach the billing write-gate (restrictive INSERT/UPDATE/DELETE policies calling company_can_write, plus a company_id-immutability trigger) to a tenant table with a direct company_id column. Call in the migration for any new tenant table. Parent-resolved child tables (no company_id) still need hand-written policies. UPDATE uses USING (true) WITH CHECK so a blocked update RAISES rather than silently matching zero rows. See docs/modules/billing.md.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Re-apply to every already-gated direct table
-- ─────────────────────────────────────────────────────────────────────────────
-- Redefining the helper changes NOTHING on its own: the original tables were gated
-- by inline DO blocks in 20260725210136, not through the helper. Discovering them
-- from pg_policies rather than a hard-coded list means every table gated since —
-- and every table gated between writing this and running it — is covered, and that
-- renames (job_notes → notes, job_note_media → note_media in 20260728040701)
-- cannot leave a stale name behind.
DO $$
DECLARE
  rec record;
BEGIN
  FOR rec IN
    SELECT DISTINCT p.tablename
    FROM pg_policies p
    JOIN pg_class c ON c.relname = p.tablename
    JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
    JOIN pg_attribute a
      ON a.attrelid = c.oid AND a.attname = 'company_id' AND NOT a.attisdropped
    WHERE p.schemaname = 'public'
      AND p.policyname = 'billing_gate_insert'
      AND c.relkind = 'r'
    ORDER BY 1
  LOOP
    PERFORM public.apply_billing_write_gate(format('public.%I', rec.tablename)::regclass);
  END LOOP;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. The parent-resolved children
-- ─────────────────────────────────────────────────────────────────────────────
-- No company_id of their own, so they resolve the parent's and cannot use the
-- helper. Same UPDATE reshape; the immutability trigger keys on the parent FK,
-- which is the gate key for these.
--
-- job_operations is why this half matters as much as the direct tables: it is the
-- table behind markOperationReceived, the write that reported success on a row it
-- never touched.
DO $$
DECLARE
  rec record;
BEGIN
  FOR rec IN
    SELECT * FROM (VALUES
      ('customer_addresses',    'customers', 'customer_id'),
      ('customer_contacts',     'customers', 'customer_id'),
      ('vendor_contacts',       'vendors',   'vendor_id'),
      ('parts_bom',             'parts',     'parent_part_id'),
      ('parts_unit_conversions','parts',     'part_id'),
      ('part_procurement_tiers','parts',     'part_id'),
      ('job_materials',         'jobs',      'job_id'),
      ('job_operations',        'jobs',      'job_id'),
      ('routing_operations',    'routings',  'routing_id'),
      ('shipment_line_items',   'shipments', 'shipment_id')
    ) AS m(child, parent, fk)
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'billing_gate_update', rec.child);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR UPDATE TO authenticated '
      'USING (true) '
      'WITH CHECK (public.company_can_write((SELECT p.company_id FROM public.%I p WHERE p.id = %I.%I)))',
      'billing_gate_update', rec.child, rec.parent, rec.child, rec.fk);

    EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I',
      rec.child || '_gate_key_immutable', rec.child);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE ON public.%I FOR EACH ROW '
      'WHEN (NEW.%I IS DISTINCT FROM OLD.%I '
      '      AND current_user IN (''authenticated'', ''anon'')) '
      'EXECUTE FUNCTION public.reject_gate_key_change()',
      rec.child || '_gate_key_immutable', rec.child, rec.fk, rec.fk);
  END LOOP;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Stop the silent shape coming back
-- ─────────────────────────────────────────────────────────────────────────────
-- The completeness guard next door checks that a tenant table IS gated. It cannot
-- see that a gate is gated the OLD way — which is exactly how this bug would
-- return, because the natural thing for the next person to hand-write is the
-- USING(...) WITH CHECK(...) pair they see elsewhere. A CI test asserts this is
-- empty (api/tests/integration/test_billing_enforcement.py).
CREATE OR REPLACE FUNCTION public.tenant_tables_with_silent_update_gate()
RETURNS TABLE(table_name text)
LANGUAGE sql
STABLE
AS $$
  SELECT p.tablename::text
  FROM pg_policies p
  WHERE p.schemaname = 'public'
    AND p.policyname = 'billing_gate_update'
    -- `qual` is the USING clause. Anything other than a plain `true` means the
    -- gate filters rows, so a blocked update matches nothing and never raises.
    AND (p.qual IS DISTINCT FROM 'true' OR p.with_check IS NULL)
  ORDER BY 1;
$$;

COMMENT ON FUNCTION public.tenant_tables_with_silent_update_gate() IS
  'Lists billing_gate_update policies still shaped USING (company_can_write(...)), which FILTERS the row instead of raising — so a blocked update silently affects zero rows. A CI test asserts this returns none. See migration billing_gate_update_with_check.';

GRANT EXECUTE ON FUNCTION public.tenant_tables_with_silent_update_gate() TO service_role;
