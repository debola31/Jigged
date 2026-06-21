-- Unify job numbering under a single per-company order counter.
--
-- Before: quotes drew Q-NNNN from a MAX(quote_number)+1 scan, quote->job jobs
-- mirrored that (J-NNNN), and direct-PO jobs used a SEPARATE PO-J-NNNN counter.
-- The two J-spaces (quote-mirrored vs PO-J-) never collided because the prefix
-- differed — at the cost of an ugly PO-J- prefix.
--
-- After: every job is J-NNNN. To keep that one J-space collision-free, quotes
-- and direct-PO jobs draw from ONE shared, atomic per-company counter:
--   * creating a quote consumes the next number  -> Q-N
--   * converting a quote keeps its number        -> J-N (unchanged path)
--   * creating a direct-PO job consumes the next -> J-N
-- A quote that never converts (or a number consumed by a direct job) leaves a
-- gap in the Q-sequence — expected, and the reason the J-space stays unique.
--
-- The counter is atomic (UPDATE ... RETURNING), so a quote and a direct job can
-- never grab the same N — which is what would otherwise make a later quote->job
-- conversion collide with an existing direct J-N. A MAX+1 scan could NOT
-- guarantee this; the dedicated counter is the whole point.

-- ── Counter table (internal; only the SECURITY DEFINER allocator touches it) ──
CREATE TABLE IF NOT EXISTS public.company_order_counters (
  company_id  uuid PRIMARY KEY REFERENCES public.companies(id) ON DELETE CASCADE,
  next_number integer NOT NULL DEFAULT 1,
  updated_at  timestamp with time zone NOT NULL DEFAULT now()
);

ALTER TABLE public.company_order_counters ENABLE ROW LEVEL SECURITY;
-- No policies + revoke: members never read/write the counter directly. It is
-- mutated only through next_order_number() (SECURITY DEFINER, below).
REVOKE INSERT, UPDATE, DELETE ON TABLE public.company_order_counters FROM anon, authenticated;

-- Seed every existing company ABOVE the high-water mark of its current Q- and
-- J- numbers, so the first allocated number can't collide with an existing
-- quote or quote-sourced job. Companies with no quotes/jobs start at 1.
INSERT INTO public.company_order_counters (company_id, next_number)
SELECT
  c.id,
  GREATEST(
    COALESCE((SELECT MAX(CAST(SUBSTRING(q.quote_number FROM '^Q-(\d+)$') AS integer))
              FROM public.quotes q
              WHERE q.company_id = c.id AND q.quote_number ~ '^Q-\d+$'), 0),
    COALESCE((SELECT MAX(CAST(SUBSTRING(j.job_number FROM '^J-(\d+)$') AS integer))
              FROM public.jobs j
              WHERE j.company_id = c.id AND j.job_number ~ '^J-\d+$'), 0)
  ) + 1
FROM public.companies c
ON CONFLICT (company_id) DO NOTHING;

-- ── Atomic allocator ──────────────────────────────────────────────────────
-- Returns the next order number and advances the counter in one statement.
-- SECURITY DEFINER so it can write the RLS-locked counter on behalf of any
-- caller. The upsert self-initializes a brand-new company at 1 (returns 1,
-- stores 2) — correct because a new company has no quotes/jobs yet.
CREATE OR REPLACE FUNCTION public.next_order_number(company_uuid uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  result integer;
BEGIN
  INSERT INTO public.company_order_counters (company_id, next_number)
  VALUES (company_uuid, 2)
  ON CONFLICT (company_id) DO UPDATE
    SET next_number = public.company_order_counters.next_number + 1,
        updated_at = now()
  RETURNING next_number - 1 INTO result;
  RETURN result;
END;
$function$;
GRANT EXECUTE ON FUNCTION public.next_order_number(uuid) TO anon, authenticated, service_role;

-- ── Repoint quote numbering at the shared counter ─────────────────────────
-- Same signature, so the set_quote_number() BEFORE-INSERT trigger keeps working
-- unchanged (it still fills quote_number when the client sends '').
CREATE OR REPLACE FUNCTION public.generate_quote_number(company_uuid uuid)
RETURNS text
LANGUAGE plpgsql
AS $function$
BEGIN
  RETURN 'Q-' || LPAD(public.next_order_number(company_uuid)::text, 4, '0');
END;
$function$;

-- ── Direct-PO jobs draw a J- number from the same counter ─────────────────
CREATE OR REPLACE FUNCTION public.generate_direct_job_number(company_uuid uuid)
RETURNS text
LANGUAGE plpgsql
AS $function$
BEGIN
  RETURN 'J-' || LPAD(public.next_order_number(company_uuid)::text, 4, '0');
END;
$function$;
GRANT EXECUTE ON FUNCTION public.generate_direct_job_number(uuid) TO anon, authenticated, service_role;

-- Retire the PO-J- generator (introduced earlier on this same branch).
DROP FUNCTION IF EXISTS public.generate_po_job_number(uuid);
