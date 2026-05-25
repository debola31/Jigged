-- Drop the `sku` column from inventory_items.
-- The field was barely used — small machine shops recognize material by name +
-- description, not by an internal stockkeeping code. The `description` column
-- already covers the disambiguation case, and search filters / forms get
-- simpler with one fewer field to think about.

BEGIN;

DROP INDEX IF EXISTS public.inventory_items_company_id_sku_idx;

ALTER TABLE public.inventory_items DROP COLUMN IF EXISTS sku;

COMMIT;
