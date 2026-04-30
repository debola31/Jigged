-- Migration: Markup rates — named, reusable pricing patterns applicable to parts.
--
-- Summary:
--   * NEW TABLE markup_rates — a named matrix of (qty, markup%) breakpoints per company.
--     Snapshot semantics on apply: "apply rate X to part Y" copies the breakpoint matrix
--     into part_pricing_tiers; no link, no cascade. (See project memory:
--     project_markup_rates_decision.md for the snapshot-vs-subscription rationale.)
--   * is_default boolean — exactly one rate per company can be the default
--     (enforced by a partial unique index). The default is auto-applied to new
--     parts on creation (TS-side, in createPart). Names are free-form.
--   * Three rates seeded per company on creation: "Default" (is_default=true),
--     "Volume tiers", "Premium small batch". Seeded both for existing companies
--     in this migration and for new companies via an AFTER INSERT trigger.
--   * Differentiated from the dropped part_categories: rates carry a multi-row matrix
--     (substantive abstraction) and ship default starters that copy-from-part can't
--     provide. See feedback_named_pattern_entities.md for the test these passed.

BEGIN;

CREATE TABLE IF NOT EXISTS public.markup_rates (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name          text NOT NULL,
  -- breakpoints: jsonb array of {qty: int, markup_percent: number}, sorted by qty asc.
  -- Atomic per rate (never queried independently of parent), so JSONB is the right shape.
  breakpoints   jsonb NOT NULL DEFAULT '[]'::jsonb,
  is_default    boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT markup_rates_name_unique_per_company UNIQUE (company_id, name)
);

-- Drop the description column if a previous draft of this migration created
-- it. We never used the value in the UI, so it's pure dead weight. Idempotent
-- for fresh databases (column doesn't exist; IF EXISTS makes this a no-op).
ALTER TABLE public.markup_rates DROP COLUMN IF EXISTS description;

CREATE INDEX IF NOT EXISTS idx_markup_rates_company ON markup_rates (company_id);

-- Exactly one default rate per company. Partial unique index lets multiple
-- is_default=false rows coexist while guaranteeing at most one true.
CREATE UNIQUE INDEX IF NOT EXISTS markup_rates_one_default_per_company
  ON public.markup_rates (company_id) WHERE is_default;

DROP TRIGGER IF EXISTS markup_rates_updated_at ON public.markup_rates;
CREATE TRIGGER markup_rates_updated_at
  BEFORE UPDATE ON public.markup_rates
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.markup_rates ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "markup_rates_select" ON public.markup_rates;
CREATE POLICY "markup_rates_select"
    ON public.markup_rates
    FOR SELECT
    USING (company_id IN (SELECT user_company_access.company_id
                            FROM user_company_access
                           WHERE user_company_access.user_id = auth.uid()));

DROP POLICY IF EXISTS "markup_rates_insert" ON public.markup_rates;
CREATE POLICY "markup_rates_insert"
    ON public.markup_rates
    FOR INSERT
    WITH CHECK (company_id IN (SELECT user_company_access.company_id
                                 FROM user_company_access
                                WHERE user_company_access.user_id = auth.uid()));

DROP POLICY IF EXISTS "markup_rates_update" ON public.markup_rates;
CREATE POLICY "markup_rates_update"
    ON public.markup_rates
    FOR UPDATE
    USING (company_id IN (SELECT user_company_access.company_id
                            FROM user_company_access
                           WHERE user_company_access.user_id = auth.uid()));

DROP POLICY IF EXISTS "markup_rates_delete" ON public.markup_rates;
CREATE POLICY "markup_rates_delete"
    ON public.markup_rates
    FOR DELETE
    USING (company_id IN (SELECT user_company_access.company_id
                            FROM user_company_access
                           WHERE user_company_access.user_id = auth.uid()));

DROP POLICY IF EXISTS "ai_readonly_select" ON public.markup_rates;
CREATE POLICY "ai_readonly_select"
    ON public.markup_rates
    FOR SELECT
    TO jigged_ai_readonly
    USING (company_id = (current_setting('jigged.company_id', true))::uuid);

COMMENT ON TABLE public.markup_rates IS
  'Named, reusable markup matrices (qty × markup%) per company. Applied to parts via snapshot — copies breakpoints into part_pricing_tiers, no link.';
COMMENT ON COLUMN public.markup_rates.breakpoints IS
  'JSONB array of {qty: int>0, markup_percent: number}. Sorted by qty ascending. At least one breakpoint required at write time.';


-- ============================================================
-- Seed defaults: per-company "Default", "Volume tiers", and
-- "Premium small batch". Inserted only when the same name doesn't
-- already exist for the company so the migration is re-runnable
-- and respects manual deletions. The "Default" seed is marked
-- is_default=true unless the company already has another default
-- (guards against violating the partial unique index).
-- ============================================================

INSERT INTO public.markup_rates (company_id, name, breakpoints, is_default)
SELECT c.id,
       'Default',
       '[{"qty": 1, "markup_percent": 25}]'::jsonb,
       NOT EXISTS (
         SELECT 1 FROM public.markup_rates mr
          WHERE mr.company_id = c.id AND mr.is_default = true
       )
  FROM public.companies c
 WHERE NOT EXISTS (
   SELECT 1 FROM public.markup_rates mr
    WHERE mr.company_id = c.id AND mr.name = 'Default'
 );

INSERT INTO public.markup_rates (company_id, name, breakpoints)
SELECT c.id,
       'Volume tiers',
       '[{"qty": 1, "markup_percent": 25},
         {"qty": 10, "markup_percent": 22},
         {"qty": 100, "markup_percent": 18},
         {"qty": 1000, "markup_percent": 15}]'::jsonb
  FROM public.companies c
 WHERE NOT EXISTS (
   SELECT 1 FROM public.markup_rates mr
    WHERE mr.company_id = c.id AND mr.name = 'Volume tiers'
 );

INSERT INTO public.markup_rates (company_id, name, breakpoints)
SELECT c.id,
       'Premium small batch',
       '[{"qty": 1, "markup_percent": 40},
         {"qty": 10, "markup_percent": 32}]'::jsonb
  FROM public.companies c
 WHERE NOT EXISTS (
   SELECT 1 FROM public.markup_rates mr
    WHERE mr.company_id = c.id AND mr.name = 'Premium small batch'
 );


-- ============================================================
-- Trigger: seed the same three defaults when a NEW company is
-- created. Once seeded, the rates are normal DB rows — the user
-- can rename, edit, or delete them. They are not re-created if
-- deleted later.
-- ============================================================

CREATE OR REPLACE FUNCTION public.seed_default_markup_rates() RETURNS trigger AS $$
BEGIN
  INSERT INTO public.markup_rates (company_id, name, breakpoints, is_default) VALUES
    (NEW.id,
     'Default',
     '[{"qty": 1, "markup_percent": 25}]'::jsonb,
     true),
    (NEW.id,
     'Volume tiers',
     '[{"qty": 1, "markup_percent": 25},
       {"qty": 10, "markup_percent": 22},
       {"qty": 100, "markup_percent": 18},
       {"qty": 1000, "markup_percent": 15}]'::jsonb,
     false),
    (NEW.id,
     'Premium small batch',
     '[{"qty": 1, "markup_percent": 40},
       {"qty": 10, "markup_percent": 32}]'::jsonb,
     false);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS companies_seed_default_markup_rates ON public.companies;
CREATE TRIGGER companies_seed_default_markup_rates
  AFTER INSERT ON public.companies
  FOR EACH ROW EXECUTE FUNCTION public.seed_default_markup_rates();

COMMIT;
