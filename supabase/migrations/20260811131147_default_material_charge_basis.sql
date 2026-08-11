-- A shop-wide default for how a part charges the materials it consumes (#727).
--
-- The per-part toggle on the Materials panel answers "does THIS part pay our
-- cost for its purchased materials, or their marked-up price?". A shop that
-- marks up purchased material marks up all of it, so answering that on every new
-- part is a chore with one predictable answer. This is that answer, given once.
--
-- SEED, NOT A RULE — the same discipline as companies.default_markup_*. It is
-- read when a BOM line is CREATED and written into that line's own
-- `charge_basis`; the rollup never reads it. Flipping it therefore reprices
-- nothing that already exists, and a part whose lines were set deliberately
-- keeps them. A read-time version of this is exactly what got the markup_rates
-- module deleted in July 2026.
--
-- Precedence when a new purchased material is added to a part:
--   1. however that part's OTHER purchased materials are already set — a part
--      with a stance keeps it, so adding one more cannot drop the panel into
--      "mixed"
--   2. otherwise this default
--
-- DEFAULT 'cost' leaves every existing company exactly where it is.
ALTER TABLE public.companies
  ADD COLUMN default_material_charge_basis text NOT NULL DEFAULT 'cost'
    CHECK (default_material_charge_basis IN ('cost', 'price'));

COMMENT ON COLUMN public.companies.default_material_charge_basis IS
  'What a NEW purchased-material BOM line is created with: ''cost'' (default) or ''price''. A seed read at line-creation time and written into parts_bom.charge_basis — never read by the cost rollup, so changing it reprices nothing. A part that already has purchased materials keeps their stance instead.';
