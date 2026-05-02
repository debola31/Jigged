-- Link parts to a markup rate so the parts list can show which rate (or "Custom") drives each part's pricing,
-- and so a single rate edit can cascade to every part using it. Snapshot semantics are replaced by a live link
-- (with ON DELETE SET NULL preserving the last tier values when a rate is removed).

BEGIN;

ALTER TABLE public.parts
  ADD COLUMN markup_rate_id uuid REFERENCES public.markup_rates(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_parts_markup_rate_id
  ON public.parts (markup_rate_id);

-- Existing rows start as NULL ("Custom"). Per the design decision recorded with this change,
-- we do not auto-match by breakpoints — users re-apply rates as needed.

COMMIT;
