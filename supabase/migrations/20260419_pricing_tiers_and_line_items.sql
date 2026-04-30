-- Migration: Three-layer pricing model — pricing tiers on Part, snapshotted line items on Quote.
--
-- Summary:
--   * NEW TABLE part_pricing_tiers — the "estimate" layer. Each part can have multiple
--     quantity tiers (qty, markup%, unit_price, override flag). Seeded from the part
--     category's default_markup_percent but editable per tier.
--   * NEW TABLE quote_line_items — snapshot of selected tiers at quote creation.
--     Immutable after creation. One quote can span multiple parts and multiple tiers per part.
--   * quote_operations / quote_materials gain a `part_id` column so multi-part quotes
--     capture each part's cost structure independently.
--   * quotes table: DROP part_id, quantity, markup_percent, unit_price, total_price,
--     base_cost, estimated_labor_cost, estimated_material_cost, converted_to_job_id.
--     No production data — clean drop.
--   * jobs table: ADD source_quote_line_item_id for full conversion provenance.
--   * convert_quote_to_job RPC: dropped — TS orchestrates the per-line conversion.

BEGIN;

-- ============================================================
-- 1. part_pricing_tiers (the estimate — lives on the Part)
-- ============================================================

CREATE TABLE IF NOT EXISTS public.part_pricing_tiers (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  part_id             uuid NOT NULL REFERENCES parts(id) ON DELETE CASCADE,
  company_id          uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  sequence            integer NOT NULL,
  quantity            integer NOT NULL CHECK (quantity > 0),
  base_cost_per_unit  numeric(12,4),
  markup_percent      numeric(5,2),
  unit_price          numeric(12,4),
  is_price_override   boolean NOT NULL DEFAULT false,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT part_pricing_tiers_unique_seq UNIQUE (part_id, sequence)
);

CREATE INDEX IF NOT EXISTS idx_part_pricing_tiers_part    ON part_pricing_tiers (part_id, sequence);
CREATE INDEX IF NOT EXISTS idx_part_pricing_tiers_company ON part_pricing_tiers (company_id);

CREATE TRIGGER part_pricing_tiers_updated_at
  BEFORE UPDATE ON public.part_pricing_tiers
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.part_pricing_tiers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "part_pricing_tiers_select" ON public.part_pricing_tiers;
CREATE POLICY "part_pricing_tiers_select"
    ON public.part_pricing_tiers
    FOR SELECT
    USING (company_id IN (SELECT user_company_access.company_id
                            FROM user_company_access
                           WHERE user_company_access.user_id = auth.uid()));

DROP POLICY IF EXISTS "part_pricing_tiers_insert" ON public.part_pricing_tiers;
CREATE POLICY "part_pricing_tiers_insert"
    ON public.part_pricing_tiers
    FOR INSERT
    WITH CHECK (company_id IN (SELECT user_company_access.company_id
                                 FROM user_company_access
                                WHERE user_company_access.user_id = auth.uid()));

DROP POLICY IF EXISTS "part_pricing_tiers_update" ON public.part_pricing_tiers;
CREATE POLICY "part_pricing_tiers_update"
    ON public.part_pricing_tiers
    FOR UPDATE
    USING (company_id IN (SELECT user_company_access.company_id
                            FROM user_company_access
                           WHERE user_company_access.user_id = auth.uid()));

DROP POLICY IF EXISTS "part_pricing_tiers_delete" ON public.part_pricing_tiers;
CREATE POLICY "part_pricing_tiers_delete"
    ON public.part_pricing_tiers
    FOR DELETE
    USING (company_id IN (SELECT user_company_access.company_id
                            FROM user_company_access
                           WHERE user_company_access.user_id = auth.uid()));

DROP POLICY IF EXISTS "ai_readonly_select" ON public.part_pricing_tiers;
CREATE POLICY "ai_readonly_select"
    ON public.part_pricing_tiers
    FOR SELECT
    TO jigged_ai_readonly
    USING (company_id = (current_setting('jigged.company_id', true))::uuid);


-- ============================================================
-- 2. Add part_id to existing cost snapshot tables (multi-part quotes)
-- ============================================================
-- No production data — snapshot rows can be cleared and repopulated by createQuote.

DELETE FROM quote_operations;
DELETE FROM quote_materials;

ALTER TABLE quote_operations
  ADD COLUMN part_id uuid NOT NULL REFERENCES parts(id) ON DELETE RESTRICT;

ALTER TABLE quote_materials
  ADD COLUMN part_id uuid NOT NULL REFERENCES parts(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_quote_operations_quote_part ON quote_operations (quote_id, part_id);
CREATE INDEX IF NOT EXISTS idx_quote_materials_quote_part  ON quote_materials  (quote_id, part_id);


-- ============================================================
-- 3. jobs.source_quote_line_item_id (provenance for converted jobs)
-- ============================================================

ALTER TABLE jobs ADD COLUMN source_quote_line_item_id uuid;
-- FK added after quote_line_items is created below.


-- ============================================================
-- 4. quote_line_items (snapshot of selected tiers on a quote)
-- ============================================================

CREATE TABLE IF NOT EXISTS public.quote_line_items (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_id            uuid NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
  company_id          uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  part_id             uuid NOT NULL REFERENCES parts(id),
  source_tier_id     uuid REFERENCES part_pricing_tiers(id) ON DELETE SET NULL,
  sequence            integer NOT NULL,
  quantity            integer NOT NULL CHECK (quantity > 0),
  unit_price          numeric(12,4) NOT NULL,
  total_price         numeric(12,4),
  markup_percent      numeric(5,2),
  base_cost_per_unit  numeric(12,4),
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT quote_line_items_unique_seq UNIQUE (quote_id, sequence)
);

CREATE INDEX IF NOT EXISTS idx_quote_line_items_quote   ON quote_line_items (quote_id, sequence);
CREATE INDEX IF NOT EXISTS idx_quote_line_items_part    ON quote_line_items (part_id);
CREATE INDEX IF NOT EXISTS idx_quote_line_items_company ON quote_line_items (company_id);

ALTER TABLE public.quote_line_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "quote_line_items_select" ON public.quote_line_items;
CREATE POLICY "quote_line_items_select"
    ON public.quote_line_items
    FOR SELECT
    USING (company_id IN (SELECT user_company_access.company_id
                            FROM user_company_access
                           WHERE user_company_access.user_id = auth.uid()));

DROP POLICY IF EXISTS "quote_line_items_insert" ON public.quote_line_items;
CREATE POLICY "quote_line_items_insert"
    ON public.quote_line_items
    FOR INSERT
    WITH CHECK (company_id IN (SELECT user_company_access.company_id
                                 FROM user_company_access
                                WHERE user_company_access.user_id = auth.uid()));

DROP POLICY IF EXISTS "quote_line_items_update" ON public.quote_line_items;
CREATE POLICY "quote_line_items_update"
    ON public.quote_line_items
    FOR UPDATE
    USING (company_id IN (SELECT user_company_access.company_id
                            FROM user_company_access
                           WHERE user_company_access.user_id = auth.uid()));

DROP POLICY IF EXISTS "quote_line_items_delete" ON public.quote_line_items;
CREATE POLICY "quote_line_items_delete"
    ON public.quote_line_items
    FOR DELETE
    USING (company_id IN (SELECT user_company_access.company_id
                            FROM user_company_access
                           WHERE user_company_access.user_id = auth.uid()));

DROP POLICY IF EXISTS "ai_readonly_select" ON public.quote_line_items;
CREATE POLICY "ai_readonly_select"
    ON public.quote_line_items
    FOR SELECT
    TO jigged_ai_readonly
    USING (company_id = (current_setting('jigged.company_id', true))::uuid);

-- Now that quote_line_items exists, finish the FK on jobs.
ALTER TABLE jobs
  ADD CONSTRAINT jobs_source_quote_line_item_id_fkey
  FOREIGN KEY (source_quote_line_item_id) REFERENCES quote_line_items(id) ON DELETE SET NULL;


-- ============================================================
-- 5. Drop deprecated columns on quotes (clean drop — no users)
-- ============================================================

-- Drop the RPC that reads old columns before we drop them.
DROP FUNCTION IF EXISTS public.convert_quote_to_job(uuid, text, integer);

ALTER TABLE quotes DROP COLUMN IF EXISTS part_id;
ALTER TABLE quotes DROP COLUMN IF EXISTS quantity;
ALTER TABLE quotes DROP COLUMN IF EXISTS markup_percent;
ALTER TABLE quotes DROP COLUMN IF EXISTS unit_price;
ALTER TABLE quotes DROP COLUMN IF EXISTS total_price;
ALTER TABLE quotes DROP COLUMN IF EXISTS base_cost;
ALTER TABLE quotes DROP COLUMN IF EXISTS estimated_labor_cost;
ALTER TABLE quotes DROP COLUMN IF EXISTS estimated_material_cost;
ALTER TABLE quotes DROP COLUMN IF EXISTS converted_to_job_id;


-- ============================================================
-- 6. Comments
-- ============================================================

COMMENT ON TABLE public.part_pricing_tiers IS
  'Quantity price breaks for a part (the "estimate" layer). Seeded from part_categories.default_markup_percent. Selected tiers are snapshotted into quote_line_items at quote creation.';
COMMENT ON COLUMN public.part_pricing_tiers.is_price_override IS
  'True when the user manually set unit_price. Recalcs from routing changes skip this tier''s unit_price.';

COMMENT ON TABLE public.quote_line_items IS
  'Immutable snapshot of selected pricing tiers at quote creation. Multiple parts per quote, multiple tiers per part.';

COMMENT ON COLUMN public.jobs.source_quote_line_item_id IS
  'Identifies which specific quote line item (part + tier) produced this job via convertQuoteToJob.';

COMMIT;
