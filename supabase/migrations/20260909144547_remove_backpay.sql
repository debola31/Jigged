-- Remove the subscription backpay feature.
--
-- It was built to bill a pilot customer's previously-unbilled months on the same
-- Checkout as their first subscription payment. In the event, the founding customer
-- subscribed before the catch-up was attached, so the three months were invoiced
-- directly in Stripe instead — a standalone invoice, sent and settled outside the
-- app. Nothing ever used this code path in production, and no second customer needs
-- it, so it goes rather than sitting as machinery nobody exercises.
--
-- The columns are dropped rather than left empty: the founding customer's row still
-- carried the backfilled (75000, 1, 2026-09-01) placeholder and a backpay_charged_at
-- stamp for a charge that never happened on this path. Leaving those behind would be
-- a standing invitation to read them as a live configuration.
--
-- Also removed with them, and worth naming so it is not rediscovered as a live bug:
-- company_billing_backpay_shape did NOT enforce the "all three or none" rule its own
-- comment claimed. With one or two of the columns NULL the first disjunct is FALSE
-- and the second evaluates to NULL, and a CHECK rejects only FALSE — so every
-- half-configured row was accepted. It is dropped here along with the columns it
-- guarded; a `num_nonnulls(...) IN (0, 3)` form is the fix if this ever comes back.

ALTER TABLE public.company_billing
  DROP CONSTRAINT IF EXISTS company_billing_backpay_shape,
  DROP COLUMN IF EXISTS backpay_monthly_cents,
  DROP COLUMN IF EXISTS backpay_months,
  DROP COLUMN IF EXISTS backpay_first_month,
  DROP COLUMN IF EXISTS backpay_charged_at;


-- Restore the sync RPC to its pre-backpay body: the billing_exempt auto-clear is
-- the only conditional left in the upsert.
--
-- CREATE OR REPLACE with an UNCHANGED signature, so the function's service_role-only
-- ACL and its COMMENT survive. A DROP would destroy both.
CREATE OR REPLACE FUNCTION public.apply_stripe_subscription(
  p_company_id             uuid,
  p_stripe_customer_id     text,
  p_stripe_subscription_id text,
  p_status                 text,
  p_price_id               text,
  p_current_period_end     timestamptz,
  p_cancel_at              timestamptz,
  p_canceled_at            timestamptz,
  p_ended_at               timestamptz,
  p_trial_end              timestamptz,
  p_event_at               timestamptz
)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  INSERT INTO public.company_billing AS cb (
    company_id, stripe_customer_id, stripe_subscription_id, subscription_status,
    subscription_price_id, current_period_end, cancel_at, canceled_at, ended_at,
    trial_end, subscription_event_at, synced_at, billing_exempt
  ) VALUES (
    p_company_id, p_stripe_customer_id, p_stripe_subscription_id, p_status,
    p_price_id, p_current_period_end, p_cancel_at, p_canceled_at, p_ended_at,
    p_trial_end, p_event_at, now(),
    -- A brand-new billing row created by a subscription event is a paying/trialing
    -- company, never grandfathered.
    false
  )
  ON CONFLICT (company_id) DO UPDATE SET
    stripe_customer_id     = EXCLUDED.stripe_customer_id,
    stripe_subscription_id = EXCLUDED.stripe_subscription_id,
    subscription_status    = EXCLUDED.subscription_status,
    subscription_price_id  = EXCLUDED.subscription_price_id,
    current_period_end     = EXCLUDED.current_period_end,
    cancel_at              = EXCLUDED.cancel_at,
    canceled_at            = EXCLUDED.canceled_at,
    ended_at               = EXCLUDED.ended_at,
    trial_end              = EXCLUDED.trial_end,
    subscription_event_at  = EXCLUDED.subscription_event_at,
    synced_at              = now(),
    billing_exempt         = CASE
      WHEN EXCLUDED.subscription_status IN ('active', 'past_due') THEN false
      ELSE cb.billing_exempt
    END
  -- Monotonic guard: only apply if this event is newer than the last one we
  -- recorded. A stale/duplicate delivery is a no-op (neither inserts nor updates).
  WHERE cb.subscription_event_at IS NULL
     OR cb.subscription_event_at <= EXCLUDED.subscription_event_at;
$$;

COMMENT ON FUNCTION public.apply_stripe_subscription IS
  'Guarded upsert of a Stripe subscription into company_billing (webhook + /checkout/sync). Monotonic by p_event_at; clears billing_exempt only on active/past_due.';
