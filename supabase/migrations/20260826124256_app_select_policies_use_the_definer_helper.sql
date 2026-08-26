-- Five SELECT policies read user_company_access inline, and that breaks the AI role.
--
-- WHAT HAPPENS. These policies target PUBLIC, and PUBLIC includes
-- jigged_ai_readonly. Evaluating them therefore requires the AI role to hold
-- SELECT on user_company_access, which it deliberately does not -- so the whole
-- query dies with `permission denied for table user_company_access` even though
-- the table's own ai_readonly_select policy would have allowed it. The Gate 1
-- eval rerun hit this on "what is my quote pipeline worth?" in all three arms.
--
-- WHY quotes WORKS AND quote_line_items DOES NOT. Most tables already express the
-- same rule through public.get_user_company_ids(), which is SECURITY DEFINER, so
-- its read of user_company_access runs as the function owner and needs nothing
-- from the caller. These five were written with the subquery inline instead.
--
-- BEHAVIOUR IS UNCHANGED FOR BROWSER USERS, and that is checkable rather than
-- asserted -- the helper's body IS the inline subquery, character for character:
--
--   get_user_company_ids():  SELECT company_id FROM user_company_access
--                             WHERE user_id = auth.uid()
--   the inline form:         company_id IN (SELECT company_id FROM user_company_access
--                                            WHERE user_id = auth.uid())
--
-- For jigged_ai_readonly, auth.uid() is NULL, so the helper returns no rows and
-- this policy contributes nothing -- access comes from ai_readonly_select, which
-- is OR'd with it as another permissive policy. Exactly as it does on `quotes`.
--
-- SELECT POLICIES ONLY, deliberately. The matching insert/update/delete policies
-- on these tables have the same inline shape, and a read-only role never causes
-- them to be evaluated. Leaving them alone keeps this change to the smallest set
-- that fixes the defect.

-- ── parts ────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "Users can view parts for their companies" ON public.parts;
CREATE POLICY "Users can view parts for their companies" ON public.parts
  FOR SELECT
  USING (company_id IN (SELECT public.get_user_company_ids()));

-- ── quote_line_items ─────────────────────────────────────────────────────────
DROP POLICY IF EXISTS quote_line_items_select ON public.quote_line_items;
CREATE POLICY quote_line_items_select ON public.quote_line_items
  FOR SELECT
  USING (company_id IN (SELECT public.get_user_company_ids()));

-- ── work_centers ─────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS work_centers_select ON public.work_centers;
CREATE POLICY work_centers_select ON public.work_centers
  FOR SELECT
  USING (company_id IN (SELECT public.get_user_company_ids()));

-- ── part_pricing_tiers ───────────────────────────────────────────────────────
DROP POLICY IF EXISTS part_pricing_tiers_select ON public.part_pricing_tiers;
CREATE POLICY part_pricing_tiers_select ON public.part_pricing_tiers
  FOR SELECT
  USING (company_id IN (SELECT public.get_user_company_ids()));

-- ── customer_addresses ───────────────────────────────────────────────────────
-- FOR ALL, so it covers SELECT and has to be rewritten too, and its WITH CHECK
-- has to be re-issued or inserts and updates would lose their guard. The EXISTS
-- keeps the same shape; only the uca join is replaced, and it now reads only
-- `customers`, which the AI role can already see.
DROP POLICY IF EXISTS "Company members manage their customer addresses" ON public.customer_addresses;
CREATE POLICY "Company members manage their customer addresses" ON public.customer_addresses
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.customers c
       WHERE c.id = customer_addresses.customer_id
         AND c.company_id IN (SELECT public.get_user_company_ids())
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.customers c
       WHERE c.id = customer_addresses.customer_id
         AND c.company_id IN (SELECT public.get_user_company_ids())
    )
  );
