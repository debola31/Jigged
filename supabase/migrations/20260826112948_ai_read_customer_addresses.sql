-- customer_addresses: grant the read the insights context already assumed.
--
-- The schema context documents this table, and jigged_ai_readonly holds no grant
-- and no policy on it -- so every "where do we ship to" question died on
-- `permission denied` and the model retried, which is the Gate 1 eval's defect 1
-- in miniature.
--
-- NOT apply_ai_read_access(), and the helper is right to refuse it: this table has
-- no company_id column. It scopes through its customer, so both halves are written
-- by hand here exactly as customer_contacts does it in the baseline.

DO $do$
BEGIN
  -- A grant with RLS disabled is not a narrower grant, it is every company's
  -- addresses. The helper refuses that case; so does this.
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.customer_addresses'::regclass) THEN
    RAISE EXCEPTION
      'customer_addresses has row level security disabled; granting the insights '
      'sandbox SELECT on it would expose every company''s addresses.';
  END IF;
END
$do$;

DROP POLICY IF EXISTS ai_readonly_select ON public.customer_addresses;

CREATE POLICY ai_readonly_select ON public.customer_addresses
  FOR SELECT TO jigged_ai_readonly
  USING (
    customer_id IN (
      SELECT c.id FROM public.customers c
       WHERE c.company_id = (current_setting('jigged.company_id', true))::uuid
    )
  );

GRANT SELECT ON public.customer_addresses TO jigged_ai_readonly;
