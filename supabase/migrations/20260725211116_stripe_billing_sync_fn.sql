-- Stripe billing: atomic, monotonically-guarded sync of a subscription into the
-- company_billing cache.
--
-- The webhook and /checkout/sync both call this. It is an UPSERT (a brand-new
-- company that signs up after launch has no billing row — the grandfather backfill
-- only covered companies that existed at launch), guarded by a monotonic
-- timestamp so concurrent / out-of-order Vercel lambdas can't lose-update each
-- other (D5). PostgREST can't express `ON CONFLICT DO UPDATE ... WHERE`, so this
-- lives in SQL and is called via .rpc() with the service-role key.
--
-- Grandfather auto-clear: billing_exempt is cleared ONLY when the company becomes
-- a real paying customer (status active/past_due), never on trialing — so a
-- grandfathered company that starts a trial and cancels mid-trial keeps its free
-- access.

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

-- Backend-only: the webhook/sync call it with the service-role key. Never exposed
-- to browser clients.
REVOKE ALL ON FUNCTION public.apply_stripe_subscription(
  uuid, text, text, text, text, timestamptz, timestamptz, timestamptz,
  timestamptz, timestamptz, timestamptz
) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_stripe_subscription(
  uuid, text, text, text, text, timestamptz, timestamptz, timestamptz,
  timestamptz, timestamptz, timestamptz
) TO service_role;
