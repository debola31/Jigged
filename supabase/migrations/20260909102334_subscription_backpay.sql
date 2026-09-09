-- Subscription backpay: charge previously-unbilled service on the FIRST invoice.
--
-- A company that ran on billing_exempt (a pilot, a grandfathered shop) owes for the
-- months already delivered when it finally subscribes. Rather than a separate
-- invoice they pay before/after checkout, /checkout appends a ONE-TIME line item to
-- the same Checkout Session, so the hosted page shows the backpay and the monthly
-- price with a single total.
--
-- Stripe guarantees one-time line items land on the initial invoice only
-- (https://docs.stripe.com/api/checkout/sessions/create), so this can never recur.
--
-- Two mechanisms that look right and are NOT, so nobody "simplifies" into them
-- later: subscription_data.add_invoice_items does not exist on Checkout Sessions
-- (only on POST /v1/subscriptions), and a pending invoice item (or a
-- customer.balance debit) is INVISIBLE on the Checkout page yet still swept into
-- the first invoice — the customer would approve one total and be charged another.
-- /checkout refuses to build a backpay session when either is present.

ALTER TABLE public.company_billing
  ADD COLUMN backpay_amount_cents integer,
  ADD COLUMN backpay_description  text,
  ADD COLUMN backpay_charged_at   timestamptz;

ALTER TABLE public.company_billing
  ADD CONSTRAINT company_billing_backpay_amount_positive
    CHECK (backpay_amount_cents IS NULL OR backpay_amount_cents > 0);

COMMENT ON COLUMN public.company_billing.backpay_amount_cents IS
  'Service-role-set one-time catch-up charge, added to the first Checkout invoice. NULL => none. Frontend never names an amount.';
COMMENT ON COLUMN public.company_billing.backpay_description IS
  'Service-role-set invoice line name for the backpay, printed verbatim on the customer''s invoice (e.g. the service window it covers).';
COMMENT ON COLUMN public.company_billing.backpay_charged_at IS
  'Stamped by apply_stripe_subscription on the first active/past_due sync. Non-NULL => /checkout will not bill the backpay again (cancel-then-resubscribe guard).';


-- Stamp backpay_charged_at when the company becomes a real paying customer.
--
-- Without this, a company that subscribes, cancels, and resubscribes would be
-- billed the backpay a second time. The trigger condition deliberately mirrors the
-- billing_exempt auto-clear directly below it: active/past_due only, NEVER
-- trialing — a trial that is abandoned mid-way has not paid for anything, so the
-- backpay must still be owed on the next attempt.
--
-- CREATE OR REPLACE with an UNCHANGED signature: that preserves the function's ACL
-- (service_role-only) and its COMMENT. A DROP would destroy both. The COMMENT is
-- re-issued below only because its text now needs the backpay clause.
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
    END,
    -- One-way latch: set once, on the first real payment, and never re-cleared.
    backpay_charged_at     = CASE
      WHEN cb.backpay_charged_at IS NULL
       AND cb.backpay_amount_cents IS NOT NULL
       AND EXCLUDED.subscription_status IN ('active', 'past_due')
      THEN now()
      ELSE cb.backpay_charged_at
    END
  -- Monotonic guard: only apply if this event is newer than the last one we
  -- recorded. A stale/duplicate delivery is a no-op (neither inserts nor updates).
  WHERE cb.subscription_event_at IS NULL
     OR cb.subscription_event_at <= EXCLUDED.subscription_event_at;
$$;

COMMENT ON FUNCTION public.apply_stripe_subscription IS
  'Guarded upsert of a Stripe subscription into company_billing (webhook + /checkout/sync). Monotonic by p_event_at; clears billing_exempt and stamps backpay_charged_at only on active/past_due.';
