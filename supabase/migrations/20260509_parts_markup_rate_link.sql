-- Link parts to a markup rate so the part detail page can show which rate
-- (or "Custom") drives each part's pricing, and so a single rate edit can
-- cascade to every part using it. The link is live: editing a rate updates
-- every linked part. ON DELETE SET NULL preserves the last-applied tier
-- values when a rate is removed (the part flips to Custom rather than
-- losing its tiers).
--
-- Lifted from the abandoned feature/markup-rate-link branch's design with
-- the same column shape, since that branch's UI is the model for the new
-- per-part Pricing flow.

BEGIN;

ALTER TABLE public.parts
  ADD COLUMN markup_rate_id uuid REFERENCES public.markup_rates(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_parts_markup_rate_id
  ON public.parts (markup_rate_id);

-- Existing rows start as NULL ("Custom"). No auto-match by breakpoints —
-- the user re-applies a rate from the Pricing card if they want the link.

COMMIT;
