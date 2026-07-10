-- Backfill: give every *unconfigured* part its company's Default markup rate.
--
-- Context. `createPart` applies the company Default rate to new parts, but parts
-- created by other paths (chiefly the CSV import) landed with markup_rate_id =
-- NULL and no part_pricing_tiers. Those "unconfigured" parts read Incomplete on
-- the parts list purely for lack of a markup — a data-at-rest gap, not a real
-- setup problem. This backfill fixes the data so users don't have to open each
-- part to make the phantom warning disappear.
--
-- Scope / safety:
--   * Targets ONLY unconfigured parts: markup_rate_id IS NULL AND no pricing
--     tiers. Parts with tiers (genuine Custom pricing) are never touched.
--   * Uses each company's own Default rate (markup_rates.is_default). Companies
--     without a Default rate are skipped (no-op).
--   * Idempotent: after it runs, those parts have a rate, so a re-run matches
--     nothing. Safe to re-apply.
--   * Only closes the *markup* gap. Parts with real gaps (unpriced ops, a
--     purchased leaf with no vendor cost) stay Incomplete — correctly — and the
--     detail page now names those gaps.
--
-- Note on local/preview: `supabase db reset` replays migrations BEFORE
-- supabase/seed.sql, so on a fresh stack this runs against an empty parts table
-- and no-ops — the seeded parts are inserted afterward (and stay unconfigured on
-- purpose, as a fixture for the auto-default path). This migration exists to
-- correct EXISTING data on merge to prod, where the parts already exist.

DO $$
DECLARE
    r          RECORD;
    v_part_ids uuid[];
BEGIN
    FOR r IN
        SELECT mr.company_id, mr.id AS rate_id
          FROM public.markup_rates mr
         WHERE mr.is_default
    LOOP
        v_part_ids := ARRAY(
            SELECT p.id
              FROM public.parts p
             WHERE p.company_id = r.company_id
               AND p.markup_rate_id IS NULL
               AND NOT EXISTS (
                   SELECT 1 FROM public.part_pricing_tiers t
                    WHERE t.part_id = p.id
               )
        );

        IF cardinality(v_part_ids) > 0 THEN
            -- Reuses the same server-side path the UI's "apply rate" uses:
            -- snapshots the Default breakpoints into part_pricing_tiers and sets
            -- parts.markup_rate_id. The per-part DELETE inside is a no-op here
            -- (we already filtered to parts with zero tiers).
            PERFORM public.bulk_apply_markup_rate(r.company_id, v_part_ids, r.rate_id);
        END IF;
    END LOOP;
END $$;
