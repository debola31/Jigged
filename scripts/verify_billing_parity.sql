-- TS↔SQL entitlement parity — the SQL half (test scenario 29).
--
-- Runs the same golden cases as __tests__/lib/entitlement.test.ts through the DB
-- function company_can_write() and RAISEs on any mismatch. isWriteAllowed(entitlement)
-- in TS must equal company_can_write() here for every case.
--
-- Run against a DB with the billing migrations applied:
--   psql "$DATABASE_URL" -f scripts/verify_billing_parity.sql
-- Wrapped in a transaction that ROLLBACKs, so it leaves no data behind.

BEGIN;

INSERT INTO public.companies (id, name, is_demo) VALUES
  ('00000000-0000-0000-0000-0000000000a1', 'parity-real', false),
  ('00000000-0000-0000-0000-0000000000a2', 'parity-demo', true)
ON CONFLICT (id) DO NOTHING;

CREATE FUNCTION pg_temp.assert_write(p_company uuid, p_expected boolean, p_label text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE got boolean;
BEGIN
  got := public.company_can_write(p_company);
  IF got IS DISTINCT FROM p_expected THEN
    RAISE EXCEPTION 'PARITY FAIL [%]: company_can_write=%, expected=%', p_label, got, p_expected;
  END IF;
END;
$$;

CREATE FUNCTION pg_temp.set_billing(
  p_exempt boolean, p_status text,
  p_ended timestamptz, p_cancel timestamptz, p_period timestamptz
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO public.company_billing
    (company_id, billing_exempt, subscription_status, ended_at, cancel_at, current_period_end)
  VALUES ('00000000-0000-0000-0000-0000000000a1', p_exempt, p_status, p_ended, p_cancel, p_period)
  ON CONFLICT (company_id) DO UPDATE SET
    billing_exempt = EXCLUDED.billing_exempt,
    subscription_status = EXCLUDED.subscription_status,
    ended_at = EXCLUDED.ended_at,
    cancel_at = EXCLUDED.cancel_at,
    current_period_end = EXCLUDED.current_period_end;
END;
$$;

-- demo short-circuits (with and without a lapsed billing row)
SELECT pg_temp.assert_write('00000000-0000-0000-0000-0000000000a2', true, 'demo, no row');
INSERT INTO public.company_billing (company_id, billing_exempt, subscription_status, ended_at)
VALUES ('00000000-0000-0000-0000-0000000000a2', false, 'canceled', now() - interval '30 days')
ON CONFLICT (company_id) DO UPDATE SET subscription_status='canceled', ended_at=now()-interval '30 days';
SELECT pg_temp.assert_write('00000000-0000-0000-0000-0000000000a2', true, 'demo, lapsed billing (ignored)');

-- no billing row, not demo
DELETE FROM public.company_billing WHERE company_id='00000000-0000-0000-0000-0000000000a1';
SELECT pg_temp.assert_write('00000000-0000-0000-0000-0000000000a1', false, 'no billing row, not demo');

SELECT pg_temp.set_billing(true, NULL, NULL, NULL, NULL);
SELECT pg_temp.assert_write('00000000-0000-0000-0000-0000000000a1', true, 'grandfathered (exempt)');

SELECT pg_temp.set_billing(false, 'trialing', NULL, NULL, now() + interval '20 days');
SELECT pg_temp.assert_write('00000000-0000-0000-0000-0000000000a1', true, 'trialing');

SELECT pg_temp.set_billing(false, 'active', NULL, NULL, now() + interval '20 days');
SELECT pg_temp.assert_write('00000000-0000-0000-0000-0000000000a1', true, 'active');

SELECT pg_temp.set_billing(false, 'past_due', NULL, NULL, NULL);
SELECT pg_temp.assert_write('00000000-0000-0000-0000-0000000000a1', true, 'past_due');

SELECT pg_temp.set_billing(false, 'canceled', now() - interval '2 days', NULL, NULL);
SELECT pg_temp.assert_write('00000000-0000-0000-0000-0000000000a1', true, 'canceled within grace');

SELECT pg_temp.set_billing(false, 'canceled', now() - interval '30 days', NULL, NULL);
SELECT pg_temp.assert_write('00000000-0000-0000-0000-0000000000a1', false, 'canceled past grace');

SELECT pg_temp.set_billing(false, 'unpaid', now() - interval '1 days', NULL, NULL);
SELECT pg_temp.assert_write('00000000-0000-0000-0000-0000000000a1', true, 'unpaid within grace');

SELECT pg_temp.set_billing(false, 'unpaid', now() - interval '10 days', NULL, NULL);
SELECT pg_temp.assert_write('00000000-0000-0000-0000-0000000000a1', false, 'unpaid past grace');

SELECT pg_temp.set_billing(false, 'canceled', NULL, now() - interval '1 days', NULL);
SELECT pg_temp.assert_write('00000000-0000-0000-0000-0000000000a1', true, 'canceled, anchored on cancel_at');

SELECT pg_temp.set_billing(false, 'canceled', NULL, NULL, now() - interval '1 days');
SELECT pg_temp.assert_write('00000000-0000-0000-0000-0000000000a1', true, 'canceled, anchored on current_period_end');

SELECT pg_temp.set_billing(false, 'canceled', NULL, NULL, NULL);
SELECT pg_temp.assert_write('00000000-0000-0000-0000-0000000000a1', false, 'canceled, no anchor');

SELECT pg_temp.set_billing(false, 'paused', NULL, NULL, NULL);
SELECT pg_temp.assert_write('00000000-0000-0000-0000-0000000000a1', false, 'paused');

SELECT pg_temp.set_billing(false, 'incomplete', NULL, NULL, NULL);
SELECT pg_temp.assert_write('00000000-0000-0000-0000-0000000000a1', false, 'incomplete');

SELECT pg_temp.set_billing(false, 'incomplete_expired', NULL, NULL, NULL);
SELECT pg_temp.assert_write('00000000-0000-0000-0000-0000000000a1', false, 'incomplete_expired');

SELECT pg_temp.set_billing(false, NULL, NULL, NULL, NULL);
SELECT pg_temp.assert_write('00000000-0000-0000-0000-0000000000a1', false, 'row exists, status null, not exempt');

-- grace boundary: exactly 7 days is still inside; one second past is out
SELECT pg_temp.set_billing(false, 'canceled', now() - interval '7 days', NULL, NULL);
SELECT pg_temp.assert_write('00000000-0000-0000-0000-0000000000a1', true, 'grace boundary: exactly 7 days');

SELECT pg_temp.set_billing(false, 'canceled', now() - interval '7 days 1 second', NULL, NULL);
SELECT pg_temp.assert_write('00000000-0000-0000-0000-0000000000a1', false, 'grace boundary: just past 7 days');

\echo '== ALL PARITY CASES PASSED =='

ROLLBACK;
