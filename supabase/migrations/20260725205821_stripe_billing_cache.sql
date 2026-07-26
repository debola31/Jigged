-- Stripe self-serve subscription billing: minimal read-cache of Stripe state.
--
-- Stripe is the sole source of truth for billing; this table is a webhook-fed
-- read cache. It is a dedicated 1:1 satellite of `companies` (NOT columns on
-- `companies`) because `companies` grants `GRANT ALL ... TO authenticated` at the
-- table level and its INSERT policy is `WITH CHECK (true)`. In PostgreSQL a
-- column-level REVOKE cannot remove a privilege already held at the table level,
-- so putting writable billing columns on `companies` would let any admin (or any
-- authenticated user via INSERT) self-stamp subscription_status='active'. Here
-- members get SELECT only; the service-role webhook is the sole writer.
--
-- Entitlement is DERIVED from this cache (see lib/entitlement.ts and, in a later
-- migration, the company_can_write() SQL function) — never stored.

CREATE TABLE IF NOT EXISTS public.company_billing (
  company_id             uuid PRIMARY KEY REFERENCES public.companies(id) ON DELETE CASCADE,
  -- Grandfather flag: existing companies at launch are exempt (full access) until
  -- they subscribe; the webhook auto-clears this on their first active/past_due.
  billing_exempt         boolean NOT NULL DEFAULT false,
  -- Cached Stripe state (overwritten wholesale on each handled webhook event).
  stripe_customer_id     text UNIQUE,
  stripe_subscription_id text,
  subscription_status    text,
  subscription_price_id  text,
  current_period_end     timestamptz,
  cancel_at              timestamptz,
  canceled_at            timestamptz,
  ended_at               timestamptz,
  trial_end              timestamptz,
  -- Reserved-customer checkout-time overrides (service-role-set only). NULL =>
  -- founding $300 price / 30-day trial. The $300/$250 price ids live in backend
  -- env, never in this table.
  override_price_id      text,
  override_trial_days    integer,
  -- Monotonic write guard: webhooks stamp event.created, /checkout/sync stamps
  -- now(). A write only applies when its stamp is >= the stored one, so
  -- concurrent/out-of-order Vercel lambdas can't lose-update each other.
  subscription_event_at  timestamptz,
  synced_at              timestamptz NOT NULL DEFAULT now(),
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT company_billing_status_check CHECK (
    subscription_status IS NULL OR subscription_status IN (
      'trialing', 'active', 'past_due', 'canceled', 'unpaid',
      'incomplete', 'incomplete_expired', 'paused'
    )
  )
);

COMMENT ON TABLE public.company_billing IS
  'Webhook-fed read cache of Stripe subscription state, 1:1 with companies. Stripe is source of truth; members read-only, service_role is sole writer. Entitlement is derived, not stored.';
COMMENT ON COLUMN public.company_billing.billing_exempt IS
  'Grandfathered (existing at launch) => full access until they subscribe; webhook auto-clears on first active/past_due.';
COMMENT ON COLUMN public.company_billing.override_price_id IS
  'Service-role-set reserved-customer price id (else backend founding price). Frontend never names a price.';
COMMENT ON COLUMN public.company_billing.override_trial_days IS
  'Service-role-set reserved-customer trial length (else 30). 0 => no trial.';
COMMENT ON COLUMN public.company_billing.subscription_event_at IS
  'Monotonic write guard: webhooks use event.created, /checkout/sync uses now().';

-- Keep updated_at fresh (matches the companies_updated_at trigger convention).
DROP TRIGGER IF EXISTS company_billing_updated_at ON public.company_billing;
CREATE TRIGGER company_billing_updated_at
  BEFORE UPDATE ON public.company_billing
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.company_billing ENABLE ROW LEVEL SECURITY;

-- Members may READ their company's billing state (drives the UI). Nobody but
-- service_role writes — there is deliberately NO insert/update/delete policy for
-- authenticated, and (below) no write grant either.
DROP POLICY IF EXISTS "Members can view their company billing" ON public.company_billing;
CREATE POLICY "Members can view their company billing"
  ON public.company_billing FOR SELECT
  USING (company_id IN (SELECT get_user_company_ids()));

-- Data API grants (house style: every new public table needs explicit grants).
-- SELECT only for members; full CRUD for the service-role webhook/backfill.
GRANT SELECT ON public.company_billing TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.company_billing TO service_role;

-- Day-1 grandfather backfill: every existing REAL company gets full access until
-- it chooses to subscribe. Demo companies are excluded — they are never
-- billing-gated (see the is_demo short-circuit in a later migration) and
-- reset_demo_company could wipe an attached row.
INSERT INTO public.company_billing (company_id, billing_exempt)
SELECT id, true
FROM public.companies
WHERE is_demo = false
ON CONFLICT (company_id) DO NOTHING;
