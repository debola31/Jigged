-- Stripe billing: DATA-LAYER write enforcement.
--
-- Entitlement is enforced where writes actually happen — in Postgres — not only
-- in the UI. Members write directly through the browser Supabase client under
-- RLS, so a lapsed (canceled/unpaid past grace) company must be unable to
-- INSERT/UPDATE/DELETE even if the frontend is bypassed, while SELECT stays open
-- (read-only, never a hard lockout).
--
-- Implementation note: rather than rewrite each of ~80 existing permissive
-- membership policies (high variance, high risk), we add ADDITIVE `AS RESTRICTIVE`
-- policies. PostgreSQL AND-combines restrictive policies with the permissive ones
-- for the same command+role, so the effective rule becomes
--   (existing membership check) AND company_can_write(...)
-- with the existing policies untouched. We add restrictive policies only for
-- INSERT/UPDATE/DELETE — never SELECT — so reads remain open. service_role and
-- SECURITY DEFINER functions (webhook, importers, demo seeder/reset) have
-- BYPASSRLS, so they are unaffected.
--
-- SEQUENCING: this runs AFTER the grandfather backfill (20260725205821) and after
-- Contour onboarding, so every pre-existing real company is billing_exempt or
-- active, and demo companies short-circuit — zero lockouts at flip time.

-- ─────────────────────────── write-guard function ───────────────────────────
-- Mirrors lib/entitlement.ts getEntitlement()'s write-allowed set + the 7-day
-- grace anchor. Returns true for demo companies, billing_exempt, live statuses,
-- or canceled/unpaid within grace; false otherwise (including a missing row).
CREATE OR REPLACE FUNCTION public.company_can_write(check_company_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    -- Demo sandboxes are never billing-gated. Checked on the ACTIVE company_id
    -- being written to, so a real company's lapse never cascades to its paired
    -- demo. The storage.objects policies call this same function, so demo uploads
    -- are covered here too.
    EXISTS (
      SELECT 1 FROM public.companies c
      WHERE c.id = check_company_id AND c.is_demo
    )
    OR COALESCE((
      SELECT
        cb.billing_exempt
        OR cb.subscription_status IN ('trialing', 'active', 'past_due')
        OR (
          cb.subscription_status IN ('canceled', 'unpaid')
          AND COALESCE(cb.ended_at, cb.cancel_at, cb.current_period_end)
              + interval '7 days' >= now()
        )
      FROM public.company_billing cb
      WHERE cb.company_id = check_company_id
    ), false);   -- missing row => false (new, never-subscribed companies)
$$;

COMMENT ON FUNCTION public.company_can_write(uuid) IS
  'Billing write-gate for RLS. True if the company may write now (demo, exempt, live sub, or canceled/unpaid within 7-day grace); false otherwise incl. missing row. Mirrors lib/entitlement.ts.';

GRANT EXECUTE ON FUNCTION public.company_can_write(uuid) TO authenticated;

-- ─────────────── restrictive write gates: direct company_id tables ───────────────
-- Each gains INSERT/UPDATE/DELETE restrictive policies keyed on its own
-- company_id column. SELECT is untouched.
DO $$
DECLARE
  t text;
  direct_tables text[] := ARRAY[
    'customers', 'vendors', 'parts', 'part_pricing_tiers', 'part_attachments',
    'part_notes', 'quotes', 'quote_line_items', 'quote_materials',
    'quote_operations', 'jobs', 'job_parts', 'job_attachments', 'job_notes',
    'job_note_media', 'routings', 'shipments', 'work_centers',
    'inventory_locations', 'inventory_transactions', 'company_custom_units',
    'ai_chat_queries', 'ai_config'
  ];
BEGIN
  FOREACH t IN ARRAY direct_tables LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'billing_gate_insert', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'billing_gate_update', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'billing_gate_delete', t);

    EXECUTE format(
      'CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR INSERT TO authenticated '
      'WITH CHECK (public.company_can_write(company_id))',
      'billing_gate_insert', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR UPDATE TO authenticated '
      'USING (public.company_can_write(company_id)) '
      'WITH CHECK (public.company_can_write(company_id))',
      'billing_gate_update', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR DELETE TO authenticated '
      'USING (public.company_can_write(company_id))',
      'billing_gate_delete', t);
  END LOOP;
END $$;

-- ─────────────── restrictive write gates: parent-resolved child tables ───────────
-- These have no company_id column; resolve the parent's company and gate on it.
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
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'billing_gate_insert', rec.child);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'billing_gate_update', rec.child);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'billing_gate_delete', rec.child);

    EXECUTE format(
      'CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR INSERT TO authenticated '
      'WITH CHECK (public.company_can_write((SELECT p.company_id FROM public.%I p WHERE p.id = %I.%I)))',
      'billing_gate_insert', rec.child, rec.parent, rec.child, rec.fk);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR UPDATE TO authenticated '
      'USING (public.company_can_write((SELECT p.company_id FROM public.%I p WHERE p.id = %I.%I))) '
      'WITH CHECK (public.company_can_write((SELECT p.company_id FROM public.%I p WHERE p.id = %I.%I)))',
      'billing_gate_update', rec.child, rec.parent, rec.child, rec.fk, rec.parent, rec.child, rec.fk);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR DELETE TO authenticated '
      'USING (public.company_can_write((SELECT p.company_id FROM public.%I p WHERE p.id = %I.%I)))',
      'billing_gate_delete', rec.child, rec.parent, rec.child, rec.fk);
  END LOOP;
END $$;

-- ─────────────────────────── Supabase Storage ───────────────────────────
-- Tenant uploads go to the private `attachments` bucket, path-namespaced
-- {companyId}/... , written directly from the browser under RLS. Amend the
-- existing INSERT + DELETE policies (recreate with the guard); leave SELECT
-- untouched so existing files stay readable (read-only). These policies existed
-- only in the prod schema dump (dashboard-created); this brings them under
-- migration control. The bucket_id = 'attachments' filter is evaluated before the
-- ::uuid cast, so non-attachments / non-uuid paths never reach the cast.
DROP POLICY IF EXISTS "Users can upload files to their company folder" ON storage.objects;
CREATE POLICY "Users can upload files to their company folder"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'attachments'
    AND (storage.foldername(name))[1] IN (
      SELECT (user_company_access.company_id)::text
      FROM user_company_access
      WHERE user_company_access.user_id = auth.uid()
    )
    AND public.company_can_write(((storage.foldername(name))[1])::uuid)
  );

DROP POLICY IF EXISTS "Users can delete files from their company folder" ON storage.objects;
CREATE POLICY "Users can delete files from their company folder"
  ON storage.objects FOR DELETE TO authenticated
  USING (
    bucket_id = 'attachments'
    AND (storage.foldername(name))[1] IN (
      SELECT (user_company_access.company_id)::text
      FROM user_company_access
      WHERE user_company_access.user_id = auth.uid()
    )
    AND public.company_can_write(((storage.foldername(name))[1])::uuid)
  );
