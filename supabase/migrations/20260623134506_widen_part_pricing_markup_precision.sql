-- Widen part_pricing_tiers.markup_percent precision so a user-typed unit price
-- round-trips to the exact cent.
--
-- markup_percent is the single source of truth for a part tier (the unit_price /
-- base_cost columns were dropped in 20260514 so price always re-derives from cost).
-- When a user overrides the unit price, the UI back-solves the markup and saves
-- that. At numeric(5,2) the markup was quantized to 0.01%, which near a typical
-- base (~$140) spaces achievable prices ~1.4¢ apart — so an exact $140.00 snapped
-- down to $139.99 on reload.
--
-- numeric(10,6): 4 integer digits + 6 decimals (max 9999.999999). This only
-- widens the type — every existing value (<= 999.99) fits unchanged, so no
-- backfill is required. 6 decimals of percent gives price resolution base x 1e-8,
-- far finer than a cent for any realistic base.
ALTER TABLE public.part_pricing_tiers
  ALTER COLUMN markup_percent TYPE numeric(10,6);
