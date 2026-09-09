-- Backpay, itemised by month.
--
-- The first shape billed the catch-up as ONE line ("service June 5 - September 9,
-- $750"). On the real Stripe page that reads as an opaque lump: the customer can
-- see the total but not that it is their monthly rate times the months they went
-- unbilled. Billing whole months as separate lines ("June 2026 $250", "July 2026
-- $250", ...) is the same money and a far better invoice — the bookkeeper reading
-- it a year from now can reconcile it against the months they used the product.
--
-- So the amount + free-text description are replaced by the three facts the lines
-- are generated from: the monthly rate, how many months, and which month is first.
-- The line labels are DERIVED in the checkout path, which is why there is no
-- description column any more — a label that disagreed with the dates would be
-- the failure mode, and now it cannot happen.
--
-- Deliberately rigid: whole months at ONE rate. An irregular schedule (a partial
-- month, or a rate that changed mid-window) needs a model change, not a fudged
-- first_month. That is the trade for making the common case impossible to typo.

ALTER TABLE public.company_billing
  ADD COLUMN backpay_monthly_cents integer,
  ADD COLUMN backpay_months        integer,
  ADD COLUMN backpay_first_month   date;

-- Preserve the AMOUNT of any row already configured under the old shape, as a
-- single month. Month labels cannot be recovered from a free-text description, so
-- a pre-existing row must be re-set to its real window — there is exactly one (the
-- founding customer), and it is re-set as part of this change. Backfilling rather
-- than dropping keeps the failure mode safe: forget the re-set and the customer is
-- still billed the right money under a wrong label, never the wrong money.
UPDATE public.company_billing
SET backpay_monthly_cents = backpay_amount_cents,
    backpay_months        = 1,
    backpay_first_month   = date_trunc('month', current_date)::date
WHERE backpay_amount_cents IS NOT NULL;

ALTER TABLE public.company_billing
  DROP CONSTRAINT IF EXISTS company_billing_backpay_amount_positive,
  DROP COLUMN backpay_amount_cents,
  DROP COLUMN backpay_description;

ALTER TABLE public.company_billing
  ADD CONSTRAINT company_billing_backpay_shape CHECK (
    -- All three or none: a half-configured row would bill a plausible-looking
    -- wrong number, which is the one outcome worth a constraint.
    (backpay_monthly_cents IS NULL AND backpay_months IS NULL AND backpay_first_month IS NULL)
    OR (
      backpay_monthly_cents > 0
      AND backpay_months BETWEEN 1 AND 36
      -- Whole months only, so the derived labels are unambiguous.
      AND backpay_first_month = date_trunc('month', backpay_first_month)::date
    )
  );

COMMENT ON COLUMN public.company_billing.backpay_monthly_cents IS
  'Service-role-set per-month catch-up rate. NULL => no backpay. Frontend never names an amount.';
COMMENT ON COLUMN public.company_billing.backpay_months IS
  'How many whole months of previously-unbilled service to charge on the first invoice.';
COMMENT ON COLUMN public.company_billing.backpay_first_month IS
  'First month covered (always day 1). With backpay_months this derives one Checkout line per month.';


-- Re-point the backpay latch at the new column. Same one-way behaviour, same
-- trigger condition as the billing_exempt auto-clear; only the column name moves.
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
    END,
    -- One-way latch: set once, on the first real payment, and never re-cleared.
    backpay_charged_at     = CASE
      WHEN cb.backpay_charged_at IS NULL
       AND cb.backpay_monthly_cents IS NOT NULL
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
