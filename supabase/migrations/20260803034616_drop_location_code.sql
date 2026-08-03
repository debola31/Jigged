-- Drop `inventory_locations.code`.
--
-- ═══════════════════════════════════════════════════════════════════════════════
-- WHY
-- ═══════════════════════════════════════════════════════════════════════════════
-- Founder's question, which turned out to be the right one: *"why do we need the code printed on
-- the label, why not just the name?"*
--
-- The label already prints the name. `locationLabelPdf` lays out the QR, then the **full path**
-- (`Cabinet 3 › Shelf A`) at 11pt black, then the code underneath at 10pt grey. So the code was a
-- second human-readable identifier sitting one line below the first one.
--
-- And it was an identifier **nothing could look up**. There is no search by code, no filter, no
-- `eq('code')` anywhere in the access layer, and the scanner parses the location UUID out of the
-- QR — `lib/jiggedScan.ts` never reads a code. A person could read one off a sticker and type it
-- into nothing.
--
-- The three arguments for keeping it, and why none held:
--   * "short enough to say out loud" — you would say "Shelf A", and the app cannot act on a code
--     you spoke anyway;
--   * "survives a rename" — does not apply; the QR carries the UUID, so relabelling never breaks
--     a printed sticker, which `locationLabelPdf`'s own docblock says;
--   * "matches codes already stencilled on the racks" — the only one with weight, but a shop with
--     that scheme would simply NAME the place `A-12`, and then the name and the paint agree with
--     no second field to keep in step.
--
-- Safe to drop rather than deprecate: no one has printed labels yet (founder, 2026-08-03), so no
-- sticker in any shop carries a code that would stop matching the software.
--
-- ═══════════════════════════════════════════════════════════════════════════════
-- WHAT WENT WITH IT
-- ═══════════════════════════════════════════════════════════════════════════════
-- The generated-code scheme in utils/locationSpec.ts — `generatedCode`, `explicitCode`,
-- `explicitCodeIn`, `shortestFreePrefix`, `deriveCodeFor`, `parentCodeOf`, `pad` — existed only to
-- derive these strings (`CAB1` → `CAB1-R03` → `CAB1-R03-L`). The builder keeps its NAME planning,
-- which is the part anyone reads.
--
-- Nothing in the database referenced the column: no index, no constraint, no view and no function
-- body (all four checked before writing this). So this is a bare drop with no dependency work.

ALTER TABLE public.inventory_locations DROP COLUMN code;

COMMENT ON TABLE public.inventory_locations IS
  'Where stock physically sits. Identity is the NAME, unique among siblings — there is no separate code: a printed label carries the QR (encoding this row''s id) and the full path, and nothing in the app resolves a location by anything else. See 20260803034616.';
